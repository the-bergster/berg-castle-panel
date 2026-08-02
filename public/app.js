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
          <div class="hub-tile-sub">Sonos · coming online</div>
        </div>
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
    </div>
  `;

  // Wire tiles
  app.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.nav));
  });

  connectWS();
}

// ---------- Rendering: Music (stub) ----------

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

    <div class="music-empty fade-in">
      <div class="music-empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <div class="music-empty-title">Sonos control lands here</div>
      <div class="music-empty-sub">Rooms, playback, volume, groups. Built on Sonos's official Control API. Wiring up next.</div>
      <div class="music-empty-stats">Dining Room verified · TTS working</div>
    </div>
  `;

  app.querySelector('[data-back]').addEventListener('click', () => navigate('/'));
  connectWS();
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
