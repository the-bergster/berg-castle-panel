// sonos.js — Direct SOAP client for Sonos ZonePlayers on the LAN.
// No auth. No cloud. Talks to port 1400 on each speaker.
//
// Verified endpoints (2026-07-31 by Jony):
//   POST /MediaRenderer/RenderingControl/Control  → volume, mute
//   POST /MediaRenderer/AVTransport/Control       → play/pause/stop, SetAVTransportURI, GetPositionInfo, GetTransportInfo
//   POST /MediaRenderer/GroupRenderingControl/Control → group volume
//   POST /ZoneGroupTopology/Control               → GetZoneGroupAttributes / GetZoneGroupState
//
// This module is deliberately dependency-free. Node 18+ has global fetch.

const fs = require('fs');
const path = require('path');

const ROOMS_FILE = path.join(__dirname, 'sonos-rooms.json');
const SOAP_TIMEOUT_MS = 3000;

function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function loadRooms() {
  try {
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    // Decode room-name entities from raw XML captured by discover-sonos.mjs.
    if (Array.isArray(data.rooms)) {
      for (const r of data.rooms) r.room = decodeEntities(r.room);
    }
    if (Array.isArray(data.all_devices)) {
      for (const d of data.all_devices) d.room = decodeEntities(d.room);
    }
    return data;
  } catch (e) {
    console.warn('[Sonos] no sonos-rooms.json — run discover-sonos.mjs first');
    return { rooms: [], all_devices: [] };
  }
}

const CACHE = loadRooms();

// Quick reverse lookups
function coordinatorFor(room) {
  const r = CACHE.rooms.find((x) => x.room.toLowerCase() === room.toLowerCase());
  return r?.coordinators?.[0] || null;
}

// ---- SOAP helpers ----

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function envelope(bodyXml) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${bodyXml}</s:Body></s:Envelope>`;
}

async function soap(ip, servicePath, serviceType, action, argsXml) {
  const url = `http://${ip}:1400${servicePath}`;
  const soapAction = `"urn:schemas-upnp-org:service:${serviceType}#${action}"`;
  const body = envelope(
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:${serviceType}">${argsXml}</u:${action}>`
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SOAP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPACTION: soapAction,
      },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Sonos SOAP ${action} @ ${ip} → ${res.status}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function pickText(xml, tag) {
  // Handles both <tag>x</tag> and <ns:tag>x</ns:tag>.
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`);
  const m = xml.match(re);
  if (!m) return null;
  const raw = m[1];
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

// ---- Service wrappers ----

async function rendering(ip, action, argsXml) {
  return soap(ip, '/MediaRenderer/RenderingControl/Control', 'RenderingControl:1', action, argsXml);
}

async function avTransport(ip, action, argsXml) {
  return soap(ip, '/MediaRenderer/AVTransport/Control', 'AVTransport:1', action, argsXml);
}

async function zoneGroupTopology(ip, action, argsXml) {
  return soap(ip, '/ZoneGroupTopology/Control', 'ZoneGroupTopology:1', action, argsXml);
}

// ---- Public API ----

async function getVolume(ip) {
  const xml = await rendering(ip, 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>');
  return parseInt(pickText(xml, 'CurrentVolume') || '0', 10);
}

async function setVolume(ip, volume) {
  const v = Math.max(0, Math.min(100, parseInt(volume, 10)));
  await rendering(ip, 'SetVolume', `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${v}</DesiredVolume>`);
  return v;
}

async function getMute(ip) {
  const xml = await rendering(ip, 'GetMute', '<InstanceID>0</InstanceID><Channel>Master</Channel>');
  return pickText(xml, 'CurrentMute') === '1';
}

async function setMute(ip, muted) {
  await rendering(ip, 'SetMute', `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${muted ? 1 : 0}</DesiredMute>`);
  return !!muted;
}

async function play(ip) {
  await avTransport(ip, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
}

async function pause(ip) {
  await avTransport(ip, 'Pause', '<InstanceID>0</InstanceID>');
}

async function stop(ip) {
  await avTransport(ip, 'Stop', '<InstanceID>0</InstanceID>');
}

async function next(ip) {
  try { await avTransport(ip, 'Next', '<InstanceID>0</InstanceID>'); } catch (_) {}
}

async function previous(ip) {
  try { await avTransport(ip, 'Previous', '<InstanceID>0</InstanceID>'); } catch (_) {}
}

async function getTransportInfo(ip) {
  const xml = await avTransport(ip, 'GetTransportInfo', '<InstanceID>0</InstanceID>');
  return {
    state: pickText(xml, 'CurrentTransportState'), // PLAYING | PAUSED_PLAYBACK | STOPPED | TRANSITIONING
    status: pickText(xml, 'CurrentTransportStatus'),
  };
}

// The current-track metadata is embedded in AVTransport GetPositionInfo → TrackMetaData
// as a DIDL-Lite XML fragment.
function parseDidl(didl) {
  if (!didl) return null;
  return {
    title: pickText(didl, 'title') || pickText(didl, 'dc:title'),
    artist: pickText(didl, 'creator') || pickText(didl, 'dc:creator'),
    album: pickText(didl, 'album') || pickText(didl, 'upnp:album'),
    art: pickText(didl, 'albumArtURI') || pickText(didl, 'upnp:albumArtURI'),
    class: pickText(didl, 'class') || pickText(didl, 'upnp:class'),
    streamContent: pickText(didl, 'streamContent') || pickText(didl, 'r:streamContent'),
  };
}

async function getPositionInfo(ip) {
  const xml = await avTransport(ip, 'GetPositionInfo', '<InstanceID>0</InstanceID>');
  const trackMeta = pickText(xml, 'TrackMetaData');
  const info = parseDidl(trackMeta);
  return {
    track_uri: pickText(xml, 'TrackURI'),
    duration: pickText(xml, 'TrackDuration'),
    relative: pickText(xml, 'RelTime'),
    track: pickText(xml, 'Track'),
    metadata: info,
  };
}

async function setAvTransportUri(ip, uri, metadata = '') {
  await avTransport(
    ip,
    'SetAVTransportURI',
    `<InstanceID>0</InstanceID><CurrentURI>${xmlEsc(uri)}</CurrentURI><CurrentURIMetaData>${xmlEsc(metadata)}</CurrentURIMetaData>`
  );
}

// Play a stream on a room in one shot: set URI, then play.
async function playStream(ip, uri) {
  await setAvTransportUri(ip, uri);
  await play(ip);
}

// Fetch a snapshot of everything: volume + state + track — for all rooms in parallel.
// Failing rooms are marked `offline: true` so the client can still render.
async function snapshot() {
  const jobs = CACHE.rooms
    .filter((r) => r.coordinators?.[0])
    .map(async (r) => {
      const ip = r.coordinators[0].ip;
      try {
        const [vol, ti, pi] = await Promise.all([
          getVolume(ip).catch(() => null),
          getTransportInfo(ip).catch(() => null),
          getPositionInfo(ip).catch(() => null),
        ]);
        return {
          room: r.room,
          ip,
          uuid: r.coordinators[0].uuid,
          model: r.coordinators[0].model,
          volume: vol,
          state: ti?.state || 'UNKNOWN',
          track: pi?.metadata || null,
          track_uri: pi?.track_uri || null,
          offline: vol === null && !ti,
        };
      } catch (e) {
        return { room: r.room, ip, offline: true, error: e.message };
      }
    });
  return Promise.all(jobs);
}

// Known-working streams we can offer as quick-play targets.
const QUICK_STREAMS = [
  { id: 'jazz', label: 'Jazz', emoji: '🎷', uri: 'x-rincon-mp3radio://ice1.somafm.com/sonicuniverse-128-mp3' },
  { id: 'chill', label: 'Chill', emoji: '🌊', uri: 'x-rincon-mp3radio://ice1.somafm.com/groovesalad-128-mp3' },
  { id: 'ambient', label: 'Ambient', emoji: '🌌', uri: 'x-rincon-mp3radio://ice1.somafm.com/deepspaceone-128-mp3' },
  { id: 'classical', label: 'Classical', emoji: '🎻', uri: 'x-rincon-mp3radio://ice1.somafm.com/poptron-128-mp3' },
];

module.exports = {
  CACHE,
  coordinatorFor,
  getVolume,
  setVolume,
  getMute,
  setMute,
  play,
  pause,
  stop,
  next,
  previous,
  getTransportInfo,
  getPositionInfo,
  setAvTransportUri,
  playStream,
  snapshot,
  QUICK_STREAMS,
};
