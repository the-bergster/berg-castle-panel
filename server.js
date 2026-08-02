// Berg Castle Control Panel v0.5 — Home + Room detail, WebSocket live sync.

// Crash forensics + resilience: log then keep running. Silent exits on unhandled
// rejection were the root cause of the 2026-07-31 overnight outage.
process.on('uncaughtException', (err) => {
  console.error('[FATAL uncaughtException]', new Date().toISOString(), err && err.stack || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL unhandledRejection]', new Date().toISOString(), reason && reason.stack || reason);
});
process.on('SIGTERM', () => { console.log('[signal] SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT', () => { console.log('[signal] SIGINT received, exiting'); process.exit(0); });

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LutronClient } = require('./lutron');
const { loadRooms } = require('./rooms');
const { loadScenes } = require('./scenes');
const { listSynthetic, findSynthetic } = require('./synthetic-scenes');
const sonos = require('./sonos');

const PORT = 4321;
const ROOMS_DATA = loadRooms();
const SCENES_DATA = loadScenes(
  path.join(__dirname, 'picos.json'),
  path.join(__dirname, 'rooms.json'),
);
const SYNTHETIC = listSynthetic();

const lutron = new LutronClient();
lutron.setKnownOutputIds(ROOMS_DATA.all_output_ids);

lutron.on('connect', () => console.log(`[Lutron] connected to ${lutron.ip}, monitoring enabled`));
lutron.on('disconnect', (e) => console.log(`[Lutron] disconnected: ${e ? e.message : ''}`));
lutron.on('change', ({ id, level, prev }) => {
  console.log(`[Lutron] #${id}: ${prev ?? '?'} → ${level}`);
  broadcast({ type: 'state', id, level });
});
lutron.connect().catch((e) => console.error('[Lutron] initial connect error:', e.message));

// ---- WebSocket ----
const clients = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function wsFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), data]);
  if (len < 65536) {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x81; hdr[1] = 126; hdr.writeUInt16BE(len, 2);
    return Buffer.concat([hdr, data]);
  }
  const hdr = Buffer.alloc(10);
  hdr[0] = 0x81; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([hdr, data]);
}

function broadcast(msg) {
  const frame = wsFrame(JSON.stringify(msg));
  for (const c of clients) {
    try { c.write(frame); } catch (_) { clients.delete(c); }
  }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  clients.add(socket);
  console.log(`[WS] +client (${clients.size})`);
  socket.write(wsFrame(JSON.stringify({ type: 'snapshot', state: lutron.getState() })));
  socket.on('data', () => {});
  socket.on('close', () => { clients.delete(socket); console.log(`[WS] -client (${clients.size})`); });
  socket.on('error', () => { clients.delete(socket); });
}

// ---- HTTP ----
const STATIC_ROOT = path.join(__dirname, 'public');

function serveStatic(res, urlPath) {
  const filePath = path.join(STATIC_ROOT, urlPath);
  if (!filePath.startsWith(STATIC_ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webmanifest': 'application/manifest+json',
    };
    // Aggressive no-cache: Cloudflare edge + browsers must always hit origin.
    // Panel is a live control surface — stale code = broken UX.
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'CDN-Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// Cache-bust suffix for the index shell so stale Cloudflare edge caches
// can't reference stale asset filenames. Bumps every process start.
const BUILD_VERSION = String(Date.now());

function serveIndexHtml(res) {
  const p = path.join(STATIC_ROOT, 'index.html');
  fs.readFile(p, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); res.end('index read fail'); return; }
    // Inject ?v=<build> onto /app.js and /app.css references.
    const bumped = html
      .replace(/href="\/app\.css"/g, `href="/app.css?v=${BUILD_VERSION}"`)
      .replace(/src="\/app\.js"/g, `src="/app.js?v=${BUILD_VERSION}"`);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'CDN-Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store',
      'X-Build-Version': BUILD_VERSION,
    });
    res.end(bumped);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Routes
  if (req.method === 'GET' && (pathname === '/' || pathname === '/room' || pathname.startsWith('/room/'))) {
    serveIndexHtml(res); return;
  }
  if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
    serveStatic(res, 'manifest.webmanifest'); return;
  }
  if (req.method === 'GET' && pathname.startsWith('/assets/')) {
    serveStatic(res, pathname.replace(/^\/assets\//, 'assets/')); return;
  }
  if (req.method === 'GET' && pathname === '/app.js') {
    serveStatic(res, 'app.js'); return;
  }
  if (req.method === 'GET' && pathname === '/app.css') {
    serveStatic(res, 'app.css'); return;
  }
  if (req.method === 'GET' && pathname === '/favicon.svg') {
    serveStatic(res, 'favicon.svg'); return;
  }

  // API
  if (req.method === 'GET' && pathname === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total_rooms: ROOMS_DATA.total_rooms,
      total_outputs: ROOMS_DATA.total_outputs,
      zones: ROOMS_DATA.zones,
      rooms: ROOMS_DATA.rooms,
    }));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/scenes') {
    // Merge synthetic "home" scenes into home_scenes list
    const syntheticHome = SYNTHETIC.filter(s => s.home).map(s => ({
      synthetic_id: s.id,
      label: s.label,
      emoji: s.emoji,
      affected_count: s.affected_count,
      area: s.area,
      pico_name: s.pico_name,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      home_scenes: [...SCENES_DATA.home_scenes, ...syntheticHome],
      master_off: SCENES_DATA.master_off,
      by_room: SCENES_DATA.by_room,
      total: SCENES_DATA.total_scenes + SYNTHETIC.length,
    }));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/synthetic-scene') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { id } = JSON.parse(body);
        const scene = findSynthetic(id);
        if (!scene) { res.writeHead(404); res.end('{"error":"unknown scene"}'); return; }
        console.log(`[Scene:synth] ${scene.id} — ${scene.outputs.length} outputs`);
        await lutron.setMany(scene.outputs.map(o => ({ id: o.id, level: o.level, fade: scene.fade || 1 })));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, count: scene.outputs.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/scene') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { pico_id, button } = JSON.parse(body);
        if (typeof pico_id !== 'number' || typeof button !== 'number') {
          res.writeHead(400); res.end('{"error":"pico_id + button required"}'); return;
        }
        console.log(`[Scene] pico #${pico_id} btn ${button}`);
        await lutron.pressPicoButton(pico_id, button);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pico_id, button }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lutron.getState()));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/set') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { id, level, fade } = JSON.parse(body);
        await lutron.setOutput(id, level, fade ?? 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, level }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/room-set') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { room_id, level, fade } = JSON.parse(body);
        const room = ROOMS_DATA.rooms.find(r => r.id === room_id);
        if (!room) { res.writeHead(404); res.end('{"error":"unknown room"}'); return; }
        await lutron.setMany(room.outputs.map(o => ({ id: o.id, level, fade: fade ?? 1 })));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ room_id, level, count: room.outputs.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/all-off') {
    lutron.setMany(ROOMS_DATA.all_output_ids.map(id => ({ id, level: 0, fade: 2 })));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: ROOMS_DATA.all_output_ids.length }));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/zone-set') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { zone, level, fade } = JSON.parse(body);
        const zoneRooms = ROOMS_DATA.zones.find(z => z.name === zone);
        if (!zoneRooms) { res.writeHead(404); res.end('{"error":"unknown zone"}'); return; }
        const cmds = [];
        for (const r of zoneRooms.rooms) for (const o of r.outputs) cmds.push({ id: o.id, level, fade: fade ?? 2 });
        await lutron.setMany(cmds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ zone, level, count: cmds.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ---- Sonos ----
  if (req.method === 'GET' && pathname === '/api/sonos/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      rooms: sonos.CACHE.rooms.map((r) => ({
        room: r.room,
        ip: r.coordinators?.[0]?.ip || null,
        uuid: r.coordinators?.[0]?.uuid || null,
        model: r.coordinators?.[0]?.model || null,
        has_sub: (r.subs || []).length > 0,
      })).filter((r) => r.ip),
      quick_streams: sonos.QUICK_STREAMS,
    }));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/sonos/snapshot') {
    try {
      const snap = await sonos.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rooms: snap, ts: Date.now() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'POST' && pathname === '/api/sonos/command') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { room, action, value, uri } = JSON.parse(body);
        const coord = sonos.coordinatorFor(room);
        if (!coord) { res.writeHead(404); res.end('{"error":"unknown room"}'); return; }
        const ip = coord.ip;
        let result = { room, action, ok: true };
        switch (action) {
          case 'play': await sonos.play(ip); break;
          case 'pause': await sonos.pause(ip); break;
          case 'stop': await sonos.stop(ip); break;
          case 'next': await sonos.next(ip); break;
          case 'previous': await sonos.previous(ip); break;
          case 'volume': result.volume = await sonos.setVolume(ip, value); break;
          case 'mute': await sonos.setMute(ip, !!value); result.muted = !!value; break;
          case 'play_stream':
            if (!uri) { res.writeHead(400); res.end('{"error":"uri required"}'); return; }
            await sonos.playStream(ip, uri);
            break;
          default:
            res.writeHead(400); res.end(JSON.stringify({ error: `unknown action: ${action}` })); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.on('upgrade', (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() === 'websocket') handleUpgrade(req, socket);
  else socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Berg Castle Panel → http://localhost:${PORT}`);
  console.log(`  ${ROOMS_DATA.total_rooms} rooms, ${ROOMS_DATA.total_outputs} outputs, ${ROOMS_DATA.zones.length} zones`);
});
