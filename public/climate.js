// Berg Castle · climate.js v2 (ecobee polish, 2026-08-03)
//
// Three-screen navigation model, mirroring the official ecobee app:
//   1. Zone list         → hash: /climate           (cards, one per thermostat)
//   2. Zone detail       → hash: /climate/<index>   (big hero temp, hold pill, action row)
//   3. Setpoint picker   → hash: /climate/<index>/set/<mode>
//                          (wheel + squircle-blue tile + floating ± controls)
//
// Settings sheet slides up from the detail action-row's third icon; it houses
// mode/fan/comfort/sensors/actions that were previously crammed into a modal.
//
// Vanilla, single global `Climate`. Optimistic UI on every write.

const Climate = (() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  const S = {
    thermostats: [],
    updatedAt: 0,
    loaded: false,
    pending: {},            // index → { heat?, cool?, mode? }
    globalBusy: null,
    toasts: [],
    lastFetchAt: 0,
    view: 'list',           // 'list' | 'detail' | 'picker' | 'settings'
    detailIndex: null,
    pickerIndex: null,
    pickerMode: null,       // 'heat' | 'cool' — which value the wheel edits
    pickerValue: null,      // in-flight value while picker open
    settingsOpen: false,
  };

  let pollTimer = null;
  let toastCounter = 0;
  let escHandler = null;
  let hostApp = null;

  const POLL_MS = 30_000;
  const SUMMARY_TTL_MS = 60_000;
  const NUDGE_DEBOUNCE_MS = 700;
  let commitTimer = null;

  // ─── Utilities ──────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtTemp(t, decimals = 0) {
    if (t === null || t === undefined) return '—';
    return decimals > 0 ? Number(t).toFixed(decimals) : String(Math.round(t));
  }

  function fmtEndTime(hold) {
    // ecobee holds carry endDate + endTime; render "until 9:00 pm" style.
    if (!hold || !hold.endTime) return null;
    // endTime is "HH:MM:SS"; endDate is YYYY-MM-DD in the thermostat's TZ.
    // We deliberately don't do TZ math client-side; ecobee returns thermostat-local.
    const [hStr, mStr] = hold.endTime.split(':');
    const h24 = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    if (isNaN(h24) || isNaN(m)) return null;
    const ampm = h24 >= 12 ? 'pm' : 'am';
    const h12 = ((h24 + 11) % 12) + 1;
    const mm = m === 0 ? '' : ':' + String(m).padStart(2, '0');
    return `until ${h12}${mm} ${ampm}`;
  }

  function isScheduleHold(hold) {
    return !!(hold && hold.holdClimateRef);
  }

  function effectiveThermostats() {
    return S.thermostats.map((t) => {
      const p = S.pending[t.index];
      if (!p) return t;
      return {
        ...t,
        desiredHeat: p.heat ?? t.desiredHeat,
        desiredCool: p.cool ?? t.desiredCool,
        hvacMode: p.mode ?? t.hvacMode,
      };
    });
  }

  function findThermostat(index) {
    return effectiveThermostats().find((t) => t.index === index);
  }

  // Current setpoint we care about for a given zone's active mode
  function activeSetpoint(t) {
    if (t.hvacMode === 'heat') return t.desiredHeat;
    if (t.hvacMode === 'cool') return t.desiredCool;
    if (t.hvacMode === 'auto') return t.desiredCool; // default picker to cool side
    return null;
  }

  // Accent tone for hero temp / picker
  function accentFor(t, override) {
    const mode = override || t.hvacMode;
    if (mode === 'heat') return 'heat';
    if (mode === 'cool') return 'cool';
    return 'cool'; // default (auto/off show blue accents on hold pill)
  }

  // ─── Networking ─────────────────────────────────────────────────────────
  async function fetchState(force = false) {
    const url = `/api/climate/thermostats${force ? '?force=1' : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    S.thermostats = data.thermostats || [];
    S.updatedAt = data.updatedAt || Date.now();
    S.lastFetchAt = Date.now();
    S.loaded = true;
    return data;
  }

  async function callAction(body) {
    const res = await fetch('/api/climate/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }

  // ─── Toasts ─────────────────────────────────────────────────────────────
  function pushToast(msg, kind = 'ok') {
    const id = ++toastCounter;
    S.toasts.push({ id, msg, kind });
    paintToasts();
    const ttl = kind === 'err' ? 5000 : 2200;
    setTimeout(() => {
      S.toasts = S.toasts.filter((t) => t.id !== id);
      paintToasts();
    }, ttl);
  }

  function paintToasts() {
    let el = document.getElementById('climate-toasts');
    if (!el) {
      if (S.toasts.length === 0) return;
      el = document.createElement('div');
      el.id = 'climate-toasts';
      el.className = 'climate-toasts';
      document.body.appendChild(el);
    }
    el.innerHTML = S.toasts.map((t) => `
      <div class="climate-toast ${t.kind === 'err' ? 'climate-toast--err' : ''}">${esc(t.msg)}</div>
    `).join('');
    if (S.toasts.length === 0) el.remove();
  }

  // ─── Icons (all inline SVG for consistent stroke) ───────────────────────
  const ICONS = {
    back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    droplet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`,
    snowflake: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07L19.07 4.93M8 3l4 3 4-3M8 21l4-3 4 3M3 8l3 4-3 4M21 8l-3 4 3 4"/></svg>`,
    flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>`,
    away: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M17 11l4 4-4 4M13 15h8"/></svg>`,
    thermostat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 1 1 4 0z"/></svg>`,
    sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8" x2="20" y2="8"/><circle cx="9" cy="8" r="2.5" fill="currentColor" stroke="none"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="16" r="2.5" fill="currentColor" stroke="none"/></svg>`,
    fan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12a4 4 0 0 1 8 0c0 5-8 3-8 3s-2-8 3-8"/><path d="M12 12a4 4 0 0 1 0 8c-5 0-3-8-3-8s8-2 8 3"/><path d="M12 12a4 4 0 0 1-8 0c0-5 8-3 8-3s2 8-3 8"/><circle cx="12" cy="12" r="1.5"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    power: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`,
    auto: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21l5-16 5 16M9 15h6"/></svg>`,
    more: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  };

  function modeIcon(mode) {
    if (mode === 'cool') return ICONS.snowflake;
    if (mode === 'heat') return ICONS.flame;
    if (mode === 'auto') return ICONS.auto;
    if (mode === 'off') return ICONS.power;
    return ICONS.power;
  }
  function modeLabel(mode) {
    if (mode === 'auxHeatOnly') return 'aux heat';
    return mode || '?';
  }
  function climateIcon(ref) {
    if (!ref) return ICONS.home;
    const r = String(ref).toLowerCase();
    if (r.includes('sleep')) return ICONS.moon;
    if (r.includes('away')) return ICONS.away;
    if (r.includes('wake')) return ICONS.sun;
    return ICONS.home;
  }

  // ─── Public: hub summary (called by app.js on landing page) ────────────
  async function loadSummary() {
    if (Date.now() - S.lastFetchAt < SUMMARY_TTL_MS && S.loaded) return summary();
    try {
      await fetchState();
    } catch (e) {
      console.warn('[climate] summary fetch failed:', e.message);
    }
    return summary();
  }
  function summary() {
    if (!S.loaded || S.thermostats.length === 0) {
      return { count: 0, avgTemp: null, running: 0, outdoor: null };
    }
    const temps = S.thermostats.map((t) => t.actualTemperature).filter((x) => x != null);
    const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    const running = S.thermostats.filter((t) => t.equipmentStatus && t.equipmentStatus.length > 0).length;
    const outdoorT = S.thermostats.find((t) => t.weather && t.weather.temperature != null);
    return {
      count: S.thermostats.length,
      avgTemp: avg,
      running,
      outdoor: outdoorT ? outdoorT.weather : null,
    };
  }

  // ─── Router integration ─────────────────────────────────────────────────
  async function render(app, hash) {
    hostApp = app;

    // Parse route
    const parts = hash.replace(/^\/climate\/?/, '').split('/').filter(Boolean);
    // parts: []  → list
    //        [idx]  → detail
    //        [idx, 'set', mode]  → picker

    if (parts.length === 0) {
      S.view = 'list';
      S.detailIndex = null;
      S.pickerIndex = null;
      // Clean up any lingering overlays from previous views
      document.getElementById('setpoint-picker-backdrop')?.remove();
      document.getElementById('climate-detail-backdrop')?.remove();
      await renderList();
    } else if (parts.length === 1) {
      S.view = 'detail';
      S.detailIndex = parseInt(parts[0], 10);
      S.pickerIndex = null;
      // Coming back from picker: nuke the picker overlay so the back button
      // actually reveals the detail view underneath.
      document.getElementById('setpoint-picker-backdrop')?.remove();
      await renderList();  // paint list as background
      renderDetail();
    } else if (parts.length === 3 && parts[1] === 'set') {
      S.view = 'picker';
      S.detailIndex = parseInt(parts[0], 10);
      S.pickerIndex = S.detailIndex;
      S.pickerMode = parts[2];
      const t = findThermostat(S.pickerIndex);
      S.pickerValue = t ? (S.pickerMode === 'heat' ? t.desiredHeat : t.desiredCool) : null;
      await renderList();
      renderDetail();
      renderPicker();
    }

    // ESC key handler
    if (!escHandler) {
      escHandler = (e) => {
        if (e.key !== 'Escape') return;
        if (S.settingsOpen) { closeSettings(); return; }
        if (S.view === 'picker') { closePicker(); return; }
        if (S.view === 'detail') { closeDetail(); return; }
      };
      window.addEventListener('keydown', escHandler);
    }

    startPolling();
  }

  function teardown() {
    stopPolling();
    if (escHandler) {
      window.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
    closeAllOverlays();
  }

  function closeAllOverlays() {
    document.getElementById('climate-detail-backdrop')?.remove();
    document.getElementById('setpoint-picker-backdrop')?.remove();
    document.getElementById('settings-sheet-backdrop')?.remove();
    S.settingsOpen = false;
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        await fetchState();
        // Only repaint the surfaces that exist
        if (document.getElementById('climate-grid')) paintList();
        if (document.getElementById('climate-detail-backdrop')) paintDetail();
      } catch (e) {
        console.warn('[climate] poll error:', e.message);
      }
    }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ─── VIEW 1: Zone list ─────────────────────────────────────────────────
  async function renderList() {
    hostApp.innerHTML = `
      <div class="topbar climate-topbar">
        <button class="climate-back" data-nav="/" aria-label="Back to hub">${ICONS.back}</button>
        <div style="text-align:center;">
          <div class="climate-topbar-title">Climate</div>
          <div class="climate-topbar-sub" id="climate-topbar-sub">Loading…</div>
        </div>
        <div class="climate-topbar-right">
          <button class="climate-icon-btn" id="climate-refresh-btn" aria-label="Refresh">${ICONS.refresh}</button>
        </div>
      </div>

      <div class="climate-page fade-in">
        <div class="climate-bar" id="climate-bar">
          <button class="climate-bar-btn" data-comfort="home"><span class="climate-bar-glyph">${ICONS.home}</span> Home</button>
          <button class="climate-bar-btn" data-comfort="sleep"><span class="climate-bar-glyph">${ICONS.moon}</span> Sleep</button>
          <button class="climate-bar-btn" data-comfort="away"><span class="climate-bar-glyph">${ICONS.away}</span> Away</button>
        </div>
        <div class="climate-bar-secondary-row">
          <button class="climate-bar-btn climate-bar-btn--secondary" data-resume-all>Resume Schedule</button>
        </div>
        <div class="climate-grid" id="climate-grid">
          <div class="climate-loading">Loading zones…</div>
        </div>
      </div>
    `;

    hostApp.querySelectorAll('[data-nav]').forEach((el) => {
      el.addEventListener('click', () => { location.hash = el.dataset.nav; });
    });
    hostApp.querySelector('#climate-refresh-btn').addEventListener('click', async () => {
      const btn = hostApp.querySelector('#climate-refresh-btn');
      btn.style.transform = 'rotate(360deg)';
      btn.style.transition = 'transform 500ms ease';
      try { await fetchState(true); paintList(); } catch (e) { pushToast(e.message, 'err'); }
      setTimeout(() => { btn.style.transform = ''; btn.style.transition = ''; }, 500);
    });
    hostApp.querySelectorAll('[data-comfort]').forEach((btn) => {
      btn.addEventListener('click', () => applyComfortAll(btn.dataset.comfort));
    });
    hostApp.querySelector('[data-resume-all]').addEventListener('click', resumeAll);

    try {
      if (!S.loaded) await fetchState(true);
      paintList();
    } catch (e) {
      $('#climate-grid').innerHTML = `
        <div class="climate-error">
          ⚠︎ ${esc(e.message)}
          <br><button class="climate-retry" onclick="Climate._retry()">Retry</button>
        </div>`;
    }
  }

  function paintList() {
    const grid = document.getElementById('climate-grid');
    if (!grid) return;
    const ts = effectiveThermostats();
    grid.innerHTML = ts.map(renderZoneCard).join('');

    grid.querySelectorAll('.zone-card').forEach((el) => {
      const idx = parseInt(el.dataset.index, 10);
      el.addEventListener('click', (e) => {
        if (e.target.closest('.zone-hold-pill-close')) return;
        location.hash = `/climate/${idx}`;
      });
      const clr = el.querySelector('.zone-hold-pill-close');
      if (clr) {
        clr.addEventListener('click', (e) => {
          e.stopPropagation();
          resumeZone(idx);
        });
      }
    });

    paintHeader();
    paintBar();
  }

  function paintHeader() {
    const sub = document.getElementById('climate-topbar-sub');
    if (!sub) return;
    const s = summary();
    const parts = [];
    if (s.avgTemp != null) parts.push(`${fmtTemp(s.avgTemp, 0)}° avg`);
    parts.push(`${s.count} zones`);
    if (s.running > 0) parts.push(`${s.running} running`);
    if (s.outdoor && s.outdoor.temperature != null) parts.push(`${fmtTemp(s.outdoor.temperature, 0)}° outside`);
    sub.textContent = parts.join(' · ');
  }

  function allOnClimate(ref) {
    if (S.thermostats.length === 0) return false;
    return S.thermostats.every((t) => t.currentClimateRef === ref);
  }
  function anyManualHold() {
    return S.thermostats.some((t) => t.activeHold && !isScheduleHold(t.activeHold));
  }
  function paintBar() {
    const bar = document.getElementById('climate-bar');
    if (!bar) return;
    ['home', 'sleep', 'away'].forEach((ref) => {
      const btn = bar.querySelector(`[data-comfort="${ref}"]`);
      if (!btn) return;
      btn.classList.toggle('active', allOnClimate(ref));
      btn.disabled = !!S.globalBusy;
    });
    const resume = bar.querySelector('[data-resume-all]');
    if (resume) resume.disabled = !!S.globalBusy || !anyManualHold();
  }

  function renderZoneCard(t) {
    const target = t.hvacMode === 'heat' ? t.desiredHeat
      : t.hvacMode === 'cool' ? t.desiredCool
      : t.hvacMode === 'auto' ? ((t.desiredHeat ?? 70) + (t.desiredCool ?? 76)) / 2
      : null;
    // Hero temp stays neutral white by design; the mode label + hold pill
    // carry the color signal. (Removed 2026-08-03 after design review — the
    // previous variable-color tempClass muddied the hierarchy.)
    void target;
    const tempClass = '';

    const modeItem = (() => {
      if (t.hvacMode === 'cool') return { cls: 'zone-card-status-item--cool', icon: ICONS.snowflake, label: 'Cool' };
      if (t.hvacMode === 'heat') return { cls: 'zone-card-status-item--heat', icon: ICONS.flame, label: 'Heat' };
      if (t.hvacMode === 'auto') return { cls: '', icon: ICONS.auto, label: 'Auto' };
      return { cls: 'zone-card-status-item--off', icon: ICONS.power, label: 'Off' };
    })();

    const hold = t.activeHold;
    const holdIsSched = isScheduleHold(hold);
    const running = t.equipmentStatus && t.equipmentStatus.length > 0;
    const hasPending = !!S.pending[t.index];

    let holdHTML = '';
    if (hold) {
      const val = holdIsSched ? '' : fmtTemp(hold.coolHoldTemp ?? hold.heatHoldTemp, 0) + '°';
      const label = holdIsSched
        ? (hold.holdClimateRef.charAt(0).toUpperCase() + hold.holdClimateRef.slice(1))
        : (fmtEndTime(hold) || 'manual hold');
      const pillClass = holdIsSched
        ? 'zone-hold-pill--schedule'
        : (t.hvacMode === 'heat' ? 'zone-hold-pill--heat' : '');
      // Label-only variant (schedule pill has no value + no close btn): center text.
      const labelOnly = !val && holdIsSched;
      holdHTML = `
        <div class="zone-card-hold-slot">
          <div class="zone-hold-pill ${pillClass}${labelOnly ? ' zone-hold-pill--label-only' : ''}">
            ${val ? `<span class="zone-hold-pill-value">${val}</span><span class="zone-hold-pill-sep"></span>` : ''}
            <span class="zone-hold-pill-label">${esc(label)}</span>
            ${holdIsSched ? '' : '<span class="zone-hold-pill-close" role="button" tabindex="0" aria-label="Resume schedule">' + ICONS.close + '</span>'}
          </div>
        </div>
      `;
    } else {
      // Instead of blank space, show a subtle "on schedule" indicator with the
      // current climate's target so info density matches held cards.
      const setpointStr = t.hvacMode === 'off'
        ? 'Off'
        : t.hvacMode === 'auto'
          ? `Auto · ${fmtTemp(t.desiredHeat, 0)}–${fmtTemp(t.desiredCool, 0)}°`
          : `${t.hvacMode === 'heat' ? 'Heat' : 'Cool'} to ${fmtTemp(activeSetpoint(t), 0)}°`;
      holdHTML = `
        <div class="zone-card-hold-slot">
          <div class="zone-hold-placeholder">
            <span class="zone-hold-placeholder-target">${esc(setpointStr)}</span>
            <span class="zone-hold-placeholder-sep">·</span>
            <span>On schedule</span>
          </div>
        </div>
      `;
    }

    // Running tag: shown INSIDE the card, subtly, only when equipment is active.
    // Keeps the header "N running" stat honest at the card level too.
    const runningHTML = running ? `
      <div class="zone-card-hold-slot" style="margin-top:6px;">
        <span class="zone-card-running-tag">
          <span class="zone-card-running-dot"></span>${esc(t.equipmentStatus.join(' · '))}
        </span>
      </div>
    ` : '';

    return `
      <button class="zone-card ${t.hvacMode === 'off' ? 'zone-card--off' : ''} ${hasPending ? 'zone-card--pending' : ''}"
              data-index="${t.index}">
        <div class="zone-card-top">
          <div class="zone-card-name-group">
            <span class="zone-card-thermo-icon">${ICONS.thermostat}</span>
            <span class="zone-card-name">${esc(t.name)}</span>
          </div>
          <span class="zone-card-more" aria-hidden="true">${ICONS.more}</span>
        </div>

        <div class="zone-card-status">
          <div class="zone-card-status-item">${ICONS.droplet} ${t.actualHumidity != null ? t.actualHumidity + '%' : '—'}</div>
          <div class="zone-card-status-item ${modeItem.cls}">${modeItem.icon} ${modeItem.label}</div>
        </div>

        <div class="zone-card-temp ${tempClass}">${fmtTemp(t.actualTemperature, 0)}</div>

        ${holdHTML}

        ${runningHTML}
      </button>
    `;
  }

  // ─── VIEW 2: Zone detail (full-screen takeover) ────────────────────────
  function renderDetail() {
    if (S.detailIndex == null) return;
    let bd = document.getElementById('climate-detail-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'climate-detail-backdrop';
      bd.className = 'climate-detail-backdrop';
      document.body.appendChild(bd);
    }
    paintDetail();
  }

  function paintDetail() {
    const bd = document.getElementById('climate-detail-backdrop');
    if (!bd) return;
    const t = findThermostat(S.detailIndex);
    if (!t) { closeDetail(); return; }

    const isOff = t.hvacMode === 'off';
    const running = t.equipmentStatus && t.equipmentStatus.length > 0;
    const hold = t.activeHold;
    const holdIsSched = isScheduleHold(hold);

    let holdHTML = '';
    if (hold) {
      const val = holdIsSched ? '' : fmtTemp(hold.coolHoldTemp ?? hold.heatHoldTemp, 0) + '°';
      const label = holdIsSched
        ? (hold.holdClimateRef.charAt(0).toUpperCase() + hold.holdClimateRef.slice(1))
        : (fmtEndTime(hold) || 'manual hold');
      const pillClass = holdIsSched
        ? 'zone-hold-pill--schedule'
        : (t.hvacMode === 'heat' ? 'zone-hold-pill--heat' : '');
      const labelOnly = !val && holdIsSched;
      holdHTML = `
        <div class="detail-hold-slot">
          <div class="zone-hold-pill ${pillClass}${labelOnly ? ' zone-hold-pill--label-only' : ''}">
            ${val ? `<span class="zone-hold-pill-value">${val}</span><span class="zone-hold-pill-sep"></span>` : ''}
            <span class="zone-hold-pill-label">${esc(label)}</span>
            ${holdIsSched ? '' : '<span class="zone-hold-pill-close" role="button" tabindex="0" id="detail-resume-btn" aria-label="Resume schedule">' + ICONS.close + '</span>'}
          </div>
        </div>
      `;
    } else {
      holdHTML = `<div class="detail-hold-slot"><div class="zone-hold-placeholder">On schedule</div></div>`;
    }

    // Bottom action row: comfort presets (moon = sleep), mode toggle, settings sheet
    const currentIsSleep = hold && holdIsSched && (hold.holdClimateRef || '').toLowerCase().includes('sleep');
    const modeClass = t.hvacMode === 'heat' ? 'action-heat' : '';

    bd.innerHTML = `
      <div class="topbar detail-topbar">
        <div class="detail-topbar-wrap">
          <button class="climate-back" id="detail-back-btn" aria-label="Back">${ICONS.back}</button>
          <div class="detail-title">${esc(t.name)}</div>
          <button class="climate-icon-btn" id="detail-settings-btn" aria-label="Settings">${ICONS.gear}</button>
        </div>
      </div>

      <div class="detail-body">
        <div class="detail-stack">
          <div class="detail-humidity">
            ${ICONS.droplet} ${t.actualHumidity != null ? t.actualHumidity + '%' : '—'}
          </div>

          <div class="detail-hero" id="detail-hero" title="Tap to adjust setpoint">
            ${fmtTemp(t.actualTemperature, 0)}
          </div>
          <div class="detail-hero-hint">
            ${isOff ? 'System Off' :
              t.hvacMode === 'auto'
                ? `Heat ${fmtTemp(t.desiredHeat, 0)}° · Cool ${fmtTemp(t.desiredCool, 0)}°`
                : `${t.hvacMode === 'heat' ? 'Heat' : 'Cool'} to ${fmtTemp(activeSetpoint(t), 0)}° · tap to change`
            }
          </div>

          ${holdHTML}
        </div>
      </div>

      <div class="detail-actions">
        <button class="detail-action-btn ${currentIsSleep ? 'active' : ''}" id="detail-sleep-btn" aria-label="Sleep comfort">
          ${ICONS.moon}
        </button>
        <button class="detail-action-btn active ${modeClass}" id="detail-mode-btn" aria-label="Mode">
          ${modeIcon(t.hvacMode)}
        </button>
        <button class="detail-action-btn" id="detail-more-btn" aria-label="Settings">
          ${ICONS.sliders}
        </button>
      </div>
    `;

    // Wire
    bd.querySelector('#detail-back-btn').addEventListener('click', closeDetail);
    bd.querySelector('#detail-hero').addEventListener('click', () => {
      if (isOff) { pushToast('Turn system on first'); return; }
      openPicker(t.index, t.hvacMode === 'heat' ? 'heat' : 'cool');
    });
    bd.querySelector('#detail-sleep-btn').addEventListener('click', () => {
      // Toggle sleep: if currently on sleep schedule, resume; otherwise apply sleep
      if (currentIsSleep) resumeZone(t.index);
      else setClimate(t.index, 'sleep');
    });
    bd.querySelector('#detail-mode-btn').addEventListener('click', () => openSettings('mode'));
    bd.querySelector('#detail-more-btn').addEventListener('click', () => openSettings());
    const settingsBtn = bd.querySelector('#detail-settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => openSettings());
    const resumeBtn = bd.querySelector('#detail-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resumeZone(t.index);
    });
  }

  function closeDetail() {
    location.hash = '/climate';
  }

  // ─── VIEW 3: Setpoint picker (wheel + squircle tile) ───────────────────
  function openPicker(index, mode) {
    location.hash = `/climate/${index}/set/${mode}`;
  }

  function renderPicker() {
    let pb = document.getElementById('setpoint-picker-backdrop');
    if (!pb) {
      pb = document.createElement('div');
      pb.id = 'setpoint-picker-backdrop';
      pb.className = 'setpoint-picker-backdrop';
      document.body.appendChild(pb);
    }
    paintPicker();
  }

  function paintPicker() {
    const pb = document.getElementById('setpoint-picker-backdrop');
    if (!pb) return;
    const t = findThermostat(S.pickerIndex);
    if (!t) { closePicker(); return; }

    const mode = S.pickerMode;
    const val = S.pickerValue ?? (mode === 'heat' ? t.desiredHeat : t.desiredCool) ?? 72;
    const isHeat = mode === 'heat';
    const isAuto = t.hvacMode === 'auto';

    // Bounds
    const min = isHeat ? (t.settings?.heatMinTemp ?? 45) : (t.settings?.coolMinTemp ?? 55);
    const max = isHeat ? (t.settings?.heatMaxTemp ?? 79) : (t.settings?.coolMaxTemp ?? 92);

    const minusDisabled = val <= min;
    const plusDisabled = val >= max;

    // Neighbors on the wheel
    const above2 = val + 2, above1 = val + 1;
    const below1 = val - 1, below2 = val - 2;

    // Auto-mode tabs
    const tabsHTML = isAuto ? `
      <div class="setpoint-picker-tabs">
        <button class="setpoint-picker-tab ${mode === 'heat' ? 'active tab-heat' : ''}" data-picker-tab="heat">Heat</button>
        <button class="setpoint-picker-tab ${mode === 'cool' ? 'active tab-cool' : ''}" data-picker-tab="cool">Cool</button>
      </div>
    ` : '';

    pb.innerHTML = `
      <div class="setpoint-picker-topbar">
        <button class="climate-back" id="picker-back-btn" aria-label="Back">${ICONS.back}</button>
        <div style="text-align:center; flex:1;">
          <div class="climate-topbar-title">${esc(t.name)}</div>
          <div class="climate-topbar-sub">${isHeat ? 'Heat to' : 'Cool to'}</div>
        </div>
        <div style="width:36px"></div>
      </div>

      ${tabsHTML ? '<div style="padding:8px 20px 0;">' + tabsHTML + '</div>' : ''}

      <div class="setpoint-picker-body">
        <div class="setpoint-wheel">
          <div class="setpoint-wheel-num setpoint-wheel-num--far" data-picker-set="${above2}">${above2}</div>
          <div class="setpoint-wheel-num setpoint-wheel-num--near" data-picker-set="${above1}">${above1}</div>
          <div class="setpoint-wheel-selected ${isHeat ? 'setpoint-wheel-selected--heat' : ''}" id="picker-selected">${val}</div>
          <div class="setpoint-wheel-num setpoint-wheel-num--near" data-picker-set="${below1}">${below1}</div>
          <div class="setpoint-wheel-num setpoint-wheel-num--far" data-picker-set="${below2}">${below2}</div>
        </div>

        <div class="setpoint-controls">
          <button class="setpoint-btn ${isHeat ? 'setpoint-btn--heat' : ''}" id="picker-plus" ${plusDisabled ? 'disabled' : ''} aria-label="+1">+</button>
          <button class="setpoint-btn ${isHeat ? 'setpoint-btn--heat' : ''}" id="picker-minus" ${minusDisabled ? 'disabled' : ''} aria-label="−1">−</button>
          <!-- Order matters: on desktop these stack vertically with + on top
               (matches ecobee reference). On mobile the @media flips to a row;
               the CSS reverses the row so − lands on the left, + on the right. -->
        </div>
      </div>

      <div class="setpoint-picker-footer">
        <button class="setpoint-picker-footer-btn" id="picker-cancel">Cancel</button>
        <button class="setpoint-picker-footer-btn setpoint-picker-footer-btn--primary ${isHeat ? 'footer-btn-heat' : ''}" id="picker-save">Set ${val}°</button>
      </div>
    `;

    // Wire
    pb.querySelector('#picker-back-btn').addEventListener('click', closePicker);
    pb.querySelector('#picker-cancel').addEventListener('click', closePicker);
    pb.querySelector('#picker-save').addEventListener('click', savePicker);
    pb.querySelector('#picker-plus').addEventListener('click', () => bumpPicker(1));
    pb.querySelector('#picker-minus').addEventListener('click', () => bumpPicker(-1));
    pb.querySelectorAll('[data-picker-set]').forEach((el) => {
      el.addEventListener('click', () => {
        S.pickerValue = parseInt(el.dataset.pickerSet, 10);
        paintPicker();
      });
    });
    pb.querySelectorAll('[data-picker-tab]').forEach((el) => {
      el.addEventListener('click', () => {
        const newMode = el.dataset.pickerTab;
        S.pickerMode = newMode;
        S.pickerValue = newMode === 'heat' ? t.desiredHeat : t.desiredCool;
        location.hash = `/climate/${t.index}/set/${newMode}`;
      });
    });

    // Wheel scroll (touch + mouse) to change value
    let wheelDebounce = null;
    const wheelEl = pb.querySelector('.setpoint-wheel');
    if (wheelEl) {
      wheelEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (wheelDebounce) return;
        wheelDebounce = setTimeout(() => { wheelDebounce = null; }, 80);
        bumpPicker(e.deltaY > 0 ? -1 : 1);
      }, { passive: false });

      // Touch/pointer swipe: drag up = warmer, drag down = cooler.
      // Each ~28px of vertical drag = 1° step, so a comfortable thumb-flick
      // moves you a few degrees and a slow drag inches you one at a time.
      const STEP_PX = 28;
      let dragActive = false;
      let dragStartY = 0;
      let dragStartVal = null;
      let dragLastVal = null;

      const onDragStart = (clientY) => {
        dragActive = true;
        dragStartY = clientY;
        dragStartVal = S.pickerValue ?? val;
        dragLastVal = dragStartVal;
      };
      const onDragMove = (clientY, e) => {
        if (!dragActive) return;
        // Up-swipe (negative deltaY in DOM coords) should increase the value,
        // matching the visual: numbers above the tile are warmer.
        const dy = dragStartY - clientY;
        const steps = Math.trunc(dy / STEP_PX);
        const t2 = findThermostat(S.pickerIndex);
        if (!t2) return;
        const isHeatMode = S.pickerMode === 'heat';
        const minV = isHeatMode ? (t2.settings?.heatMinTemp ?? 45) : (t2.settings?.coolMinTemp ?? 55);
        const maxV = isHeatMode ? (t2.settings?.heatMaxTemp ?? 79) : (t2.settings?.coolMaxTemp ?? 92);
        const target = Math.min(maxV, Math.max(minV, dragStartVal + steps));
        if (target !== dragLastVal) {
          dragLastVal = target;
          S.pickerValue = target;
          paintPicker();
        }
        if (e && e.cancelable) e.preventDefault();
      };
      const onDragEnd = () => { dragActive = false; };

      wheelEl.addEventListener('touchstart', (e) => {
        if (!e.touches[0]) return;
        onDragStart(e.touches[0].clientY);
      }, { passive: true });
      wheelEl.addEventListener('touchmove', (e) => {
        if (!e.touches[0]) return;
        onDragMove(e.touches[0].clientY, e);
      }, { passive: false });
      wheelEl.addEventListener('touchend', onDragEnd, { passive: true });
      wheelEl.addEventListener('touchcancel', onDragEnd, { passive: true });

      // Mouse drag for desktop testing (in addition to the wheel event above)
      wheelEl.addEventListener('mousedown', (e) => {
        onDragStart(e.clientY);
        const mm = (ev) => onDragMove(ev.clientY, null);
        const mu = () => {
          onDragEnd();
          window.removeEventListener('mousemove', mm);
          window.removeEventListener('mouseup', mu);
        };
        window.addEventListener('mousemove', mm);
        window.addEventListener('mouseup', mu);
      });
    }
  }

  function bumpPicker(delta) {
    const t = findThermostat(S.pickerIndex);
    if (!t) return;
    const mode = S.pickerMode;
    const isHeat = mode === 'heat';
    const min = isHeat ? (t.settings?.heatMinTemp ?? 45) : (t.settings?.coolMinTemp ?? 55);
    const max = isHeat ? (t.settings?.heatMaxTemp ?? 79) : (t.settings?.coolMaxTemp ?? 92);
    let v = (S.pickerValue ?? (isHeat ? t.desiredHeat : t.desiredCool) ?? 72) + delta;
    v = Math.min(max, Math.max(min, v));
    S.pickerValue = v;
    paintPicker();
  }

  async function savePicker() {
    const t = findThermostat(S.pickerIndex);
    if (!t) return closePicker();
    const isHeat = S.pickerMode === 'heat';
    const val = S.pickerValue;
    const heat = isHeat ? val : (t.desiredHeat ?? 70);
    const cool = isHeat ? (t.desiredCool ?? 76) : val;

    // Optimistic
    S.pending[t.index] = { heat, cool };
    closePicker();
    paintList();
    paintDetail();

    try {
      await callAction({
        action: 'hold-temp',
        index: t.index,
        coolTemp: cool,
        heatTemp: heat,
        holdType: 'nextTransition',
      });
      pushToast(`${t.name}: ${isHeat ? 'heat' : 'cool'} to ${val}°`);
    } catch (e) {
      pushToast(`${t.name}: ${e.message}`, 'err');
    }
    delete S.pending[t.index];
    setTimeout(() => refresh(true), 400);
  }

  function closePicker() {
    if (S.detailIndex != null) location.hash = `/climate/${S.detailIndex}`;
    else location.hash = '/climate';
  }

  // ─── Settings bottom sheet ─────────────────────────────────────────────
  function openSettings(focus) {
    S.settingsOpen = true;
    const t = findThermostat(S.detailIndex);
    if (!t) return;

    let sh = document.getElementById('settings-sheet-backdrop');
    if (!sh) {
      sh = document.createElement('div');
      sh.id = 'settings-sheet-backdrop';
      sh.className = 'settings-sheet-backdrop';
      sh.addEventListener('click', (e) => { if (e.target === sh) closeSettings(); });
      document.body.appendChild(sh);
    }
    paintSettings(focus);
  }
  function closeSettings() {
    S.settingsOpen = false;
    document.getElementById('settings-sheet-backdrop')?.remove();
  }
  function paintSettings(focus) {
    const sh = document.getElementById('settings-sheet-backdrop');
    if (!sh) return;
    const t = findThermostat(S.detailIndex);
    if (!t) return closeSettings();

    const hold = t.activeHold;
    const holdIsSched = isScheduleHold(hold);

    const modePills = ['heat', 'cool', 'auto', 'off'].map((m) => {
      const cls = t.hvacMode === m ? `active ${m === 'cool' ? 'pill-cool' : m === 'heat' ? 'pill-heat' : ''}` : '';
      return `<button class="settings-pill ${cls}" data-mode="${m}">${modeIcon(m)} ${modeLabel(m)}</button>`;
    }).join('');

    const fanPills = ['auto', 'on'].map((f) => `
      <button class="settings-pill ${t.desiredFanMode === f ? 'active' : ''}" data-fan="${f}">${f}</button>
    `).join('');

    const climatePills = (t.climates || []).slice(0, 6).map((c) => {
      const active = t.currentClimateRef === c.climateRef && holdIsSched;
      return `<button class="settings-pill ${active ? 'active' : ''}" data-climate="${esc(c.climateRef)}">
        ${climateIcon(c.climateRef)} ${esc(c.name)}
        ${c.heatTemp != null && c.coolTemp != null ? `<span class="settings-pill-sub">${fmtTemp(c.heatTemp, 0)}·${fmtTemp(c.coolTemp, 0)}°</span>` : ''}
      </button>`;
    }).join('');

    const sensorsHTML = (t.sensors || []).length === 0 ? '' : `
      <div class="settings-sheet-section">
        <div class="settings-sheet-section-label">Sensors</div>
        <div class="settings-sensors">
          ${t.sensors.map((s) => `
            <div class="settings-sensor ${s.inUse ? 'settings-sensor--in-use' : ''}">
              <div class="settings-sensor-name">
                ${esc(s.name)}
                ${s.occupancy ? '<span class="settings-sensor-occ" title="occupied">●</span>' : ''}
              </div>
              <div class="settings-sensor-temp">${fmtTemp(s.temperature, 1)}°</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    sh.innerHTML = `
      <div class="settings-sheet" style="position:relative;">
        <div class="settings-sheet-handle"></div>
        <button class="settings-sheet-close" id="settings-close-btn" aria-label="Close">${ICONS.close}</button>
        <div class="settings-sheet-title">${esc(t.name)}</div>
        <div class="settings-sheet-sub">Settings & mode</div>

        <div class="settings-sheet-section" id="settings-mode-section">
          <div class="settings-sheet-section-label">System</div>
          <div class="settings-pills">${modePills}</div>
        </div>

        <div class="settings-sheet-section">
          <div class="settings-sheet-section-label">Fan</div>
          <div class="settings-pills">${fanPills}</div>
        </div>

        ${climatePills ? `
          <div class="settings-sheet-section">
            <div class="settings-sheet-section-label">Comfort profile</div>
            <div class="settings-pills">${climatePills}</div>
          </div>` : ''}

        ${sensorsHTML}

        <div class="settings-sheet-section" style="margin-bottom:0;">
          <button class="settings-action-btn" id="settings-resume-btn"
                  ${!hold || holdIsSched ? 'disabled' : ''}>
            ${ICONS.refresh} Resume Schedule
          </button>
        </div>
      </div>
    `;

    sh.querySelector('#settings-close-btn').addEventListener('click', closeSettings);
    sh.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setMode(t.index, btn.dataset.mode));
    });
    sh.querySelectorAll('[data-fan]').forEach((btn) => {
      btn.addEventListener('click', () => setFan(t.index, btn.dataset.fan));
    });
    sh.querySelectorAll('[data-climate]').forEach((btn) => {
      btn.addEventListener('click', () => setClimate(t.index, btn.dataset.climate));
    });
    const resume = sh.querySelector('#settings-resume-btn');
    if (resume) resume.addEventListener('click', () => { resumeZone(t.index); closeSettings(); });

    if (focus === 'mode') {
      const el = sh.querySelector('#settings-mode-section');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ─── Mutations ──────────────────────────────────────────────────────────
  async function setMode(index, mode) {
    const t = S.thermostats.find((x) => x.index === index);
    if (!t || mode === t.hvacMode) return;
    S.pending[index] = { ...(S.pending[index] || {}), mode };
    paintList();
    paintDetail();
    if (S.settingsOpen) paintSettings();
    try {
      await callAction({ action: 'hvac-mode', index, hvacMode: mode });
      pushToast(`${t.name}: ${modeLabel(mode)}`);
    } catch (e) {
      pushToast(`${t.name}: ${e.message}`, 'err');
    }
    if (S.pending[index]) {
      const { mode: _drop, ...rest } = S.pending[index];
      if (Object.keys(rest).length === 0) delete S.pending[index];
      else S.pending[index] = rest;
    }
    setTimeout(() => refresh(true), 400);
  }

  async function setFan(index, fan) {
    const t = S.thermostats.find((x) => x.index === index);
    if (!t) return;
    try {
      await callAction({ action: 'fan-mode', index, fanMode: fan, holdType: 'nextTransition' });
      pushToast(`${t.name}: fan ${fan}`);
    } catch (e) {
      pushToast(`${t.name}: ${e.message}`, 'err');
    }
    setTimeout(() => refresh(true), 400);
  }

  async function setClimate(index, ref) {
    const t = S.thermostats.find((x) => x.index === index);
    if (!t) return;
    try {
      await callAction({ action: 'hold-climate', index, climateRef: ref, holdType: 'nextTransition' });
      pushToast(`${t.name}: ${ref}`);
    } catch (e) {
      pushToast(`${t.name}: ${e.message}`, 'err');
    }
    setTimeout(() => refresh(true), 400);
  }

  async function resumeZone(index) {
    const t = S.thermostats.find((x) => x.index === index);
    if (!t) return;
    try {
      await callAction({ action: 'resume', index, resumeAll: false });
      pushToast(`${t.name}: resumed schedule`);
    } catch (e) {
      pushToast(`${t.name}: ${e.message}`, 'err');
    }
    setTimeout(() => refresh(true), 400);
  }

  async function applyComfortAll(ref) {
    S.globalBusy = ref;
    paintBar();
    try {
      const r = await callAction({ action: 'apply-comfort-all', climateRef: ref, holdType: 'nextTransition' });
      const failed = (r.results || []).filter((x) => !x.ok).length;
      if (failed) pushToast(`${ref}: ${failed} zone(s) failed`, 'err');
      else pushToast(`All zones → ${ref}`);
    } catch (e) {
      pushToast(`apply ${ref}: ${e.message}`, 'err');
    } finally {
      S.globalBusy = null;
      setTimeout(() => refresh(true), 600);
    }
  }

  async function resumeAll() {
    S.globalBusy = 'resume-all';
    paintBar();
    try {
      await callAction({ action: 'resume-all', resumeAll: false });
      pushToast('All zones resumed');
    } catch (e) {
      pushToast(`resume all: ${e.message}`, 'err');
    } finally {
      S.globalBusy = null;
      setTimeout(() => refresh(true), 600);
    }
  }

  async function refresh(force = false) {
    try {
      await fetchState(force);
      paintList();
      paintDetail();
      if (S.settingsOpen) paintSettings();
    } catch (e) {
      console.warn('[climate] refresh:', e.message);
    }
  }

  async function _retry() {
    try {
      await fetchState(true);
      paintList();
      startPolling();
    } catch (e) {
      pushToast(e.message, 'err');
    }
  }

  return {
    render,
    teardown,
    loadSummary,
    summary,
    state: S,
    _retry,
  };
})();

window.Climate = Climate;
