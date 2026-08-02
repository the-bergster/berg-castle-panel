// sonos/events.js — Real-time state via UPnP GENA, with an automatic polling fallback.
//
// The official Sonos app feels instant because it never polls: the players push state
// changes to it. We do the same. Our HTTP server exposes a NOTIFY endpoint, we
// SUBSCRIBE each player's services to it, and the players POST us their LastChange
// documents whenever anything moves.
//
// This only works if the speakers can reach US. They sit on a different VLAN here
// (players on 192.168.4.x, server on 192.168.2.x), so reachability is verified at
// startup rather than assumed: we subscribe, wait for the initial NOTIFY that Sonos
// always sends immediately, and if it does not arrive we transparently fall back to
// adaptive polling. Either way the rest of the app consumes the same events.
//
// Subscription budget for this 19-room household:
//   AVTransport + RenderingControl per room      = 38
//   ZoneGroupTopology + ContentDirectory on one  =  2
//   -------------------------------------------------
//   40 subscriptions, renewed well inside their timeout.
// Group state is household-wide, so subscribing to it on every player would be 19x
// the traffic for identical information.

'use strict';

const { EventEmitter } = require('events');
const http = require('http');
const X = require('./xml');
const dev = require('./device');

const SUBSCRIBE_TIMEOUT_SECONDS = 600;
const RENEW_MARGIN_MS = 60000; // renew a minute before expiry
const HANDSHAKE_TIMEOUT_MS = 6000; // how long to wait for the proof-of-life NOTIFY
const POLL_ACTIVE_MS = 2000; // something is playing
const POLL_IDLE_MS = 8000; // household is quiet

/** Per-room services. Topology/content are household-wide and subscribed once. */
const ROOM_SERVICES = ['AVTransport', 'RenderingControl'];
const HOUSEHOLD_SERVICES = ['ZoneGroupTopology', 'ContentDirectory'];

/**
 * Parse a LastChange document. Sonos encodes state as attributes named `val`,
 * one element per changed variable, scoped by InstanceID, and RenderingControl
 * additionally scopes by `channel`.
 */
function parseLastChange(raw) {
  if (!raw) return {};
  const doc = X.parseXml(raw);
  const instance = X.find(doc, 'InstanceID');
  if (!instance) return {};
  const out = {};
  for (const node of instance.children) {
    const channel = X.attr(node, 'channel');
    const value = X.attr(node, 'val');
    if (value === null) continue;
    // Master is the only channel a UI cares about; LF/RF exist on bonded pairs.
    if (channel && channel !== 'Master') continue;
    out[node.name] = value;
  }
  return out;
}

class SonosEvents extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {import('./topology').Topology} opts.topology
   * @param {import('./player').Player} opts.player
   * @param {string} opts.callbackHost  IP the speakers should call back on
   * @param {number} opts.callbackPort
   * @param {string} [opts.notifyPath]
   */
  constructor({ topology, player, callbackHost, callbackPort, notifyPath = '/sonos/notify' }) {
    super();
    this.topology = topology;
    this.player = player;
    this.callbackHost = callbackHost;
    this.callbackPort = callbackPort;
    this.notifyPath = notifyPath;

    this.mode = 'starting'; // 'push' | 'poll'
    this.subscriptions = new Map(); // sid -> { ip, service, expiresAt }
    this._renewTimer = null;
    this._pollTimer = null;
    this._stopped = false;
    this._sawNotify = false;
    this._notifyWaiters = [];
    this._lastSnapshot = new Map(); // room -> serialised state, for poll diffing
  }

  get callbackUrl() {
    return `http://${this.callbackHost}:${this.callbackPort}${this.notifyPath}`;
  }

  // ---- Lifecycle ----

  async start() {
    this._stopped = false;
    const pushWorks = await this._trySubscribe();
    if (pushWorks) {
      this.mode = 'push';
      this._scheduleRenewals();
      // A slow heartbeat still runs under push: it catches anything GENA misses
      // (position ticks, a speaker that rebooted and dropped its subscription).
      this._startPolling(POLL_IDLE_MS * 2);
      this.emit('mode', 'push');
    } else {
      this.mode = 'poll';
      this._startPolling();
      this.emit('mode', 'poll');
    }
    return this.mode;
  }

  async stop() {
    this._stopped = true;
    clearTimeout(this._renewTimer);
    clearTimeout(this._pollTimer);
    await this._unsubscribeAll();
  }

  /**
   * Subscribe one player+service to our callback, then wait for the initial NOTIFY
   * that proves the speaker can actually reach us.
   */
  async _trySubscribe() {
    const probeRoom = this.topology.rooms.find((r) => r.ip);
    if (!probeRoom) return false;

    const sid = await this._subscribe(probeRoom.ip, 'AVTransport').catch(() => null);
    if (!sid) return false;

    const heard = await this._waitForNotify(HANDSHAKE_TIMEOUT_MS);
    if (!heard) {
      await this._unsubscribe(probeRoom.ip, 'AVTransport', sid).catch(() => {});
      return false;
    }

    // Reachability proven — subscribe the rest of the household in parallel.
    const jobs = [];
    for (const room of this.topology.rooms) {
      for (const service of ROOM_SERVICES) {
        if (room.ip === probeRoom.ip && service === 'AVTransport') continue;
        jobs.push(this._subscribe(room.ip, service).catch(() => null));
      }
    }
    for (const service of HOUSEHOLD_SERVICES) {
      jobs.push(this._subscribe(probeRoom.ip, service).catch(() => null));
    }
    const results = await Promise.all(jobs);
    const ok = results.filter(Boolean).length;
    this.emit('log', `GENA: ${ok + 1}/${jobs.length + 1} subscriptions established`);
    return true;
  }

  _waitForNotify(timeoutMs) {
    if (this._sawNotify) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._notifyWaiters = this._notifyWaiters.filter((w) => w !== resolve);
        resolve(false);
      }, timeoutMs);
      this._notifyWaiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  _subscribe(ip, serviceName) {
    const service = require('./soap').SERVICES[serviceName];
    if (!service) return Promise.reject(new Error(`Unknown service ${serviceName}`));

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: ip,
          port: 1400,
          path: service.event,
          method: 'SUBSCRIBE',
          headers: {
            CALLBACK: `<${this.callbackUrl}>`,
            NT: 'upnp:event',
            TIMEOUT: `Second-${SUBSCRIBE_TIMEOUT_SECONDS}`,
          },
          timeout: 5000,
        },
        (res) => {
          res.resume();
          if (res.statusCode !== 200) {
            reject(new Error(`SUBSCRIBE ${serviceName}@${ip} → ${res.statusCode}`));
            return;
          }
          const sid = res.headers.sid;
          const timeout = /Second-(\d+)/.exec(res.headers.timeout || '');
          const seconds = timeout ? parseInt(timeout[1], 10) : SUBSCRIBE_TIMEOUT_SECONDS;
          this.subscriptions.set(sid, {
            ip,
            service: serviceName,
            eventPath: service.event,
            expiresAt: Date.now() + seconds * 1000,
          });
          resolve(sid);
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`SUBSCRIBE ${serviceName}@${ip} timed out`));
      });
      req.end();
    });
  }

  _renew(sid) {
    const sub = this.subscriptions.get(sid);
    if (!sub) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: sub.ip,
          port: 1400,
          path: sub.eventPath,
          method: 'SUBSCRIBE',
          headers: { SID: sid, TIMEOUT: `Second-${SUBSCRIBE_TIMEOUT_SECONDS}` },
          timeout: 5000,
        },
        (res) => {
          res.resume();
          if (res.statusCode !== 200) {
            // A speaker that rebooted forgets its subscriptions; re-establish.
            this.subscriptions.delete(sid);
            this._subscribe(sub.ip, sub.service).then(resolve).catch(reject);
            return;
          }
          const timeout = /Second-(\d+)/.exec(res.headers.timeout || '');
          const seconds = timeout ? parseInt(timeout[1], 10) : SUBSCRIBE_TIMEOUT_SECONDS;
          sub.expiresAt = Date.now() + seconds * 1000;
          resolve(sid);
        }
      );
      req.on('error', () => {
        this.subscriptions.delete(sid);
        this._subscribe(sub.ip, sub.service).then(resolve).catch(reject);
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('renew timeout'));
      });
      req.end();
    });
  }

  _unsubscribe(ip, serviceName, sid) {
    const service = require('./soap').SERVICES[serviceName];
    return new Promise((resolve) => {
      const req = http.request(
        { host: ip, port: 1400, path: service.event, method: 'UNSUBSCRIBE', headers: { SID: sid }, timeout: 3000 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on('error', resolve);
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.end();
    });
  }

  async _unsubscribeAll() {
    const entries = [...this.subscriptions.entries()];
    this.subscriptions.clear();
    await Promise.all(entries.map(([sid, sub]) => this._unsubscribe(sub.ip, sub.service, sid)));
  }

  _scheduleRenewals() {
    clearTimeout(this._renewTimer);
    if (this._stopped) return;
    this._renewTimer = setTimeout(async () => {
      const due = [...this.subscriptions.entries()].filter(
        ([, sub]) => sub.expiresAt - Date.now() < RENEW_MARGIN_MS
      );
      await Promise.allSettled(due.map(([sid]) => this._renew(sid)));
      this._scheduleRenewals();
    }, 30000);
  }

  // ---- Inbound NOTIFY ----

  /**
   * Handle a NOTIFY request. Mounted by server.js on the main HTTP listener so the
   * speakers only ever need to reach one port.
   */
  handleNotify(req, res) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(); // defensive cap
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Length': '0' });
      res.end();

      if (!this._sawNotify) {
        this._sawNotify = true;
        const waiters = this._notifyWaiters;
        this._notifyWaiters = [];
        for (const w of waiters) w(true);
      }

      try {
        this._dispatch(req.headers.sid, body);
      } catch (e) {
        this.emit('log', `NOTIFY parse error: ${e.message}`);
      }
    });
    req.on('error', () => {});
  }

  _dispatch(sid, body) {
    const sub = this.subscriptions.get(sid);
    const doc = X.parseXml(body);

    // ZoneGroupTopology pushes its state directly rather than via LastChange.
    const zoneGroupState = X.text(doc, 'ZoneGroupState');
    if (zoneGroupState) {
      this.topology._apply(zoneGroupState);
      this.emit('topology', this.topology);
      return;
    }

    // ContentDirectory announces which containers changed.
    const favoritesUpdate = X.text(doc, 'FavoritesUpdateID');
    const savedQueuesUpdate = X.text(doc, 'SavedQueuesUpdateID');
    const containerUpdate = X.text(doc, 'ContainerUpdateIDs');
    if (favoritesUpdate || savedQueuesUpdate || containerUpdate) {
      this.emit('content', {
        favorites: !!favoritesUpdate,
        playlists: !!savedQueuesUpdate,
        containers: containerUpdate || null,
      });
      return;
    }

    const lastChange = X.text(doc, 'LastChange');
    if (!lastChange || !sub) return;

    const values = parseLastChange(lastChange);
    const room = this.topology.rooms.find((r) => r.ip === sub.ip);
    const roomName = room ? room.name : null;

    if (sub.service === 'AVTransport') {
      this.emit('transport', {
        room: roomName,
        ip: sub.ip,
        state: values.TransportState || null,
        playMode: values.CurrentPlayMode || null,
        crossfade: values.CurrentCrossfadeMode || null,
        trackUri: values.CurrentTrackURI || null,
        trackMetadata: values.CurrentTrackMetaData || null,
        enclosingMetadata: values.EnqueuedTransportURIMetaData || null,
        numberOfTracks: values.NumberOfTracks ? parseInt(values.NumberOfTracks, 10) : null,
        track: values.CurrentTrack ? parseInt(values.CurrentTrack, 10) : null,
        duration: values.CurrentTrackDuration || null,
        avTransportUri: values.AVTransportURI || null,
        raw: values,
      });
      return;
    }

    if (sub.service === 'RenderingControl') {
      this.emit('rendering', {
        room: roomName,
        ip: sub.ip,
        volume: values.Volume != null ? parseInt(values.Volume, 10) : null,
        muted: values.Mute != null ? values.Mute === '1' : null,
        bass: values.Bass != null ? parseInt(values.Bass, 10) : null,
        treble: values.Treble != null ? parseInt(values.Treble, 10) : null,
        loudness: values.Loudness != null ? values.Loudness === '1' : null,
        raw: values,
      });
    }
  }

  // ---- Polling fallback ----

  /**
   * Adaptive polling. Used as the whole transport when GENA cannot reach us, and as
   * a slow safety net when it can. Emits the same 'snapshot' event either way, so
   * consumers never branch on the mode.
   */
  _startPolling(intervalOverride = null) {
    clearTimeout(this._pollTimer);
    const tick = async () => {
      if (this._stopped) return;
      let anyPlaying = false;
      try {
        const snapshot = await this.player.snapshot();
        anyPlaying = snapshot.some((s) => s.state === 'PLAYING' || s.state === 'TRANSITIONING');
        const changed = [];
        for (const state of snapshot) {
          const key = `${state.state}|${state.volume}|${state.muted}|${state.track?.title || ''}|${state.groupId}|${state.positionSeconds || 0}`;
          if (this._lastSnapshot.get(state.room) !== key) {
            this._lastSnapshot.set(state.room, key);
            changed.push(state);
          }
        }
        this.emit('snapshot', { rooms: snapshot, changed });
      } catch (e) {
        this.emit('log', `poll error: ${e.message}`);
      }
      const delay = intervalOverride ?? (anyPlaying ? POLL_ACTIVE_MS : POLL_IDLE_MS);
      this._pollTimer = setTimeout(tick, delay);
    };
    this._pollTimer = setTimeout(tick, 200);
  }
}

module.exports = { SonosEvents, parseLastChange };
