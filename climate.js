// Berg Castle · climate.js
//
// Thin passthrough to the ecobee bridge on localhost:8734.
// The bridge is a Python FastAPI daemon that holds the ecobee refresh token
// and exposes a REST API. It lives at ~/.openclaw/workspace/projects/ecobee-bridge/
// and is managed by a launchd LaunchAgent.
//
// Berg Castle Panel is the only front-end (jony-admin's version was removed
// 2026-08-03). server.js mounts these routes under /api/climate/*.

const http = require('http');

const BRIDGE_HOST = process.env.ECOBEE_BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = parseInt(process.env.ECOBEE_BRIDGE_PORT || '8734', 10);
const BRIDGE_KEY_PATH = require('path').join(
  require('os').homedir(),
  '.openclaw/workspace/.secrets/ecobee/bridge-key.txt'
);

let BRIDGE_KEY = null;
function loadKey() {
  if (BRIDGE_KEY) return BRIDGE_KEY;
  try {
    BRIDGE_KEY = require('fs').readFileSync(BRIDGE_KEY_PATH, 'utf8').trim();
  } catch (e) {
    console.warn('[climate] bridge key not readable:', e.message);
    BRIDGE_KEY = '';
  }
  return BRIDGE_KEY;
}

/** Make an authenticated request to the bridge and stream the JSON response back. */
function bridgeRequest({ method, path, body }) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      method,
      path,
      headers: {
        'X-Ecobee-Bridge-Key': loadKey(),
        'Content-Type': 'application/json',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
      },
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('bridge timeout')); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ─── Action allowlist ─────────────────────────────────────────────────────
// Actions the panel is allowed to dispatch, mapped to bridge paths.
const ACTION_ROUTES = {
  'hold-temp':          '/hold/temp',
  'hold-climate':       '/hold/climate',
  'hvac-mode':          '/hvac-mode',
  'fan-mode':           '/fan-mode',
  'resume':             '/resume',
  'apply-comfort-all':  '/apply-comfort-all',
  'resume-all':         '/resume-all',
};

// ─── HTTP handler ─────────────────────────────────────────────────────────
/**
 * Handle /api/climate/* requests. Returns true if handled.
 * `readBody` is server.js's small helper for buffering the request body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  // GET /api/climate/thermostats[?force=1]
  if (req.method === 'GET' && pathname === '/api/climate/thermostats') {
    try {
      const force = url.searchParams.get('force') === '1';
      const { status, body } = await bridgeRequest({
        method: 'GET',
        path: `/thermostats${force ? '?force=true' : ''}`,
      });
      res.writeHead(status || 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (e) {
      console.error('[climate] handler error:', e && e.stack || e);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return true;
  }

  // POST /api/climate/action  { action: '...', ...args }
  if (req.method === 'POST' && pathname === '/api/climate/action') {
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return true;
    }
    const action = typeof payload.action === 'string' ? payload.action : '';
    const bridgePath = ACTION_ROUTES[action];
    if (!bridgePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown action: ${action}` }));
      return true;
    }
    const { action: _drop, ...forward } = payload;
    try {
      const { status, body } = await bridgeRequest({
        method: 'POST',
        path: bridgePath,
        body: forward,
      });
      res.writeHead(status || 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return true;
  }

  return false;
}

// ─── Health-check helper for server startup ───────────────────────────────
async function checkBridge() {
  try {
    const { status } = await bridgeRequest({ method: 'GET', path: '/health' });
    return status === 200;
  } catch {
    return false;
  }
}

module.exports = { handle, checkBridge, bridgeRequest };
