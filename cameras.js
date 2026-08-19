// Camera hub bridge — the panel server's link to MediaMTX.
//
// Responsibilities:
//   1. Registry: which wall panels are acting as cameras, their room + online
//      state. Panels heartbeat here; viewers read the list to build the grid.
//   2. Proxy: forward WHIP (publish) and HLS (view) between the tunnel and the
//      localhost-only MediaMTX, so it all rides the one existing tunnel and
//      MediaMTX is never exposed directly.
//   3. Viewer tracking: count who's watching each stream so the iPad can stop
//      publishing (camera light off) the moment nobody's looking.
//
// Stream naming: cam-<slug>, slug derived from the room. e.g. "Kids Lounge" ->
// cam-kids-lounge.

const http = require('http');

const MTX_HLS = { host: '127.0.0.1', port: 8888 };
const MTX_WHIP = { host: '127.0.0.1', port: 8889 };
const MTX_API = { host: '127.0.0.1', port: 9997 };

// deviceId -> { deviceId, room, slug, lastSeen }
const panels = new Map();
// slug -> { count, lastViewerAt }  (active viewers per stream)
const viewers = new Map();

const ONLINE_MS = 20000; // a panel is "online" if seen within 20s

function slugify(room) {
  return String(room || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

// ---- Registry ----

function register({ deviceId, room }) {
  if (!deviceId || !room) return { ok: false, error: 'deviceId and room required' };
  const slug = slugify(room);
  panels.set(deviceId, { deviceId, room, slug, lastSeen: Date.now() });
  return { ok: true, slug };
}

function unregister(deviceId) {
  panels.delete(deviceId);
  return { ok: true };
}

function list() {
  const now = Date.now();
  const out = [];
  for (const p of panels.values()) {
    out.push({
      deviceId: p.deviceId,
      room: p.room,
      slug: p.slug,
      online: now - p.lastSeen < ONLINE_MS,
      viewers: (viewers.get(p.slug) || {}).count || 0,
    });
  }
  // Stable order by room name.
  out.sort((a, b) => a.room.localeCompare(b.room));
  return out;
}

// ---- Viewer tracking (drives on-demand publish) ----

function addViewer(slug) {
  const v = viewers.get(slug) || { count: 0, lastViewerAt: 0 };
  v.count += 1;
  v.lastViewerAt = Date.now();
  viewers.set(slug, v);
  return v.count;
}

function removeViewer(slug) {
  const v = viewers.get(slug);
  if (!v) return 0;
  v.count = Math.max(0, v.count - 1);
  v.lastViewerAt = Date.now();
  viewers.set(slug, v);
  return v.count;
}

function viewerCount(slug) {
  return (viewers.get(slug) || {}).count || 0;
}

// A panel polls this to learn whether it should be publishing (someone watching).
function shouldPublish(deviceId) {
  const p = panels.get(deviceId);
  if (p) p.lastSeen = Date.now(); // this poll doubles as a heartbeat
  if (!p) return { publish: false, slug: null };
  return { publish: viewerCount(p.slug) > 0, slug: p.slug };
}

// ---- Proxy helpers ----

// Generic byte-for-byte proxy to a localhost MediaMTX listener. Used for both
// WHIP (publish; POST SDP, DELETE to stop) and HLS (view; GET playlists+segs).
//
// `publicPrefix` (e.g. "/hls") is prepended to any redirect Location MediaMTX
// returns so the browser stays under our proxy path. MediaMTX LL-HLS issues a
// 302 to "/<stream>/index.m3u8?cookieCheck=1" and sets a session cookie; we
// pass the cookie straight through and just fix the path.
function proxy(target, req, res, rewritePath, publicPrefix) {
  const outPath = rewritePath || req.url;
  const headers = { ...req.headers };
  delete headers.host; // let node set it for the upstream
  const opts = {
    host: target.host,
    port: target.port,
    method: req.method,
    path: outPath,
    headers,
  };
  const up = http.request(opts, (upRes) => {
    // Pass through status + headers (incl. Location for WHIP resource URL,
    // Content-Type for HLS, Set-Cookie for the LL-HLS session). Force no-store
    // so the tunnel/edge never caches a live playlist or segment.
    const outHeaders = { ...upRes.headers };
    outHeaders['cache-control'] = 'no-store';
    delete outHeaders['cdn-cache-control'];
    // Rewrite a same-origin redirect so it stays under our public prefix.
    if (publicPrefix && outHeaders.location && outHeaders.location.startsWith('/')
        && !outHeaders.location.startsWith(publicPrefix + '/')) {
      outHeaders.location = publicPrefix + outHeaders.location;
    }
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'camera hub unreachable: ' + e.message }));
  });
  req.pipe(up);
}

// ---- MediaMTX API (path status) ----

function apiPaths() {
  return new Promise((resolve) => {
    const r = http.request(
      { host: MTX_API.host, port: MTX_API.port, path: '/v3/paths/list', method: 'GET' },
      (resp) => {
        let d = '';
        resp.on('data', (c) => (d += c));
        resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      },
    );
    r.on('error', () => resolve(null));
    r.end();
  });
}

module.exports = {
  slugify,
  register, unregister, list,
  addViewer, removeViewer, viewerCount, shouldPublish,
  proxy, apiPaths,
  MTX_HLS, MTX_WHIP, MTX_API,
};
