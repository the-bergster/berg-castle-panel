// admin.js — Owner-only admin surface for Berg Castle Panel.
//
// Provisions Cloudflare Access users (add/remove from the "Household" policy)
// so Simon can invite people from the panel itself instead of editing the CF
// dashboard or hand-running curl.
//
// Security model:
//   - Cloudflare Access sits in front of the whole tunnel. Every request that
//     reaches this origin has already been authenticated by CF, which injects
//     `Cf-Access-Authenticated-User-Email` (and a signed JWT assertion).
//   - We treat that header as the identity, and only OWNER_EMAILS may touch any
//     /api/admin/* route. Everyone else on the allow-list (e.g. Dovilė) gets 403.
//   - Because CF Access is the gate, the header cannot be spoofed by a remote
//     client — it only reaches us via the authenticated tunnel. (If the panel is
//     ever exposed without CF in front, ADMIN_ALLOW_LOCAL must stay false.)

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- Config ----------------------------------------------------------------

const OWNER_EMAILS = new Set(['me@simonberg.ai']);

// The Household policy is a *reusable* (account-level) policy. CF rejects updates
// through the app-scoped endpoint (error 12130), so we use /access/policies/{id}.
const CF_POLICY_ID = '034b8d96-09ed-4143-8d9d-7acce9fb6be1';

// Load the CF admin token from the secrets file (never committed).
const SECRETS_PATH = path.join(
  process.env.HOME || '/Users/jony',
  '.openclaw/workspace/.secrets/cloudflare/berg-castle.env',
);

function loadCfEnv() {
  const out = { token: '', account: '' };
  try {
    const txt = fs.readFileSync(SECRETS_PATH, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*(CLOUDFLARE_API_TOKEN|CF_ACCOUNT_ID)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[1] === 'CLOUDFLARE_API_TOKEN') out.token = m[2];
      if (m[1] === 'CF_ACCOUNT_ID') out.account = m[2];
    }
  } catch (e) {
    console.error('[admin] could not read CF secrets:', e.message);
  }
  return out;
}

const CF = loadCfEnv();

// ---- Identity --------------------------------------------------------------

// Extract the authenticated email CF Access injected. Header name is lower-cased
// by Node. Falls back to the JWT-derived header if present.
function requesterEmail(req) {
  const h = req.headers || {};
  const email =
    h['cf-access-authenticated-user-email'] ||
    h['x-cf-access-authenticated-user-email'] ||
    '';
  return String(email).trim().toLowerCase();
}

function isOwner(req) {
  const email = requesterEmail(req);
  if (email && OWNER_EMAILS.has(email)) return true;
  // Local dev bypass: only when explicitly opted in AND the request is loopback.
  if (process.env.ADMIN_ALLOW_LOCAL === '1') {
    const ra = (req.socket && req.socket.remoteAddress) || '';
    if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return true;
  }
  return false;
}

// ---- Cloudflare API --------------------------------------------------------

function cfRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!CF.token || !CF.account) {
      reject(new Error('Cloudflare credentials not loaded'));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${CF.account}${apiPath}`,
      method,
      headers: {
        Authorization: `Bearer ${CF.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 12000,
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const r = https.request(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          resolve({ status: resp.statusCode, json });
        } catch (e) {
          reject(new Error(`CF bad JSON (${resp.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('CF request timeout')); });
    if (payload) r.write(payload);
    r.end();
  });
}

function policyPath() {
  return `/access/policies/${CF_POLICY_ID}`;
}

// Read the current include[] list and normalise to plain emails.
async function getPolicy() {
  const { status, json } = await cfRequest('GET', policyPath());
  if (!json.success) {
    throw new Error(`CF getPolicy failed (${status}): ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

function emailsFromInclude(include) {
  return (include || [])
    .map((e) => e && e.email && e.email.email)
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rewrite the whole policy include[] with a new email set. CF requires a PUT of
// the full policy object; we preserve name/decision and only swap include[].
async function writeEmails(policy, emails) {
  const include = emails.map((e) => ({ email: { email: e } }));
  const body = {
    name: policy.name,
    decision: policy.decision,
    include,
    exclude: policy.exclude || [],
    require: policy.require || [],
  };
  const { status, json } = await cfRequest('PUT', policyPath(), body);
  if (!json.success) {
    throw new Error(`CF writeEmails failed (${status}): ${JSON.stringify(json.errors)}`);
  }
  return emailsFromInclude(json.result.include);
}

// ---- HTTP helpers ----------------------------------------------------------

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); }
    });
  });
}

// ---- Route handler ---------------------------------------------------------
// Returns true if it handled the request, false to let the main router continue.

async function handle(req, res, pathname) {
  if (!pathname.startsWith('/api/admin/')) return false;

  // Every admin route is owner-gated.
  if (!isOwner(req)) {
    sendJson(res, 403, {
      error: 'forbidden',
      detail: 'Admin is restricted to the house owner.',
      you: requesterEmail(req) || null,
    });
    return true;
  }

  try {
    // GET /api/admin/whoami — who CF thinks I am (used by the UI header).
    if (req.method === 'GET' && pathname === '/api/admin/whoami') {
      sendJson(res, 200, { email: requesterEmail(req), owner: true });
      return true;
    }

    // GET /api/admin/users — list current allow-listed emails.
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const policy = await getPolicy();
      const emails = emailsFromInclude(policy.include);
      sendJson(res, 200, {
        policyName: policy.name,
        owners: [...OWNER_EMAILS],
        users: emails,
      });
      return true;
    }

    // POST /api/admin/users  { email }  — add a user.
    if (req.method === 'POST' && pathname === '/api/admin/users') {
      const { email } = await readBody(req);
      const clean = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(clean)) {
        sendJson(res, 400, { error: 'invalid_email' });
        return true;
      }
      const policy = await getPolicy();
      const current = emailsFromInclude(policy.include);
      if (current.includes(clean)) {
        sendJson(res, 200, { users: current, added: false, note: 'already had access' });
        return true;
      }
      const next = await writeEmails(policy, [...current, clean]);
      console.log(`[admin] ${requesterEmail(req)} added ${clean}`);
      sendJson(res, 200, { users: next, added: true });
      return true;
    }

    // DELETE /api/admin/users  { email }  — remove a user.
    if (req.method === 'DELETE' && pathname === '/api/admin/users') {
      const { email } = await readBody(req);
      const clean = String(email || '').trim().toLowerCase();
      if (OWNER_EMAILS.has(clean)) {
        sendJson(res, 400, { error: 'cannot_remove_owner' });
        return true;
      }
      const policy = await getPolicy();
      const current = emailsFromInclude(policy.include);
      if (!current.includes(clean)) {
        sendJson(res, 200, { users: current, removed: false, note: 'was not on the list' });
        return true;
      }
      const next = await writeEmails(policy, current.filter((e) => e !== clean));
      console.log(`[admin] ${requesterEmail(req)} removed ${clean}`);
      sendJson(res, 200, { users: next, removed: true });
      return true;
    }

    sendJson(res, 404, { error: 'unknown_admin_route' });
    return true;
  } catch (e) {
    console.error('[admin] error:', e.message);
    sendJson(res, 502, { error: 'cloudflare_error', detail: e.message });
    return true;
  }
}

module.exports = { handle, isOwner, requesterEmail };
