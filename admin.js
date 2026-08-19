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
const houseMemory = require('./house-memory');
const wallSettings = require('./wall-settings');

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

// ---- Resend (invite email) -------------------------------------------------

const RESEND_SECRETS = path.join(
  process.env.HOME || '/Users/jony',
  '.openclaw/workspace/.secrets/resend-rhapsody.env',
);

function loadResendKey() {
  try {
    const txt = fs.readFileSync(RESEND_SECRETS, 'utf8');
    const m = txt.match(/^\s*RESEND_API_KEY\s*=\s*(.+?)\s*$/m);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

const RESEND_KEY = loadResendKey();
const INVITE_FROM = process.env.BERG_INVITE_FROM || 'Berg Castle <hello@bergcastle.com>';
const PANEL_URL = 'https://home.bergcastle.com';

// Send a branded "you've been given access" email. Best-effort: a send failure
// never blocks the user-add (they're already on the allow-list either way).
function sendInvite(toEmail) {
  return new Promise((resolve) => {
    if (!RESEND_KEY) { resolve({ sent: false, reason: 'no_resend_key' }); return; }
    const subject = 'Your Berg Castle access is ready';
    const html = inviteHtml();
    const text = inviteText();
    const body = JSON.stringify({ from: INVITE_FROM, to: [toEmail], subject, html, text });
    const opts = {
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 12000,
    };
    const r = https.request(opts, (resp) => {
      let d = '';
      resp.on('data', (c) => (d += c));
      resp.on('end', () => {
        let j = {};
        try { j = JSON.parse(d || '{}'); } catch (_) {}
        if (resp.statusCode >= 200 && resp.statusCode < 300 && j.id) {
          resolve({ sent: true, id: j.id });
        } else {
          resolve({ sent: false, reason: (j.message || `http_${resp.statusCode}`) });
        }
      });
    });
    r.on('error', (e) => resolve({ sent: false, reason: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ sent: false, reason: 'timeout' }); });
    r.write(body);
    r.end();
  });
}

function inviteText() {
  return [
    "You've been given access to Berg Castle \u2014 Simon's smart home.",
    '',
    `Open it here: ${PANEL_URL}`,
    '',
    'Choose the email sign-in, enter this address, and you\'ll get a 6-digit code',
    'in your inbox. Enter the code and you\'re in.',
    '',
    'On iPhone: after signing in, tap Share \u2192 Add to Home Screen to install the app.',
  ].join('\n');
}

function inviteHtml() {
  return `<!doctype html><html><body style="margin:0;background:#08080a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f4f4f7;">
  <div style="max-width:480px;margin:0 auto;padding:40px 28px;">
    <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#ffb84d;font-weight:600;">Berg Castle</div>
    <h1 style="font-size:24px;font-weight:650;letter-spacing:-.02em;margin:16px 0 8px;color:#fff;">You're in.</h1>
    <p style="font-size:15px;line-height:1.6;color:#b8b8c0;margin:0 0 28px;">You've been given access to Simon's smart home. Tap below to open it, choose the email sign-in, and you'll get a 6-digit code in this inbox.</p>
    <a href="${PANEL_URL}" style="display:inline-block;background:#ffb84d;color:#1a1206;text-decoration:none;font-weight:650;font-size:15px;padding:14px 28px;border-radius:12px;">Open Berg Castle</a>
    <p style="font-size:13px;line-height:1.6;color:#7a7a84;margin:28px 0 0;">On iPhone, after signing in: tap Share \u2192 <b style="color:#b8b8c0;">Add to Home Screen</b> to install the app.</p>
    <p style="font-size:12px;color:#5a5a64;margin:24px 0 0;">${PANEL_URL}</p>
  </div></body></html>`;
}

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

// Owner gate. The ONLY way to pass is a genuine Cloudflare Access identity header
// whose email is in OWNER_EMAILS. There is deliberately NO loopback/dev bypass:
// the panel runs behind cloudflared on the same host, so every request arrives
// from 127.0.0.1 at the socket level. A loopback bypass would therefore grant
// owner rights to EVERYONE on the household allow-list (this was the 2026-08-17
// bug Simon caught). CF Access injects the header only on the authenticated
// tunnel, and a remote client cannot spoof it, so the header is the sole gate.
function isOwner(req) {
  const email = requesterEmail(req);
  return !!(email && OWNER_EMAILS.has(email));
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

async function handle(req, res, pathname, ctx = {}) {
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
      // Fire the branded invite email (best-effort — never blocks the add).
      const invite = await sendInvite(clean);
      if (invite.sent) console.log(`[admin] invite emailed to ${clean} (${invite.id})`);
      else console.log(`[admin] invite NOT sent to ${clean}: ${invite.reason}`);
      sendJson(res, 200, { users: next, added: true, invited: invite.sent, inviteReason: invite.reason });
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

    // ---- Voice agent memory + system-prompt override (owner-only) ----

    // GET /api/admin/voice-memory — current memory file + prompt override.
    if (req.method === 'GET' && pathname === '/api/admin/voice-memory') {
      sendJson(res, 200, {
        memory: houseMemory.readMemory(),
        promptOverride: houseMemory.readPromptOverride(),
        persona: houseMemory.readPersona(),
        personaDefault: houseMemory.DEFAULT_PERSONA,
        basePrompt: ctx.basePrompt || '',
      });
      return true;
    }

    // PUT /api/admin/voice-persona { persona } — edit the personality/voice.
    // Empty resets to the built-in default.
    if (req.method === 'PUT' && pathname === '/api/admin/voice-persona') {
      const { persona } = await readBody(req);
      houseMemory.writePersona(String(persona || ''));
      console.log(`[admin] ${requesterEmail(req)} edited voice persona`);
      sendJson(res, 200, { ok: true, persona: houseMemory.readPersona() });
      return true;
    }

    // PUT /api/admin/voice-memory { memory } — replace the whole memory file
    // (Simon curating/pruning what the agent remembers).
    if (req.method === 'PUT' && pathname === '/api/admin/voice-memory') {
      const { memory } = await readBody(req);
      houseMemory.writeMemory(String(memory || ''));
      console.log(`[admin] ${requesterEmail(req)} edited voice memory`);
      sendJson(res, 200, { ok: true, memory: houseMemory.readMemory() });
      return true;
    }

    // PUT /api/admin/voice-prompt { promptOverride } — set the owner system-prompt
    // override that layers on top of the base instructions.
    if (req.method === 'PUT' && pathname === '/api/admin/voice-prompt') {
      const { promptOverride } = await readBody(req);
      houseMemory.writePromptOverride(String(promptOverride || ''));
      console.log(`[admin] ${requesterEmail(req)} edited voice prompt override`);
      sendJson(res, 200, { ok: true, promptOverride: houseMemory.readPromptOverride() });
      return true;
    }

    // ---- Wall-panel device settings (owner-only edit) ----
    // Edited here in the web admin so there's one settings home; the native iOS
    // app reads these (see /api/wall-settings) and does the keep-awake + wake-word
    // work, which a web page can't do itself.

    // GET /api/admin/wall-settings — current wall-panel settings.
    if (req.method === 'GET' && pathname === '/api/admin/wall-settings') {
      sendJson(res, 200, wallSettings.read());
      return true;
    }

    // PUT /api/admin/wall-settings { wallMode, wakeWord } — update them.
    if (req.method === 'PUT' && pathname === '/api/admin/wall-settings') {
      const body = await readBody(req);
      const next = wallSettings.write({
        wallMode: body.wallMode,
        wakeWord: body.wakeWord,
        camera: body.camera,
      });
      console.log(`[admin] ${requesterEmail(req)} set wall-settings`, next);
      sendJson(res, 200, { ok: true, ...next });
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
