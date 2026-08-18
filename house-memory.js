// house-memory.js — Command-only memory + editable system-prompt override for the
// Berg Castle voice agent.
//
// Design (agreed with Simon 2026-08-18):
//   - ONE dated memory file. Loaded in full into every voice session.
//   - The agent only writes when Simon explicitly says "remember ..." (the
//     `remember` tool). No autonomous capture, no self-editing behaviour.
//   - Simon curates via the admin panel: edit the system-prompt override, and
//     view / prune the memory file. Both are his-eyes-only (admin gated).
//   - Two-tier (distilled main + daily recall) deferred until volume demands it.
//     Dates are already in the file, so that split is a clean migration later.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.HOME || '/Users/jony',
  '.openclaw/workspace/.secrets/berg-castle-watch');
const MEMORY_FILE = path.join(DATA_DIR, 'house-memory.md');
const PROMPT_FILE = path.join(DATA_DIR, 'house-prompt-override.md');
const PERSONA_FILE = path.join(DATA_DIR, 'house-persona.md');

// Default personality/voice (editable by Simon). This is the non-functional,
// pure-personality opening of the system prompt. The deterministic house-data +
// behaviour rules stay in voice.js buildInstructions and are NOT editable here.
const DEFAULT_PERSONA = `You are Jony, the voice of Berg Castle — Simon Berg's smart home. Your name
is Jony; if anyone asks who you are or what you're called, say you're Jony. You
control the lighting, fireplaces, scenes, climate, and music by calling tools. You
are warm, brief, and confident. Speak like a capable house manager, not a chatbot. Confirm
actions in a few words ("Lounge is at 30%", "Kitchen set to 70", "Playing Beat It
in the kitchen"). Never read out numeric IDs unless asked.`;

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function todayStamp() {
  // Local (America/New_York) date, YYYY-MM-DD.
  const d = new Date();
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return p; // en-CA gives YYYY-MM-DD
}

// ---- Memory ----

function readMemory() {
  try { return fs.readFileSync(MEMORY_FILE, 'utf8'); } catch (_) { return ''; }
}

function writeMemory(content) {
  ensureDir();
  fs.writeFileSync(MEMORY_FILE, content, 'utf8');
}

// Append a fact under today's date heading. Command-only — called by the
// `remember` tool when Simon explicitly asks.
function remember(fact) {
  const clean = String(fact || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { ok: false, error: 'nothing to remember' };
  ensureDir();
  let content = readMemory();
  const stamp = todayStamp();
  const heading = `## ${stamp}`;
  if (!content.includes(heading)) {
    content = content.trimEnd();
    content += (content ? '\n\n' : '') + heading + '\n';
  }
  // Insert the bullet under the (last) today heading.
  const lines = content.split('\n');
  // find index of today's heading, then the end of its block
  let hIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) { hIdx = i; break; }
  }
  const bullet = `- ${clean}`;
  if (hIdx === -1) {
    lines.push(heading, bullet);
  } else {
    // find where today's block ends (next heading or EOF)
    let end = lines.length;
    for (let i = hIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { end = i; break; }
    }
    lines.splice(end, 0, bullet);
  }
  // Tidy: collapse blank lines between consecutive bullets so a day's notes sit
  // together, but keep one blank line before each date heading.
  let out = lines.join('\n')
    .replace(/\n{2,}(- )/g, '\n$1')       // no blank line between bullets
    .replace(/\n{3,}/g, '\n\n')            // never more than one blank line
    .replace(/([^\n])\n(## )/g, '$1\n\n$2') // one blank line before a heading
    .trimEnd() + '\n';
  writeMemory(out);
  return { ok: true, remembered: clean, date: stamp };
}

// ---- Personality (editable voice/tone; defaults baked in) ----

function readPersona() {
  try {
    const t = fs.readFileSync(PERSONA_FILE, 'utf8');
    return t.trim() ? t.trim() : DEFAULT_PERSONA;
  } catch (_) { return DEFAULT_PERSONA; }
}

function writePersona(text) {
  ensureDir();
  const clean = String(text || '').trim();
  // Empty string = reset to default (delete the file).
  if (!clean) { try { fs.unlinkSync(PERSONA_FILE); } catch (_) {} return; }
  fs.writeFileSync(PERSONA_FILE, clean, 'utf8');
}

// ---- System-prompt override ----

function readPromptOverride() {
  try { return fs.readFileSync(PROMPT_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function writePromptOverride(text) {
  ensureDir();
  fs.writeFileSync(PROMPT_FILE, String(text || ''), 'utf8');
}

// ---- Injection block for buildSessionConfig ----
// Returns the text to append to the base instructions each session.
function instructionsBlock() {
  const mem = readMemory().trim();
  const override = readPromptOverride();
  let out = '';
  if (override) {
    out += `\n\n--- OWNER INSTRUCTIONS (set by Simon, take priority) ---\n${override}`;
  }
  if (mem) {
    out += `\n\n--- THINGS SIMON HAS ASKED YOU TO REMEMBER ---\n` +
      `These are facts and preferences Simon explicitly told you to remember. ` +
      `Honour them. If one conflicts with a live request, follow the live request.\n\n${mem}`;
  }
  return out;
}

module.exports = {
  MEMORY_FILE, PROMPT_FILE, PERSONA_FILE, DEFAULT_PERSONA,
  readMemory, writeMemory, remember,
  readPersona, writePersona,
  readPromptOverride, writePromptOverride,
  instructionsBlock, todayStamp,
};
