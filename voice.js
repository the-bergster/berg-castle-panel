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
const houseMemory = require('./house-memory');

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

// Build the room-awareness block. `panelRoom` is the room this physical iPad
// panel is mounted in (set per-device in the panel settings). When present, the
// agent treats bare/implicit locations ("the lights", "in this room", "the
// temperature") as referring to THIS room, while an explicitly named room still
// wins. We resolve the spoken room to the closest lighting room / climate zone /
// Sonos room so the tool calls target the right things.
function buildRoomContext(panelRoom, roomsData, climateZones, sonosRooms) {
  const room = (panelRoom || '').trim();
  if (!room) return '';

  // Best-effort exact-ish matches so we can hint the agent which real names to
  // use for each subsystem (names differ across Lutron / Ecobee / Sonos).
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = norm(room);
  const findName = (names) => {
    if (!names || !names.length) return null;
    let hit = names.find((n) => norm(n) === target);
    if (hit) return hit;
    hit = names.find((n) => norm(n).includes(target) || target.includes(norm(n)));
    return hit || null;
  };

  const lightingRoomNames = [];
  for (const z of roomsData.zones) for (const r of z.rooms) lightingRoomNames.push(r.name);
  const lightRoom = findName(lightingRoomNames);
  const climateZone = findName(climateZones);
  const sonosRoom = findName(sonosRooms);

  const lines = [];
  lines.push('\nYOU ARE HERE (this panel\'s physical location)');
  lines.push(`- This wall panel is physically located in: ${room}.`);
  lines.push('- When the person does NOT name a room ("turn off the lights", "what\'s the temperature", "play some jazz", "warm it up"), assume they mean THIS room and act on it.');
  lines.push('- "this room", "in here", "here" all mean this room.');
  lines.push('- If they DO name a different room, that always wins — act on the room they named, not this one.');
  if (lightRoom) lines.push(`- For lights here, use the lighting room "${lightRoom}".`);
  if (climateZone) lines.push(`- For temperature/climate here, use the climate zone "${climateZone}".`);
  if (sonosRoom) lines.push(`- For music here, use the Sonos room "${sonosRoom}".`);
  if (!climateZone) lines.push('- This room may not have its own thermostat; if there\'s no matching climate zone, say so briefly rather than guessing.');
  if (!sonosRoom) lines.push('- This room may not have its own Sonos; if there\'s no matching music room, say so briefly rather than guessing.');
  return lines.join('\n') + '\n';
}

function buildInstructions(roomsData, scenesData, synthetic, climateZones, sonosRooms, panelRoom) {
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

  const climateList = (climateZones && climateZones.length)
    ? climateZones.map(z => `    - ${z}`).join('\n')
    : '    (none found)';
  const sonosList = (sonosRooms && sonosRooms.length)
    ? sonosRooms.map(r => `    - ${r}`).join('\n')
    : '    (none found)';

  // Personality/voice is editable by Simon (house-persona.md); the deterministic
  // behaviour + house data below stays in code.
  return `${houseMemory.readPersona()}

CORE BEHAVIOUR
- When asked to change something, CALL THE TOOL. Don't just describe it.
- Batch related changes when natural (e.g. "movie mode" = dim + fireplace on).
- If a room, zone, or output is ambiguous, ask one short clarifying question.
- To answer "what's on?" call get_state; for temperature call get_climate; for
  "what's playing" call get_music_state. Then summarise briefly.
- Levels are 0-100. "Off" = 0. "Full"/"bright" = 100. "Dim"/"low" ~ 25-30.
- Fireplaces are ON/OFF only: use set_fireplace with on=true/false.

CLIMATE (Ecobee zones)
- Temperatures are Fahrenheit. "Warmer"/"cooler" = adjust ~2-3°F from current;
  call get_climate first if you need the current setpoint.
- set_temperature holds a target; set_hvac_mode switches heat/cool/auto/off;
  resume_climate_schedule cancels a hold.
- Match the spoken room to the closest zone name below. If unclear, ask.

MUSIC (Sonos)
- play_music takes a natural query + a room, searches (Spotify) and plays it.
  e.g. "play Michael Jackson Beat It in the kitchen".
- control_music for play/pause/skip; set_music_volume for louder/quieter
  (use delta +/-10 for "turn it up/down", absolute for "set to 40").
- Match the spoken room to the closest Sonos room name below.

HELPFUL SCENE SHORTHAND
- "All off" / "everything off" → all_off (lights only).
- "Fireplaces on/off" → fire_synthetic_scene with the matching synthetic id.

THE HOUSE (lighting rooms grouped by zone, with the outputs in each):
${zones}

FIREPLACES (on/off switches):
${fires}

LIGHTING SCENES you can fire:
  Pico scenes:
${homeScenes || '    (none)'}
  Synthetic scenes:
${synthScenes || '    (none)'}

CLIMATE ZONES (thermostats):
${climateList}

SONOS MUSIC ROOMS:
${sonosList}

Cameras are coming soon — you can't see them yet.
${buildRoomContext(panelRoom, roomsData, climateZones, sonosRooms)}

MEMORY
- When Simon explicitly asks you to remember something ("remember that...",
  "note that...", "from now on..."), CALL the remember tool with a short, clear
  fact. Then confirm out loud in a few words ("Got it — I'll remember that").
- Only use remember when he actually asks you to remember. Don't record ordinary
  commands or chit-chat.

WAKE-WORD CONVERSATION STYLE (voice)
- This is a hands-free voice panel triggered by a wake word ("Hey Jony"). Often
  the person says only the wake word and waits, THEN gives the request.
- On a new session, OPEN with a very short, natural acknowledgement and then
  stop and listen — e.g. "Yeah?", "What's up?", "How can I help?". One breath,
  no menu, no listing what you can do.
- Keep every spoken reply short and conversational. This is voice, not an essay.
- SIGNING OFF: when the person signals they're done ("that's all", "thanks Jony",
  "nothing else", "that'll do", "never mind"), CALL the end_conversation tool.
  When you say goodbye, end like a human on a call — a warm one-liner with a
  natural closer ("No problem, catch you later!", "Anytime — bye!", "Sure, see
  you!"). NEVER narrate the mechanics of ending (no "let me close things out",
  "ending the call", "hanging up now"). Also call end_conversation on a clear
  goodbye.
- Do not call end_conversation while a request is still in progress.${houseMemory.instructionsBlock()}`;
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

    // ---- Climate (Ecobee) ----
    {
      type: 'function',
      name: 'get_climate',
      description: 'Read current climate for all zones (or one): actual temp, humidity, mode, setpoints, and whether a hold is active. Call before answering any "how warm/cold is" or "what is the temperature" question.',
      parameters: {
        type: 'object',
        properties: {
          zone: { type: 'string', description: 'Optional exact thermostat/zone name to filter to one.' },
        },
      },
    },
    {
      type: 'function',
      name: 'set_temperature',
      description: 'Set/hold a target temperature for a climate zone. Provide the zone name and the desired temperature in Fahrenheit. Use for "make the kitchen warmer", "set the master to 70", etc.',
      parameters: {
        type: 'object',
        properties: {
          zone: { type: 'string', description: 'Exact thermostat/zone name.' },
          temperature: { type: 'integer', description: 'Target temperature in Fahrenheit (e.g. 70).' },
        },
        required: ['zone', 'temperature'],
      },
    },
    {
      type: 'function',
      name: 'set_hvac_mode',
      description: 'Set a climate zone to heat, cool, auto, or off.',
      parameters: {
        type: 'object',
        properties: {
          zone: { type: 'string', description: 'Exact thermostat/zone name.' },
          mode: { type: 'string', enum: ['heat', 'cool', 'auto', 'off'] },
        },
        required: ['zone', 'mode'],
      },
    },
    {
      type: 'function',
      name: 'resume_climate_schedule',
      description: 'Cancel a manual hold and resume the normal schedule for a climate zone (or all zones if zone omitted).',
      parameters: {
        type: 'object',
        properties: {
          zone: { type: 'string', description: 'Exact thermostat/zone name, or omit for all zones.' },
        },
      },
    },

    // ---- Music (Sonos) ----
    {
      type: 'function',
      name: 'play_music',
      description: 'Search for music and play it in a room. Use for "play Beat It in the kitchen", "put on some Miles Davis in the lounge". Provide a natural search query and the room.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to play, e.g. "Michael Jackson Beat It" or "Miles Davis Kind of Blue".' },
          room: { type: 'string', description: 'Exact Sonos room name (e.g. Kitchen, Lounge, Pool).' },
          type: { type: 'string', enum: ['track', 'album', 'artist', 'playlist'], description: 'What kind of result to prefer. Default track.' },
        },
        required: ['query', 'room'],
      },
    },
    {
      type: 'function',
      name: 'control_music',
      description: 'Transport control for a Sonos room: play, pause, stop, next, previous.',
      parameters: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Exact Sonos room name.' },
          action: { type: 'string', enum: ['play', 'pause', 'stop', 'next', 'previous'] },
        },
        required: ['room', 'action'],
      },
    },
    {
      type: 'function',
      name: 'set_music_volume',
      description: 'Set or adjust the volume of a Sonos room. Give either an absolute volume 0-100, or a relative delta (e.g. +10, -10 for "turn it up/down").',
      parameters: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Exact Sonos room name.' },
          volume: { type: 'integer', minimum: 0, maximum: 100, description: 'Absolute volume 0-100.' },
          delta: { type: 'integer', description: 'Relative change, e.g. 10 or -10.' },
        },
        required: ['room'],
      },
    },
    {
      type: 'function',
      name: 'get_music_state',
      description: 'Get what is playing across Sonos rooms (or one room). Call before answering "what is playing".',
      parameters: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Optional exact Sonos room name to filter to one.' },
        },
      },
    },
    {
      type: 'function',
      name: 'remember',
      description: 'Save a fact or preference to long-term memory. ONLY call this when Simon explicitly asks you to remember/note something (e.g. "remember that I like the lounge at 30% in the evenings"). Do not use for ordinary commands.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'A short, clear statement of what to remember, phrased as a durable fact or preference.' },
        },
        required: ['fact'],
      },
    },
    {
      type: 'function',
      name: 'end_conversation',
      description: 'Hang up / end the voice conversation. Call this AFTER you have spoken a brief sign-off, when the person has signalled they are done ("thanks", "that\'s all", "nothing else", "goodbye"). Do not call it while a request is still being handled.',
      parameters: { type: 'object', properties: {} },
    },
  ];
}

function buildSessionConfig(roomsData, scenesData, synthetic, climateZones, sonosRooms, panelRoom) {
  return {
    type: 'realtime',
    model: MODEL,
    audio: {
      output: { voice: VOICE },
      // Tune server-side VAD so speaker echo / background noise doesn't
      // constantly interrupt Jony mid-sentence on a wall panel. Higher threshold
      // + longer required silence + more prefix padding = fewer false barge-ins.
      // We keep interrupt_response=true so a real user CAN still cut in.
      input: {
        turn_detection: {
          type: 'server_vad',
          threshold: 0.75,
          prefix_padding_ms: 400,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true,
        },
      },
    },
    instructions: buildInstructions(roomsData, scenesData, synthetic, climateZones, sonosRooms, panelRoom),
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

module.exports = { MODEL, VOICE, buildInstructions, buildSessionConfig, mintClientSecret, loadApiKey };
