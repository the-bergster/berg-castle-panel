// Classify + curate Pico buttons into "scenes".
// - Big scenes = high-impact multi-room ones that go on the Home page
// - Room scenes = go inside room detail
// - Skip = "On", "Off", "Raise", "Lower", "Favorite" — trivial per-load controls

const fs = require('fs');
const path = require('path');

const TRIVIAL_ENGRAVINGS = new Set(['on', 'off', 'raise', 'lower', 'favorite', 'favourite']);

// Home scene chips Simon has explicitly removed from the top strip.
// These scenes are still triggerable elsewhere (inside their room detail views)
// but hidden from the always-visible home-page scroll strip.
const HIDDEN_HOME_ENGRAVINGS = new Set([
  'welcome',      // Simon doesn't use it
  'comfortable',  // Simon doesn't use it
  'magic',        // Simon doesn't use it
  'house off',    // Redundant with All Off (Side Foyer Off superset); remove per 2026-07-30
]);

// Emoji picker for scene labels
function emojiFor(engraving) {
  const e = engraving.toLowerCase();
  // Match specific compound scenes first, before generic "off"
  if (e.includes('hall on') || e.includes('hall off')) return '🪜';
  if (e.includes('welcome')) return '👋';
  if (e.includes('house off') || e.includes('all off') || e === 'off') return '⏻';
  if (e.includes('bedtime') || e.includes('sleep') || e.includes('goodnight')) return '🌙';
  if (e.includes('morning') || e.includes('wake')) return '🌅';
  if (e.includes('evening') || e.includes('cozy') || e.includes('cosy')) return '🕯️';
  if (e.includes('movie') || e.includes('chill')) return '🎬';
  if (e.includes('bright')) return '☀️';
  if (e.includes('magic')) return '✨';
  if (e.includes('garden')) return '🌿';
  if (e.includes('showering') || e.includes('shower')) return '🚿';
  if (e.includes('medium')) return '🔆';
  if (e.includes('low')) return '🌘';
  if (e.includes('upstairs')) return '⬆️';
  if (e.includes('comfortable') || e.includes('comfort')) return '🛋️';
  return '💡';
}

function loadScenes(picosPath, roomsPath) {
  const picos = JSON.parse(fs.readFileSync(picosPath, 'utf8'));
  const rooms = JSON.parse(fs.readFileSync(roomsPath, 'utf8'));

  // Build room lookup by id (Lutron area id)
  const roomsById = new Map(rooms.rooms.map(r => [r.id, r]));

  const allScenes = [];
  const bigScenes = [];       // for home page — hit 20+ loads across the house
  const scenesByRoom = new Map(); // room area id -> scenes list

  for (const pico of picos.picos) {
    for (const btn of pico.buttons) {
      const eng = btn.engraving.trim();
      if (!eng) continue;
      if (TRIVIAL_ENGRAVINGS.has(eng.toLowerCase())) continue; // handled by direct output controls
      if (btn.assignments.length === 0) continue;

      const scene = {
        pico_id: pico.id,
        pico_name: pico.name,
        button: btn.component_number,
        label: eng,
        emoji: emojiFor(eng),
        affected_count: btn.assignments.length,
        area: pico.area?.name || 'Other',
        area_id: pico.area?.id || 0,
      };
      allScenes.push(scene);

      // Big scene heuristic: 15+ affected loads OR engraving contains a known big-scene word
      const isBig = btn.assignments.length >= 15 ||
                    /welcome|house|whole|morning|bedtime|evening|goodnight|garden|hall on|hall off/i.test(eng);
      // Exclude explicitly hidden ones from home strip
      if (isBig && !HIDDEN_HOME_ENGRAVINGS.has(eng.toLowerCase())) bigScenes.push(scene);

      // Room-scoped scenes (only if the pico's own area has that room)
      const room = roomsById.get(pico.area?.id);
      if (room) {
        if (!scenesByRoom.has(room.id)) scenesByRoom.set(room.id, []);
        scenesByRoom.get(room.id).push(scene);
      }
    }
  }

  // For big scenes on home page: dedupe by (label lower, affected_count within 5)
  // so we don't show 3 identical "Evening" scenes from Whole House Mood 1/2/3
  const seen = new Map();
  for (const s of bigScenes) {
    const key = `${s.label.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, s);
    else {
      // Prefer the one from "Whole House Mood" area, or with more affected loads
      const prev = seen.get(key);
      if (s.area.toLowerCase().includes('whole') && !prev.area.toLowerCase().includes('whole')) {
        seen.set(key, s);
      } else if (s.affected_count > prev.affected_count) {
        seen.set(key, s);
      }
    }
  }
  const homeScenes = [...seen.values()].sort((a, b) => {
    // Priority order for common ones (top of scroll strip = most-used first)
    const order = ['welcome', 'morning', 'evening', 'cozy', 'cosy', 'movie', 'chill', 'bright',
      'garden on', 'garden off', 'hall on', 'hall off', 'upstairs off',
      'bedtime', 'goodnight', 'house off', 'sleep', 'all off', 'off'];
    const av = order.findIndex(o => a.label.toLowerCase().includes(o));
    const bv = order.findIndex(o => b.label.toLowerCase().includes(o));
    if (av === -1 && bv === -1) return b.affected_count - a.affected_count;
    if (av === -1) return 1;
    if (bv === -1) return -1;
    return av - bv;
  });

  // The MASTER Off — pick the widest "off" scene available.
  // NOTE: bare "off" engravings are filtered by TRIVIAL_ENGRAVINGS above (so they
  // don't clutter every room's scene chips), so we re-scan the raw picos here to
  // find the truly biggest "Off"-type button anywhere in the house.
  let masterOff = null;
  for (const pico of picos.picos) {
    for (const btn of pico.buttons) {
      const l = (btn.engraving || '').toLowerCase();
      const isOffish = l === 'off' || l === 'house off' || l === 'all off';
      if (!isOffish) continue;
      if (btn.assignments.length < 50) continue; // must be a big off (not per-load)
      if (!masterOff || btn.assignments.length > masterOff.affected_count) {
        masterOff = {
          pico_id: pico.id,
          pico_name: pico.name,
          button: btn.component_number,
          label: btn.engraving,
          emoji: '⏻',
          affected_count: btn.assignments.length,
          area: pico.area?.name || 'Other',
          area_id: pico.area?.id || 0,
        };
      }
    }
  }

  return {
    all: allScenes,
    home_scenes: homeScenes,
    master_off: masterOff,
    by_room: Object.fromEntries(scenesByRoom),
    total_scenes: allScenes.length,
    total_picos: picos.total_picos,
  };
}

module.exports = { loadScenes };
