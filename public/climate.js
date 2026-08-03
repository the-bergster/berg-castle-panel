// Berg Castle · climate.js
//
// The Climate app: 9 ecobee zones with live temp, mode, holds, sensors,
// setpoint nudge, and comfort-profile broadcast.
//
// Vanilla, single global `Climate` — matches Music module pattern.
//
// Design notes:
//   • Optimistic UI on every mutation. Debounced setpoint bumps so a
//     triple-tap on ± fires one API call, not three.
//   • Poll only when the Climate view is active (Home hub uses a light
//     summary fetch that doesn't wake anything up on the ecobee side).
//   • Colour palette: heat = --heat (warm coral), cool = --cool (soft blue),
//     both stay muted so the amber Lutron/Sonos accents remain hero.

const Climate = (() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  const S = {
    thermostats: [],
    updatedAt: 0,
    loaded: false,
    expandedIndex: null,
    pending: {},            // index → { heat?, cool?, mode? }
    globalBusy: null,       // 'home' | 'sleep' | 'away' | 'resume-all'
    toasts: [],
    lastFetchAt: 0,
  };

  let pollTimer = null;
  let debounceTimers = {};
  let toastCounter = 0;
  let hostApp = null;
  let escHandler = null;

  const POLL_MS = 30_000;
  const NUDGE_DEBOUNCE_MS = 900;
  const SUMMARY_TTL_MS = 60_000;  // Hub tile summary — refetch at most once/min

  // ─── Utilities ──────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtTemp(t, decimals = 0) {
    if (t === null || t === undefined) return '—';
    return decimals > 0 ? Number(t).toFixed(decimals) : String(Math.round(t));
  }

  function modeIcon(mode) {
    // Simple 1-char glyphs; matches the panel's restrained aesthetic
    switch (mode) {
      case 'cool': return '❄';
      case 'heat': return '☼';
      case 'auto': return '⇅';
      case 'off':  return '○';
      case 'auxHeatOnly': return '⚡';
      default: return '·';
    }
  }
  function modeLabel(mode) {
    return mode === 'auxHeatOnly' ? 'aux' : (mode || '?');
  }

  function climateGlyph(ref) {
    if (!ref) return '·';
    const r = String(ref).toLowerCase();
    if (r.includes('home')) return '⌂';
    if (r.includes('away')) return '⤴';
    if (r.includes('sleep')) return '☾';
    if (r.includes('wake')) return '☀';
    return '·';
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
    const ttl = kind === 'err' ? 6000 : 2500;
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

  // ─── Public: hub summary (called by app.js) ─────────────────────────────
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

  // ─── Public: full Climate view ──────────────────────────────────────────
  async function render(app, hash) {
    hostApp = app;

    app.innerHTML = `
      <div class="topbar climate-topbar">
        <div>
          <div class="topbar-title">Climate</div>
          <span class="topbar-sub" id="climate-topbar-sub">Loading…</span>
        </div>
        <button class="climate-back" data-nav="/" aria-label="Back to hub">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
      </div>

      <div class="climate-page fade-in">
        <div class="climate-bar" id="climate-bar">
          <div class="climate-bar-group">
            <button class="climate-bar-btn" data-comfort="home">
              <span class="climate-bar-glyph">⌂</span> Home
            </button>
            <button class="climate-bar-btn" data-comfort="sleep">
              <span class="climate-bar-glyph">☾</span> Sleep
            </button>
            <button class="climate-bar-btn" data-comfort="away">
              <span class="climate-bar-glyph">⤴</span> Away
            </button>
          </div>
          <div class="climate-bar-group climate-bar-group--right">
            <button class="climate-bar-btn climate-bar-btn--secondary" data-resume-all>
              <span class="climate-bar-glyph">↺</span> Resume Schedule
            </button>
          </div>
        </div>

        <div class="climate-grid" id="climate-grid">
          <div class="climate-loading">Loading zones…</div>
        </div>
      </div>
    `;

    // Wire nav
    app.querySelectorAll('[data-nav]').forEach((el) => {
      el.addEventListener('click', () => { location.hash = el.dataset.nav; });
    });
    app.querySelectorAll('[data-comfort]').forEach((btn) => {
      btn.addEventListener('click', () => applyComfortAll(btn.dataset.comfort));
    });
    app.querySelector('[data-resume-all]').addEventListener('click', resumeAll);

    // ESC closes any open detail
    escHandler = (e) => {
      if (e.key === 'Escape' && S.expandedIndex != null) {
        S.expandedIndex = null;
        paintGrid();
      }
    };
    window.addEventListener('keydown', escHandler);

    try {
      await fetchState(true);
    } catch (e) {
      $('#climate-grid').innerHTML = `<div class="climate-error">⚠︎ ${esc(e.message)}<br><button class="climate-retry" onclick="Climate._retry()">Retry</button></div>`;
      return;
    }
    paintAll();
    startPolling();
  }

  function teardown() {
    stopPolling();
    if (escHandler) {
      window.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
    // Detail modal cleanup
    const backdrop = document.getElementById('climate-detail-backdrop');
    if (backdrop) backdrop.remove();
    S.expandedIndex = null;
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        await fetchState();
        paintAll();
      } catch (e) {
        console.warn('[climate] poll error:', e.message);
      }
    }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ─── Painting ───────────────────────────────────────────────────────────
  function paintAll() {
    paintHeader();
    paintBar();
    paintGrid();
  }

  function paintHeader() {
    const sub = document.getElementById('climate-topbar-sub');
    if (!sub) return;
    const s = summary();
    let text = `${s.count} zones`;
    if (s.avgTemp != null) text += ` · ${fmtTemp(s.avgTemp, 0)}° avg`;
    if (s.outdoor && s.outdoor.temperature != null) text += ` · ${fmtTemp(s.outdoor.temperature, 0)}° outside`;
    sub.textContent = text;
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
      if (S.globalBusy === ref) btn.innerHTML = `<span class="climate-bar-glyph">…</span> ${ref[0].toUpperCase() + ref.slice(1)}`;
    });
    const resume = bar.querySelector('[data-resume-all]');
    if (resume) {
      resume.disabled = !!S.globalBusy || !anyManualHold();
      if (S.globalBusy === 'resume-all') resume.innerHTML = `<span class="climate-bar-glyph">…</span> Resume Schedule`;
    }
  }

  function paintGrid() {
    const grid = document.getElementById('climate-grid');
    if (!grid) return;
    const ts = effectiveThermostats();
    grid.innerHTML = ts.map(renderZoneTile).join('');

    // Wire per-tile handlers
    grid.querySelectorAll('.zone-tile').forEach((el) => {
      const idx = parseInt(el.dataset.index, 10);
      el.addEventListener('click', (e) => {
        // Ignore clicks on nudge buttons / hold-clear
        if (e.target.closest('.nudge-btn') || e.target.closest('.zone-hold-clear')) return;
        openDetail(idx);
      });
      // Nudges
      el.querySelectorAll('.nudge-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const which = btn.dataset.which;
          const delta = parseInt(btn.dataset.delta, 10);
          nudge(idx, which, delta);
        });
      });
      // Manual hold clear
      const clr = el.querySelector('.zone-hold-clear');
      if (clr) {
        clr.addEventListener('click', (e) => {
          e.stopPropagation();
          resumeZone(idx);
        });
      }
    });

    // If a detail is open, re-render it too
    if (S.expandedIndex != null) paintDetail();
  }

  function renderZoneTile(t) {
    const target = t.hvacMode === 'heat' ? t.desiredHeat
      : t.hvacMode === 'cool' ? t.desiredCool
      : t.hvacMode === 'auto' ? ((t.desiredHeat ?? 70) + (t.desiredCool ?? 76)) / 2
      : null;

    // Color the actual temp based on delta from target
    let tempColor = '';
    if (t.hvacMode !== 'off' && t.actualTemperature != null && target != null) {
      const d = t.actualTemperature - target;
      if (Math.abs(d) >= 1) tempColor = d > 0 ? 'zone-temp--warm' : 'zone-temp--cool';
    }

    const isOff = t.hvacMode === 'off';
    const running = t.equipmentStatus && t.equipmentStatus.length > 0;
    const hold = t.activeHold;
    const holdIsSched = isScheduleHold(hold);
    const hasPending = !!S.pending[t.index];

    const setpointHTML = isOff
      ? `<span class="zone-setpoint-off">off</span>`
      : t.hvacMode === 'auto'
      ? `<span class="zone-setpoint-heat">${fmtTemp(t.desiredHeat, 0)}°</span>
         <span class="zone-setpoint-sep">·</span>
         <span class="zone-setpoint-cool">${fmtTemp(t.desiredCool, 0)}°</span>`
      : `<span class="zone-setpoint-single">${fmtTemp(t.hvacMode === 'heat' ? t.desiredHeat : t.desiredCool, 0)}°</span>`;

    const holdChip = hold ? `
      <div class="zone-hold ${holdIsSched ? 'zone-hold--schedule' : 'zone-hold--manual'}"
           title="${holdIsSched ? 'On ' + esc(hold.holdClimateRef) + ' schedule' : 'Manual hold — tap × to resume schedule'}">
        <span class="zone-hold-glyph">${climateGlyph(hold.holdClimateRef)}</span>
        ${holdIsSched ? '' : '<span class="zone-hold-clear" role="button" aria-label="Resume schedule">×</span>'}
      </div>
    ` : '';

    const nudges = isOff ? '' : `
      <div class="zone-nudges">
        ${t.hvacMode === 'auto' ? `
          <div class="nudge-group">
            <span class="nudge-label">heat</span>
            <button class="nudge-btn" data-which="heat" data-delta="-1" aria-label="heat down">−</button>
            <button class="nudge-btn" data-which="heat" data-delta="1" aria-label="heat up">+</button>
          </div>
          <div class="nudge-group">
            <span class="nudge-label">cool</span>
            <button class="nudge-btn" data-which="cool" data-delta="-1" aria-label="cool down">−</button>
            <button class="nudge-btn" data-which="cool" data-delta="1" aria-label="cool up">+</button>
          </div>
        ` : `
          <div class="nudge-group">
            <button class="nudge-btn" data-which="${t.hvacMode === 'heat' ? 'heat' : 'cool'}" data-delta="-1" aria-label="down">−</button>
            <button class="nudge-btn" data-which="${t.hvacMode === 'heat' ? 'heat' : 'cool'}" data-delta="1" aria-label="up">+</button>
          </div>
        `}
      </div>
    `;

    return `
      <button class="zone-tile ${isOff ? 'zone-tile--off' : ''} ${hasPending ? 'zone-tile--pending' : ''}"
              data-index="${t.index}">
        <div class="zone-tile-top">
          <div class="zone-name">${esc(t.name)}</div>
          ${holdChip}
        </div>
        <div class="zone-temp ${tempColor}">
          ${fmtTemp(t.actualTemperature, 1)}<span class="zone-temp-unit">°</span>
        </div>
        <div class="zone-setpoint">${setpointHTML}</div>
        <div class="zone-tile-bottom">
          <div class="zone-mode zone-mode--${t.hvacMode}">
            <span class="zone-mode-glyph">${modeIcon(t.hvacMode)}</span>${modeLabel(t.hvacMode)}
          </div>
          ${running ? `<div class="zone-running" title="${esc(t.equipmentStatus.join(', '))}"><span class="zone-running-dot"></span>running</div>` : ''}
        </div>
        ${nudges}
      </button>
    `;
  }

  // ─── Zone detail modal ──────────────────────────────────────────────────
  function openDetail(index) {
    S.expandedIndex = index;
    paintDetail();
  }
  function closeDetail() {
    S.expandedIndex = null;
    const bd = document.getElementById('climate-detail-backdrop');
    if (bd) bd.remove();
  }

  function paintDetail() {
    if (S.expandedIndex == null) return;
    const t = effectiveThermostats().find((x) => x.index === S.expandedIndex);
    if (!t) return closeDetail();

    let bd = document.getElementById('climate-detail-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'climate-detail-backdrop';
      bd.className = 'climate-detail-backdrop';
      bd.addEventListener('click', (e) => {
        if (e.target === bd) closeDetail();
      });
      document.body.appendChild(bd);
    }

    const hold = t.activeHold;
    const holdIsSched = isScheduleHold(hold);
    const running = t.equipmentStatus && t.equipmentStatus.length > 0;

    const statusBits = [];
    if (t.actualHumidity != null) statusBits.push(`${t.actualHumidity}% humidity`);
    if (running) statusBits.push(`<span class="detail-running-tag"><span class="zone-running-dot"></span>${esc(t.equipmentStatus.join(' · '))}</span>`);
    if (hold) {
      const label = holdIsSched ? esc(hold.holdClimateRef || '') : 'manual hold';
      statusBits.push(`<span class="detail-hold-tag ${holdIsSched ? 'detail-hold-tag--sched' : 'detail-hold-tag--manual'}">${climateGlyph(hold.holdClimateRef)} ${label}</span>`);
    }

    const targetHTML = t.hvacMode === 'off'
      ? `<div class="detail-target-off">system off</div>`
      : t.hvacMode === 'auto'
      ? `
        <div class="detail-dial detail-dial--heat">
          <div class="detail-dial-label">heat</div>
          <div class="detail-dial-row">
            <button class="detail-dial-btn" data-nudge-which="heat" data-nudge-delta="-1" aria-label="heat down">−</button>
            <div class="detail-dial-value">${fmtTemp(t.desiredHeat, 0)}°</div>
            <button class="detail-dial-btn" data-nudge-which="heat" data-nudge-delta="1" aria-label="heat up">+</button>
          </div>
        </div>
        <div class="detail-dial detail-dial--cool">
          <div class="detail-dial-label">cool</div>
          <div class="detail-dial-row">
            <button class="detail-dial-btn" data-nudge-which="cool" data-nudge-delta="-1" aria-label="cool down">−</button>
            <div class="detail-dial-value">${fmtTemp(t.desiredCool, 0)}°</div>
            <button class="detail-dial-btn" data-nudge-which="cool" data-nudge-delta="1" aria-label="cool up">+</button>
          </div>
        </div>
      `
      : `
        <div class="detail-dial detail-dial--${t.hvacMode}">
          <div class="detail-dial-label">${t.hvacMode === 'heat' ? 'heat to' : 'cool to'}</div>
          <div class="detail-dial-row">
            <button class="detail-dial-btn" data-nudge-which="${t.hvacMode}" data-nudge-delta="-1" aria-label="down">−</button>
            <div class="detail-dial-value">${fmtTemp(t.hvacMode === 'heat' ? t.desiredHeat : t.desiredCool, 0)}°</div>
            <button class="detail-dial-btn" data-nudge-which="${t.hvacMode}" data-nudge-delta="1" aria-label="up">+</button>
          </div>
        </div>
      `;

    const modePills = ['heat', 'cool', 'auto', 'off'].map((m) => `
      <button class="detail-pill ${t.hvacMode === m ? 'detail-pill--active' : ''}" data-mode="${m}">
        <span class="detail-pill-glyph">${modeIcon(m)}</span> ${modeLabel(m)}
      </button>
    `).join('');

    const fanPills = ['auto', 'on'].map((f) => `
      <button class="detail-pill ${t.desiredFanMode === f ? 'detail-pill--active' : ''}" data-fan="${f}">${f}</button>
    `).join('');

    const climatePills = (t.climates || []).slice(0, 6).map((c) => `
      <button class="detail-pill ${t.currentClimateRef === c.climateRef && holdIsSched ? 'detail-pill--active' : ''}"
              data-climate="${esc(c.climateRef)}">
        <span class="detail-pill-glyph">${climateGlyph(c.climateRef)}</span> ${esc(c.name)}
        ${c.heatTemp != null && c.coolTemp != null ? `<span class="detail-pill-sub">${fmtTemp(c.heatTemp, 0)}·${fmtTemp(c.coolTemp, 0)}°</span>` : ''}
      </button>
    `).join('');

    const sensorList = (t.sensors || []).length === 0 ? '' : `
      <div class="detail-row">
        <div class="detail-label">Sensors</div>
        <div class="detail-sensors">
          ${t.sensors.map((s) => `
            <div class="detail-sensor ${s.inUse ? 'detail-sensor--in-use' : ''}">
              <div class="detail-sensor-name">
                ${esc(s.name)}
                ${s.occupancy ? '<span class="detail-sensor-occ" title="occupied">●</span>' : ''}
              </div>
              <div class="detail-sensor-temp">${fmtTemp(s.temperature, 1)}°</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    bd.innerHTML = `
      <div class="climate-detail" role="dialog" aria-modal="true">
        <div class="detail-header">
          <div>
            <div class="detail-name">${esc(t.name)}</div>
            ${statusBits.length ? `<div class="detail-status">${statusBits.join('<span class="detail-status-sep">·</span>')}</div>` : ''}
          </div>
          <button class="detail-close" aria-label="Close">✕</button>
        </div>

        <div class="detail-body">
          <div class="detail-actual">
            <div class="detail-actual-value">${fmtTemp(t.actualTemperature, 1)}<span class="detail-actual-unit">°</span></div>
            <div class="detail-target-wrap">${targetHTML}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Mode</div>
            <div class="detail-pills">${modePills}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Fan</div>
            <div class="detail-pills">${fanPills}</div>
          </div>

          ${climatePills ? `
          <div class="detail-row">
            <div class="detail-label">Comfort</div>
            <div class="detail-pills">${climatePills}</div>
          </div>` : ''}

          <div class="detail-row">
            <div class="detail-label">Actions</div>
            <div class="detail-pills">
              <button class="detail-pill detail-pill--action"
                      data-resume-zone
                      ${!hold || holdIsSched ? 'disabled' : ''}>
                <span class="detail-pill-glyph">↺</span> Resume Schedule
              </button>
            </div>
          </div>

          ${sensorList}
        </div>

        ${S.pending[t.index] ? '<div class="detail-pending">Saving…</div>' : ''}
      </div>
    `;

    // Wire handlers
    bd.querySelector('.detail-close').addEventListener('click', closeDetail);
    bd.querySelectorAll('[data-nudge-which]').forEach((btn) => {
      btn.addEventListener('click', () => {
        nudge(t.index, btn.dataset.nudgeWhich, parseInt(btn.dataset.nudgeDelta, 10));
      });
    });
    bd.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setMode(t.index, btn.dataset.mode));
    });
    bd.querySelectorAll('[data-fan]').forEach((btn) => {
      btn.addEventListener('click', () => setFan(t.index, btn.dataset.fan));
    });
    bd.querySelectorAll('[data-climate]').forEach((btn) => {
      btn.addEventListener('click', () => setClimate(t.index, btn.dataset.climate));
    });
    const resumeBtn = bd.querySelector('[data-resume-zone]');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumeZone(t.index));
  }

  // ─── Mutations ──────────────────────────────────────────────────────────
  function nudge(index, which, delta) {
    const t = S.thermostats.find((x) => x.index === index);
    if (!t) return;
    const cur = S.pending[index] || {};
    const heatBase = cur.heat ?? t.desiredHeat ?? 70;
    const coolBase = cur.cool ?? t.desiredCool ?? 76;
    let heat = heatBase;
    let cool = coolBase;
    if (which === 'heat') heat = Math.round(heatBase + delta);
    else cool = Math.round(coolBase + delta);
    if (t.hvacMode === 'auto') {
      const minDelta = (t.settings && t.settings.heatCoolMinDelta) || 5;
      if (cool - heat < minDelta) {
        if (which === 'heat') cool = heat + minDelta;
        else heat = cool - minDelta;
      }
    }
    S.pending[index] = { ...cur, heat, cool };
    paintGrid();

    // Debounced commit
    if (debounceTimers[index]) clearTimeout(debounceTimers[index]);
    debounceTimers[index] = setTimeout(() => commitTempHold(index), NUDGE_DEBOUNCE_MS);
  }

  async function commitTempHold(index) {
    const t = S.thermostats.find((x) => x.index === index);
    const p = S.pending[index];
    if (!t || !p) return;
    const heat = p.heat ?? t.desiredHeat ?? 70;
    const cool = p.cool ?? t.desiredCool ?? 76;
    try {
      await callAction({
        action: 'hold-temp',
        index,
        coolTemp: cool,
        heatTemp: heat,
        holdType: 'nextTransition',
      });
      pushToast(`${t.name}: ${fmtTemp(heat, 0)}° / ${fmtTemp(cool, 0)}°`);
    } catch (e) {
      pushToast(`${t.name}: ${e.message}`, 'err');
    }
    delete S.pending[index];
    setTimeout(() => refresh(true), 400);
  }

  async function setMode(index, mode) {
    const t = S.thermostats.find((x) => x.index === index);
    if (!t || mode === t.hvacMode) return;
    S.pending[index] = { ...(S.pending[index] || {}), mode };
    paintGrid();
    try {
      await callAction({ action: 'hvac-mode', index, hvacMode: mode });
      pushToast(`${t.name}: mode → ${modeLabel(mode)}`);
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
      pushToast(`${t.name}: fan → ${fan}`);
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
      pushToast(`${t.name}: → ${ref}`);
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
      pushToast(`${t.name}: resumed`);
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
      paintAll();
    } catch (e) {
      console.warn('[climate] refresh:', e.message);
    }
  }

  // For error-retry inline handler
  async function _retry() {
    try {
      await fetchState(true);
      paintAll();
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
