#!/usr/bin/env node
// Build a clean rooms-with-outputs JSON from the extracted Lutron project XML.
// Reads lutron-158.xml, writes rooms.json used by server.js at boot.

import fs from 'node:fs';
import path from 'node:path';

const XML_PATH = '/Users/jony/.openclaw/workspace/memory/home-control/lutron-158.xml';
const OUT_PATH = new URL('./rooms.json', import.meta.url).pathname;

const xml = fs.readFileSync(XML_PATH, 'utf8');

// Walk Area open/close tags + Output tags in order, so we assign each output
// to its NEAREST enclosing Area (Lutron nests Areas).
const tokenRe = /<Area\s+Name="([^"]+)"\s+UUID="\d+"\s+IntegrationID="(\d+)"[^>]*>|<\/Area>|<Output\s+Name="([^"]+)"\s+UUID="\d+"\s+IntegrationID="(\d+)"\s+OutputType="([^"]+)"[^>]*\/>/g;

const rooms = new Map(); // key: `${areaId}:${areaName}` -> { id, name, path, outputs: [] }
const stack = [];
let m;
while ((m = tokenRe.exec(xml)) !== null) {
  const t = m[0];
  if (t.startsWith('<Area ')) {
    const name = m[1];
    const id = parseInt(m[2], 10);
    const path = [...stack.map(s => s.name), name].join(' > ');
    const entry = { id, name, path, outputs: [] };
    stack.push(entry);
  } else if (t.startsWith('</Area>')) {
    const entry = stack.pop();
    if (entry && entry.outputs.length > 0) {
      const key = `${entry.id}:${entry.name}`;
      rooms.set(key, entry);
    }
  } else if (t.startsWith('<Output ')) {
    if (stack.length > 0) {
      stack[stack.length - 1].outputs.push({
        id: parseInt(m[4], 10),
        name: m[3],
        type: m[5],
      });
    }
  }
}

// Also flush any still-open areas that have outputs (should not happen but safe)
for (const entry of stack) {
  if (entry.outputs.length > 0) {
    const key = `${entry.id}:${entry.name}`;
    rooms.set(key, entry);
  }
}

// Convert to array, sort by path
const roomsArr = [...rooms.values()].sort((a, b) => a.path.localeCompare(b.path));

// Skip the top-level "Berg Residence" umbrella if it has no direct outputs of its own
// (it always has all its children's outputs bubbled up via nesting; keep only leaves)
// Actually, Lutron's structure has "Berg Residence" as root, all real rooms are children.
// A room is a "leaf" if no other room's path starts with its path + " > "
const isLeaf = (room) => !roomsArr.some(other =>
  other !== room && other.path.startsWith(room.path + ' > ')
);
const leafRooms = roomsArr.filter(isLeaf);

// Build final structure
const output = {
  generated_at: new Date().toISOString(),
  source: XML_PATH,
  total_outputs: leafRooms.reduce((sum, r) => sum + r.outputs.length, 0),
  total_rooms: leafRooms.length,
  rooms: leafRooms.map(r => ({
    id: r.id,
    name: r.name,
    path: r.path,
    slug: r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    outputs: r.outputs.sort((a, b) => a.id - b.id),
  })),
};

fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${output.total_rooms} rooms, ${output.total_outputs} outputs total`);

// Print summary
for (const r of output.rooms) {
  console.log(`  [${r.id.toString().padStart(3)}] ${r.name.padEnd(30)} ${r.outputs.length} outputs`);
}
