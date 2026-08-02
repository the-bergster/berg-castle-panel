// intercom.js — record-in-browser + push-to-Sonos broadcast.
//
// UX model:
//   1. Browser records with MediaRecorder → uploads binary blob to /api/intercom/record.
//   2. Server saves to recordings/<uuid>.webm|mp3, serves it at /recordings/<uuid>.<ext>.
//   3. Client calls /api/intercom/broadcast with { recording_id, rooms: [...] }.
//   4. Server tells each Sonos coordinator to SetAVTransportURI(<panel-url>/recordings/<uuid>) then Play.
//
// Verified during Simon's 2026-07-31 session that Sonos can reach the panel machine's
// static server; the same pattern works here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// LAN address of this panel — Sonos speakers must be able to reach it.
// Derived at boot; can be overridden with INTERCOM_HOST env var.
function detectLanIp() {
  if (process.env.INTERCOM_HOST) return process.env.INTERCOM_HOST;
  const os = require('os');
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.')) {
        return a.address;
      }
    }
  }
  return '127.0.0.1';
}

const LAN_HOST = detectLanIp();
const PANEL_URL_BASE = process.env.PANEL_URL_BASE || `http://${LAN_HOST}:4321`;
console.log(`[Intercom] Sonos-reachable panel URL base: ${PANEL_URL_BASE}`);

// Keep a small manifest so we can clean up old recordings.
const MANIFEST_FILE = path.join(RECORDINGS_DIR, '_manifest.json');
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); }
  catch (_) { return { recordings: [] }; }
}
function writeManifest(m) {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2));
}

const MAX_KEEP = 20;
function pruneOldRecordings() {
  const m = readManifest();
  if (m.recordings.length <= MAX_KEEP) return;
  const toRemove = m.recordings
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(MAX_KEEP);
  for (const r of toRemove) {
    try { fs.unlinkSync(path.join(RECORDINGS_DIR, r.filename)); } catch (_) {}
  }
  m.recordings = m.recordings.filter((r) => !toRemove.includes(r));
  writeManifest(m);
}

// Transcode arbitrary browser-recorded audio (webm/opus, mp4/aac, etc.) into
// MP3 so Sonos will play it reliably across all firmware/model variants.
function transcodeToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-y',                       // overwrite
      '-i', inputPath,
      '-vn',                      // no video
      '-ac', '2',                 // stereo
      '-ar', '44100',             // 44.1kHz
      '-b:a', '128k',             // 128kbps CBR
      '-f', 'mp3',
      outputPath,
    ];
    const ff = spawn('/opt/homebrew/bin/ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (c) => (stderr += c.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

// Save a recording blob, transcode to MP3, and return metadata.
async function saveRecording(buffer, mimeType) {
  const id = crypto.randomBytes(6).toString('hex');
  const rawExt =
    /webm/i.test(mimeType) ? 'webm' :
    /mp4|m4a/i.test(mimeType) ? 'm4a' :
    /wav/i.test(mimeType) ? 'wav' :
    /ogg/i.test(mimeType) ? 'ogg' :
    /mp3|mpeg/i.test(mimeType) ? 'mp3' : 'bin';
  const rawPath = path.join(RECORDINGS_DIR, `${id}.raw.${rawExt}`);
  fs.writeFileSync(rawPath, buffer);

  const filename = `${id}.mp3`;
  const filepath = path.join(RECORDINGS_DIR, filename);

  // Skip transcode if the input is already MP3.
  if (rawExt === 'mp3') {
    fs.renameSync(rawPath, filepath);
  } else {
    try {
      await transcodeToMp3(rawPath, filepath);
      try { fs.unlinkSync(rawPath); } catch (_) {}
    } catch (e) {
      console.error('[Intercom] ffmpeg failed:', e.message);
      throw e;
    }
  }

  const stats = fs.statSync(filepath);
  const meta = {
    id,
    filename,
    mime_type: 'audio/mpeg',
    source_mime: mimeType,
    size_bytes: stats.size,
    created_at: Date.now(),
    url_path: `/recordings/${filename}`,
  };

  const manifest = readManifest();
  manifest.recordings.push(meta);
  writeManifest(manifest);
  pruneOldRecordings();

  return meta;
}

function getRecording(id) {
  const manifest = readManifest();
  return manifest.recordings.find((r) => r.id === id) || null;
}

function fullUrlFor(recording) {
  return `${PANEL_URL_BASE}${recording.url_path}`;
}

module.exports = {
  RECORDINGS_DIR,
  PANEL_URL_BASE,
  saveRecording,
  getRecording,
  fullUrlFor,
};
