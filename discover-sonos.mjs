#!/usr/bin/env node
// discover-sonos.mjs — Sweep 192.168.4.100-199 for Sonos ZonePlayers.
// Every Sonos speaker exposes /xml/device_description.xml on :1400.
// Output: sonos-rooms.json — room name → { ip, uuid, model }.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUBNET_BASE = '192.168.4';
const RANGE_START = 100;
const RANGE_END = 199;
const TIMEOUT_MS = 1500;

async function fetchDesc(ip) {
  const url = `http://${ip}:1400/xml/device_description.xml`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const xml = await res.text();
    return xml;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pick(xml, tag) {
  const re = new RegExp(`<${tag}>([^<]+)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

async function probe(ip) {
  const xml = await fetchDesc(ip);
  if (!xml) return null;
  if (!/Sonos/i.test(xml)) return null;
  const roomName = pick(xml, 'roomName');
  const uuid = pick(xml, 'UDN')?.replace(/^uuid:/, '');
  const modelName = pick(xml, 'modelName');
  const displayName = pick(xml, 'displayName');
  const zoneType = pick(xml, 'zoneType'); // 8 = subwoofer, 11 = bonded surround
  const isSub = modelName?.toLowerCase().includes('sub') || zoneType === '8';
  return {
    ip,
    uuid,
    room: roomName,
    model: displayName || modelName,
    zone_type: zoneType,
    is_sub: !!isSub,
  };
}

async function main() {
  const outPath = path.join(__dirname, 'sonos-rooms.json');
  console.log(`Scanning ${SUBNET_BASE}.${RANGE_START}-${RANGE_END} for Sonos zones...`);
  const jobs = [];
  for (let i = RANGE_START; i <= RANGE_END; i++) {
    jobs.push(probe(`${SUBNET_BASE}.${i}`));
  }
  const results = (await Promise.all(jobs)).filter(Boolean);
  results.sort((a, b) => (a.room || '').localeCompare(b.room || ''));

  const byRoom = {};
  for (const r of results) {
    if (!r.room) continue;
    if (!byRoom[r.room]) byRoom[r.room] = { room: r.room, coordinators: [], subs: [] };
    if (r.is_sub) byRoom[r.room].subs.push(r);
    else byRoom[r.room].coordinators.push(r);
  }

  const summary = {
    scanned_at: new Date().toISOString(),
    total_devices: results.length,
    total_rooms: Object.keys(byRoom).length,
    rooms: Object.values(byRoom).sort((a, b) => a.room.localeCompare(b.room)),
    all_devices: results,
  };

  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outPath}: ${results.length} devices across ${Object.keys(byRoom).length} rooms.`);
  for (const r of summary.rooms) {
    const coord = r.coordinators[0];
    console.log(`  ${r.room.padEnd(28)} ${coord?.ip || '(no primary)'} ${coord?.model || ''}${r.subs.length ? ` +sub` : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
