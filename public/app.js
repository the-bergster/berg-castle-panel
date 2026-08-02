// Berg Castle · app.js
// Minimal SPA — Home (room grid) + Room detail. WebSocket live sync.

const app = document.getElementById('app');

let ROOMS = { rooms: [], zones: [], total_rooms: 0, total_outputs: 0 };
let SCENES = { home_scenes: [], master_off: null, by_room: {}, total: 0 };
let STATE = new Map(); // integration_id -> level
let ws = null;
let currentRoute = null;

// ---------- Data ----------

async function fetchRooms() {
  const res = await fetch('/api/rooms');
  ROOMS = await res.json();
}

async function fetchScenes() {
  const res = await fetch('/api/scenes');
  SCENES = await res.json();
}

async function fireScene(picoId, button) {
  try {
    await fetch('/api/scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pico_id: picoId, button }),
    });
  } catch (_) {}
}

async function fireSyntheticScene(id) {
  try {
    await fetch('/api/synthetic-scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch (_) {}
}

async function fetchState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  STATE = new Map(Object.entries(data).map(([k, v]) => [parseInt(k, 10), v]));
}

function levelOf(id) { return STATE.get(id) ?? 0; }
function isOn(id) { return levelOf(id) > 0; }

function roomOnCount(room) {
  return room.outputs.filter(o => isOn(o.id)).length;
}

function roomAvgLevel(room) {
  const onOutputs = room.outputs.filter(o => isOn(o.id));
  if (onOutputs.length === 0) return 0;
  return Math.round(onOutputs.reduce((s, o) => s + levelOf(o.id), 0) / onOutputs.length);
}

// ---------- WebSocket ----------

function connectWS() {
  setConn('connecting');
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/';
  ws = new WebSocket(url);
  ws.onopen = () => setConn('live');
  ws.onclose = () => { setConn('offline'); setTimeout(connectWS, 2000); };
  ws.onerror = () => setConn('offline');
  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'snapshot') {
        STATE = new Map(Object.entries(msg.state).map(([k, v]) => [parseInt(k, 10), v]));
        rerenderStateOnly();
      } else if (msg.type === 'state') {
        STATE.set(msg.id, msg.level);
        applyLevelToUI(msg.id, msg.level);
      }
    } catch (_) {}
  };
}

function setConn(status) {
  const badge = document.getElementById('conn-badge');
  const label = document.getElementById('conn-label');
  if (!badge) return;
  badge.classList.toggle('live', status === 'live');
  label.textContent = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline';
}

// ---------- Actions ----------

async function setOutput(id, level, fade = 1) {
  STATE.set(id, level);
  applyLevelToUI(id, level);
  try {
    await fetch('/api/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, level, fade }),
    });
  } catch (_) {}
}

async function setRoom(roomId, level, fade = 1) {
  const room = ROOMS.rooms.find(r => r.id === roomId);
  if (!room) return;
  for (const o of room.outputs) {
    STATE.set(o.id, level);
    applyLevelToUI(o.id, level);
  }
  try {
    await fetch('/api/room-set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, level, fade }),
    });
  } catch (_) {}
}

async function setZone(zone, level, fade = 2) {
  const zoneObj = ROOMS.zones.find(z => z.name === zone);
  if (!zoneObj) return;
  for (const r of zoneObj.rooms) {
    for (const o of r.outputs) {
      STATE.set(o.id, level);
      applyLevelToUI(o.id, level);
    }
  }
  try {
    await fetch('/api/zone-set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, level, fade }),
    });
  } catch (_) {}
}

async function allOff() {
  for (const [id] of STATE) STATE.set(id, 0);
  rerenderStateOnly();
  try {
    await fetch('/api/all-off', { method: 'POST' });
  } catch (_) {}
}

// ---------- Router ----------

function route() {
  const hash = location.hash.slice(1) || '/';
  currentRoute = hash;
  if (hash === '/' || hash === '') {
    renderHub();
  } else if (hash === '/lights') {
    renderHome();
  } else if (hash === '/music') {
    renderMusic();
  } else if (hash === '/intercom') {
    renderIntercom();
  } else if (hash.startsWith('/room/')) {
    const id = parseInt(hash.split('/')[2], 10);
    renderRoom(id);
  } else {
    renderHub();
  }
  // Scroll top on route change
  window.scrollTo(0, 0);
}

function navigate(path) {
  location.hash = path;
}

window.addEventListener('hashchange', route);

// ---------- Rendering: Hub (landing home) ----------

function renderHub() {
  const totalOn = [...STATE.values()].filter(v => v > 0).length;
  const totalRoomsOn = ROOMS.rooms.filter(r => roomOnCount(r) > 0).length;
  const musicPlaying = SONOS.rooms.filter((r) => sonosIsPlaying(r.state)).length;
  const musicTotal = SONOS.rooms.length;

  app.innerHTML = `
    <div class="topbar">
      <div>
        <div class="topbar-title">Berg Castle</div>
        <span class="topbar-sub">Home</span>
      </div>
      <div class="conn-badge" id="conn-badge">
        <span class="dot"></span>
        <span id="conn-label">Connecting</span>
      </div>
    </div>

    <div class="hub-grid fade-in">
      <button class="hub-tile hub-music" data-nav="/music">
        <div class="hub-tile-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
        </div>
        <div class="hub-tile-body">
          <div class="hub-tile-title">Music</div>
          <div class="hub-tile-sub">${musicTotal === 0 ? 'Sonos · loading' : musicPlaying === 0 ? `${musicTotal} zones · silent` : `${musicPlaying} playing · ${musicTotal} zones`}</div>
        </div>
        ${musicPlaying > 0 ? `<div class="hub-tile-badge hub-badge-music">${musicPlaying}</div>` : ''}
      </button>

      <button class="hub-tile hub-lights" data-nav="/lights">
        <div class="hub-tile-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.7.6 1 1.4 1 2.3v1h6v-1c0-.9.3-1.7 1-2.3A7 7 0 0 0 12 2z"/>
          </svg>
        </div>
        <div class="hub-tile-body">
          <div class="hub-tile-title">Lights</div>
          <div class="hub-tile-sub">${totalOn === 0 ? 'All off' : `${totalOn} on · ${totalRoomsOn} ${totalRoomsOn === 1 ? 'room' : 'rooms'}`}</div>
        </div>
        ${totalOn > 0 ? `<div class="hub-tile-badge">${totalOn}</div>` : ''}
      </button>

      <button class="hub-tile hub-intercom" data-nav="/intercom">
        <div class="hub-tile-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <path d="M12 19v3M8 22h8"/>
          </svg>
        </div>
        <div class="hub-tile-body">
          <div class="hub-tile-title">Intercom</div>
          <div class="hub-tile-sub">Broadcast to any zone</div>
        </div>
      </button>
    </div>
  `;

  // Wire tiles
  app.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.nav));
  });

  connectWS();

  // Load Sonos state once so the Music tile shows accurate counts.
  // Only re-render if we didn't already have data cached, to avoid an infinite loop.
  if (SONOS.rooms.length === 0) {
    fetchSonos().then(() => {
      if ((currentRoute === '/' || currentRoute === '') && SONOS.rooms.length > 0) renderHub();
    });
  }
}

// ---------- Rendering: Music (stub) ----------

// Music state (separate from Lights `STATE` Map).
let SONOS = { rooms: [], quick_streams: [], ts: 0 };
let SONOS_TIMER = null;

async function fetchSonos() {
  try {
    const [r, s] = await Promise.all([
      fetch('/api/sonos/rooms').then((r) => r.json()),
      fetch('/api/sonos/snapshot').then((r) => r.json()),
    ]);
    SONOS = {
      rooms: (s.rooms || []).map((snap) => {
        const meta = r.rooms.find((x) => x.room === snap.room) || {};
        return { ...meta, ...snap };
      }),
      quick_streams: r.quick_streams || [],
      ts: s.ts || Date.now(),
    };
  } catch (e) {
    console.error('[Sonos] fetch failed', e);
  }
}

async function sonosCmd(payload) {
  try {
    const res = await fetch('/api/sonos/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('sonos cmd failed: ' + res.status);
    return res.json();
  } catch (e) {
    console.error('[Sonos] cmd failed', e);
    return null;
  }
}

function sonosIsPlaying(state) {
  return state === 'PLAYING' || state === 'TRANSITIONING';
}

function renderMusic() {
  app.innerHTML = `
    <div class="topbar">
      <button class="topbar-back" data-back>
        <span class="chev">‹</span>
      </button>
      <div>
        <div class="topbar-title">Music</div>
        <span class="topbar-sub">Sonos</span>
      </div>
      <div class="conn-badge" id="conn-badge">
        <span class="dot"></span>
        <span id="conn-label">Connecting</span>
      </div>
    </div>

    <div class="music-shell fade-in">
      <div id="music-summary" class="music-summary"></div>
      <div id="music-rooms" class="music-rooms">
        <div class="music-loading">Reading rooms…</div>
      </div>
    </div>
  `;

  app.querySelector('[data-back]').addEventListener('click', () => {
    stopMusicPolling();
    navigate('/');
  });

  connectWS();
  loadAndRenderMusic();
  startMusicPolling();
}

async function loadAndRenderMusic() {
  await fetchSonos();
  renderMusicRooms();
}

function renderMusicRooms() {
  const summary = document.getElementById('music-summary');
  const holder = document.getElementById('music-rooms');
  if (!summary || !holder) return;

  const rooms = SONOS.rooms.slice().sort((a, b) => a.room.localeCompare(b.room));
  const playingCount = rooms.filter((r) => sonosIsPlaying(r.state)).length;

  summary.innerHTML = `
    <div class="music-summary-num">${playingCount}</div>
    <div class="music-summary-label">
      ${playingCount === 0 ? 'Nothing playing' : `${playingCount === 1 ? 'room' : 'rooms'} playing`}<br>
      <span style="color:var(--text-dimmer);font-size:11px;letter-spacing:0.05em">${rooms.length} Sonos zones on ${SONOS.quick_streams.length ? 'network' : 'LAN'}</span>
    </div>
  `;

  holder.innerHTML = rooms.map(renderMusicRoomCard).join('');

  // Wire per-room controls.
  holder.querySelectorAll('[data-music-room]').forEach((card) => {
    const room = card.dataset.musicRoom;

    const playBtn = card.querySelector('[data-mact="toggle"]');
    if (playBtn) playBtn.addEventListener('click', async () => {
      const r = SONOS.rooms.find((x) => x.room === room);
      const nextAction = sonosIsPlaying(r?.state) ? 'pause' : 'play';
      // Optimistic UI
      if (r) r.state = nextAction === 'play' ? 'PLAYING' : 'PAUSED_PLAYBACK';
      renderMusicRooms();
      await sonosCmd({ room, action: nextAction });
      fetchSonos().then(renderMusicRooms);
    });

    const nextBtn = card.querySelector('[data-mact="next"]');
    if (nextBtn) nextBtn.addEventListener('click', async () => {
      await sonosCmd({ room, action: 'next' });
      setTimeout(() => fetchSonos().then(renderMusicRooms), 400);
    });

    const volSlider = card.querySelector('[data-mact="volume"]');
    if (volSlider) {
      volSlider.addEventListener('input', (e) => {
        // Local echo only; commit on change.
        const num = card.querySelector('[data-vol-label]');
        if (num) num.textContent = e.target.value;
      });
      volSlider.addEventListener('change', async (e) => {
        const v = parseInt(e.target.value, 10);
        const r = SONOS.rooms.find((x) => x.room === room);
        if (r) r.volume = v;
        await sonosCmd({ room, action: 'volume', value: v });
      });
    }

    card.querySelectorAll('[data-stream-uri]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uri = btn.dataset.streamUri;
        const r = SONOS.rooms.find((x) => x.room === room);
        if (r) r.state = 'TRANSITIONING';
        renderMusicRooms();
        await sonosCmd({ room, action: 'play_stream', uri });
        setTimeout(() => fetchSonos().then(renderMusicRooms), 700);
      });
    });
  });
}

function renderMusicRoomCard(r) {
  const playing = sonosIsPlaying(r.state);
  const paused = r.state === 'PAUSED_PLAYBACK';
  const stateLabel = playing ? 'Playing' : paused ? 'Paused' : 'Idle';
  const trackTitle = r.track?.title || '';
  const trackArtist = r.track?.artist || r.track?.streamContent || '';
  const nowPlaying = playing || paused;
  const isTtsFile = trackTitle && /\.(mp3|wav|m4a)$/i.test(trackTitle) && !trackArtist;

  const streams = SONOS.quick_streams.map((s) => `
    <button class="music-stream-chip" data-stream-uri="${escapeHtml(s.uri)}">${s.emoji} ${escapeHtml(s.label)}</button>
  `).join('');

  return `
    <section class="music-card ${playing ? 'is-playing' : ''}" data-music-room="${escapeHtml(r.room)}">
      <div class="music-card-head">
        <div class="music-card-title">
          <div class="music-card-room">${escapeHtml(r.room)}</div>
          <div class="music-card-state">${stateLabel}${r.model ? ` · ${escapeHtml(r.model)}` : ''}</div>
        </div>
        <button class="music-play-btn ${playing ? 'is-on' : ''}" data-mact="toggle" title="${playing ? 'Pause' : 'Play'}">
          ${playing
            ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
          }
        </button>
      </div>

      ${nowPlaying && !isTtsFile && trackTitle ? `
        <div class="music-now">
          <div class="music-now-title">${escapeHtml(trackTitle)}</div>
          ${trackArtist ? `<div class="music-now-artist">${escapeHtml(trackArtist)}</div>` : ''}
        </div>
      ` : ''}

      <div class="music-vol">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="music-vol-icon"><path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7"/></svg>
        <input type="range" min="0" max="100" value="${r.volume ?? 0}" data-mact="volume" class="music-vol-slider"/>
        <span class="music-vol-num" data-vol-label>${r.volume ?? 0}</span>
      </div>

      <div class="music-streams">${streams}</div>
    </section>
  `;
}

function startMusicPolling() {
  stopMusicPolling();
  SONOS_TIMER = setInterval(async () => {
    if (currentRoute !== '/music') return;
    await fetchSonos();
    renderMusicRooms();
  }, 4000);
}

function stopMusicPolling() {
  if (SONOS_TIMER) { clearInterval(SONOS_TIMER); SONOS_TIMER = null; }
}

// ---------- Rendering: Intercom ----------

let INTERCOM = {
  selected: new Set(),
  recorder: null,
  chunks: [],
  stream: null,
  startedAt: 0,
  timerId: null,
  recording: null,   // meta returned from server
  status: 'idle',    // 'idle' | 'recording' | 'uploading' | 'ready' | 'broadcasting' | 'sent' | 'error'
  error: null,
  volume: 40,
};

function renderIntercom() {
  // Reset per-visit state (but keep last selection).
  INTERCOM.recorder = null;
  INTERCOM.chunks = [];
  INTERCOM.recording = null;
  INTERCOM.status = 'idle';
  INTERCOM.error = null;

  app.innerHTML = `
    <div class="topbar">
      <button class="topbar-back" data-back>
        <span class="chev">‹</span>
      </button>
      <div>
        <div class="topbar-title">Intercom</div>
        <span class="topbar-sub">Broadcast</span>
      </div>
      <div class="conn-badge" id="conn-badge">
        <span class="dot"></span>
        <span id="conn-label">Connecting</span>
      </div>
    </div>

    <div class="intercom-shell fade-in">
      <div class="intercom-section">
        <div class="intercom-section-head">
          <div class="intercom-section-title">Broadcast to</div>
          <div class="intercom-section-actions">
            <button class="intercom-quick" data-select="all">All</button>
            <button class="intercom-quick" data-select="none">None</button>
          </div>
        </div>
        <div id="intercom-rooms" class="intercom-rooms">
          <div class="intercom-loading">Loading zones…</div>
        </div>
      </div>

      <div class="intercom-vol">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="music-vol-icon"><path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7"/></svg>
        <input type="range" min="0" max="100" value="${INTERCOM.volume}" id="intercom-volume" class="music-vol-slider"/>
        <span class="music-vol-num" id="intercom-vol-num">${INTERCOM.volume}</span>
      </div>

      <div class="intercom-record-panel">
        <div id="intercom-status" class="intercom-status">Ready</div>
        <button id="intercom-record-btn" class="intercom-record-btn">
          <div class="intercom-record-inner"></div>
        </button>
        <div id="intercom-timer" class="intercom-timer">00:00</div>
        <div class="intercom-actions">
          <button id="intercom-cancel" class="intercom-secondary" hidden>Discard</button>
          <button id="intercom-send" class="intercom-primary" hidden>Send to <span id="intercom-send-count">0</span></button>
        </div>
      </div>
    </div>
  `;

  app.querySelector('[data-back]').addEventListener('click', () => navigate('/'));
  connectWS();
  loadIntercomRooms();
  wireIntercomControls();
}

async function loadIntercomRooms() {
  if (SONOS.rooms.length === 0) await fetchSonos();
  renderIntercomRooms();
}

function renderIntercomRooms() {
  const holder = document.getElementById('intercom-rooms');
  if (!holder) return;
  const rooms = SONOS.rooms.slice().sort((a, b) => a.room.localeCompare(b.room));

  holder.innerHTML = rooms.map((r) => {
    const selected = INTERCOM.selected.has(r.room);
    return `
      <button class="intercom-room ${selected ? 'is-on' : ''}" data-room="${escapeHtml(r.room)}">
        <span class="intercom-room-check">${selected ? '✓' : ''}</span>
        <span class="intercom-room-name">${escapeHtml(r.room)}</span>
      </button>
    `;
  }).join('');

  holder.querySelectorAll('[data-room]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = btn.dataset.room;
      if (INTERCOM.selected.has(room)) INTERCOM.selected.delete(room);
      else INTERCOM.selected.add(room);
      renderIntercomRooms();
      updateIntercomSendButton();
    });
  });

  updateIntercomSendButton();
}

function updateIntercomSendButton() {
  const countEl = document.getElementById('intercom-send-count');
  if (countEl) countEl.textContent = INTERCOM.selected.size;
  const sendBtn = document.getElementById('intercom-send');
  if (sendBtn) sendBtn.disabled = INTERCOM.selected.size === 0;
}

function wireIntercomControls() {
  // Quick All / None.
  app.querySelectorAll('[data-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.select === 'all') {
        for (const r of SONOS.rooms) INTERCOM.selected.add(r.room);
      } else {
        INTERCOM.selected.clear();
      }
      renderIntercomRooms();
    });
  });

  // Volume slider.
  const vol = document.getElementById('intercom-volume');
  const volNum = document.getElementById('intercom-vol-num');
  if (vol) {
    vol.addEventListener('input', (e) => {
      INTERCOM.volume = parseInt(e.target.value, 10);
      volNum.textContent = INTERCOM.volume;
    });
  }

  // Record button.
  const recBtn = document.getElementById('intercom-record-btn');
  if (recBtn) recBtn.addEventListener('click', toggleIntercomRecording);

  // Cancel + Send.
  document.getElementById('intercom-cancel')?.addEventListener('click', discardIntercomRecording);
  document.getElementById('intercom-send')?.addEventListener('click', sendIntercomBroadcast);
}

function setIntercomStatus(msg, kind) {
  const s = document.getElementById('intercom-status');
  if (!s) return;
  s.textContent = msg;
  s.dataset.kind = kind || '';
}

function updateIntercomTimer() {
  const t = document.getElementById('intercom-timer');
  if (!t) return;
  const ms = Date.now() - INTERCOM.startedAt;
  const sec = Math.floor(ms / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  t.textContent = `${mm}:${ss}`;
}

async function toggleIntercomRecording() {
  if (INTERCOM.status === 'recording') {
    stopIntercomRecording();
    return;
  }
  if (INTERCOM.status === 'ready') {
    // Second tap when we already have a recording ready → discard and re-record.
    discardIntercomRecording();
  }
  await startIntercomRecording();
}

async function startIntercomRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    setIntercomStatus('This browser can\'t record audio', 'error');
    return;
  }
  try {
    INTERCOM.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Pick the best mime type this browser supports.
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    INTERCOM.recorder = new MediaRecorder(INTERCOM.stream, mime ? { mimeType: mime } : undefined);
    INTERCOM.chunks = [];
    INTERCOM.recorder.ondataavailable = (e) => { if (e.data.size > 0) INTERCOM.chunks.push(e.data); };
    INTERCOM.recorder.onstop = handleIntercomRecordingStopped;
    INTERCOM.recorder.start();
    INTERCOM.startedAt = Date.now();
    INTERCOM.status = 'recording';
    INTERCOM.timerId = setInterval(updateIntercomTimer, 200);
    setIntercomStatus('Recording… tap to stop', 'recording');
    document.getElementById('intercom-record-btn').classList.add('is-recording');
    document.getElementById('intercom-cancel').hidden = true;
    document.getElementById('intercom-send').hidden = true;
  } catch (e) {
    console.error('[Intercom] getUserMedia failed', e);
    setIntercomStatus('Mic permission denied', 'error');
  }
}

function stopIntercomRecording() {
  if (!INTERCOM.recorder || INTERCOM.recorder.state === 'inactive') return;
  INTERCOM.recorder.stop();
  clearInterval(INTERCOM.timerId);
  INTERCOM.timerId = null;
  document.getElementById('intercom-record-btn').classList.remove('is-recording');
  setIntercomStatus('Uploading…', 'uploading');
  INTERCOM.status = 'uploading';
}

async function handleIntercomRecordingStopped() {
  // Stop the mic stream.
  if (INTERCOM.stream) {
    for (const t of INTERCOM.stream.getTracks()) t.stop();
    INTERCOM.stream = null;
  }
  const blob = new Blob(INTERCOM.chunks, { type: INTERCOM.recorder.mimeType || 'audio/webm' });
  if (blob.size === 0) {
    setIntercomStatus('No audio captured', 'error');
    INTERCOM.status = 'idle';
    return;
  }
  try {
    const res = await fetch('/api/intercom/record', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    if (!res.ok) throw new Error('upload failed: ' + res.status);
    INTERCOM.recording = await res.json();
    INTERCOM.status = 'ready';
    setIntercomStatus(`Ready · ${(INTERCOM.recording.size_bytes / 1024).toFixed(0)} KB`, 'ready');
    document.getElementById('intercom-cancel').hidden = false;
    document.getElementById('intercom-send').hidden = false;
    updateIntercomSendButton();
  } catch (e) {
    console.error('[Intercom] upload failed', e);
    setIntercomStatus('Upload failed', 'error');
    INTERCOM.status = 'error';
  }
}

function discardIntercomRecording() {
  INTERCOM.recording = null;
  INTERCOM.chunks = [];
  INTERCOM.status = 'idle';
  document.getElementById('intercom-timer').textContent = '00:00';
  document.getElementById('intercom-cancel').hidden = true;
  document.getElementById('intercom-send').hidden = true;
  setIntercomStatus('Ready', '');
}

async function sendIntercomBroadcast() {
  if (!INTERCOM.recording || INTERCOM.selected.size === 0) return;
  INTERCOM.status = 'broadcasting';
  setIntercomStatus(`Broadcasting to ${INTERCOM.selected.size}…`, 'broadcasting');
  document.getElementById('intercom-send').disabled = true;
  try {
    const res = await fetch('/api/intercom/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recording_id: INTERCOM.recording.id,
        rooms: [...INTERCOM.selected],
        volume: INTERCOM.volume,
      }),
    });
    if (!res.ok) throw new Error('broadcast failed: ' + res.status);
    const data = await res.json();
    INTERCOM.status = 'sent';
    const label = data.failed === 0
      ? `Sent to ${data.successful} ${data.successful === 1 ? 'zone' : 'zones'}`
      : `Sent to ${data.successful} · ${data.failed} failed`;
    setIntercomStatus(label, data.failed === 0 ? 'sent' : 'error');
    setTimeout(() => {
      if (INTERCOM.status === 'sent') {
        discardIntercomRecording();
        updateIntercomSendButton();
      }
    }, 2500);
  } catch (e) {
    console.error('[Intercom] broadcast failed', e);
    setIntercomStatus('Broadcast failed', 'error');
    INTERCOM.status = 'error';
  } finally {
    document.getElementById('intercom-send').disabled = false;
  }
}

// ---------- Rendering: Lights ----------

function renderHome() {
  const totalOn = [...STATE.values()].filter(v => v > 0).length;
  const totalRoomsOn = ROOMS.rooms.filter(r => roomOnCount(r) > 0).length;

  app.innerHTML = `
    <div class="topbar">
      <button class="topbar-back" data-back-hub>
        <span class="chev">‹</span>
      </button>
      <div>
        <div class="topbar-title">Berg Castle</div>
        <span class="topbar-sub">Lights</span>
      </div>
      <div class="conn-badge" id="conn-badge">
        <span class="dot"></span>
        <span id="conn-label">Connecting</span>
      </div>
    </div>

    <div class="home-summary fade-in">
      <div class="summary-num">${totalOn}</div>
      <div class="summary-label">
        ${totalOn === 0 ? 'All off' : `${totalOn === 1 ? 'light' : 'lights'} on`}<br>
        <span style="color:var(--text-dimmer);font-size:11px;letter-spacing:0.05em">
          across ${totalRoomsOn} ${totalRoomsOn === 1 ? 'room' : 'rooms'}
        </span>
      </div>
    </div>

    <div class="scene-strip fade-in">
      ${SCENES.home_scenes.map(s => `
        <button class="scene"
          ${s.synthetic_id ? `data-synthetic="${s.synthetic_id}"` : `data-pico="${s.pico_id}" data-btn="${s.button}"`}
          title="${escapeHtml(s.pico_name)} · ${s.affected_count} loads">
          ${s.emoji} ${escapeHtml(s.label)}
        </button>
      `).join('')}
      ${SCENES.master_off ? `
        <button class="scene danger" data-pico="${SCENES.master_off.pico_id}" data-btn="${SCENES.master_off.button}" title="Side Foyer ‘Off’ · ${SCENES.master_off.affected_count} loads">
          ⏻ All Off
        </button>
      ` : ''}
    </div>

    <div class="zones fade-in">
      ${ROOMS.zones.map(zone => `
        <section class="zone">
          <div class="zone-head">
            <div class="zone-name">${escapeHtml(zone.name)}</div>
            <div class="zone-count">${countZoneOn(zone)}/${zone.rooms.length}</div>
          </div>
          <div class="room-grid">
            ${zone.rooms.map(room => renderRoomTile(room)).join('')}
          </div>
        </section>
      `).join('')}
    </div>
  `;

  // Wire back-to-hub
  const backBtn = app.querySelector('[data-back-hub]');
  if (backBtn) backBtn.addEventListener('click', () => navigate('/'));

  // Wire scenes (Pico + synthetic)
  app.querySelectorAll('.scene').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.synthetic) {
        fireSyntheticScene(btn.dataset.synthetic);
      } else {
        const picoId = parseInt(btn.dataset.pico, 10);
        const b = parseInt(btn.dataset.btn, 10);
        fireScene(picoId, b);
      }
      btn.style.transform = 'scale(0.94)';
      setTimeout(() => btn.style.transform = '', 150);
    });
  });

  // Wire room tiles
  app.querySelectorAll('.room-tile').forEach(tile => {
    tile.addEventListener('click', () => navigate('/room/' + tile.dataset.roomId));
  });

  setConn(ws && ws.readyState === WebSocket.OPEN ? 'live' : 'connecting');
}

function renderRoomTile(room) {
  const onCount = roomOnCount(room);
  const avg = roomAvgLevel(room);
  const anyOn = onCount > 0;
  const glowIntensity = anyOn ? Math.min(1, 0.35 + (avg / 100) * 0.65) : 0;

  const bulbs = room.outputs.slice(0, 6).map(o =>
    `<span class="bulb-dot${isOn(o.id) ? ' on' : ''}"></span>`
  ).join('');

  const statusText = anyOn
    ? `${onCount}/${room.outputs.length} · <span class="dim">${avg}%</span>`
    : `${room.outputs.length} ${room.outputs.length === 1 ? 'light' : 'lights'}`;

  return `
    <div class="room-tile ${anyOn ? 'any-on' : ''}"
         data-room-id="${room.id}"
         style="--glow-intensity: ${glowIntensity}">
      <div class="room-tile-name">${escapeHtml(room.name)}</div>
      <div>
        <div class="room-tile-bulbs">${bulbs}</div>
        <div class="room-tile-status">${statusText}</div>
      </div>
    </div>
  `;
}

function countZoneOn(zone) {
  return zone.rooms.filter(r => roomOnCount(r) > 0).length;
}

// ---------- Rendering: Room detail ----------

function renderRoom(roomId) {
  const room = ROOMS.rooms.find(r => r.id === roomId);
  if (!room) { renderHome(); return; }

  const anyOn = roomOnCount(room) > 0;

  app.innerHTML = `
    <div class="topbar">
      <button class="topbar-back" onclick="history.back()">
        <span class="chev">‹</span> Home
      </button>
      <div class="conn-badge" id="conn-badge">
        <span class="dot"></span>
        <span id="conn-label">Connecting</span>
      </div>
    </div>

    <div class="room-detail fade-in">
      <div class="room-hero">
        <div class="room-hero-name">${escapeHtml(room.name)}</div>
        <div class="room-hero-sub">
          ${room.outputs.length} ${room.outputs.length === 1 ? 'output' : 'outputs'}
          · <span id="room-summary">${roomOnCount(room)} on</span>
        </div>
      </div>

      <div class="room-actions">
        <button class="room-action" data-level="100">Full</button>
        <button class="room-action" data-level="60">60%</button>
        <button class="room-action" data-level="30">30%</button>
        <button class="room-action off" data-level="0">Off</button>
      </div>

      ${renderRoomScenes(room.id)}

      <div class="output-list">
        ${room.outputs.map(o => renderOutputCard(o)).join('')}
      </div>
    </div>
  `;

  // Wire room actions
  app.querySelectorAll('.room-action').forEach(btn => {
    btn.addEventListener('click', () => {
      setRoom(room.id, parseInt(btn.dataset.level, 10));
    });
  });

  // Wire room-scoped scenes
  app.querySelectorAll('.room-scene').forEach(btn => {
    btn.addEventListener('click', () => {
      const picoId = parseInt(btn.dataset.pico, 10);
      const b = parseInt(btn.dataset.btn, 10);
      fireScene(picoId, b);
      btn.style.transform = 'scale(0.94)';
      setTimeout(() => btn.style.transform = '', 150);
    });
  });

  // Wire sliders
  app.querySelectorAll('.output-card').forEach(card => {
    attachSlider(card);
  });

  setConn(ws && ws.readyState === WebSocket.OPEN ? 'live' : 'connecting');
}

function renderOutputCard(o) {
  const level = levelOf(o.id);
  const on = level > 0;
  return `
    <div class="output-card ${on ? 'on' : ''}" data-output-id="${o.id}">
      <div class="output-head">
        <div class="output-name">
          ${escapeHtml(o.name)}
          <span class="type">${o.type}</span>
        </div>
        <div class="output-level">${Math.round(level)}%</div>
      </div>
      <div class="slider" data-output-id="${o.id}">
        <div class="slider-track">
          <div class="slider-fill" style="width:${level}%"></div>
        </div>
        <div class="slider-thumb" style="left:${level}%"></div>
      </div>
    </div>
  `;
}

function attachSlider(card) {
  const id = parseInt(card.dataset.outputId, 10);
  const slider = card.querySelector('.slider');
  const fill = card.querySelector('.slider-fill');
  const thumb = card.querySelector('.slider-thumb');
  const levelEl = card.querySelector('.output-level');

  let dragging = false;
  let debounceTimer = null;
  let lastSentLevel = null;

  const pctFromEvent = (e) => {
    const rect = slider.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.max(0, Math.min(100, Math.round((x / rect.width) * 100)));
  };

  const paint = (pct) => {
    fill.style.width = pct + '%';
    thumb.style.left = pct + '%';
    levelEl.textContent = pct + '%';
    card.classList.toggle('on', pct > 0);
    updateRoomSummary(id);
  };

  const send = (pct, immediate = false) => {
    if (lastSentLevel === pct) return;
    lastSentLevel = pct;
    clearTimeout(debounceTimer);
    const fire = () => {
      fetch('/api/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, level: pct, fade: 1 }),
      }).catch(() => {});
    };
    if (immediate) fire();
    else debounceTimer = setTimeout(fire, 80);
  };

  const onStart = (e) => {
    dragging = true;
    slider.classList.add('dragging');
    const pct = pctFromEvent(e);
    paint(pct);
    send(pct);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const pct = pctFromEvent(e);
    paint(pct);
    send(pct);
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    slider.classList.remove('dragging');
    if (lastSentLevel !== null) send(lastSentLevel, true);
    STATE.set(id, lastSentLevel);
  };

  slider.addEventListener('mousedown', onStart);
  slider.addEventListener('touchstart', onStart, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('touchend', onEnd);
}

// Apply an incoming level update to whatever UI is on screen
function applyLevelToUI(id, level) {
  const pct = Math.round(level);

  // Room tile (home view)
  const room = ROOMS.rooms.find(r => r.outputs.some(o => o.id === id));
  if (room) {
    const tile = app.querySelector(`.room-tile[data-room-id="${room.id}"]`);
    if (tile) {
      const anyOn = roomOnCount(room) > 0;
      const avg = roomAvgLevel(room);
      tile.classList.toggle('any-on', anyOn);
      tile.style.setProperty('--glow-intensity', anyOn ? Math.min(1, 0.35 + (avg / 100) * 0.65) : 0);
      // Update status text
      const statusEl = tile.querySelector('.room-tile-status');
      const onCount = roomOnCount(room);
      if (statusEl) {
        statusEl.innerHTML = anyOn
          ? `${onCount}/${room.outputs.length} · <span class="dim">${avg}%</span>`
          : `${room.outputs.length} ${room.outputs.length === 1 ? 'light' : 'lights'}`;
      }
      // Update bulbs
      const bulbs = tile.querySelectorAll('.bulb-dot');
      room.outputs.slice(0, bulbs.length).forEach((o, idx) => {
        bulbs[idx].classList.toggle('on', isOn(o.id));
      });
    }
  }

  // Output card (room view)
  const card = app.querySelector(`.output-card[data-output-id="${id}"]`);
  if (card && !card.querySelector('.slider').classList.contains('dragging')) {
    card.classList.toggle('on', pct > 0);
    card.querySelector('.output-level').textContent = pct + '%';
    card.querySelector('.slider-fill').style.width = pct + '%';
    card.querySelector('.slider-thumb').style.left = pct + '%';
    updateRoomSummary(id);
  }

  // Home summary counter
  const summaryNum = app.querySelector('.summary-num');
  const summaryLabel = app.querySelector('.summary-label');
  if (summaryNum) {
    const totalOn = [...STATE.values()].filter(v => v > 0).length;
    const totalRoomsOn = ROOMS.rooms.filter(r => roomOnCount(r) > 0).length;
    summaryNum.textContent = totalOn;
    if (summaryLabel) {
      summaryLabel.innerHTML = `${totalOn === 0 ? 'All off' : `${totalOn === 1 ? 'light' : 'lights'} on`}<br>
        <span style="color:var(--text-dimmer);font-size:11px;letter-spacing:0.05em">
          across ${totalRoomsOn} ${totalRoomsOn === 1 ? 'room' : 'rooms'}
        </span>`;
    }
  }

  // Zone count in home view
  ROOMS.zones.forEach(zone => {
    if (zone.rooms.some(r => r.outputs.some(o => o.id === id))) {
      const zoneEl = [...app.querySelectorAll('.zone-name')]
        .find(el => el.textContent === zone.name);
      if (zoneEl) {
        const countEl = zoneEl.parentElement.querySelector('.zone-count');
        if (countEl) countEl.textContent = `${countZoneOn(zone)}/${zone.rooms.length}`;
      }
    }
  });
}

function updateRoomSummary(outputId) {
  const room = ROOMS.rooms.find(r => r.outputs.some(o => o.id === outputId));
  if (!room) return;
  const summaryEl = document.getElementById('room-summary');
  if (summaryEl) summaryEl.textContent = `${roomOnCount(room)} on`;
}

function rerenderStateOnly() {
  // Called after a full snapshot — refresh everything on screen without rebuilding.
  for (const [id, level] of STATE) applyLevelToUI(id, level);
}

// ---------- Scenes (rendered from Lutron Pico programming) ----------

function renderRoomScenes(roomId) {
  const scenes = (SCENES.by_room && SCENES.by_room[roomId]) || [];
  if (scenes.length === 0) return '';
  return `
    <div class="room-scene-strip">
      ${scenes.map(s => `
        <button class="room-scene" data-pico="${s.pico_id}" data-btn="${s.button}" title="${escapeHtml(s.pico_name)} · ${s.affected_count} loads">
          ${s.emoji} ${escapeHtml(s.label)}
        </button>
      `).join('')}
    </div>
  `;
}

// ---------- Utils ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ---------- Boot ----------

async function boot() {
  await Promise.all([fetchRooms(), fetchScenes(), fetchState()]);
  route();
  connectWS();
}

boot();
