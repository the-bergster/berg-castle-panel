#!/usr/bin/env node
// Parse the Lutron project XML for every Pico keypad, extract its buttons
// with engravings and (roughly) the room it lives in.
// Output: picos.json — used by server.js to expose scene buttons in the UI.

import fs from 'node:fs';
import path from 'node:path';

const XML_PATH = '/Users/jony/.openclaw/workspace/memory/home-control/lutron-158.xml';
const OUT_PATH = new URL('./picos.json', import.meta.url).pathname;

const xml = fs.readFileSync(XML_PATH, 'utf8');

// Walk Areas + Devices (Picos are Devices with DeviceType="PICO_KEYPAD") + their Button components.
// Areas nest. Track the current Area stack so we know where each Pico lives.

const tokenRe = /<Area\s+Name="([^"]+)"\s+UUID="\d+"\s+IntegrationID="(\d+)"[^>]*>|<\/Area>|<Device\s+Name="([^"]+)"\s+UUID="\d+"\s+SerialNumber="(\d+)"\s+IntegrationID="(\d+)"\s+DeviceType="PICO_KEYPAD"[^>]*>|<\/Device>|<Component\s+ComponentNumber="(\d+)"\s+ComponentType="BUTTON">|<\/Component>|<Button\s+Name="([^"]+)"\s+UUID="\d+"\s+Engraving="([^"]*)"[^>]*>|<PresetAssignment[^>]*><Delay>[^<]*<\/Delay><Fade>[^<]*<\/Fade><Level>([\d.]+)<\/Level><IntegrationID>(\d+)<\/IntegrationID><\/PresetAssignment>/g;

function decodeEntities(s) {
  return s.replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const areaStack = [];
const picos = [];
let currentPico = null;
let currentButton = null;

let m;
while ((m = tokenRe.exec(xml)) !== null) {
  const t = m[0];
  if (t.startsWith('<Area ')) {
    areaStack.push({ name: decodeEntities(m[1]), id: parseInt(m[2], 10) });
  } else if (t === '</Area>') {
    areaStack.pop();
  } else if (t.startsWith('<Device ') && t.includes('PICO_KEYPAD')) {
    currentPico = {
      name: decodeEntities(m[3]),
      serial: m[4],
      id: parseInt(m[5], 10),
      area: areaStack.length ? areaStack[areaStack.length - 1] : null,
      area_path: areaStack.map(a => a.name).join(' > '),
      buttons: [],
    };
    picos.push(currentPico);
  } else if (t === '</Device>') {
    currentPico = null;
  } else if (t.startsWith('<Component ')) {
    if (currentPico) {
      currentButton = {
        component_number: parseInt(m[6], 10),
        assignments: [],
      };
    }
  } else if (t === '</Component>') {
    if (currentPico && currentButton && currentButton.engraving !== undefined) {
      currentPico.buttons.push(currentButton);
    }
    currentButton = null;
  } else if (t.startsWith('<Button ')) {
    if (currentButton) {
      currentButton.button_name = decodeEntities(m[7]);
      currentButton.engraving = decodeEntities(m[8]);
    }
  } else if (t.startsWith('<PresetAssignment')) {
    if (currentButton) {
      currentButton.assignments.push({
        integration_id: parseInt(m[10], 10),
        level: parseFloat(m[9]),
      });
    }
  }
}

// Filter to picos that have at least one button with an engraving and at least one assignment
// (i.e. actually programmed buttons users would want to trigger)
const usefulPicos = picos.map(p => {
  const usefulButtons = p.buttons.filter(b => b.engraving && b.engraving.trim() && b.assignments.length > 0);
  return { ...p, buttons: usefulButtons };
}).filter(p => p.buttons.length > 0);

// Group by area
const byArea = {};
for (const p of usefulPicos) {
  const areaName = p.area?.name || 'Other';
  if (!byArea[areaName]) byArea[areaName] = [];
  byArea[areaName].push(p);
}

const out = {
  generated_at: new Date().toISOString(),
  total_picos: usefulPicos.length,
  total_buttons: usefulPicos.reduce((s, p) => s + p.buttons.length, 0),
  picos: usefulPicos.sort((a, b) => (a.area_path || '').localeCompare(b.area_path || '')),
  by_area: byArea,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${out.total_picos} programmed picos, ${out.total_buttons} scene buttons`);
console.log('');
console.log('=== Picos by area ===');
for (const p of out.picos) {
  console.log(`\n${p.area_path || '(no area)'} — ${p.name} [id=${p.id}]`);
  for (const b of p.buttons) {
    const affected = b.assignments.length;
    console.log(`  btn #${b.component_number.toString().padStart(2)}  "${b.engraving}"  → ${affected} loads`);
  }
}
