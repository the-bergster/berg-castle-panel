// sonos/search.js — Pluggable catalog search.
//
// WHY THIS EXISTS
// Sonos S2 players cannot search. Verified against this household's firmware:
//   * ContentDirectory GetSearchCapabilities returns an empty string
//   * the UPnP Search action returns error 401 (not implemented)
//   * browsing any third-party service container returns 701 (no such object)
//   * MusicServices GetSessionId returns 806 for OAuth-linked services
// On S2, catalog browse and search live in Sonos's cloud. The player is a playback
// endpoint: hand it a URI and it plays, but it will not tell you what exists.
//
// So we do what Sonos's cloud does — search the service's own API ourselves, then
// synthesise the URI + DIDL metadata the player expects. The formats below were
// derived from THIS household's own favourites and queue, not from guesswork.

'use strict';

const didl = require('./didl');

/**
 * Flags observed in this household's working Spotify content. `flags` encodes
 * playback capabilities; the low 4 hex digits are mirrored into the metadata item id.
 *   track     8232 (0x2028)  as used by every track in the live queue
 *   album     8268 (0x204C)  as used by the "The Greatest Hits" favourite
 *   playlist  8300 (0x206C)  as used by the "Songs Like:" favourite
 */
const SPOTIFY_FLAGS = { track: 8232, album: 8268, playlist: 8300, artist: 8236 };

/**
 * Hard ceiling on Spotify's `limit` parameter.
 * The API documents 1-50, but apps on the default (non-extended) quota tier get a
 * bare 400 "Invalid limit" above 10 — verified empirically against these credentials
 * at every value from 1 to 20, for one type and for four. Requesting more results
 * means paging with `offset`, not raising `limit`.
 */
const SEARCH_MAX_LIMIT = 10;

/** Percent-encode a Spotify URI for the `res` element: "spotify:track:X" -> "spotify%3atrack%3aX". */
function encodeSpotifyUri(spotifyUri) {
  return spotifyUri.replace(/:/g, '%3a');
}

class SpotifyProvider {
  /**
   * @param {Object} config
   * @param {string} config.client_id
   * @param {string} config.client_secret
   * @param {string} [config.market]
   * @param {number} [config.sonos_sid]  Defaults to 12
   * @param {number} [config.sonos_sn]   The account serial from the household's own URIs
   */
  constructor(config = {}) {
    this.id = 'spotify';
    this.name = 'Spotify';
    this.config = config;
    this.sid = config.sonos_sid || 12;
    this.sn = config.sonos_sn == null ? 7 : config.sonos_sn;
    this.market = config.market || 'US';
    this._token = null;
    this._tokenExpiry = 0;
    this._tokenPromise = null;
    this._cache = new Map();
  }

  get available() {
    return Boolean(this.config.client_id && this.config.client_secret);
  }

  /**
   * Learn the household's real sid/sn by inspecting a URI that Sonos itself produced.
   * Re-linking a Spotify account changes `sn`, and a stale value yields silent
   * playback failures, so we prefer observation over configuration.
   */
  adoptFromUri(uri) {
    const params = didl.uriParams(uri);
    if (params.sid != null) this.sid = params.sid;
    if (params.sn != null) this.sn = params.sn;
    return { sid: this.sid, sn: this.sn };
  }

  /** The SA_RINCON descriptor for this service. */
  get token() {
    return didl.serviceToken(this.sid);
  }

  // ---- Auth (Client Credentials — no user login, no user data) ----

  async _accessToken() {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    if (this._tokenPromise) return this._tokenPromise;

    this._tokenPromise = (async () => {
      const auth = Buffer.from(`${this.config.client_id}:${this.config.client_secret}`).toString('base64');
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Spotify auth failed (${res.status}). Check client_id/client_secret. ${detail.slice(0, 200)}`);
      }
      const json = await res.json();
      this._token = json.access_token;
      // Refresh a minute early so a request never races the expiry.
      this._tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
      this._tokenPromise = null;
      return this._token;
    })();

    try {
      return await this._tokenPromise;
    } catch (e) {
      this._tokenPromise = null;
      throw e;
    }
  }

  async _api(path, params = {}) {
    const token = await this._accessToken();
    const url = new URL(`https://api.spotify.com/v1/${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      // Token rejected mid-flight — drop it and retry once.
      this._token = null;
      this._tokenExpiry = 0;
      const retryToken = await this._accessToken();
      const retry = await fetch(url, { headers: { Authorization: `Bearer ${retryToken}` } });
      if (!retry.ok) throw new Error(`Spotify API ${retry.status} on ${path}`);
      return retry.json();
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || '1';
      throw new Error(`Spotify rate limit — retry after ${retryAfter}s`);
    }
    if (!res.ok) throw new Error(`Spotify API ${res.status} on ${path}`);
    return res.json();
  }

  // ---- URI + metadata construction ----

  /** Build the playable `res` URI and DIDL metadata for a Spotify object. */
  toSonos(kind, spotifyUri, { title = '', artist = '', album = '', art = '' } = {}) {
    const flags = SPOTIFY_FLAGS[kind] || SPOTIFY_FLAGS.track;
    const encoded = encodeSpotifyUri(spotifyUri);
    const query = `?sid=${this.sid}&flags=${flags}&sn=${this.sn}`;

    if (kind === 'track') {
      return {
        uri: `x-sonos-spotify:${encoded}${query}`,
        metadata: didl.buildMetadata({
          id: didl.itemId('track', flags) + encoded,
          title,
          creator: artist,
          album,
          art,
          upnpClass: didl.UPNP_CLASS.track,
          token: this.token,
        }),
      };
    }

    // Albums, playlists and artist radio are containers: the player expands them.
    const containerKind = kind === 'album' ? 'album' : 'playlist';
    return {
      uri: `x-rincon-cpcontainer:${didl.itemId(containerKind, flags)}${encoded}${query}`,
      metadata: didl.buildMetadata({
        id: didl.itemId(containerKind, flags) + encoded,
        title,
        creator: artist,
        art,
        upnpClass: kind === 'album' ? didl.UPNP_CLASS.album : didl.UPNP_CLASS.playlist,
        token: this.token,
      }),
    };
  }

  // ---- Search ----

  /**
   * @param {string} query
   * @param {Object} opts
   * @param {string[]} [opts.types]  Any of track, album, artist, playlist
   * @param {number} [opts.limit]
   * @param {number} [opts.offset]
   * @returns {Promise<{ tracks:[], albums:[], artists:[], playlists:[] }>}
   */
  async search(query, { types = ['track', 'album', 'artist', 'playlist'], limit = SEARCH_MAX_LIMIT, offset = 0 } = {}) {
    if (!this.available) throw new Error('Spotify search is not configured');
    // Spotify rejects anything above 10 for this app's quota tier with a bare
    // "Invalid limit" 400 — the documented ceiling of 50 applies only to apps with
    // extended quota. Clamping here rather than at the route keeps every caller safe.
    const safeLimit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, limit));
    const cacheKey = `s:${query}:${types.join(',')}:${safeLimit}:${offset}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.at < 120000) return cached.value;

    let json;
    try {
      json = await this._api('search', {
        q: query,
        type: types.join(','),
        limit: safeLimit,
        offset: offset || undefined,
        market: this.market,
      });
    } catch (e) {
      // Self-heal if Spotify tightens the ceiling further.
      if (/400/.test(e.message) && safeLimit > 1) {
        json = await this._api('search', {
          q: query,
          type: types.join(','),
          limit: 1,
          market: this.market,
        });
      } else {
        throw e;
      }
    }

    const value = {
      tracks: (json.tracks?.items || []).filter(Boolean).map((t) => this._track(t)),
      albums: (json.albums?.items || []).filter(Boolean).map((a) => this._album(a)),
      artists: (json.artists?.items || []).filter(Boolean).map((a) => this._artist(a)),
      playlists: (json.playlists?.items || []).filter(Boolean).map((p) => this._playlist(p)),
    };

    this._cache.set(cacheKey, { at: Date.now(), value });
    if (this._cache.size > 200) this._cache.delete(this._cache.keys().next().value);
    return value;
  }

  /**
   * Look up tracks by Spotify id.
   *
   * Used to repair queue entries: Sonos frequently serves DIDL for a queue item with
   * nothing but a res URI and album art — no dc:title, no dc:creator — most often for
   * the entry that is currently loaded. The URI still carries the track id, so the
   * metadata is recoverable rather than lost.
   *
   * Deliberately one request per id. The batch endpoint (/v1/tracks?ids=) answers 403
   * for Client-Credentials tokens, while the single-track endpoint (/v1/tracks/{id})
   * works — verified against this app's credentials. In practice only a handful of
   * rows per queue are ever missing metadata, and results are cached, so the extra
   * requests are negligible. Concurrency is capped so a large repair cannot trip
   * Spotify's rate limiter.
   */
  async tracksByIds(ids, { concurrency = 5, max = 40 } = {}) {
    const wanted = [...new Set(ids.filter(Boolean))].slice(0, max);
    if (!wanted.length) return new Map();

    const out = new Map();
    const missing = [];
    for (const id of wanted) {
      const cached = this._cache.get(`t:${id}`);
      if (cached) out.set(id, cached.value);
      else missing.push(id);
    }

    for (let i = 0; i < missing.length; i += concurrency) {
      const slice = missing.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        slice.map((id) => this._api(`tracks/${encodeURIComponent(id)}`, { market: this.market }))
      );
      results.forEach((result, idx) => {
        if (result.status !== 'fulfilled' || !result.value || !result.value.id) return;
        const track = this._track(result.value);
        this._cache.set(`t:${slice[idx]}`, { at: Date.now(), value: track });
        out.set(slice[idx], track);
      });
    }
    return out;
  }

  /** Extract the Spotify track id from a Sonos URI, if it is one. */
  static trackIdFromUri(uri) {
    const m = /x-sonos-spotify:spotify%3[aA]track%3[aA]([A-Za-z0-9]+)/.exec(String(uri || ''));
    return m ? m[1] : null;
  }

  /** An artist's top tracks — the natural drill-down from a search result. */
  async artistTopTracks(artistId) {
    const json = await this._api(`artists/${artistId}/top-tracks`, { market: this.market });
    return (json.tracks || []).map((t) => this._track(t));
  }

  async artistAlbums(artistId, limit = 30) {
    const json = await this._api(`artists/${artistId}/albums`, {
      market: this.market,
      limit,
      include_groups: 'album,single',
    });
    return (json.items || []).map((a) => this._album(a));
  }

  async albumTracks(albumId) {
    const album = await this._api(`albums/${albumId}`, { market: this.market });
    const art = album.images?.[0]?.url || '';
    return (album.tracks?.items || []).map((t) =>
      this._track({ ...t, album: { name: album.name, images: album.images } }, art)
    );
  }

  // ---- Result shaping ----

  _track(t, fallbackArt = '') {
    const artist = (t.artists || []).map((a) => a.name).join(', ');
    const art = t.album?.images?.[0]?.url || fallbackArt;
    const sonos = this.toSonos('track', t.uri, {
      title: t.name,
      artist,
      album: t.album?.name || '',
      art,
    });
    return {
      kind: 'track',
      id: t.id,
      title: t.name,
      artist,
      album: t.album?.name || null,
      art: art || null,
      durationSeconds: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
      duration: t.duration_ms ? didl.formatDuration(Math.round(t.duration_ms / 1000)) : null,
      explicit: !!t.explicit,
      service: 'Spotify',
      ...sonos,
    };
  }

  _album(a) {
    const artist = (a.artists || []).map((x) => x.name).join(', ');
    const art = a.images?.[0]?.url || '';
    return {
      kind: 'album',
      id: a.id,
      title: a.name,
      artist,
      art: art || null,
      year: a.release_date ? String(a.release_date).slice(0, 4) : null,
      trackCount: a.total_tracks || null,
      service: 'Spotify',
      ...this.toSonos('album', a.uri, { title: a.name, artist, art }),
    };
  }

  _artist(a) {
    const art = a.images?.[0]?.url || '';
    return {
      kind: 'artist',
      id: a.id,
      title: a.name,
      artist: a.name,
      art: art || null,
      genres: a.genres || [],
      service: 'Spotify',
      // An artist is not directly playable; the UI drills into top tracks instead.
      uri: null,
      metadata: '',
    };
  }

  _playlist(p) {
    const art = p.images?.[0]?.url || '';
    const owner = p.owner?.display_name || '';
    return {
      kind: 'playlist',
      id: p.id,
      title: p.name,
      artist: owner,
      art: art || null,
      trackCount: p.tracks?.total || null,
      service: 'Spotify',
      ...this.toSonos('playlist', p.uri, { title: p.name, artist: owner, art }),
    };
  }
}

/**
 * Registry of search providers. Additional services (Apple Music via MusicKit,
 * a local library index) implement the same shape and slot in here.
 */
class SearchRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (provider && provider.available) this.providers.set(provider.id, provider);
    return this;
  }

  get(id) {
    return this.providers.get(id) || null;
  }

  get primary() {
    return this.providers.values().next().value || null;
  }

  get list() {
    return [...this.providers.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  get enabled() {
    return this.providers.size > 0;
  }

  async search(query, opts = {}) {
    const provider = opts.provider ? this.get(opts.provider) : this.primary;
    if (!provider) {
      const err = new Error('No search provider configured');
      err.code = 'NO_PROVIDER';
      throw err;
    }
    const results = await provider.search(query, opts);
    return { provider: provider.id, ...results };
  }
}

module.exports = { SpotifyProvider, SearchRegistry, SPOTIFY_FLAGS, SEARCH_MAX_LIMIT, encodeSpotifyUri };
