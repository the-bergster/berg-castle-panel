// Wall-panel settings — a tiny owner-editable JSON store.
//
// These are DEVICE behaviours for the wall-mounted iPad (keep-awake + wake word),
// but Simon wanted a single settings home, so they're edited in the web admin
// and the native app READS them and does the OS-level work. This module is the
// persistence + defaults; admin.js exposes the read/write endpoints.

const fs = require('fs');
const path = require('path');

// Stored alongside the other panel secrets/state so it survives restarts and
// isn't in the git tree.
const STORE_DIR = path.join(
  process.env.HOME || '/Users/jony',
  '.openclaw', 'workspace', '.secrets', 'berg-castle-watch'
);
const STORE_PATH = path.join(STORE_DIR, 'wall-settings.json');

const DEFAULTS = Object.freeze({
  // Master switch: this device acts as an always-on wall panel (keep-awake).
  wallMode: false,
  // On-device "Hey Jony" wake word (only meaningful when wallMode is true).
  wakeWord: false,
  // This panel may act as an on-demand room camera (publishes front camera via
  // WHIP only while someone is viewing). Only meaningful when wallMode is true.
  camera: false,
});

function read() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      wallMode: !!parsed.wallMode,
      wakeWord: !!parsed.wakeWord,
      camera: !!parsed.camera,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(next) {
  const cur = read();
  const merged = {
    wallMode: next.wallMode === undefined ? cur.wallMode : !!next.wallMode,
    wakeWord: next.wakeWord === undefined ? cur.wakeWord : !!next.wakeWord,
    camera: next.camera === undefined ? cur.camera : !!next.camera,
  };
  // Wake word + camera are meaningless without wall mode — keep state coherent.
  if (!merged.wallMode) { merged.wakeWord = false; merged.camera = false; }
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error('[wall-settings] write failed:', e.message);
  }
  return merged;
}

module.exports = { read, write, DEFAULTS };
