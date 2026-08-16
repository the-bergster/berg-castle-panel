// Voice agent (OpenAI Realtime, speech-to-speech) for Berg Castle.
//
// Two responsibilities:
//   1. mintClientSecret() — creates a short-lived ephemeral key so the browser
//      can open a WebRTC session with OpenAI WITHOUT ever seeing the real key.
//      The real key stays here on the Mac. Endpoint: /v1/realtime/client_secrets
//      (the GA endpoint; the old /v1/realtime/sessions was retired 2026).
//   2. buildSessionConfig() — assembles the agent's instructions (from LIVE room
//      + scene data, so it's never stale) and the tool schemas it can call.
//
// v1 scope: lighting + fireplaces + scenes. Climate/music/intercom/cameras are
// left as clearly-marked TODO slots so they drop in without a rebuild.

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL = 'gpt-realtime-2.1'; // latest speech-to-speech (verified 2026-08-16)
const VOICE = 'cedar';
const KEY_FILE = path.join(
  process.env.HOME || '/Users/jony',
  '.openclaw/workspace/.secrets/openai-voice/key.env',
);

function loadApiKey() {
  // Prefer env, fall back to the stashed key file.
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8');
    const m = raw.match(/OPENAI_API_KEY\s*=\s*(.+)/);
    if (m) return m[1].trim();
  } catch (_) {}
  return null;
}

// -------- Agent knowledge (built from live data) --------

function buildInstructions(roomsData, scenesData, synthetic) {
  const zones = roomsData.zones.map(z => {
    const rooms = z.rooms.map(r => {
      const outs = r.outputs
        .map(o => `${o.name} (#${o.id}${o.isFireplace ? ', fireplace/switch' : ''})`)
        .join(', ');
      return `    - ${r.name} [room #${r.id}]: ${outs}`;
    }).join('\n');
    return `  ${z.name}:\n${rooms}`;
  }).join('\n');

  // Fireplaces live in their own room (excluded from Lights zones), so surface
  // them explicitly.
  const fireRoom = roomsData.rooms.find(r => r.slug === 'fireplaces');
  const fires = fireRoom
    ? fireRoom.outputs.map(o => `    - ${o.name} (#${o.id})`).join('\n')
    : '    (none found)';

  const homeScenes = (scenesData.home_scenes || [])
    .map(s => `    - "${s.label}" ${s.emoji || ''} (pico #${s.pico_id}, button ${s.button})`)
    .join('\n');
  const synthScenes = (synthetic || [])
    .map(s => `    - "${s.label}" (synthetic id "${s.id}")`)
    .join('\n');

  return `You are the voice of Berg Castle — Simon Berg's smart home. You control the
lighting, fireplaces, and scenes by calling tools. You are warm, brief, and
confident. Speak like a capable house manager, not a chatbot. Confirm actions in
a few words ("Lounge is at 30%", "Dining fireplace on"). Never read out numeric
IDs unless asked.

CORE BEHAVIOUR
- When asked to change something, CALL THE TOOL. Don't just describe it.
- Batch related changes when natural (e.g. "movie mode" = dim + fireplace on).
- If a room or output is ambiguous, ask one short clarifying question.
- To answer "what's on?" call get_state first, then summarise briefly.
- Levels are 0-100. "Off" = 0. "Full"/"bright" = 100. "Dim"/"low" ~ 25-30.
- Fireplaces are ON/OFF only: use set_fireplace with on=true/false.

HELPFUL SCENE SHORTHAND
- "All off" / "everything off" → all_off.
- "Fireplaces on/off" → fire_synthetic_scene with the matching synthetic id.

THE HOUSE (rooms grouped by zone, with the outputs in each):
${zones}

FIREPLACES (on/off switches):
${fires}

SCENES you can fire:
  Pico scenes:
${homeScenes || '    (none)'}
  Synthetic scenes:
${synthScenes || '    (none)'}

If someone asks about cameras, music, or climate, say those are coming soon —
you only control lighting, fireplaces, and scenes for now.`;
}

// -------- Tool schemas exposed to the model --------

function toolSchemas() {
  return [
    {
      type: 'function',
      name: 'set_output',
      description: 'Set a single light/output to a level 0-100. Use for one specific fixture.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The output id (#number) from the house list.' },
          level: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['id', 'level'],
      },
    },
    {
      type: 'function',
      name: 'set_room',
      description: 'Set every light in a room to a level 0-100.',
      parameters: {
        type: 'object',
        properties: {
          room_id: { type: 'integer' },
          level: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['room_id', 'level'],
      },
    },
    {
      type: 'function',
      name: 'set_zone',
      description: 'Set every light in a whole zone (e.g. Kitchen, Master Suite) to a level.',
      parameters: {
        type: 'object',
        properties: {
          zone: { type: 'string', description: 'Exact zone name from the house list.' },
          level: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['zone', 'level'],
      },
    },
    {
      type: 'function',
      name: 'set_fireplace',
      description: 'Turn a fireplace on or off. Fireplaces are on/off only.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The fireplace output id.' },
          on: { type: 'boolean' },
        },
        required: ['id', 'on'],
      },
    },
    {
      type: 'function',
      name: 'all_off',
      description: 'Turn off every light in the whole house.',
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: 'fire_scene',
      description: 'Fire a Pico-programmed scene by pico id + button number.',
      parameters: {
        type: 'object',
        properties: {
          pico_id: { type: 'integer' },
          button: { type: 'integer' },
        },
        required: ['pico_id', 'button'],
      },
    },
    {
      type: 'function',
      name: 'fire_synthetic_scene',
      description: 'Fire a synthetic scene (e.g. Fireplaces On/Off) by its synthetic id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      type: 'function',
      name: 'get_state',
      description: 'Get the current on/off + level of everything. Call before answering "what is on".',
      parameters: { type: 'object', properties: {} },
    },
  ];
}

function buildSessionConfig(roomsData, scenesData, synthetic) {
  return {
    type: 'realtime',
    model: MODEL,
    audio: { output: { voice: VOICE } },
    instructions: buildInstructions(roomsData, scenesData, synthetic),
    tools: toolSchemas(),
    tool_choice: 'auto',
  };
}

// -------- Ephemeral client-secret mint --------

function mintClientSecret(sessionConfig) {
  const apiKey = loadApiKey();
  if (!apiKey) return Promise.reject(new Error('OpenAI API key not configured'));

  const payload = JSON.stringify({
    // 2 min TTL is plenty to open the WebRTC connection.
    expires_after: { anchor: 'created_at', seconds: 120 },
    session: sessionConfig,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/realtime/client_secrets',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          // Binds a stable safety identifier to the ephemeral token.
          'OpenAI-Safety-Identifier': 'berg-castle-panel',
        },
      },
      (resp) => {
        let data = '';
        resp.on('data', (c) => (data += c));
        resp.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (resp.statusCode >= 400) {
              reject(new Error(json.error?.message || `HTTP ${resp.statusCode}`));
              return;
            }
            resolve(json); // { value: "ek_...", expires_at, session }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { MODEL, VOICE, buildSessionConfig, mintClientSecret, loadApiKey };
