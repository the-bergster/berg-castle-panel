// sonos/api.js — HTTP routes for the Music half of the panel.
//
// Exposed as a single handler so server.js stays readable: it returns true when it
// has taken ownership of a request, false when the URL is not ours.
//
// Every write route is idempotent-ish and returns the resulting state where cheap,
// so the client can reconcile without an extra round trip.

'use strict';

const presets = require('./presets');
const { SonosError } = require('./soap');

const MAX_BODY_BYTES = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, error) {
  const status = error instanceof SonosError && error.unsupported ? 400 : 500;
  sendJson(res, status, {
    error: error.message,
    code: error instanceof SonosError ? error.code || null : null,
    unsupported: error instanceof SonosError ? error.unsupported : false,
  });
}

/** Required query/body parameter with a clear message when it is missing. */
function need(value, name) {
  if (value === undefined || value === null || value === '') {
    const err = new Error(`Missing required parameter: ${name}`);
    err.status = 400;
    throw err;
  }
  return value;
}

// ---- Album art proxy cache ---------------------------------------------------
// Art is fetched from speakers (or a service CDN) and re-served to the browser.
// Without this, a 19-zone view fires dozens of cross-origin image requests at
// embedded hardware every refresh. Entries are small and short-lived.

const ART_CACHE = new Map(); // url -> { at, contentType, body }
const ART_CACHE_MAX = 120;
const ART_TTL_MS = 10 * 60 * 1000;

async function serveArt(sys, res, rawUrl) {
  const target = sys.resolveArtUrl(rawUrl);
  if (!target) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  const hit = ART_CACHE.get(target);
  if (hit && Date.now() - hit.at < ART_TTL_MS) {
    res.writeHead(200, {
      'Content-Type': hit.contentType,
      'Content-Length': hit.body.length,
      'Cache-Control': 'private, max-age=600',
    });
    res.end(hit.body);
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const upstream = await fetch(target, { signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    ART_CACHE.set(target, { at: Date.now(), contentType, body });
    if (ART_CACHE.size > ART_CACHE_MAX) ART_CACHE.delete(ART_CACHE.keys().next().value);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=600',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Cache-Control': 'no-store' });
    res.end();
  }
}

/**
 * @param {import('./index').SonosSystem} sys
 * @returns {Promise<boolean>} true when the request was handled
 */
async function handle(sys, req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/sonos')) return false;

  const method = req.method;
  const q = url.searchParams;

  try {
    // ---- Reads ----

    if (method === 'GET' && p === '/api/sonos/state') {
      await sys.ensureReady();
      const rooms = await sys.player.snapshot();
      sendJson(res, 200, { ...sys.toJSON(), rooms, ts: Date.now() });
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/zones') {
      await sys.ensureReady();
      sendJson(res, 200, sys.toJSON());
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/now') {
      const room = need(q.get('room'), 'room');
      // Detail view: include the saved-queue size, which costs one extra browse.
      sendJson(res, 200, await sys.player.nowPlaying(room, { withQueueLength: true }));
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/queue') {
      const room = need(q.get('room'), 'room');
      const start = parseInt(q.get('start') || '0', 10);
      const count = Math.min(500, parseInt(q.get('count') || '200', 10));
      sendJson(res, 200, await sys.player.getQueue(room, { start, count }));
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/favorites') {
      sendJson(res, 200, await sys.library.favorites());
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/playlists') {
      sendJson(res, 200, await sys.library.playlists());
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/playlist-tracks') {
      const id = need(q.get('id'), 'id');
      sendJson(res, 200, await sys.library.playlistTracks(id));
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/radio') {
      const favorites = await sys.library.radioFavorites().catch(() => ({ items: [] }));
      sendJson(res, 200, { presets: presets.list(), favorites: favorites.items });
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/linein') {
      sendJson(res, 200, await sys.library.lineInSources());
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/alarms') {
      sendJson(res, 200, { alarms: await sys.library.alarms() });
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/caps') {
      const room = need(q.get('room'), 'room');
      sendJson(res, 200, await sys.capabilities(room));
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/art') {
      await serveArt(sys, res, q.get('u'));
      return true;
    }

    // ---- Search ----

    if (method === 'GET' && p === '/api/sonos/search') {
      const query = (q.get('q') || '').trim();
      if (!query) {
        sendJson(res, 200, { tracks: [], albums: [], artists: [], playlists: [], query: '' });
        return true;
      }
      if (!sys.search.enabled) {
        sendJson(res, 503, {
          error: 'No search provider configured',
          code: 'NO_PROVIDER',
          hint: 'Add Spotify client_id and client_secret to sonos-config.json',
        });
        return true;
      }
      const types = (q.get('types') || 'track,album,artist,playlist').split(',');
      const limit = Math.min(10, parseInt(q.get('limit') || '10', 10));
      const results = await sys.search.search(query, { types, limit });
      sendJson(res, 200, { ...results, query });
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/artist-tracks') {
      const id = need(q.get('id'), 'id');
      const provider = sys.search.get(q.get('provider') || 'spotify');
      if (!provider) throw new Error('Unknown search provider');
      const [tracks, albums] = await Promise.all([
        provider.artistTopTracks(id),
        provider.artistAlbums(id).catch(() => []),
      ]);
      sendJson(res, 200, { tracks, albums });
      return true;
    }

    if (method === 'GET' && p === '/api/sonos/album-tracks') {
      const id = need(q.get('id'), 'id');
      const provider = sys.search.get(q.get('provider') || 'spotify');
      if (!provider) throw new Error('Unknown search provider');
      sendJson(res, 200, { tracks: await provider.albumTracks(id) });
      return true;
    }

    // ---- Writes ----

    if (method === 'POST' && p === '/api/sonos/transport') {
      const { room, action, value } = await readBody(req);
      need(room, 'room');
      need(action, 'action');
      let result = { room, action, ok: true };
      switch (action) {
        case 'play': await sys.player.play(room); break;
        case 'pause': await sys.player.pause(room); break;
        case 'stop': await sys.player.stop(room); break;
        case 'toggle': result.state = await sys.player.toggle(room); break;
        case 'next': await sys.player.next(room); break;
        case 'previous': await sys.player.previous(room); break;
        case 'seek': await sys.player.seekTo(room, Number(value)); break;
        case 'playIndex': await sys.player.playQueueIndex(room, Number(value)); break;
        default: {
          const err = new Error(`Unknown transport action: ${action}`);
          err.status = 400;
          throw err;
        }
      }
      sendJson(res, 200, result);
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/volume') {
      const { room, volume, delta, scope = 'player' } = await readBody(req);
      need(room, 'room');
      let result;
      if (scope === 'group') {
        result = delta !== undefined
          ? await sys.player.adjustGroupVolume(room, delta)
          : await sys.player.setGroupVolume(room, volume);
      } else {
        result = delta !== undefined
          ? await sys.player.adjustVolume(room, delta)
          : await sys.player.setVolume(room, volume);
      }
      sendJson(res, 200, { room, scope, volume: result });
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/mute') {
      const { room, muted, scope = 'player' } = await readBody(req);
      need(room, 'room');
      if (scope === 'group') await sys.player.setGroupMute(room, !!muted);
      else await sys.player.setMute(room, !!muted);
      sendJson(res, 200, { room, scope, muted: !!muted });
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/group') {
      const { action, room, target, members } = await readBody(req);
      need(action, 'action');
      let result;
      switch (action) {
        case 'join': result = await sys.player.join(need(room, 'room'), need(target, 'target')); break;
        case 'leave': result = await sys.player.leave(need(room, 'room')); break;
        case 'party': result = await sys.player.party(need(room, 'room')); break;
        case 'ungroupAll': result = await sys.player.ungroupAll(); break;
        case 'set': result = await sys.player.setGroupMembers(need(room, 'room'), members || []); break;
        default: {
          const err = new Error(`Unknown group action: ${action}`);
          err.status = 400;
          throw err;
        }
      }
      sendJson(res, 200, { ...result, topology: sys.topology.toJSON() });
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/play') {
      const { room, item, mode = 'now', presetId, lineInRoom, tv } = await readBody(req);
      need(room, 'room');
      if (tv) {
        sendJson(res, 200, await sys.player.playTV(room));
        return true;
      }
      if (presetId) {
        const preset = presets.byId(presetId);
        if (!preset) throw new Error(`Unknown radio preset: ${presetId}`);
        sendJson(res, 200, await sys.player.playItem(room, preset, 'now'));
        return true;
      }
      if (lineInRoom) {
        sendJson(res, 200, await sys.player.playLineIn(room, lineInRoom));
        return true;
      }
      need(item, 'item');
      sendJson(res, 200, await sys.player.playItem(room, item, mode));
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/queue') {
      const { room, action, index, from, to, title, item, mode } = await readBody(req);
      need(room, 'room');
      need(action, 'action');
      let result = { room, action, ok: true };
      switch (action) {
        case 'clear': await sys.player.clearQueue(room); break;
        case 'remove': await sys.player.removeFromQueue(room, Number(need(index, 'index'))); break;
        case 'reorder': result = await sys.player.reorderQueue(room, Number(from), Number(to)); break;
        case 'save': result = await sys.player.saveQueue(room, need(title, 'title')); break;
        case 'add': result = await sys.player.playItem(room, need(item, 'item'), mode || 'queue'); break;
        default: {
          const err = new Error(`Unknown queue action: ${action}`);
          err.status = 400;
          throw err;
        }
      }
      sendJson(res, 200, result);
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/playmode') {
      const { room, shuffle, repeat, crossfade } = await readBody(req);
      need(room, 'room');
      const result = {};
      if (shuffle !== undefined || repeat !== undefined) {
        result.playMode = await sys.player.setPlayMode(room, { shuffle, repeat });
      }
      if (crossfade !== undefined) {
        await sys.player.setCrossfade(room, !!crossfade);
        result.crossfade = !!crossfade;
      }
      sendJson(res, 200, { room, ...result });
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/eq') {
      const { room, setting, value } = await readBody(req);
      need(room, 'room');
      need(setting, 'setting');
      sendJson(res, 200, await sys.setEQ(room, setting, value));
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/sleep') {
      const { room, minutes } = await readBody(req);
      need(room, 'room');
      sendJson(res, 200, await sys.player.setSleepTimer(room, minutes));
      return true;
    }

    if (method === 'POST' && p === '/api/sonos/refresh') {
      await sys.topology.refresh();
      await sys.topology.loadModels();
      sys.library.invalidate();
      sendJson(res, 200, sys.toJSON());
      return true;
    }

    sendJson(res, 404, { error: `No such Sonos route: ${p}` });
    return true;
  } catch (e) {
    if (e.status === 400) {
      sendJson(res, 400, { error: e.message });
      return true;
    }
    console.error(`[Sonos API] ${method} ${p} → ${e.message}`);
    fail(res, e);
    return true;
  }
}

module.exports = { handle, readBody, sendJson };
