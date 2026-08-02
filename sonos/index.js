// sonos/index.js — The Sonos subsystem facade.
//
// Owns construction and wiring of topology, player, library, search and events, and
// is the only thing server.js needs to know about.
//
// Replaces the previous flat sonos.js, which read a static IP-sweep file and sent
// every command to a room's own IP. Both assumptions were wrong once rooms were
// grouped; see topology.js and player.js for the specifics.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { Topology } = require('./topology');
const { Player } = require('./player');
const { Library } = require('./library');
const { SonosEvents } = require('./events');
const { SpotifyProvider, SearchRegistry } = require('./search');
const didl = require('./didl');
const dev = require('./device');
const { SonosError } = require('./soap');

const CONFIG_PATH = path.join(__dirname, '..', 'sonos-config.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'sonos-config.example.json');

/** Strip the documentation keys out of the example-shaped config. */
function stripComments(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '_comment') continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

function loadConfig() {
  let config = {};
  try {
    config = stripComments(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[Sonos] sonos-config.json unreadable: ${e.message}`);
    try {
      config = stripComments(JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8')));
      config.spotify = { ...config.spotify, client_id: '', client_secret: '' };
    } catch (_) {
      config = {};
    }
  }
  // Environment variables win, so the panel can run without a config file at all.
  config.spotify = config.spotify || {};
  if (process.env.SPOTIFY_CLIENT_ID) config.spotify.client_id = process.env.SPOTIFY_CLIENT_ID;
  if (process.env.SPOTIFY_CLIENT_SECRET) config.spotify.client_secret = process.env.SPOTIFY_CLIENT_SECRET;
  config.household = config.household || {};
  config.ui = config.ui || {};
  return config;
}

/** Best-guess LAN address for GENA callbacks — the interface that reaches the players. */
function detectCallbackHost() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) candidates.push(addr.address);
    }
  }
  // Prefer a private-range address; Tailscale/VPN addresses are not routable for players.
  const preferred = candidates.find((ip) => ip.startsWith('192.168.')) ||
    candidates.find((ip) => ip.startsWith('10.')) ||
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  return preferred || candidates[0] || '127.0.0.1';
}

class SonosSystem extends EventEmitter {
  constructor({ port } = {}) {
    super();
    this.config = loadConfig();
    this.ready = false;
    this.startupError = null;

    this.topology = new Topology({
      seedIps: this.config.household.seed_ips || [],
    });
    this.library = new Library(this.topology);

    this.search = new SearchRegistry();
    this.spotify = new SpotifyProvider(this.config.spotify || {});
    this.search.register(this.spotify);

    // The player borrows the search provider to repair queue entries that Sonos
    // returns without metadata.
    this.player = new Player(this.topology, this.spotify);

    this.events = new SonosEvents({
      topology: this.topology,
      player: this.player,
      callbackHost: detectCallbackHost(),
      callbackPort: port || 4321,
    });

    this._wireEvents();
  }

  _wireEvents() {
    // Re-emit upward so server.js can broadcast to browsers without knowing details.
    for (const name of ['transport', 'rendering', 'topology', 'content', 'snapshot', 'mode']) {
      this.events.on(name, (payload) => this.emit(name, payload));
    }
    this.events.on('log', (msg) => console.log(`[Sonos] ${msg}`));
    this.events.on('content', (which) => {
      if (which.favorites) this.library.invalidate('favorites');
      if (which.playlists) this.library.invalidate('playlists');
    });
    this.topology.on('change', () => this.emit('topology', this.topology));
  }

  async init() {
    try {
      await this.topology.refresh();
      await this.topology.loadModels();
      console.log(
        `[Sonos] ${this.topology.rooms.length} rooms in ${this.topology.groups.length} groups`
      );
      await this._adoptServiceAccount();
      const mode = await this.events.start();
      console.log(`[Sonos] live updates via ${mode === 'push' ? 'GENA push' : 'polling fallback'}`);
      this.ready = true;
    } catch (e) {
      this.startupError = e;
      console.error(`[Sonos] init failed: ${e.message}`);
      // A failed init must not take the panel down — the Lights half still works,
      // and a later request will retry topology.
    }
    return this;
  }

  /**
   * Learn the household's real Spotify sid/sn from content Sonos itself produced.
   * Re-linking an account changes `sn`, and a stale value fails silently at playback
   * time, so observation beats configuration here.
   */
  async _adoptServiceAccount() {
    if (!this.spotify.available) {
      console.log('[Sonos] Spotify search not configured — add credentials to sonos-config.json');
      return;
    }
    if (this.config.spotify.sonos_sn != null && this.config.spotify.sonos_sid != null) {
      // Explicit override present, but still verify against live content when possible.
    }
    try {
      const { items } = await this.library.favorites();
      const spotifyItem = items.find((i) => i.uri && i.uri.includes('x-sonos-spotify:'));
      if (spotifyItem) {
        const adopted = this.spotify.adoptFromUri(spotifyItem.uri);
        console.log(`[Sonos] Spotify linked as sid=${adopted.sid} sn=${adopted.sn}`);
        return;
      }
      // Fall back to the queue of any room.
      const room = this.topology.rooms.find((r) => r.ip);
      if (room) {
        const queue = await this.player.getQueue(room.name, { count: 5 }).catch(() => null);
        const track = queue && queue.tracks.find((t) => t.uri && t.uri.includes('x-sonos-spotify:'));
        if (track) {
          const adopted = this.spotify.adoptFromUri(track.uri);
          console.log(`[Sonos] Spotify linked as sid=${adopted.sid} sn=${adopted.sn} (from queue)`);
        }
      }
    } catch (e) {
      console.warn(`[Sonos] could not auto-detect Spotify account: ${e.message}`);
    }
  }

  /** Ensure topology is usable before serving a request that depends on it. */
  async ensureReady() {
    if (!this.topology.rooms.length) {
      await this.topology.refresh();
      await this.topology.loadModels();
    }
    return this;
  }

  // ---- Capability probing (per-model UI gating) ----

  /**
   * Which controls a given room's hardware actually supports. An Arc has night mode
   * and speech enhancement; a Play:3 has neither and answers UPnP 402. An Amp wired
   * for fixed output must not show a volume slider at all.
   */
  async capabilities(room) {
    const player = this.topology.playerFor(room);
    if (!player) return null;
    const cacheKey = `caps:${player.uuid}`;
    if (this._capsCache && this._capsCache.has(cacheKey)) return this._capsCache.get(cacheKey);
    if (!this._capsCache) this._capsCache = new Map();

    const [bass, treble, loudness, outputFixed, supportsFixed, night, speech, subGain, surround] =
      await Promise.all([
        dev.rendering.getBass(player.ip).catch(() => null),
        dev.rendering.getTreble(player.ip).catch(() => null),
        dev.rendering.getLoudness(player.ip).catch(() => null),
        dev.rendering.getOutputFixed(player.ip).catch(() => null),
        dev.rendering.getSupportsOutputFixed(player.ip).catch(() => null),
        dev.rendering.getEQ(player.ip, 'NightMode').catch(() => null),
        dev.rendering.getEQ(player.ip, 'DialogLevel').catch(() => null),
        dev.rendering.getEQ(player.ip, 'SubGain').catch(() => null),
        dev.rendering.getEQ(player.ip, 'SurroundLevel').catch(() => null),
      ]);

    const roomRecord = this.topology.roomByName(room);
    const bonding = roomRecord ? roomRecord.bonding : { sub: false, surrounds: 0 };
    const model = roomRecord ? roomRecord.model || '' : '';

    // A device answering GetEQ is necessary but not sufficient. Every Amp reports a
    // SubGain of 0 whether or not a sub exists, and reports NightMode whether or not
    // it is wired to a TV. Showing those controls anyway is how an app starts feeling
    // fake, so the physical facts from ZoneGroupState get the final say.
    const isHomeTheatre = /Arc|Beam|Ray|Playbar|Playbase/i.test(model) || bonding.surrounds > 0 || bonding.sub;

    const caps = {
      room,
      model: roomRecord ? roomRecord.model : null,
      bass: bass !== null,
      treble: treble !== null,
      loudness: loudness !== null,
      nightMode: night !== null && isHomeTheatre,
      speechEnhance: speech !== null && isHomeTheatre,
      subGain: subGain !== null && bonding.sub,
      surroundLevel: surround !== null && bonding.surrounds > 0,
      hasSub: bonding.sub,
      surrounds: bonding.surrounds,
      stereoPair: bonding.stereoPair,
      outputFixed: outputFixed === true,
      supportsOutputFixed: supportsFixed === true,
      volumeControllable: outputFixed !== true,
      values: { bass, treble, loudness, nightMode: night, speechEnhance: speech, subGain, surroundLevel: surround },
    };
    this._capsCache.set(cacheKey, caps);
    return caps;
  }

  /** Apply an EQ / tone change, routed to the individual player. */
  async setEQ(room, setting, value) {
    const player = this.topology.playerFor(room);
    if (!player) throw new SonosError(`Unknown room: ${room}`, { action: 'setEQ' });
    switch (setting) {
      case 'bass':
        await dev.rendering.setBass(player.ip, value);
        break;
      case 'treble':
        await dev.rendering.setTreble(player.ip, value);
        break;
      case 'loudness':
        await dev.rendering.setLoudness(player.ip, !!value);
        break;
      case 'nightMode':
        await dev.rendering.setEQ(player.ip, 'NightMode', value ? 1 : 0);
        break;
      case 'speechEnhance':
        await dev.rendering.setEQ(player.ip, 'DialogLevel', value ? 1 : 0);
        break;
      case 'subGain':
        await dev.rendering.setEQ(player.ip, 'SubGain', value);
        break;
      case 'surroundLevel':
        await dev.rendering.setEQ(player.ip, 'SurroundLevel', value);
        break;
      default:
        throw new SonosError(`Unknown EQ setting: ${setting}`, { action: 'setEQ' });
    }
    if (this._capsCache) this._capsCache.delete(`caps:${player.uuid}`);
    return { room, setting, value };
  }

  /**
   * Album art proxy target, validated so the endpoint cannot be turned into an SSRF
   * pivot into the LAN. Two legitimate shapes reach us:
   *   - an absolute service CDN URL (Apple Music, Spotify), allowed by host suffix
   *   - a speaker-hosted /getaa path, which parseDidl has usually already made
   *     absolute against the speaker that served it
   * Anything else — including other LAN hosts and link-local metadata addresses —
   * is refused.
   */
  resolveArtUrl(rawUrl) {
    if (!rawUrl) return null;
    const knownIps = new Set(
      [...this.topology.devices.values()].map((d) => d.ip).filter(Boolean)
    );

    if (/^https?:\/\//i.test(rawUrl)) {
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (_) {
        return null;
      }
      // A speaker serving its own art cache.
      if (knownIps.has(parsed.hostname) && parsed.port === '1400') return rawUrl;
      // A music service CDN.
      const allowedHost = /\.(mzstatic|scdn|sonos|sonosradio|pandora|siriusxm|tidal|deezer|napster|soundcloud|audible|qobuz)\.(com|co|net|io)$/i;
      if (parsed.protocol === 'https:' && allowedHost.test(parsed.hostname)) return rawUrl;
      return null;
    }

    // A relative /getaa path — bind it to any speaker we know.
    const ip = this.topology.rooms.find((r) => r.ip);
    return ip ? didl.resolveArt(rawUrl, ip.ip) : null;
  }

  toJSON() {
    return {
      ready: this.ready,
      mode: this.events.mode,
      searchProviders: this.search.list,
      searchEnabled: this.search.enabled,
      topology: this.topology.toJSON(),
      favoriteRooms: this.config.ui.favorite_rooms || [],
      error: this.startupError ? this.startupError.message : null,
    };
  }
}

module.exports = { SonosSystem, loadConfig, detectCallbackHost };
