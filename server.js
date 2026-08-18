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
const { SonosSystem } = require('./sonos');
const sonosApi = require('./sonos/api');
const intercom = require('./intercom');
const climate = require('./climate');
const voice = require('./voice');
const admin = require('./admin');
const watchRelay = require('./watch-relay');
const voiceStream = require('./voice-stream');
const { WebSocketServer } = require('ws');

const PORT = 4321;

// Watch service token (scopes POST /api/watch/voice). Loaded from secrets.
const WATCH_TOKEN = (() => {
  if (process.env.WATCH_TOKEN) return process.env.WATCH_TOKEN.trim();
  try {
    const p = path.join(process.env.HOME || '/Users/jony', '.openclaw/workspace/.secrets/berg-castle-watch/token.env');
    const m = fs.readFileSync(p, 'utf8').match(/WATCH_TOKEN\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
})();
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

// ---- Sonos ----
// The Music half is self-contained: it discovers its own topology, subscribes to
// player events, and pushes changes to browsers over the same WebSocket the Lights
// half uses. A Sonos failure must never take the Lights half down, so every hook
// here is defensive.
const sonos = new SonosSystem({ port: PORT });

sonos.on('transport', (evt) => broadcast({ type: 'sonos:transport', ...evt }));
sonos.on('rendering', (evt) => broadcast({ type: 'sonos:rendering', ...evt }));
sonos.on('topology', () => broadcast({ type: 'sonos:topology', topology: sonos.topology.toJSON() }));
sonos.on('content', (which) => broadcast({ type: 'sonos:content', ...which }));
sonos.on('snapshot', ({ changed }) => {
  // Under polling this is the only change signal; under push it is a slow safety net.
  if (changed && changed.length) broadcast({ type: 'sonos:rooms', rooms: changed });
});

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

// ---- Voice tool executor ----
// Routes a tool the Realtime model asked for to the same Lutron paths the UI
// uses. Returns a small JSON result the model reads back to the user.
async function runVoiceTool(name, args) {
  switch (name) {
    case 'set_output': {
      const { id, level } = args;
      await lutron.setOutput(id, level, 1);
      return { ok: true, id, level };
    }
    case 'set_room': {
      const room = ROOMS_DATA.rooms.find(r => r.id === args.room_id);
      if (!room) return { ok: false, error: 'unknown room' };
      await lutron.setMany(room.outputs.map(o => ({ id: o.id, level: args.level, fade: 1 })));
      return { ok: true, room: room.name, level: args.level, count: room.outputs.length };
    }
    case 'set_zone': {
      const zone = ROOMS_DATA.zones.find(z => z.name.toLowerCase() === String(args.zone || '').toLowerCase());
      if (!zone) return { ok: false, error: 'unknown zone' };
      const cmds = [];
      for (const r of zone.rooms) for (const o of r.outputs) cmds.push({ id: o.id, level: args.level, fade: 2 });
      await lutron.setMany(cmds);
      return { ok: true, zone: zone.name, level: args.level, count: cmds.length };
    }
    case 'set_fireplace': {
      const { id, on } = args;
      await lutron.setOutput(id, on ? 100 : 0, 0);
      return { ok: true, id, on: !!on };
    }
    case 'all_off': {
      await lutron.setMany(ROOMS_DATA.all_output_ids.map(id => ({ id, level: 0, fade: 2 })));
      return { ok: true, count: ROOMS_DATA.all_output_ids.length };
    }
    case 'fire_scene': {
      await lutron.pressPicoButton(args.pico_id, args.button);
      return { ok: true, pico_id: args.pico_id, button: args.button };
    }
    case 'fire_synthetic_scene': {
      const scene = findSynthetic(args.id);
      if (!scene) return { ok: false, error: 'unknown scene' };
      await lutron.setMany(scene.outputs.map(o => ({ id: o.id, level: o.level, fade: scene.fade || 1 })));
      return { ok: true, scene: scene.label, count: scene.outputs.length };
    }
    case 'get_state': {
      const state = lutron.getState();
      // Summarise: which named outputs are on + their level.
      const on = [];
      for (const r of ROOMS_DATA.rooms) {
        for (const o of r.outputs) {
          const lvl = state[o.id] || 0;
          if (lvl > 0) on.push({ room: r.name, name: o.name, level: lvl });
        }
      }
      return { ok: true, on_count: on.length, on };
    }

    // ---- Climate (Ecobee) ----
    case 'get_climate': {
      const { body } = await climate.bridgeRequest({ method: 'GET', path: '/thermostats' });
      let list = (body && body.thermostats) || [];
      if (args.zone) {
        const match = matchByName(list, args.zone, t => t.name);
        list = match ? [match] : [];
        if (!match) return { ok: false, error: `unknown climate zone: ${args.zone}` };
      }
      const zones = list.map(t => ({
        zone: t.name,
        temp: t.actualTemperature,
        humidity: t.actualHumidity,
        mode: t.hvacMode,
        heatSetpoint: t.desiredHeat,
        coolSetpoint: t.desiredCool,
        hold: t.activeHold ? true : false,
        schedule: t.currentClimateRef,
      }));
      return { ok: true, zones };
    }
    case 'set_temperature': {
      const { body } = await climate.bridgeRequest({ method: 'GET', path: '/thermostats' });
      const t = matchByName((body && body.thermostats) || [], args.zone, x => x.name);
      if (!t) return { ok: false, error: `unknown climate zone: ${args.zone}` };
      const temp = Math.round(args.temperature);
      // Hold both setpoints at the target so it holds regardless of heat/cool mode.
      await climate.bridgeRequest({
        method: 'POST', path: '/hold/temp',
        body: { index: t.index, coolTemp: temp, heatTemp: temp, holdType: 'nextTransition' },
      });
      return { ok: true, zone: t.name, temperature: temp };
    }
    case 'set_hvac_mode': {
      const { body } = await climate.bridgeRequest({ method: 'GET', path: '/thermostats' });
      const t = matchByName((body && body.thermostats) || [], args.zone, x => x.name);
      if (!t) return { ok: false, error: `unknown climate zone: ${args.zone}` };
      await climate.bridgeRequest({
        method: 'POST', path: '/hvac-mode',
        body: { index: t.index, hvacMode: args.mode },
      });
      return { ok: true, zone: t.name, mode: args.mode };
    }
    case 'resume_climate_schedule': {
      if (!args.zone) {
        await climate.bridgeRequest({ method: 'POST', path: '/resume-all', body: { resumeAll: false } });
        return { ok: true, resumed: 'all zones' };
      }
      const { body } = await climate.bridgeRequest({ method: 'GET', path: '/thermostats' });
      const t = matchByName((body && body.thermostats) || [], args.zone, x => x.name);
      if (!t) return { ok: false, error: `unknown climate zone: ${args.zone}` };
      await climate.bridgeRequest({ method: 'POST', path: '/resume', body: { index: t.index, resumeAll: false } });
      return { ok: true, zone: t.name, resumed: true };
    }

    // ---- Music (Sonos) ----
    case 'play_music': {
      const room = matchSonosRoom(args.room);
      if (!room) return { ok: false, error: `unknown music room: ${args.room}` };
      if (!sonos.search || !sonos.search.enabled) return { ok: false, error: 'music search not configured' };
      const type = args.type || 'track';
      const results = await sonos.search.search(args.query, { types: [type], limit: 5 });
      const bucket = ({ track: 'tracks', album: 'albums', artist: 'artists', playlist: 'playlists' })[type] || 'tracks';
      const item = (results[bucket] || [])[0] || (results.tracks || [])[0];
      if (!item) return { ok: false, error: `nothing found for "${args.query}"` };
      await sonos.player.playItem(room, item, 'now');
      return { ok: true, room, playing: item.title, artist: item.artist || null };
    }
    case 'control_music': {
      const room = matchSonosRoom(args.room);
      if (!room) return { ok: false, error: `unknown music room: ${args.room}` };
      const a = args.action;
      if (a === 'play') await sonos.player.play(room);
      else if (a === 'pause') await sonos.player.pause(room);
      else if (a === 'stop') await sonos.player.stop(room);
      else if (a === 'next') await sonos.player.next(room);
      else if (a === 'previous') await sonos.player.previous(room);
      else return { ok: false, error: `unknown action: ${a}` };
      return { ok: true, room, action: a };
    }
    case 'set_music_volume': {
      const room = matchSonosRoom(args.room);
      if (!room) return { ok: false, error: `unknown music room: ${args.room}` };
      let vol;
      if (typeof args.delta === 'number') vol = await sonos.player.adjustVolume(room, args.delta);
      else if (typeof args.volume === 'number') vol = await sonos.player.setVolume(room, args.volume);
      else return { ok: false, error: 'provide volume or delta' };
      return { ok: true, room, volume: vol };
    }
    case 'get_music_state': {
      const rooms = args.room ? [matchSonosRoom(args.room)].filter(Boolean) : (sonos.topology.rooms || []).map(r => r.name);
      if (args.room && !rooms.length) return { ok: false, error: `unknown music room: ${args.room}` };
      const playing = [];
      for (const rm of rooms) {
        try {
          const np = await sonos.player.nowPlaying(rm);
          if (np && np.state === 'PLAYING') {
            const tr = np.track || {};
            playing.push({
              room: rm,
              title: tr.title || null,
              artist: tr.artist || null,
              album: tr.album || null,
            });
          }
        } catch (_) {}
      }
      return { ok: true, playing_count: playing.length, playing };
    }

    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

// Fuzzy-match a spoken name against a list (exact, then contains, then startsWith).
function matchByName(list, spoken, getName) {
  if (!spoken) return null;
  const q = String(spoken).toLowerCase().trim();
  return list.find(x => getName(x).toLowerCase() === q)
    || list.find(x => getName(x).toLowerCase().includes(q))
    || list.find(x => q.includes(getName(x).toLowerCase()))
    || null;
}

// Match a spoken room to a real Sonos room name; returns the canonical name.
function matchSonosRoom(spoken) {
  const rooms = (sonos.topology.rooms || []).map(r => r.name);
  const m = matchByName(rooms.map(n => ({ n })), spoken, x => x.n);
  return m ? m.n : null;
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
      .replace(/href="\/music\.css"/g, `href="/music.css?v=${BUILD_VERSION}"`)
      .replace(/src="\/app\.js"/g, `src="/app.js?v=${BUILD_VERSION}"`)
      .replace(/src="\/music\.js"/g, `src="/music.js?v=${BUILD_VERSION}"`);
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

  // ---- Owner-only admin (Cloudflare Access-gated) ----
  if (req.method === 'GET' && pathname === '/admin') {
    serveStatic(res, 'admin.html'); return;
  }
  if (pathname.startsWith('/api/admin/')) {
    const handled = await admin.handle(req, res, pathname);
    if (handled) return;
  }

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
  if (req.method === 'GET' && pathname === '/music.js') {
    serveStatic(res, 'music.js'); return;
  }
  if (req.method === 'GET' && pathname === '/music.css') {
    serveStatic(res, 'music.css'); return;
  }
  if (req.method === 'GET' && pathname === '/climate.js') {
    serveStatic(res, 'climate.js'); return;
  }
  if (req.method === 'GET' && pathname === '/climate.css') {
    serveStatic(res, 'climate.css'); return;
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

  // ---- Voice agent (OpenAI Realtime) ----
  if (req.method === 'GET' && pathname === '/voice.js') {
    serveStatic(res, 'voice.js'); return;
  }
  if (req.method === 'GET' && pathname === '/voice.css') {
    serveStatic(res, 'voice.css'); return;
  }
  // Mint an ephemeral client secret (browser never sees the real key).
  if (req.method === 'GET' && pathname === '/api/voice/session') {
    (async () => {
      // Pull live climate zone names + Sonos room names so the agent knows the
      // real setup. Both are best-effort — fall back to empty if unavailable.
      let climateZones = [];
      let sonosRooms = [];
      try {
        const { body } = await climate.bridgeRequest({ method: 'GET', path: '/thermostats' });
        const list = (body && body.thermostats) || [];
        climateZones = list.map(t => t.name).filter(Boolean);
      } catch (e) { console.error('[voice] climate list failed:', e.message); }
      try {
        sonosRooms = [...new Set((sonos.topology.rooms || []).map(r => r.name).filter(Boolean))].sort();
      } catch (e) { console.error('[voice] sonos list failed:', e.message); }

      const cfg = voice.buildSessionConfig(ROOMS_DATA, SCENES_DATA, SYNTHETIC, climateZones, sonosRooms);
      const out = await voice.mintClientSecret(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: out.value, expires_at: out.expires_at, model: voice.MODEL }));
    })().catch((e) => {
      console.error('[voice] mint failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  // Execute a tool call the model requested (fired by the browser).
  if (req.method === 'POST' && pathname === '/api/voice/tool') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name, args } = JSON.parse(body || '{}');
        const result = await runVoiceTool(name, args || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('[voice:tool]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ---- Watch press-to-talk voice relay ----
  // The Watch POSTs one recorded clip (base64 PCM16 mono 24k) + a service token.
  // We run one turn through the SAME Jony agent + tools, return spoken reply.
  if (req.method === 'POST' && pathname === '/api/watch/voice') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        // Service-token auth: Watch can't do CF Access OTP, so it presents a
        // static bearer token scoped to just this route.
        const token = (req.headers['x-watch-token'] || payload.token || '').trim();
        if (!WATCH_TOKEN || token !== WATCH_TOKEN) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' })); return;
        }
        if (!payload.audio) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'no audio' })); return;
        }
        const apiKey = voice.loadApiKey();
        // Build the SAME session config the browser uses (live house data).
        let climateZones = [], sonosRooms = [];
        try {
          const { body } = await climate.bridgeRequest({ method: 'GET', path: '/thermostats' });
          climateZones = ((body && body.thermostats) || []).map(t => t.name).filter(Boolean);
        } catch (_) {}
        try {
          sonosRooms = [...new Set((sonos.topology.rooms || []).map(r => r.name).filter(Boolean))].sort();
        } catch (_) {}
        const cfg = voice.buildSessionConfig(ROOMS_DATA, SCENES_DATA, SYNTHETIC, climateZones, sonosRooms);
        const result = await watchRelay.runTurn({
          apiKey,
          sessionConfig: cfg,
          audioPcm16Base64: payload.audio,
          runToolFn: runVoiceTool,
          log: (...a) => console.log(...a),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          transcript: result.transcript,
          reply: result.replyText,
          audio: result.audioPcm16.toString('base64'), // PCM16 24k mono
          sampleRate: 24000,
        }));
      } catch (e) {
        console.error('[watch:voice]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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

  // ---- Intercom ----
  if (req.method === 'GET' && pathname.startsWith('/recordings/')) {
    // Serve saved MP3 recordings so Sonos can pull them.
    const file = pathname.replace(/^\/recordings\//, '');
    // Prevent path traversal + block manifest.
    if (file.includes('..') || file.includes('/') || file === '_manifest.json') {
      res.writeHead(404); res.end(); return;
    }
    const filepath = path.join(intercom.RECORDINGS_DIR, file);
    fs.readFile(filepath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/intercom/record') {
    // Accept audio blob (Content-Type = audio/webm etc.), transcode to mp3, return meta.
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) { res.writeHead(400); res.end('{"error":"empty body"}'); return; }
        if (buf.length > 20 * 1024 * 1024) { res.writeHead(413); res.end('{"error":"recording too large (max 20MB)"}'); return; }
        const mime = req.headers['content-type'] || 'audio/webm';
        const meta = await intercom.saveRecording(buf, mime);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
      } catch (e) {
        console.error('[Intercom] record failed:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/intercom/broadcast') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { recording_id, rooms, volume, restore } = JSON.parse(body);
        const rec = intercom.getRecording(recording_id);
        if (!rec) { res.writeHead(404); res.end('{"error":"unknown recording"}'); return; }
        if (!Array.isArray(rooms) || rooms.length === 0) {
          res.writeHead(400); res.end('{"error":"rooms[] required"}'); return;
        }
        const url = intercom.fullUrlFor(rec);
        const shouldRestore = restore !== false; // default ON

        // 1. Capture pre-broadcast state per room (only if we plan to restore).
        const roomPlayers = rooms.map((r) => ({ room: r, player: sonos.intercom.playerFor(r) }));
        let preStates = null;
        if (shouldRestore) {
          preStates = await Promise.all(roomPlayers.map(async ({ room, player }) => {
            if (!player) return null;
            try {
              const s = await sonos.intercom.captureState(player.ip);
              console.log(`[Intercom] captured ${room}:`, {
                state: s.state, vol: s.volume, uri: s.current_uri?.slice(0, 60),
                pos: s.position, track: s.track_number, is_queue: s.is_queue,
              });
              return { room, state: s };
            } catch (e) {
              console.warn(`[Intercom] captureState failed for ${room}: ${e.message}`);
              return null;
            }
          }));
        }

        // 2. Fire the broadcast in parallel.
        const results = await Promise.all(roomPlayers.map(async ({ room, player }) => {
          if (!player) return { room, ok: false, error: 'unknown room' };
          try {
            await sonos.intercom.playAnnouncement(player.ip, url, volume);
            return { room, ok: true };
          } catch (e) {
            return { room, ok: false, error: e.message };
          }
        }));

        // 3. Schedule the restore. We know duration_ms from ffprobe; add a small
        //    buffer so Sonos actually finishes playback before we swap the URI back.
        let restoreScheduledAt = null;
        if (shouldRestore && preStates) {
          const durationMs = rec.duration_ms || 8000;
          const buffer = 800;
          const delay = durationMs + buffer;
          restoreScheduledAt = Date.now() + delay;
          setTimeout(async () => {
            const restoreResults = await Promise.all(preStates.map(async (entry) => {
              if (!entry) return null;
              try {
                const out = await sonos.intercom.restoreState(entry.state);
                console.log(`[Intercom] restored ${entry.room} (was ${entry.state.state}, queue=${!!entry.state.is_queue}):`, out.notes || out);
                return { room: entry.room, ...out };
              } catch (e) {
                console.error(`[Intercom] restore failed for ${entry.room}:`, e.message);
                return { room: entry.room, restored: false, error: e.message };
              }
            }));
            console.log('[Intercom] restore complete:', restoreResults.filter(Boolean).length, 'rooms');
          }, delay).unref();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          recording_id, url, rooms: results,
          successful: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          duration_ms: rec.duration_ms,
          restore: shouldRestore,
          restore_scheduled_at: restoreScheduledAt,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ---- Sonos ----
  // Players POST their GENA event notifications here. This must be checked before
  // anything else because NOTIFY is not a method the rest of the router expects.
  if (req.method === 'NOTIFY' && pathname === '/sonos/notify') {
    sonos.events.handleNotify(req, res);
    return;
  }
  if (pathname.startsWith('/api/sonos')) {
    if (await sonosApi.handle(sonos, req, res, url)) return;
  }

  if (pathname.startsWith('/api/climate')) {
    if (await climate.handle(req, res, url)) return;
  }

  res.writeHead(404); res.end('Not found');
});

// Freeflow voice socket (Watch): persistent bridge to OpenAI Realtime. Uses the
// `ws` library (separate from the hand-rolled live-sync socket) on /ws/voice.
const voiceWss = new WebSocketServer({ noServer: true });
voiceWss.on('connection', (ws) => {
  console.log('[voice-stream] +watch client');
  let climateZones = [], sonosRooms = [];
  try { sonosRooms = [...new Set((sonos.topology.rooms || []).map(r => r.name).filter(Boolean))].sort(); } catch (_) {}
  // Kick off with whatever climate zones we can grab; don't block the socket.
  climate.bridgeRequest({ method: 'GET', path: '/thermostats' })
    .then(({ body }) => { climateZones = ((body && body.thermostats) || []).map(t => t.name).filter(Boolean); })
    .catch(() => {})
    .finally(() => {
      const cfg = voice.buildSessionConfig(ROOMS_DATA, SCENES_DATA, SYNTHETIC, climateZones, sonosRooms);
      voiceStream.attachSession(ws, { sessionConfig: cfg, runToolFn: runVoiceTool, log: (...a) => console.log(...a) });
    });
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  let pathname = '/';
  try { pathname = new URL(req.url, `http://${req.headers.host}`).pathname; } catch (_) {}
  if (pathname === '/ws/voice') {
    // Auth: Watch presents the service token as ?token= (can't set WS headers easily).
    let token = '';
    try { token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token') || ''; } catch (_) {}
    if (!WATCH_TOKEN || token.trim() !== WATCH_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    voiceWss.handleUpgrade(req, socket, head, (ws) => voiceWss.emit('connection', ws, req));
    return;
  }
  handleUpgrade(req, socket);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Berg Castle Panel → http://localhost:${PORT}`);
  console.log(`  ${ROOMS_DATA.total_rooms} rooms, ${ROOMS_DATA.total_outputs} outputs, ${ROOMS_DATA.zones.length} zones`);
  // Sonos initialises after the listener is up: GENA subscriptions name this server
  // as their callback target, so the port must already be accepting connections.
  sonos.init();
});

process.on('SIGTERM', () => sonos.events.stop().finally(() => process.exit(0)));
