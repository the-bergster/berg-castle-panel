// sonos/library.js — Everything the household itself can enumerate.
//
// On S2 this is a short list, and knowing exactly how short is what keeps the UI
// honest: Sonos Favourites (FV:2), Sonos Playlists a.k.a. saved queues (SQ:), the
// local music library (A:*, empty here — no NAS share is indexed), and radio
// favourites (R:0/0). Anything beyond that comes from a search provider.
//
// Results are cached and invalidated by ContentDirectory events, so opening the
// browse screen is instant rather than a fresh round trip to a speaker.

'use strict';

const dev = require('./device');
const didl = require('./didl');

const CACHE_TTL_MS = 300000; // favourites change rarely; events invalidate early anyway

/**
 * Human label for a favourite ("Album", "Playlist", "Station", "Track").
 * A favourite always reports upnp:class "sonos-favorite", so the useful class is the
 * one on the item nested in its r:resMD.
 */
function describeFavorite(fav, inner) {
  const cls = (inner && inner.upnpClass) || '';
  if (cls.includes('album')) return 'Album';
  if (cls.includes('playlistContainer')) return 'Playlist';
  if (cls.includes('audioBroadcast')) return 'Station';
  if (cls.includes('musicTrack')) return 'Track';
  if (cls.includes('person') || cls.includes('musicArtist')) return 'Artist';
  // Fall back to what the URI scheme implies.
  if (fav.kind === 'radio') return 'Station';
  if (fav.kind === 'container') return 'Playlist';
  if (fav.kind === 'sonos-playlist') return 'Sonos playlist';
  return 'Track';
}

class Library {
  /** @param {import('./topology').Topology} topology */
  constructor(topology) {
    this.topology = topology;
    this._cache = new Map(); // key -> { at, value }
  }

  /** Any reachable speaker can answer content queries for the whole household. */
  _anyIp() {
    const room = this.topology.rooms.find((r) => r.ip);
    if (!room) throw new Error('No Sonos speaker available');
    return room.ip;
  }

  _cached(key, ttl = CACHE_TTL_MS) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    return null;
  }

  _store(key, value) {
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Called when a ContentDirectory event reports a container changed. */
  invalidate(which) {
    if (!which) this._cache.clear();
    else this._cache.delete(which);
  }

  /**
   * Sonos Favourites. Each carries the real playable payload in r:resMD.
   * "Shortcut" favourites (empty res) are browse entry points rather than something
   * we can hand straight to SetAVTransportURI, so they are marked unplayable.
   */
  async favorites({ force = false } = {}) {
    if (!force) {
      const hit = this._cached('favorites');
      if (hit) return hit;
    }
    const ip = this._anyIp();
    const page = await dev.content.browse(ip, 'FV:2', { count: 200 });
    const items = didl.parseDidl(page.raw, ip).map((fav) => {
      const payload = didl.favouritePayload(fav);
      // The favourite's own art is often absent; the embedded resMD usually has it.
      const inner = fav.resMD ? didl.parseDidlOne(fav.resMD, ip) : null;
      return {
        id: fav.id,
        title: fav.title,
        description: fav.description || null,
        art: fav.art || (inner ? inner.art : null),
        uri: payload.uri,
        metadata: payload.metadata,
        playAs: payload.playAs,
        playable: payload.playable,
        kind: fav.kind,
        // The favourite's own upnp:class is always "sonos-favorite"; the real type
        // lives on the item inside r:resMD. Without this an album favourite is
        // indistinguishable from a playlist favourite in the UI.
        label: describeFavorite(fav, inner),
        service: fav.service || (inner ? inner.service : null),
        type: fav.type,
      };
    });
    return this._store('favorites', { items, total: page.totalMatches });
  }

  /**
   * Sonos Playlists — saved queues stored on the players themselves
   * (file:///jffs/settings/savedqueues.rsq#N).
   */
  async playlists({ force = false } = {}) {
    if (!force) {
      const hit = this._cached('playlists');
      if (hit) return hit;
    }
    const ip = this._anyIp();
    const page = await dev.content.browse(ip, 'SQ:', { count: 200 });
    const items = didl.parseDidl(page.raw, ip).map((p) => ({
      id: p.id,
      title: p.title,
      art: p.art,
      uri: p.uri,
      metadata: '',
      playAs: 'container',
      playable: true,
      kind: 'sonos-playlist',
      label: 'Sonos playlist',
      service: 'Sonos',
    }));
    return this._store('playlists', { items, total: page.totalMatches });
  }

  /** Tracks inside a saved queue, for the playlist detail screen. */
  async playlistTracks(playlistId) {
    const ip = this._anyIp();
    const page = await dev.content.browse(ip, playlistId, { count: 500 });
    return { tracks: didl.parseDidl(page.raw, ip), total: page.totalMatches };
  }

  /** Radio favourites. Empty in this household, but present on many systems. */
  async radioFavorites() {
    const hit = this._cached('radio');
    if (hit) return hit;
    const ip = this._anyIp();
    const page = await dev.content.browse(ip, 'R:0/0', { count: 200 });
    const items = didl.parseDidl(page.raw, ip).map((r) => ({
      id: r.id,
      title: r.title,
      art: r.art,
      uri: r.uri,
      metadata: r.resMD || '',
      playAs: 'stream',
      playable: !!r.uri,
      kind: 'radio',
      service: r.service,
    }));
    return this._store('radio', { items, total: page.totalMatches });
  }

  /**
   * Local music library. Reports availability so the UI can hide the section
   * entirely rather than showing empty shelves — this household has no share.
   */
  async localLibrary() {
    const hit = this._cached('local');
    if (hit) return hit;
    const ip = this._anyIp();
    const [albums, artists, tracks] = await Promise.all([
      dev.content.browse(ip, 'A:ALBUM', { count: 1 }).catch(() => ({ totalMatches: 0 })),
      dev.content.browse(ip, 'A:ALBUMARTIST', { count: 1 }).catch(() => ({ totalMatches: 0 })),
      dev.content.browse(ip, 'A:TRACKS', { count: 1 }).catch(() => ({ totalMatches: 0 })),
    ]);
    return this._store('local', {
      available: (albums.totalMatches || 0) + (tracks.totalMatches || 0) > 0,
      albums: albums.totalMatches || 0,
      artists: artists.totalMatches || 0,
      tracks: tracks.totalMatches || 0,
    });
  }

  /** Browse any container by object id — powers drill-down into library nodes. */
  async browse(objectId, { start = 0, count = 100 } = {}) {
    const ip = this._anyIp();
    const page = await dev.content.browse(ip, objectId, { start, count });
    return {
      items: didl.parseDidl(page.raw, ip),
      total: page.totalMatches,
      returned: page.numberReturned,
      start,
    };
  }

  /**
   * Rooms whose hardware exposes a line-in, so the UI can offer "play the turntable
   * in here". Detection is by probing AudioIn — devices without the service refuse it.
   */
  async lineInSources() {
    const hit = this._cached('linein');
    if (hit) return hit;
    const candidates = this.topology.rooms.filter((r) => r.ip);
    const results = await Promise.all(
      candidates.map(async (room) => {
        const attrs = await dev.audioIn.getAudioInputAttributes(room.ip).catch(() => null);
        if (!attrs) return null;
        return {
          room: room.name,
          uuid: room.uuid,
          name: attrs.name || `${room.name} Line-In`,
          icon: attrs.icon || null,
          uri: `x-rincon-stream:${room.uuid}`,
        };
      })
    );
    return this._store('linein', { items: results.filter(Boolean) });
  }

  /** Household alarms, read from any speaker (the list is household-wide). */
  async alarms() {
    const ip = this._anyIp();
    const { alarms } = await dev.alarms.list(ip);
    return alarms.map((a) => {
      const room = this.topology.roomByUuid(a.roomUuid);
      return { ...a, room: room ? room.name : a.roomUuid };
    });
  }
}

module.exports = { Library };
