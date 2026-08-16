// Room data loader + zone grouping + soft renames + cross-room output moves.
// Reads rooms.json + applies human-authored organizational overrides on top.
// Lutron programming is never touched — these are all "app-level" refinements.

const fs = require('fs');
const path = require('path');

// -------- Zone assignments (keyed by Lutron area id) --------

const ZONE_MAP = {
  // Dining & Entertaining
  58: 'Dining',   // Dining Room
  82: 'Dining',   // Dining Bathroom
  40: 'Dining',   // Lounge — biggest entertaining space

  // Kitchen
  67: 'Kitchen',  // Kitchen (main)
  74: 'Kitchen',  // Butler's Pantry
  207: 'Kitchen', // Extractor Fan Kitchen

  // Offices
  61: 'Offices',  // Office
  198: 'Offices', // Office 2 → renamed to Office Equipment below
  29: 'Offices',  // Dovile Office

  // Entryways
  52: 'Entryways',   // Foyer
  55: 'Entryways',   // Foyer Bathroom
  63: 'Entryways',   // Side Foyer

  // Living Spaces
  43: 'Living',   // Sun Room → renamed to Kids Lounge
  6: 'Living',    // Gym

  // Utility
  81: 'Utility',  // Basement
  165: 'Utility', // Laundry Room

  // Upstairs Hall (new zone)
  19: 'Upstairs Hall',  // Bedroom Hall
  211: 'Upstairs Hall', // Reading Nook Upstairs
  24: 'Upstairs Hall',  // Bedroom Hall Bathroom
  87: 'Upstairs Hall',  // Bedroom Hall Stairs Bathroom

  // Master Suite
  5: 'Master Suite',
  125: 'Master Suite',
  126: 'Master Suite',

  // Bedrooms (Dovile Office removed; hall bathrooms moved to Upstairs Hall)
  32: 'Bedrooms',  // Kids Bedroom
  33: 'Bedrooms',  // Kids Playroom
  28: 'Bedrooms',  // Bedroom One
  18: 'Bedrooms',  // Bedroom 3
  31: 'Bedrooms',  // Bedroom Four

  // Spa
  176: 'Spa',

  // Fireplaces (kept as its own room/tile — outputs render as switches)
  140: 'Fireplaces',

  // Outside
  46: 'Outside',
  170: 'Outside',
  168: 'Outside',
  173: 'Outside',
  143: 'Outside',
  190: 'Outside',
  214: 'Outside',
};

const ZONE_ORDER = [
  'Kitchen',
  'Dining',
  'Offices',
  'Entryways',
  'Living',
  'Upstairs Hall',
  'Master Suite',
  'Bedrooms',
  'Utility',
  'Spa',
  'Fireplaces',
  'Outside',
  'Other',
];

// -------- Room name overrides --------

const NAME_OVERRIDES = {
  74: "Butler's Pantry",  // was "Buttler&apos;s Pantry"
  43: 'Kids Lounge',      // was "Sun Room"
  198: 'Office Equipment',// was "Office 2"
  19: 'Hallway',          // Bedroom Hall → the main upstairs hallway
  211: 'Reading Nook',    // Reading Nook Upstairs → shortened
  24: 'Hall Bathroom',    // Bedroom Hall Bathroom → shortened
  87: 'Stairs Bathroom',  // Bedroom Hall Stairs Bathroom → shortened
};

// -------- Output-level overrides (rename + hide) --------
const OUTPUT_NAME_OVERRIDES = {
  59: 'Recessed',           // was "Receesed" (Dining Room)
  34: 'Pendant',            // was "Pedant" (Bedroom One)
  106: 'Under Cabinet',     // was "under cabinet" (Kitchen) — caps consistency
  105: 'Under Cabinet',     // was "Under cabinet" (Butler's Pantry) — caps consistency
  169: 'Playground Interior', // was "Playgroung interior" (Playground)
  9: 'Sitting Recessed',    // was "Sitting Recesssed" (Master Suite)
  11: 'Bed Lounge Outlet',  // was "Outlet" — more descriptive
};

const HIDDEN_OUTPUT_IDS = new Set([
  70,   // Kitchen "?" — dead switch, hide per Simon 2026-07-30
]);

// -------- Cross-room output moves --------
// (Fireplaces used to be redistributed into their home rooms; Simon asked
//  2026-08-16 to keep them together in a dedicated "Fireplaces" tile, rendered
//  as switches rather than sliders. So no fireplace moves anymore.)
// Format: { output_id: target_area_id }
const OUTPUT_MOVES = {};

// Output ids that live in the Fireplaces room — flagged so the UI renders them
// as on/off switches instead of dimmer sliders.
const FIREPLACE_OUTPUT_IDS = new Set([80, 151, 152, 154]);

// Rooms to drop entirely from the UI (they get emptied out by output moves)
const DROP_ROOM_IDS = new Set([
  207, // Extractor Fan Kitchen — merged into Kitchen (its lone output moves)
]);

// Cross-room output moves for the Extractor Fan
const EXTRACTOR_MOVE = { 208: 67 }; // #208 Extractor Kitchen → Kitchen area (id 67)

// -------- Helpers --------

function decodeEntities(s) {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// -------- Loader --------

function loadRooms() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'rooms.json'), 'utf8'));

  // Build lookup: raw room by id
  const rawById = new Map(raw.rooms.map(r => [r.id, r]));

  // Start with rooms shallow-copied, name-overridden, entities decoded
  const rooms = raw.rooms
    .filter(r => !DROP_ROOM_IDS.has(r.id))
    .map(r => ({
      id: r.id,
      name: NAME_OVERRIDES[r.id] || decodeEntities(r.name),
      path: r.path,
      slug: r.slug,
      outputs: r.outputs
        .filter(o => !HIDDEN_OUTPUT_IDS.has(o.id))
        .map(o => ({
          ...o,
          name: OUTPUT_NAME_OVERRIDES[o.id] || decodeEntities(o.name),
          _origin_room_id: r.id,
          isFireplace: FIREPLACE_OUTPUT_IDS.has(o.id),
        })),
      zone: ZONE_MAP[r.id] || 'Other',
    }));

  const roomById = new Map(rooms.map(r => [r.id, r]));

  // Apply output moves (fireplaces + extractor).
  const allMoves = { ...OUTPUT_MOVES, ...EXTRACTOR_MOVE };
  for (const [outputIdStr, targetRoomId] of Object.entries(allMoves)) {
    const outputId = parseInt(outputIdStr, 10);
    if (HIDDEN_OUTPUT_IDS.has(outputId)) continue;
    // Find source (search all raw rooms, including dropped ones)
    let sourceOutput = null;
    for (const rawRoom of raw.rooms) {
      const match = rawRoom.outputs.find(o => o.id === outputId);
      if (match) {
        sourceOutput = {
          ...match,
          name: OUTPUT_NAME_OVERRIDES[outputId] || decodeEntities(match.name),
          _origin_room_id: rawRoom.id,
        };
        break;
      }
    }
    if (!sourceOutput) continue;

    // Remove from any current room in `rooms`
    for (const r of rooms) {
      r.outputs = r.outputs.filter(o => o.id !== outputId);
    }
    // Add to target
    const target = roomById.get(targetRoomId);
    if (target) target.outputs.push(sourceOutput);
  }

  // Sort each room's outputs by id for stable display
  for (const r of rooms) r.outputs.sort((a, b) => a.id - b.id);

  // Drop rooms that ended up with zero outputs (shouldn't happen but safe)
  const finalRooms = rooms.filter(r => r.outputs.length > 0);

  // Group by zone
  const zones = {};
  for (const zoneName of ZONE_ORDER) zones[zoneName] = [];
  for (const room of finalRooms) {
    if (!zones[room.zone]) zones[room.zone] = [];
    zones[room.zone].push(room);
  }
  for (const zone of Object.values(zones)) {
    zone.sort((a, b) => a.name.localeCompare(b.name));
  }
  const zonesArr = ZONE_ORDER
    .filter(name => zones[name] && zones[name].length > 0)
    .map(name => ({ name, rooms: zones[name] }));
  for (const [name, roomList] of Object.entries(zones)) {
    if (!ZONE_ORDER.includes(name) && roomList.length > 0) {
      zonesArr.push({ name, rooms: roomList });
    }
  }

  return {
    total_rooms: finalRooms.length,
    total_outputs: finalRooms.reduce((s, r) => s + r.outputs.length, 0),
    rooms: finalRooms,
    zones: zonesArr,
    all_output_ids: finalRooms.flatMap(r => r.outputs.map(o => o.id)),
  };
}

module.exports = { loadRooms };
