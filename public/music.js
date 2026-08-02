// Berg Castle · music.js
// The Music app: zones, now playing, queue, browse, search, grouping and EQ.
//
// Vanilla, no build step — matches the rest of the panel. Exposed as a single global
// `Music` that app.js routes into.
//
// Two ideas carry most of the feel:
//   1. Optimistic UI. Every control paints its new state immediately and reconciles
//      when the server answers. On a phone over Cloudflare that is the difference
//      between "instant" and "laggy".
//   2. Local interpolation. The scrub bar ticks client-side between server updates,
//      so the position moves smoothly at 60fps instead of jumping every few seconds.

const Music = (() => {
  'use strict';

  // ---------- State ----------

  const S = {
    rooms: [],           // nowPlaying records, one per room
    topology: { rooms: [], groups: [] },
    favorites: [],
    playlists: [],
    radio: { presets: [], favorites: [] },
    lineIn: [],
    searchEnabled: false,
    searchProviders: [],
    favoriteRooms: [],
    mode: null,          // 'push' | 'poll'
    loaded: false,
    // Per-screen scratch
    activeRoom: null,
    queue: { room: null, tracks: [], total: 0, updatedAt: 0 },
    search: { query: '', results: null, tab: 'track', loading: false },
    caps: new Map(),
    // Local position interpolation
    tick: { room: null, seconds: 0, duration: 0, playing: false, at: 0 },
  };

  let tickTimer = null;
  let pollTimer = null;
  let searchDebounce = null;
  let toastTimer = null;

  // ---------- Utilities ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtTime(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }

  function parseTime(value) {
    if (!value || typeof value !== 'string') return 0;
    const parts = value.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  /** Short haptic tap where the platform supports it — makes controls feel physical. */
  function haptic(ms = 8) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (_) {} }
  }

  function toast(message, isError = false) {
    const existing = $('.m-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'm-toast' + (isError ? ' is-error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), isError ? 4200 : 2200);
  }

  /**
   * Replace a container's contents only when they would actually differ.
   *
   * The polling loop repaints every few seconds. Blindly assigning innerHTML each
   * time costs nothing visually *if* nothing changed — except it does: the container
   * empties for an instant, the document collapses to a fraction of its height, the
   * browser clamps scrollY to the new maximum, and the user is thrown back to the top
   * mid-scroll. Repeat every 3 seconds and the page is unusable.
   *
   * So: compare a signature of the meaningful state first and skip identical repaints
   * entirely, and when a repaint really is needed, restore the scroll position across
   * it. Volatile values that tick every second (playback position) are deliberately
   * excluded from signatures — those are updated in place by the ticker instead.
   */
  const RENDER_SIGS = new Map();

  function renderIfChanged(holder, key, signature, buildHtml) {
    if (!holder) return false;
    if (RENDER_SIGS.get(key) === signature) return false;
    RENDER_SIGS.set(key, signature);
    const y = window.scrollY;
    holder.innerHTML = buildHtml();
    // Only restore if the page is still tall enough to hold that offset, so we never
    // fight a genuinely shorter page.
    if (y > 0 && document.documentElement.scrollHeight - window.innerHeight >= y) {
      window.scrollTo(0, y);
    }
    return true;
  }

  function invalidateRender(key) {
    if (key) RENDER_SIGS.delete(key);
    else RENDER_SIGS.clear();
  }

  const ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5l9 7-9 7V5z"/><rect x="16" y="5" width="2.6" height="14" rx="1"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 5l-9 7 9 7V5z"/><rect x="5.4" y="5" width="2.6" height="14" rx="1"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 6h13M3 12h13M3 18h9M18 12v7M18 19a2 2 0 1 0 0 .01"/></svg>',
    group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    browse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    eq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
    sleep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    drag: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
    radio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>',
    linein: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  };

  function artHtml(url, cls, alt = '') {
    if (url) {
      return `<img class="m-art ${cls}" src="/api/sonos/art?u=${encodeURIComponent(url)}" alt="${esc(alt)}" loading="lazy" onerror="this.replaceWith(Music.fallbackArt('${cls}'))"/>`;
    }
    return `<div class="m-art m-art-fallback ${cls}">${ICONS.note}</div>`;
  }

  function fallbackArt(cls) {
    const el = document.createElement('div');
    el.className = `m-art m-art-fallback ${cls}`;
    el.innerHTML = ICONS.note;
    return el;
  }

  // ---------- API ----------

  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) {
      let detail = `${res.status}`;
      try { detail = (await res.json()).error || detail; } catch (_) {}
      throw new Error(detail);
    }
    return res.json();
  }

  const post = (path, body) => api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** Fire a command, roll the UI back and surface the reason if it fails. */
  async function command(fn, { onError } = {}) {
    try {
      return await fn();
    } catch (e) {
      toast(e.message || 'Command failed', true);
      if (onError) onError(e);
      return null;
    }
  }

  // ---------- Data loading ----------

  async function loadState() {
    const data = await api('/api/sonos/state');
    S.rooms = data.rooms || [];
    S.topology = data.topology || { rooms: [], groups: [] };
    S.searchEnabled = !!data.searchEnabled;
    S.searchProviders = data.searchProviders || [];
    S.favoriteRooms = data.favoriteRooms || [];
    S.mode = data.mode;
    S.loaded = true;
    if (data.error) toast(`Sonos: ${data.error}`, true);
    return data;
  }

  async function loadLibrary() {
    const [fav, pl, radio, lineIn] = await Promise.all([
      api('/api/sonos/favorites').catch(() => ({ items: [] })),
      api('/api/sonos/playlists').catch(() => ({ items: [] })),
      api('/api/sonos/radio').catch(() => ({ presets: [], favorites: [] })),
      api('/api/sonos/linein').catch(() => ({ items: [] })),
    ]);
    S.favorites = fav.items || [];
    S.playlists = pl.items || [];
    S.radio = radio;
    S.lineIn = lineIn.items || [];
  }

  function roomState(name) {
    return S.rooms.find((r) => r.room === name) || null;
  }

  /**
   * Zones list shows GROUPS, not rooms — a grouped set is one thing playing one thing,
   * which is exactly how the real app models it. The coordinator's record represents
   * the group.
   */
  function groupCards() {
    const byId = new Map();
    for (const room of S.rooms) {
      const existing = byId.get(room.groupId);
      if (!existing || room.isCoordinator) byId.set(room.groupId, room);
    }
    const cards = [...byId.values()];
    const rank = (r) => {
      if (r.state === 'PLAYING' || r.state === 'TRANSITIONING') return 0;
      if (r.state === 'PAUSED_PLAYBACK') return 1;
      if (r.offline) return 4;
      const fav = S.favoriteRooms.indexOf(r.room);
      return fav >= 0 ? 2 : 3;
    };
    return cards.sort((a, b) => rank(a) - rank(b) || a.room.localeCompare(b.room));
  }

  function isPlaying(state) {
    return state === 'PLAYING' || state === 'TRANSITIONING';
  }

  function hasAudio(state) {
    return isPlaying(state) || state === 'PAUSED_PLAYBACK';
  }

  /**
   * Turn a raw now-playing record into what a person should actually read.
   *
   * The raw data needs real work before it is presentable:
   *   - A STOPPED player still reports whatever it last held, so the zone list would
   *     otherwise show a track that is not playing and cannot be resumed.
   *   - TV, line-in and AirPlay sources have no track metadata at all — they would
   *     read as "Idle" while audibly playing.
   *   - Internet radio reports its stream mount ("groovesalad-128-mp3") as the title.
   *   - The announcement system leaves hashed .mp3 filenames behind on idle players.
   */
  function displayTrack(np, { showLoaded = false } = {}) {
    if (!np) return { title: null, subtitle: null, art: null, live: false };
    const track = np.track || {};

    if (np.sourceKind === 'tv') {
      return { title: 'TV', subtitle: np.model || 'HDMI', art: null, live: true };
    }
    if (np.sourceKind === 'line-in') {
      return { title: 'Line-In', subtitle: track.title || np.model || null, art: null, live: true };
    }
    if (np.sourceKind === 'airplay') {
      return { title: track.title || 'AirPlay', subtitle: track.artist || 'AirPlay', art: track.art || null, live: true };
    }
    // Nothing is loaded, or the player is stopped and only holding stale metadata.
    // The zone list and mini player hide that; the now-playing screen shows it,
    // because there it is not stale — it is what will start when you press play.
    if (!track.title || (!hasAudio(np.state) && !showLoaded)) {
      return { title: null, subtitle: null, art: null, live: false };
    }

    let title = track.title;
    let subtitle = track.artist || null;

    // Internet radio: "groovesalad-128-mp3" -> "Groove Salad".
    const mount = /^([a-z0-9]+?)-\d+-(mp3|aac)$/i.exec(title);
    if (mount) {
      const preset = (S.radio.presets || []).find((p) => p.id === mount[1].toLowerCase());
      title = preset ? preset.title : mount[1].replace(/([a-z])([A-Z])/g, '$1 $2');
      if (!subtitle) subtitle = track.station && track.station !== track.title ? track.station : 'Radio';
    }

    // Announcement/TTS artefacts: a bare filename with no artist is not music.
    if (!subtitle && /^[0-9a-f]{6,}\.(mp3|wav|m4a)$/i.test(title)) {
      return { title: 'Announcement', subtitle: null, art: null, live: true };
    }
    if (/\.(mp3|wav|m4a)$/i.test(title) && !subtitle) {
      title = title.replace(/\.[a-z0-9]+$/i, '');
    }

    if (subtitle && subtitle === title) subtitle = null;
    return { title, subtitle, art: track.art || null, live: true };
  }

  // ---------- Position interpolation ----------

  function startTick() {
    stopTick();
    tickTimer = setInterval(() => {
      if (!S.tick.playing) return;
      const elapsed = (Date.now() - S.tick.at) / 1000;
      const seconds = Math.min(S.tick.duration || Infinity, S.tick.seconds + elapsed);
      paintScrub(seconds, S.tick.duration);
      paintMiniProgress(seconds, S.tick.duration);
    }, 250);
  }

  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function syncTick(np) {
    if (!np) return;
    S.tick = {
      room: np.room,
      seconds: np.positionSeconds || 0,
      duration: np.track?.durationSeconds || 0,
      playing: isPlaying(np.state),
      at: Date.now(),
    };
  }

  function paintScrub(seconds, duration) {
    const fill = $('.m-scrub-fill');
    const thumb = $('.m-scrub-thumb');
    const elapsed = $('[data-scrub-elapsed]');
    const track = $('.m-scrub-track');
    if (!fill || !track || track.classList.contains('is-dragging')) return;
    const pct = duration > 0 ? Math.min(100, (seconds / duration) * 100) : 0;
    fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
    if (elapsed) elapsed.textContent = fmtTime(seconds);
  }

  function paintMiniProgress(seconds, duration) {
    const bar = $('.m-mini-progress i');
    if (!bar) return;
    bar.style.width = (duration > 0 ? Math.min(100, (seconds / duration) * 100) : 0) + '%';
  }

  // ---------- Album art ambience ----------

  /**
   * Sample the album art and drive the background wash from it. Keeps the now-playing
   * screen feeling like it belongs to the music rather than to the app chrome.
   */
  function applyArtAmbience(url) {
    const root = document.documentElement;
    if (!url) {
      root.style.setProperty('--m-art-1', '#1a1a22');
      root.style.setProperty('--m-art-2', '#0d0d12');
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let r = 0, g = 0, b = 0, n = 0;
        let br = 0, bg = 0, bb = 0, bestScore = -1;
        for (let i = 0; i < data.length; i += 4) {
          const [pr, pg, pb] = [data[i], data[i + 1], data[i + 2]];
          r += pr; g += pg; b += pb; n++;
          // Favour saturated, mid-bright pixels for the accent wash.
          const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
          const sat = max === 0 ? 0 : (max - min) / max;
          const score = sat * (1 - Math.abs(max / 255 - 0.62));
          if (score > bestScore) { bestScore = score; br = pr; bg = pg; bb = pb; }
        }
        const avg = [r / n, g / n, b / n];
        // Dim heavily — this sits behind text and must never fight it.
        root.style.setProperty('--m-art-1', `rgba(${br | 0}, ${bg | 0}, ${bb | 0}, 0.42)`);
        root.style.setProperty('--m-art-2', `rgba(${avg[0] | 0}, ${avg[1] | 0}, ${avg[2] | 0}, 0.30)`);
      } catch (_) {
        // Tainted canvas — harmless, just keep the neutral wash.
      }
    };
    img.src = `/api/sonos/art?u=${encodeURIComponent(url)}`;
  }

  // ---------- Sliders (shared pointer handling) ----------

  /**
   * Wire a horizontal drag control. One implementation serves volume and scrub, on
   * both touch and mouse, with pointer capture so a drag that leaves the element
   * still tracks.
   */
  function attachSlider(track, { onInput, onCommit, disabled = false }) {
    if (!track || disabled) return;
    let dragging = false;

    const pct = (evt) => {
      const rect = track.getBoundingClientRect();
      const x = (evt.clientX ?? 0) - rect.left;
      return Math.max(0, Math.min(1, rect.width ? x / rect.width : 0));
    };

    track.addEventListener('pointerdown', (e) => {
      dragging = true;
      track.setPointerCapture(e.pointerId);
      track.classList.add('is-dragging');
      onInput(pct(e));
      e.preventDefault();
    });
    track.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      onInput(pct(e));
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove('is-dragging');
      haptic(6);
      onCommit(pct(e));
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  function volumeControlHtml(value, muted, { fixed = false, label = null } = {}) {
    const v = value == null ? 0 : value;
    return `
      <div class="m-vol ${fixed ? 'is-fixed' : ''}">
        <span class="m-vol-icon ${muted ? 'is-muted' : ''}" data-mute>${muted ? ICONS.muted : ICONS.volume}</span>
        <div class="m-vol-track" data-vol>
          <div class="m-vol-rail"><div class="m-vol-fill" style="width:${v}%"></div></div>
          <div class="m-vol-thumb" style="left:${v}%"></div>
        </div>
        <span class="m-vol-num">${fixed ? 'FIX' : v}</span>
      </div>`;
  }

  function wireVolume(scope, { getRoom, groupScope = false }) {
    const wrap = scope.querySelector('.m-vol');
    if (!wrap) return;
    const track = wrap.querySelector('[data-vol]');
    const fill = wrap.querySelector('.m-vol-fill');
    const thumb = wrap.querySelector('.m-vol-thumb');
    const num = wrap.querySelector('.m-vol-num');
    if (wrap.classList.contains('is-fixed')) return;

    const paint = (ratio) => {
      const v = Math.round(ratio * 100);
      fill.style.width = v + '%';
      thumb.style.left = v + '%';
      num.textContent = v;
      return v;
    };

    attachSlider(track, {
      onInput: paint,
      onCommit: async (ratio) => {
        const v = paint(ratio);
        const room = getRoom();
        const local = roomState(room);
        if (local) local.volume = v;
        await command(() => post('/api/sonos/volume', {
          room, volume: v, scope: groupScope ? 'group' : 'player',
        }));
      },
    });

    const muteBtn = wrap.querySelector('[data-mute]');
    if (muteBtn) {
      muteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const room = getRoom();
        const local = roomState(room);
        const next = !(local && local.muted);
        if (local) local.muted = next;
        muteBtn.classList.toggle('is-muted', next);
        muteBtn.innerHTML = next ? ICONS.muted : ICONS.volume;
        haptic();
        await command(() => post('/api/sonos/mute', {
          room, muted: next, scope: groupScope ? 'group' : 'player',
        }));
      });
    }
  }

  // ---------- Screen: Zones ----------

  function renderZones(app) {
    stopTick();
    app.innerHTML = `
      ${topbar('Music', S.mode === 'push' ? 'Live' : 'Sonos', { back: '/' })}
      <div class="m-shell fade-in">
        <div id="m-zones-content">${S.loaded ? '' : zoneSkeleton()}</div>
      </div>`;
    wireTopbar(app);
    // The container was just recreated, so any cached render signature is stale —
    // without this the conditional repaint would decide the empty list is current.
    invalidateRender('zones');
    if (S.loaded) paintZones();
    (S.loaded ? Promise.resolve() : loadState()).then(() => paintZones());
    startPolling();
  }

  function zoneSkeleton() {
    return `<div class="m-zones">${Array.from({ length: 6 }, () => `
      <div class="m-zone"><div class="m-skeleton" style="width:56px;height:56px;border-radius:10px"></div>
      <div class="m-zone-body"><div class="m-skeleton" style="width:45%;height:15px;margin-bottom:8px"></div>
      <div class="m-skeleton" style="width:70%;height:12px"></div></div></div>`).join('')}</div>`;
  }

  function paintZones() {
    const holder = document.getElementById('m-zones-content');
    if (!holder) return;
    const cards = groupCards();
    const playing = cards.filter((c) => isPlaying(c.state));

    const signature = JSON.stringify(cards.map((c) => {
      const d = displayTrack(c);
      return [c.room, c.groupName, c.groupSize, c.state, d.title, d.subtitle, d.art, c.offline, c.model, c.service];
    }));
    const changed = renderIfChanged(holder, 'zones', signature, () => `
      <div class="m-summary">
        <div class="m-summary-num">${playing.length}</div>
        <div class="m-summary-label">
          ${playing.length === 0 ? 'Nothing playing' : `${playing.length === 1 ? 'zone' : 'zones'} playing`}<br>
          <span class="m-summary-sub">${S.topology.rooms.length} rooms · ${S.topology.groups.length} groups</span>
        </div>
      </div>

      <div class="m-toolbar">
        <button class="m-chip" data-go="/music/browse">${ICONS.browse} Browse</button>
        <button class="m-chip" data-go="/music/search">${ICONS.search} Search</button>
        ${S.topology.groups.some((g) => g.size > 1)
          ? `<button class="m-chip is-danger" data-ungroup>${ICONS.group} Drop all groups</button>` : ''}
        ${playing.length ? `<button class="m-chip is-danger" data-pause-all>${ICONS.pause} Pause all</button>` : ''}
      </div>

      <div class="m-zones">${cards.map(zoneCard).join('')}</div>`);

    if (changed) wireZones(holder);
  }

  function zoneCard(r) {
    const playing = isPlaying(r.state);
    const d = displayTrack(r);

    // The second line is context, not a repeat of the first: service and group size
    // when something is on, hardware when the room is idle.
    const context = r.offline
      ? 'Unreachable'
      : [
          d.live ? (r.sourceKind === 'tv' ? null : r.service) : r.model,
          r.groupSize > 1 ? `${r.groupSize} rooms` : null,
        ].filter(Boolean).join(' · ');

    const subline = [d.subtitle, context].filter(Boolean).join(' · ');

    return `
      <div class="m-zone ${playing ? 'is-playing' : ''} ${r.offline ? 'is-offline' : ''}" data-room="${esc(r.room)}">
        ${artHtml(d.art, 'm-zone-art', d.title || r.room)}
        <div class="m-zone-body">
          <div class="m-zone-name">
            ${esc(r.groupSize > 1 ? r.groupName : r.room)}
            ${playing ? '<span class="m-eq"><i></i><i></i><i></i></span>' : ''}
            ${r.groupSize > 1 ? `<span class="m-zone-badge">${r.groupSize}</span>` : ''}
          </div>
          <div class="m-zone-track">${d.title
            ? esc(d.title)
            : `<span style="color:var(--text-dimmer)">${r.state === 'PAUSED_PLAYBACK' ? 'Paused' : 'Idle'}</span>`}</div>
          <div class="m-zone-sub">${esc(subline)}</div>
        </div>
        <button class="m-zone-play ${playing ? 'is-on' : ''}" data-toggle aria-label="${playing ? 'Pause' : 'Play'} ${esc(r.room)}">
          ${playing ? ICONS.pause : ICONS.play}
        </button>
      </div>`;
  }

  function wireZones(holder) {
    $$('[data-go]', holder).forEach((el) => {
      el.addEventListener('click', () => navigate(el.dataset.go));
    });

    const ungroup = $('[data-ungroup]', holder);
    if (ungroup) ungroup.addEventListener('click', async () => {
      haptic(12);
      await command(() => post('/api/sonos/group', { action: 'ungroupAll' }));
      await refresh();
    });

    const pauseAll = $('[data-pause-all]', holder);
    if (pauseAll) pauseAll.addEventListener('click', async () => {
      haptic(12);
      const playing = groupCards().filter((c) => isPlaying(c.state));
      playing.forEach((c) => { c.state = 'PAUSED_PLAYBACK'; });
      paintZones();
      await Promise.all(playing.map((c) =>
        command(() => post('/api/sonos/transport', { room: c.room, action: 'pause' }))));
      await refresh();
    });

    $$('.m-zone', holder).forEach((card) => {
      const room = card.dataset.room;
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-toggle]')) return;
        navigate('/music/z/' + encodeURIComponent(room));
      });
      const btn = $('[data-toggle]', card);
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        haptic();
        const r = roomState(room);
        const next = isPlaying(r?.state) ? 'PAUSED_PLAYBACK' : 'PLAYING';
        if (r) r.state = next;
        // Repaint just this card so the whole list does not flash.
        card.classList.toggle('is-playing', next === 'PLAYING');
        btn.classList.toggle('is-on', next === 'PLAYING');
        btn.innerHTML = next === 'PLAYING' ? ICONS.pause : ICONS.play;
        await command(() => post('/api/sonos/transport', { room, action: 'toggle' }));
        setTimeout(refresh, 500);
      });
    });
  }

  // ---------- Screen: Now Playing ----------

  async function renderNowPlaying(app, room) {
    S.activeRoom = room;
    app.innerHTML = `
      ${topbar(room, 'Now Playing', { back: '/music' })}
      <div class="m-np m-shell fade-in" id="m-np"><div class="m-empty">Loading…</div></div>`;
    wireTopbar(app);
    invalidateRender('np');
    await paintNowPlaying(room);
    startTick();
    startPolling();
  }

  async function paintNowPlaying(room) {
    const holder = document.getElementById('m-np');
    if (!holder) return;

    let np;
    try {
      np = await api('/api/sonos/now?room=' + encodeURIComponent(room));
    } catch (e) {
      holder.innerHTML = `<div class="m-empty"><strong>Could not reach ${esc(room)}</strong>${esc(e.message)}</div>`;
      return;
    }
    if (!np) { holder.innerHTML = `<div class="m-empty"><strong>Unknown room</strong></div>`; return; }

    // Keep the shared room list in sync so the zones screen is correct on return.
    const idx = S.rooms.findIndex((r) => r.room === room);
    if (idx >= 0) S.rooms[idx] = np; else S.rooms.push(np);
    syncTick(np);

    const playing = isPlaying(np.state);
    const track = np.track || {};
    const d = displayTrack(np, { showLoaded: true });
    const duration = track.durationSeconds || 0;
    const position = np.positionSeconds || 0;
    const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    const isRadio = np.sourceKind === 'radio' || np.sourceKind === 'line-in' || np.sourceKind === 'tv';

    applyArtAmbience(d.art);

    const caps = S.caps.get(room);
    const group = S.topology.groups.find((g) => g.id === np.groupId);
    const members = group ? group.memberUuids.map((u) => S.topology.rooms.find((r) => r.uuid === u)).filter(Boolean) : [];

    holder.className = `m-np m-shell ${playing ? '' : 'is-paused'}`;

    // Same conditional-repaint rule as the zone list. Without it the poll loop
    // rebuilds this view every few seconds, which re-creates the <img> and makes the
    // album art visibly blink. Playback position is deliberately absent from the
    // signature — the ticker moves the scrub bar in place.
    const signature = JSON.stringify([
      np.room, np.state, d.title, d.subtitle, d.art, track.album, track.station,
      np.shuffle, np.repeat, np.volume, np.muted, np.groupName, np.groupSize,
      np.queueLength, np.canNext, np.canPrevious, np.canSeek, np.sourceKind, np.hasTV,
      members.map((m) => { const st = roomState(m.name); return [m.name, st && st.volume, st && st.muted]; }),
    ]);
    const changed = renderIfChanged(holder, 'np', signature, () => `
      <div class="m-np-art-wrap">${artHtml(d.art, 'm-np-art', d.title || room)}</div>

      <div class="m-np-meta">
        <div class="m-np-title">${esc(d.title || 'Nothing playing')}</div>
        ${d.subtitle ? `<div class="m-np-artist">${esc(d.subtitle)}</div>` : ''}
        ${track.album && track.album !== d.subtitle && track.album !== d.title ? `<div class="m-np-album">${esc(track.album)}</div>` : ''}
        ${track.station && track.station !== d.title && track.station !== d.subtitle ? `<div class="m-np-album">${esc(track.station)}</div>` : ''}
        ${np.service || np.sourceKind !== 'none'
          ? `<div class="m-np-source">${sourceLabel(np)}</div>` : ''}
      </div>

      <div class="m-scrub">
        <div class="m-scrub-track ${duration > 0 && np.canSeek ? '' : 'is-disabled'}" data-scrub>
          <div class="m-scrub-rail"></div>
          <div class="m-scrub-fill" style="width:${pct}%"></div>
          <div class="m-scrub-thumb" style="left:${pct}%"></div>
        </div>
        <div class="m-scrub-times">
          <span data-scrub-elapsed>${fmtTime(position)}</span>
          <span>${isRadio && !duration ? 'LIVE' : fmtTime(duration)}</span>
        </div>
      </div>

      <div class="m-transport">
        <button class="m-tbtn is-small ${np.shuffle ? 'is-on' : ''}" data-shuffle aria-label="Shuffle">${ICONS.shuffle}</button>
        <button class="m-tbtn" data-prev ${np.canPrevious ? '' : 'disabled'} aria-label="Previous">${ICONS.prev}</button>
        <button class="m-tbtn m-tbtn-main" data-toggle aria-label="${playing ? 'Pause' : 'Play'}">${playing ? ICONS.pause : ICONS.play}</button>
        <button class="m-tbtn" data-next ${np.canNext ? '' : 'disabled'} aria-label="Next">${ICONS.next}</button>
        <button class="m-tbtn is-small ${np.repeat !== 'none' ? 'is-on' : ''} ${np.repeat === 'one' ? 'm-repeat-one' : ''}" data-repeat aria-label="Repeat">${ICONS.repeat}</button>
      </div>

      ${volumeControlHtml(np.volume, np.muted, { fixed: caps ? !caps.volumeControllable : false })}

      <div class="m-actions" style="margin-top:22px">
        <button class="m-action" data-go="/music/q/${encodeURIComponent(room)}">${ICONS.queue}<span>Queue${np.queueLength ? ` · ${np.queueLength}` : ''}</span></button>
        <button class="m-action ${np.groupSize > 1 ? 'is-on' : ''}" data-group>${ICONS.group}<span>${np.groupSize > 1 ? `${np.groupSize} rooms` : 'Group'}</span></button>
        <button class="m-action" data-go="/music/browse">${ICONS.browse}<span>Browse</span></button>
        <button class="m-action" data-more>${ICONS.more}<span>More</span></button>
      </div>

      ${members.length > 1 ? `
        <div class="m-members">
          <div class="m-section-head"><div class="m-section-title">Room volumes</div></div>
          ${members.map((m) => {
            const st = roomState(m.name);
            return `<div class="m-member" data-member="${esc(m.name)}">
              <div class="m-member-name">${m.uuid === group.coordinatorUuid ? '<span class="m-coord-dot"></span>' : ''}${esc(m.name)}</div>
              ${volumeControlHtml(st ? st.volume : 0, st ? st.muted : false)}
            </div>`;
          }).join('')}
        </div>` : ''}
    `);

    if (changed) wireNowPlaying(holder, room, np);
    if (!caps) {
      api('/api/sonos/caps?room=' + encodeURIComponent(room))
        .then((c) => { S.caps.set(room, c); })
        .catch(() => {});
    }
  }

  function sourceLabel(np) {
    const map = {
      'line-in': 'Line-In', tv: 'TV', airplay: 'AirPlay', radio: 'Radio',
      queue: np.service || 'Queue', track: np.service || 'Track', container: np.service || '',
    };
    const label = map[np.sourceKind] || np.service || '';
    return esc(label || 'Idle');
  }

  function wireNowPlaying(holder, room, np) {
    const btn = (sel) => $(sel, holder);

    btn('[data-toggle]').addEventListener('click', async () => {
      haptic();
      const nowPlaying = isPlaying(np.state);
      np.state = nowPlaying ? 'PAUSED_PLAYBACK' : 'PLAYING';
      S.tick.playing = !nowPlaying;
      S.tick.at = Date.now();
      holder.classList.toggle('is-paused', nowPlaying);
      btn('[data-toggle]').innerHTML = nowPlaying ? ICONS.play : ICONS.pause;
      await command(() => post('/api/sonos/transport', { room, action: 'toggle' }));
    });

    const step = async (action) => {
      haptic();
      await command(() => post('/api/sonos/transport', { room, action }));
      setTimeout(() => paintNowPlaying(room), 700);
    };
    btn('[data-next]').addEventListener('click', () => step('next'));
    btn('[data-prev]').addEventListener('click', () => step('previous'));

    btn('[data-shuffle]').addEventListener('click', async () => {
      haptic();
      const next = !np.shuffle;
      np.shuffle = next;
      btn('[data-shuffle]').classList.toggle('is-on', next);
      await command(() => post('/api/sonos/playmode', { room, shuffle: next }));
    });

    btn('[data-repeat]').addEventListener('click', async () => {
      haptic();
      const order = { none: 'all', all: 'one', one: 'none' };
      const next = order[np.repeat] || 'all';
      np.repeat = next;
      const el = btn('[data-repeat]');
      el.classList.toggle('is-on', next !== 'none');
      el.classList.toggle('m-repeat-one', next === 'one');
      await command(() => post('/api/sonos/playmode', { room, repeat: next }));
    });

    // Scrub
    const scrub = btn('[data-scrub]');
    const duration = np.track?.durationSeconds || 0;
    if (scrub && duration > 0 && np.canSeek) {
      const fill = $('.m-scrub-fill', holder);
      const thumb = $('.m-scrub-thumb', holder);
      const elapsed = $('[data-scrub-elapsed]', holder);
      attachSlider(scrub, {
        onInput: (ratio) => {
          fill.style.width = ratio * 100 + '%';
          thumb.style.left = ratio * 100 + '%';
          elapsed.textContent = fmtTime(ratio * duration);
        },
        onCommit: async (ratio) => {
          const seconds = Math.round(ratio * duration);
          S.tick.seconds = seconds;
          S.tick.at = Date.now();
          await command(() => post('/api/sonos/transport', { room, action: 'seek', value: seconds }));
        },
      });
    }

    wireVolume(holder, { getRoom: () => room, groupScope: np.groupSize > 1 });

    $$('.m-member', holder).forEach((el) => {
      wireVolume(el, { getRoom: () => el.dataset.member });
    });

    $$('[data-go]', holder).forEach((el) => el.addEventListener('click', () => navigate(el.dataset.go)));
    btn('[data-group]').addEventListener('click', () => openGroupSheet(room));
    btn('[data-more]').addEventListener('click', () => openMoreSheet(room, np));
  }

  // ---------- Screen: Queue ----------

  async function renderQueue(app, room) {
    S.activeRoom = room;
    app.innerHTML = `
      ${topbar('Queue', room, { back: '/music/z/' + encodeURIComponent(room) })}
      <div class="m-shell fade-in" id="m-queue"><div class="m-empty">Loading queue…</div></div>`;
    wireTopbar(app);
    await paintQueue(room);
    startPolling();
  }

  async function paintQueue(room) {
    const holder = document.getElementById('m-queue');
    if (!holder) return;
    let data, np;
    try {
      [data, np] = await Promise.all([
        api(`/api/sonos/queue?room=${encodeURIComponent(room)}&count=500`),
        api('/api/sonos/now?room=' + encodeURIComponent(room)).catch(() => null),
      ]);
    } catch (e) {
      holder.innerHTML = `<div class="m-empty"><strong>Could not read the queue</strong>${esc(e.message)}</div>`;
      return;
    }
    S.queue = { room, tracks: data.tracks, total: data.total, updatedAt: Date.now() };
    const current = np ? np.queueTrack : 0;

    if (!data.tracks.length) {
      holder.innerHTML = `
        <div class="m-empty">
          <strong>Queue is empty</strong>
          Play something from Browse or Search and it will show up here.
        </div>
        <div class="m-toolbar" style="justify-content:center">
          <button class="m-chip" data-go="/music/browse">${ICONS.browse} Browse</button>
          <button class="m-chip" data-go="/music/search">${ICONS.search} Search</button>
        </div>`;
      $$('[data-go]', holder).forEach((el) => el.addEventListener('click', () => navigate(el.dataset.go)));
      return;
    }

    holder.innerHTML = `
      <div class="m-section-head">
        <div class="m-section-title">${data.total} ${data.total === 1 ? 'track' : 'tracks'}</div>
        <div>
          <button class="m-section-action" data-save>Save</button>
          <button class="m-section-action" data-clear style="color:var(--danger)">Clear</button>
        </div>
      </div>
      <div class="m-list" data-queue-list>
        ${data.tracks.map((t, i) => queueRow(t, i + 1, i + 1 === current)).join('')}
      </div>`;

    wireQueue(holder, room);
  }

  function queueRow(t, index, isCurrent) {
    // Plenty of singles are on an album of the same name as the artist; printing
    // "Ricky Martin · Ricky Martin" reads like a bug even though it is accurate.
    const parts = [t.artist, t.album].filter(Boolean);
    const sub = parts[0] === parts[1] ? parts[0] : parts.join(' · ');
    return `
      <div class="m-row ${isCurrent ? 'is-current' : ''}" data-index="${index}" draggable="false">
        <span class="m-drag-handle" data-handle>${ICONS.drag}</span>
        ${artHtml(t.art, 'm-row-art', t.title)}
        <div class="m-row-body">
          <div class="m-row-title">${esc(t.title || `Track ${index}`)}</div>
          <div class="m-row-sub">${esc(sub || '')}</div>
        </div>
        <span class="m-row-meta">${t.duration || ''}</span>
        <button class="m-row-btn is-danger" data-remove aria-label="Remove">${ICONS.close}</button>
      </div>`;
  }

  function wireQueue(holder, room) {
    const list = $('[data-queue-list]', holder);

    $$('.m-row', holder).forEach((row) => {
      const index = parseInt(row.dataset.index, 10);

      row.addEventListener('click', async (e) => {
        if (e.target.closest('[data-remove]') || e.target.closest('[data-handle]')) return;
        haptic();
        $$('.m-row', holder).forEach((r) => r.classList.remove('is-current'));
        row.classList.add('is-current');
        await command(() => post('/api/sonos/transport', { room, action: 'playIndex', value: index }));
      });

      $('[data-remove]', row).addEventListener('click', async (e) => {
        e.stopPropagation();
        haptic(10);
        row.style.transition = 'opacity 160ms, transform 160ms';
        row.style.opacity = '0';
        row.style.transform = 'translateX(-16px)';
        await command(() => post('/api/sonos/queue', { room, action: 'remove', index }));
        setTimeout(() => paintQueue(room), 260);
      });
    });

    attachDragReorder(list, async (from, to) => {
      haptic(14);
      await command(() => post('/api/sonos/queue', { room, action: 'reorder', from, to }));
      setTimeout(() => paintQueue(room), 320);
    });

    $('[data-clear]', holder).addEventListener('click', async () => {
      if (!confirm('Clear the whole queue?')) return;
      haptic(14);
      await command(() => post('/api/sonos/queue', { room, action: 'clear' }));
      paintQueue(room);
    });

    $('[data-save]', holder).addEventListener('click', async () => {
      const title = prompt('Save this queue as a Sonos playlist named:');
      if (!title) return;
      const result = await command(() => post('/api/sonos/queue', { room, action: 'save', title }));
      if (result) { toast(`Saved “${title}”`); S.playlists = []; }
    });
  }

  /**
   * Drag-to-reorder using pointer events so it works identically with touch and mouse.
   * Indices reported to the caller are 1-based positions as displayed; the server
   * handles the InsertBefore arithmetic.
   */
  function attachDragReorder(list, onDrop) {
    if (!list) return;
    let dragRow = null;
    let dropTarget = null;
    let dropAfter = false;

    const clearMarkers = () => {
      $$('.m-row', list).forEach((r) => r.classList.remove('is-drop-before', 'is-drop-after'));
    };

    $$('[data-handle]', list).forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        dragRow = handle.closest('.m-row');
        if (!dragRow) return;
        handle.setPointerCapture(e.pointerId);
        dragRow.classList.add('is-dragging');
        haptic(10);
        e.preventDefault();
      });

      handle.addEventListener('pointermove', (e) => {
        if (!dragRow) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const row = el && el.closest ? el.closest('.m-row') : null;
        clearMarkers();
        if (!row || row === dragRow) { dropTarget = null; return; }
        const rect = row.getBoundingClientRect();
        dropAfter = e.clientY > rect.top + rect.height / 2;
        row.classList.add(dropAfter ? 'is-drop-after' : 'is-drop-before');
        dropTarget = row;
      });

      const finish = () => {
        if (!dragRow) return;
        const from = parseInt(dragRow.dataset.index, 10);
        dragRow.classList.remove('is-dragging');
        clearMarkers();
        if (dropTarget) {
          const targetIndex = parseInt(dropTarget.dataset.index, 10);
          let to = dropAfter ? targetIndex : targetIndex;
          if (dropAfter && targetIndex < from) to = targetIndex + 1;
          if (!dropAfter && targetIndex > from) to = targetIndex - 1;
          if (to !== from) onDrop(from, to);
        }
        dragRow = null;
        dropTarget = null;
      };
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });
  }

  // ---------- Screen: Browse ----------

  async function renderBrowse(app) {
    app.innerHTML = `
      ${topbar('Browse', 'Favorites · Playlists · Radio', { back: '/music' })}
      <div class="m-shell fade-in" id="m-browse"><div class="m-empty">Loading…</div></div>`;
    wireTopbar(app);
    if (!S.favorites.length && !S.playlists.length) await loadLibrary();
    paintBrowse();
  }

  function paintBrowse() {
    const holder = document.getElementById('m-browse');
    if (!holder) return;

    const section = (title, items, renderer, action) => {
      if (!items.length) return '';
      return `
        <div class="m-section-head">
          <div class="m-section-title">${title}</div>
          ${action || ''}
        </div>
        <div class="m-list">${items.map(renderer).join('')}</div>`;
    };

    holder.innerHTML = `
      <div class="m-toolbar" style="padding-top:16px">
        <button class="m-chip" data-go="/music/search">${ICONS.search} Search ${S.searchEnabled ? '' : '(off)'}</button>
      </div>

      ${section('Sonos Favorites', S.favorites.filter((f) => f.playable), favRow)}
      ${section('Sonos Playlists', S.playlists, favRow)}
      ${section('Radio', S.radio.presets || [], radioRow)}
      ${section('Line-In', S.lineIn.filter((l) => l.name && l.name !== 'Audio Component'), lineInRow)}

      ${S.favorites.some((f) => !f.playable) ? `
        <div class="m-section-head"><div class="m-section-title">Shortcuts</div></div>
        <div class="m-empty" style="padding:12px 6px;text-align:left">
          ${S.favorites.filter((f) => !f.playable).map((f) => esc(f.title)).join(' · ')}
          <div style="margin-top:8px;font-size:12px;color:var(--text-dimmer)">
            These favorites are Sonos cloud browse shortcuts with no direct stream URI,
            so they can only be opened from the official app.
          </div>
        </div>` : ''}
    `;

    $$('[data-go]', holder).forEach((el) => el.addEventListener('click', () => navigate(el.dataset.go)));
    $$('[data-item]', holder).forEach((el) => {
      el.addEventListener('click', () => {
        const payload = JSON.parse(decodeURIComponent(el.dataset.item));
        openPlaySheet(payload);
      });
    });
  }

  function itemAttr(item) {
    return encodeURIComponent(JSON.stringify(item));
  }

  /** One-line status for a room in the play-target sheet. */
  function playSheetSub(room) {
    const d = displayTrack(room);
    if (isPlaying(room.state)) {
      return d.title ? `Playing · ${d.title}` : 'Playing';
    }
    if (room.state === 'PAUSED_PLAYBACK') return d.title ? `Paused · ${d.title}` : 'Paused';
    return room.model || 'Idle';
  }

  function favRow(f) {
    return `
      <button class="m-row" data-item="${itemAttr(f)}">
        ${artHtml(f.art, 'm-row-art', f.title)}
        <div class="m-row-body">
          <div class="m-row-title">${esc(f.title)}</div>
          <div class="m-row-sub">${esc([f.service, f.label].filter(Boolean).join(' · '))}</div>
        </div>
        <span class="m-row-btn">${ICONS.play}</span>
      </button>`;
  }

  function radioRow(r) {
    return `
      <button class="m-row" data-item="${itemAttr(r)}">
        <div class="m-art m-art-fallback m-row-art" style="font-size:20px">${r.emoji || ICONS.radio}</div>
        <div class="m-row-body">
          <div class="m-row-title">${esc(r.title)}</div>
          <div class="m-row-sub">${esc(r.artist || '')} · SomaFM</div>
        </div>
        <span class="m-row-btn">${ICONS.play}</span>
      </button>`;
  }

  function lineInRow(l) {
    return `
      <button class="m-row" data-item="${itemAttr({ ...l, kind: 'line-in', title: l.name, playAs: 'stream', playable: true })}">
        <div class="m-art m-art-fallback m-row-art">${ICONS.linein}</div>
        <div class="m-row-body">
          <div class="m-row-title">${esc(l.name)}</div>
          <div class="m-row-sub">Line-In · ${esc(l.room)}</div>
        </div>
        <span class="m-row-btn">${ICONS.play}</span>
      </button>`;
  }

  // ---------- Screen: Search ----------

  function renderSearch(app) {
    app.innerHTML = `
      ${topbar('Search', S.searchEnabled ? (S.searchProviders[0]?.name || 'Catalog') : 'Unavailable', { back: '/music' })}
      <div class="m-shell fade-in">
        <div class="m-search-bar">
          <div class="m-search-input-wrap">
            <span class="m-search-icon">${ICONS.search}</span>
            <input class="m-search-input" id="m-q" type="search" autocomplete="off" autocapitalize="off"
              spellcheck="false" placeholder="${S.searchEnabled ? 'Songs, albums, artists…' : 'Search is not configured'}"
              value="${esc(S.search.query)}" ${S.searchEnabled ? '' : 'disabled'}/>
            ${S.search.query ? `<button class="m-search-clear" data-clear>${ICONS.close}</button>` : ''}
          </div>
          <div class="m-tabs" id="m-tabs"></div>
        </div>
        <div id="m-results"></div>
      </div>`;
    wireTopbar(app);

    const input = document.getElementById('m-q');
    if (!S.searchEnabled) {
      document.getElementById('m-results').innerHTML = `
        <div class="m-empty">
          <strong>Search needs a Spotify app</strong>
          Sonos players can't search their own catalogs — that lives in Sonos's cloud.
          Add a free Spotify client ID and secret to <code>sonos-config.json</code> and
          full catalog search turns on here.
        </div>`;
      return;
    }

    input.addEventListener('input', () => {
      S.search.query = input.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(runSearch, 280);
    });
    const clear = $('[data-clear]');
    if (clear) clear.addEventListener('click', () => {
      S.search.query = ''; S.search.results = null;
      input.value = ''; input.focus();
      paintSearch();
    });

    if (S.search.results) paintSearch();
    else if (!S.search.query) {
      document.getElementById('m-results').innerHTML = `
        <div class="m-empty"><strong>Search ${esc(S.searchProviders[0]?.name || '')}</strong>
        Anything you find plays straight to any room in the house.</div>`;
    }
    setTimeout(() => input.focus(), 120);
  }

  async function runSearch() {
    const query = S.search.query.trim();
    const results = document.getElementById('m-results');
    if (!query) { S.search.results = null; if (results) results.innerHTML = ''; return; }
    if (results) results.innerHTML = `<div class="m-list">${Array.from({ length: 6 }, () => `
      <div class="m-row"><div class="m-skeleton" style="width:46px;height:46px;border-radius:8px"></div>
      <div class="m-row-body"><div class="m-skeleton" style="width:55%;height:13px;margin-bottom:7px"></div>
      <div class="m-skeleton" style="width:35%;height:11px"></div></div></div>`).join('')}</div>`;
    try {
      S.search.results = await api('/api/sonos/search?q=' + encodeURIComponent(query));
      paintSearch();
    } catch (e) {
      if (results) results.innerHTML = `<div class="m-empty"><strong>Search failed</strong>${esc(e.message)}</div>`;
    }
  }

  function paintSearch() {
    const tabs = document.getElementById('m-tabs');
    const results = document.getElementById('m-results');
    const r = S.search.results;
    if (!tabs || !results) return;
    if (!r) { tabs.innerHTML = ''; results.innerHTML = ''; return; }

    const groups = [
      { key: 'track', label: 'Songs', items: r.tracks || [] },
      { key: 'album', label: 'Albums', items: r.albums || [] },
      { key: 'artist', label: 'Artists', items: r.artists || [] },
      { key: 'playlist', label: 'Playlists', items: r.playlists || [] },
    ].filter((g) => g.items.length);

    if (!groups.length) {
      tabs.innerHTML = '';
      results.innerHTML = `<div class="m-empty"><strong>No results</strong>Nothing matched “${esc(S.search.query)}”.</div>`;
      return;
    }
    if (!groups.some((g) => g.key === S.search.tab)) S.search.tab = groups[0].key;

    tabs.innerHTML = groups.map((g) => `
      <button class="m-tab ${g.key === S.search.tab ? 'is-active' : ''}" data-tab="${g.key}">${g.label} ${g.items.length}</button>`).join('');
    $$('[data-tab]', tabs).forEach((el) => el.addEventListener('click', () => {
      S.search.tab = el.dataset.tab; paintSearch();
    }));

    const active = groups.find((g) => g.key === S.search.tab);
    results.innerHTML = `<div class="m-list">${active.items.map(searchRow).join('')}</div>`;
    $$('[data-item]', results).forEach((el) => el.addEventListener('click', () => {
      const payload = JSON.parse(decodeURIComponent(el.dataset.item));
      if (payload.kind === 'artist') openArtist(payload);
      else openPlaySheet(payload);
    }));
  }

  function searchRow(item) {
    const sub = item.kind === 'track' ? [item.artist, item.album].filter(Boolean).join(' · ')
      : item.kind === 'album' ? [item.artist, item.year].filter(Boolean).join(' · ')
      : item.kind === 'artist' ? (item.genres || []).slice(0, 2).join(', ') || 'Artist'
      : `${item.trackCount || ''} tracks${item.artist ? ' · ' + item.artist : ''}`;
    return `
      <button class="m-row" data-item="${itemAttr(item)}">
        ${artHtml(item.art, 'm-row-art' + (item.kind === 'artist' ? ' is-round' : ''), item.title)}
        <div class="m-row-body">
          <div class="m-row-title">${esc(item.title)}</div>
          <div class="m-row-sub">${esc(sub)}</div>
        </div>
        ${item.duration ? `<span class="m-row-meta">${item.duration}</span>` : ''}
        <span class="m-row-btn">${item.kind === 'artist' ? '›' : ICONS.play}</span>
      </button>`;
  }

  async function openArtist(artist) {
    const app = document.getElementById('app');
    app.innerHTML = `
      ${topbar(artist.title, 'Artist', { back: '/music/search' })}
      <div class="m-shell fade-in" id="m-artist"><div class="m-empty">Loading…</div></div>`;
    wireTopbar(app);
    try {
      const data = await api(`/api/sonos/artist-tracks?id=${encodeURIComponent(artist.id)}`);
      const holder = document.getElementById('m-artist');
      holder.innerHTML = `
        <div style="display:flex;justify-content:center;padding:10px 0 22px">
          ${artHtml(artist.art, 'm-np-art is-round', artist.title)}
        </div>
        <div class="m-section-head"><div class="m-section-title">Top songs</div></div>
        <div class="m-list">${(data.tracks || []).map(searchRow).join('')}</div>
        ${(data.albums || []).length ? `
          <div class="m-section-head"><div class="m-section-title">Albums</div></div>
          <div class="m-list">${data.albums.map(searchRow).join('')}</div>` : ''}`;
      $$('[data-item]', holder).forEach((el) => el.addEventListener('click', () => {
        openPlaySheet(JSON.parse(decodeURIComponent(el.dataset.item)));
      }));
    } catch (e) {
      document.getElementById('m-artist').innerHTML =
        `<div class="m-empty"><strong>Could not load artist</strong>${esc(e.message)}</div>`;
    }
  }

  // ---------- Sheets ----------

  function openSheet(html, { onMount } = {}) {
    const existing = $('.m-sheet-backdrop');
    if (existing) existing.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'm-sheet-backdrop';
    backdrop.innerHTML = `<div class="m-sheet"><div class="m-sheet-grip"></div>${html}</div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
    document.addEventListener('keydown', onKey);
    backdrop._onKey = onKey;
    if (onMount) onMount($('.m-sheet', backdrop));
    return backdrop;
  }

  function closeSheet() {
    const backdrop = $('.m-sheet-backdrop');
    if (!backdrop) return;
    if (backdrop._onKey) document.removeEventListener('keydown', backdrop._onKey);
    backdrop.style.opacity = '0';
    backdrop.style.transition = 'opacity 140ms';
    setTimeout(() => backdrop.remove(), 140);
  }

  /** Choose a room and how to play — the sheet every play action funnels through. */
  function openPlaySheet(item) {
    const target = S.activeRoom || (groupCards()[0] || {}).room;
    const cards = groupCards();
    const isTrack = item.kind === 'track';

    openSheet(`
      <div class="m-sheet-head"><div class="m-sheet-title">${esc(item.title)}</div></div>
      <div class="m-sheet-sub">${esc([item.artist, item.service].filter(Boolean).join(' · '))}</div>

      <div class="m-section-head"><div class="m-section-title">Play in</div></div>
      <div id="m-play-rooms">
        ${cards.map((c) => `
          <label class="m-check ${c.room === target ? 'is-on' : ''}" data-room="${esc(c.room)}">
            <span class="m-check-box">${ICONS.check}</span>
            <span class="m-check-body">
              <span class="m-check-name">${esc(c.groupSize > 1 ? c.groupName : c.room)}</span>
              <span class="m-check-sub">${esc(playSheetSub(c))}</span>
            </span>
          </label>`).join('')}
      </div>

      <div class="m-toolbar" style="padding-top:18px">
        <button class="m-chip is-active" data-play="now">${ICONS.play} Play now</button>
        ${isTrack ? `<button class="m-chip" data-play="next">${ICONS.plus} Play next</button>` : ''}
        <button class="m-chip" data-play="queue">${ICONS.queue} Add to queue</button>
      </div>
    `, {
      onMount(sheet) {
        let chosen = target;
        $$('[data-room]', sheet).forEach((el) => {
          el.addEventListener('click', () => {
            chosen = el.dataset.room;
            $$('[data-room]', sheet).forEach((x) => x.classList.toggle('is-on', x === el));
            haptic();
          });
        });
        $$('[data-play]', sheet).forEach((btn) => {
          btn.addEventListener('click', async () => {
            const mode = btn.dataset.play;
            haptic(12);
            closeSheet();
            const body = item.kind === 'line-in'
              ? { room: chosen, lineInRoom: item.room }
              : item.id && S.radio.presets?.some((p) => p.id === item.id)
                ? { room: chosen, presetId: item.id }
                : { room: chosen, item, mode };
            const result = await command(() => post('/api/sonos/play', body));
            if (result) {
              toast(mode === 'now' ? `Playing in ${chosen}` : mode === 'next' ? `Playing next in ${chosen}` : `Added to ${chosen}`);
              S.activeRoom = chosen;
              setTimeout(refresh, 900);
            }
          });
        });
      },
    });
  }

  /** Grouping: pick exactly which rooms play together. */
  function openGroupSheet(room) {
    const np = roomState(room);
    const group = S.topology.groups.find((g) => g.id === np?.groupId);
    const coordinator = group ? group.coordinatorName : room;
    const selected = new Set(group ? group.members || group.memberUuids.map((u) => {
      const r = S.topology.rooms.find((x) => x.uuid === u);
      return r ? r.name : null;
    }).filter(Boolean) : [room]);

    const allRooms = S.topology.rooms.slice().sort((a, b) => a.name.localeCompare(b.name));

    openSheet(`
      <div class="m-sheet-head">
        <div>
          <div class="m-sheet-title">Group</div>
        </div>
        <button class="m-sheet-done" data-done>Done</button>
      </div>
      <div class="m-sheet-sub">${esc(coordinator)} is the group leader — its music plays everywhere you tick.</div>

      <div class="m-toolbar" style="padding-bottom:14px">
        <button class="m-chip" data-all>Everywhere</button>
        <button class="m-chip" data-none>Just ${esc(coordinator)}</button>
      </div>

      <div id="m-group-rooms">
        ${allRooms.map((r) => {
          const locked = r.name === coordinator;
          const st = S.rooms.find((x) => x.room === r.name);
          return `
            <label class="m-check ${selected.has(r.name) || locked ? 'is-on' : ''} ${locked ? 'is-locked' : ''}" data-room="${esc(r.name)}">
              <span class="m-check-box">${ICONS.check}</span>
              <span class="m-check-body">
                <span class="m-check-name">${esc(r.name)}${locked ? ' · leader' : ''}</span>
                <span class="m-check-sub">${esc(r.model || '')}${st && isPlaying(st.state) && !locked ? ' · currently playing' : ''}</span>
              </span>
            </label>`;
        }).join('')}
      </div>
    `, {
      onMount(sheet) {
        const paint = () => {
          $$('[data-room]', sheet).forEach((el) => {
            const name = el.dataset.room;
            el.classList.toggle('is-on', selected.has(name) || name === coordinator);
          });
        };
        $$('[data-room]', sheet).forEach((el) => {
          const name = el.dataset.room;
          if (name === coordinator) return;
          el.addEventListener('click', () => {
            if (selected.has(name)) selected.delete(name); else selected.add(name);
            haptic();
            paint();
          });
        });
        $('[data-all]', sheet).addEventListener('click', () => {
          allRooms.forEach((r) => selected.add(r.name)); haptic(12); paint();
        });
        $('[data-none]', sheet).addEventListener('click', () => {
          selected.clear(); selected.add(coordinator); haptic(12); paint();
        });
        $('[data-done]', sheet).addEventListener('click', async () => {
          closeSheet();
          const members = [...selected];
          const result = await command(() => post('/api/sonos/group', {
            action: 'set', room: coordinator, members,
          }));
          if (result) {
            S.topology = result.topology || S.topology;
            toast(members.length > 1 ? `Grouped ${members.length} rooms` : `${coordinator} on its own`);
            await refresh();
          }
        });
      },
    });
  }

  /** Overflow: EQ, sleep timer, crossfade, party mode. */
  async function openMoreSheet(room, np) {
    if (!S.lineIn.length) await loadLibrary().catch(() => {});
    const caps = S.caps.get(room) || await api('/api/sonos/caps?room=' + encodeURIComponent(room)).catch(() => null);
    if (caps) S.caps.set(room, caps);
    const v = caps ? caps.values : {};

    const toneRow = (key, label, value, min, max) => `
      <div class="m-eq-row">
        <div class="m-eq-label"><span>${label}</span><span class="m-eq-value" data-val="${key}">${value > 0 ? '+' : ''}${value}</span></div>
        <div class="m-vol-track" data-tone="${key}" data-min="${min}" data-max="${max}">
          <div class="m-vol-rail"><div class="m-vol-fill" style="width:${((value - min) / (max - min)) * 100}%"></div></div>
          <div class="m-vol-thumb" style="left:${((value - min) / (max - min)) * 100}%"></div>
        </div>
      </div>`;

    const toggleRow = (key, label, on, hint) => `
      <div class="m-eq-row">
        <div class="m-eq-label">
          <span>${label}${hint ? `<div style="font-size:11px;color:var(--text-dimmer);margin-top:2px">${hint}</div>` : ''}</span>
          <button class="m-toggle ${on ? 'is-on' : ''}" data-toggle-eq="${key}"></button>
        </div>
      </div>`;

    openSheet(`
      <div class="m-sheet-head"><div class="m-sheet-title">${esc(room)}</div></div>
      <div class="m-sheet-sub">${esc(caps?.model || '')}${caps?.hasSub ? ' · Sub' : ''}${caps?.surrounds ? ` · ${caps.surrounds} surrounds` : ''}</div>

      <div class="m-section-head"><div class="m-section-title">Sound</div></div>
      ${caps?.bass ? toneRow('bass', 'Bass', v.bass ?? 0, -10, 10) : ''}
      ${caps?.treble ? toneRow('treble', 'Treble', v.treble ?? 0, -10, 10) : ''}
      ${caps?.loudness ? toggleRow('loudness', 'Loudness', !!v.loudness, 'Boosts bass and treble at low volume') : ''}
      ${caps?.nightMode ? toggleRow('nightMode', 'Night sound', !!v.nightMode, 'Softens loud effects') : ''}
      ${caps?.speechEnhance ? toggleRow('speechEnhance', 'Speech enhancement', !!v.speechEnhance) : ''}
      ${caps?.subGain ? toneRow('subGain', 'Sub gain', v.subGain ?? 0, -15, 15) : ''}
      ${caps?.surroundLevel ? toneRow('surroundLevel', 'Surround level', v.surroundLevel ?? 0, -15, 15) : ''}

      ${np && (np.hasTV || S.lineIn.length) ? `
        <div class="m-section-head"><div class="m-section-title">Sources</div></div>
        <div class="m-toolbar">
          ${np.hasTV ? `<button class="m-chip ${np.sourceKind === 'tv' ? 'is-active' : ''}" data-tv>📺 TV</button>` : ''}
          ${S.lineIn.filter((l) => l.name && l.name !== 'Audio Component')
            .map((l) => `<button class="m-chip" data-linein="${esc(l.room)}">${ICONS.linein} ${esc(l.name)}</button>`).join('')}
        </div>` : ''}

      <div class="m-section-head"><div class="m-section-title">Playback</div></div>
      ${toggleRow('crossfade', 'Crossfade', false, 'Blend the end of one track into the next')}

      <div class="m-section-head"><div class="m-section-title">Sleep timer</div></div>
      <div class="m-toolbar">
        ${[15, 30, 45, 60, 120].map((m) => `<button class="m-chip" data-sleep="${m}">${m}m</button>`).join('')}
        <button class="m-chip is-danger" data-sleep="0">Off</button>
      </div>

      <div class="m-section-head"><div class="m-section-title">Whole house</div></div>
      <div class="m-toolbar">
        <button class="m-chip" data-party>${ICONS.group} Play everywhere</button>
        <button class="m-chip is-danger" data-stop>${ICONS.pause} Stop this group</button>
      </div>
    `, {
      onMount(sheet) {
        $$('[data-tone]', sheet).forEach((track) => {
          const key = track.dataset.tone;
          const min = Number(track.dataset.min);
          const max = Number(track.dataset.max);
          const fill = $('.m-vol-fill', track);
          const thumb = $('.m-vol-thumb', track);
          const label = $(`[data-val="${key}"]`, sheet);
          const paint = (ratio) => {
            const value = Math.round(min + ratio * (max - min));
            fill.style.width = ratio * 100 + '%';
            thumb.style.left = ratio * 100 + '%';
            label.textContent = (value > 0 ? '+' : '') + value;
            return value;
          };
          attachSlider(track, {
            onInput: paint,
            onCommit: async (ratio) => {
              const value = paint(ratio);
              await command(() => post('/api/sonos/eq', { room, setting: key, value }));
              S.caps.delete(room);
            },
          });
        });

        $$('[data-toggle-eq]', sheet).forEach((btn) => {
          btn.addEventListener('click', async () => {
            const key = btn.dataset.toggleEq;
            const next = !btn.classList.contains('is-on');
            btn.classList.toggle('is-on', next);
            haptic();
            if (key === 'crossfade') {
              await command(() => post('/api/sonos/playmode', { room, crossfade: next }));
            } else {
              await command(() => post('/api/sonos/eq', { room, setting: key, value: next }));
              S.caps.delete(room);
            }
          });
        });

        $$('[data-sleep]', sheet).forEach((btn) => {
          btn.addEventListener('click', async () => {
            const minutes = Number(btn.dataset.sleep);
            haptic(12);
            closeSheet();
            const result = await command(() => post('/api/sonos/sleep', { room, minutes }));
            if (result) toast(minutes ? `Sleeping in ${minutes} min` : 'Sleep timer off');
          });
        });

        const tvBtn = $('[data-tv]', sheet);
        if (tvBtn) tvBtn.addEventListener('click', async () => {
          haptic(12);
          closeSheet();
          const result = await command(() => post('/api/sonos/play', { room, tv: true }));
          if (result) { toast(`${room} switched to TV`); setTimeout(() => paintNowPlaying(room), 900); }
        });

        $$('[data-linein]', sheet).forEach((btn) => {
          btn.addEventListener('click', async () => {
            haptic(12);
            closeSheet();
            const source = btn.dataset.linein;
            const result = await command(() => post('/api/sonos/play', { room, lineInRoom: source }));
            if (result) { toast(`Playing ${source} line-in`); setTimeout(() => paintNowPlaying(room), 900); }
          });
        });

        $('[data-party]', sheet).addEventListener('click', async () => {
          haptic(16);
          closeSheet();
          const result = await command(() => post('/api/sonos/group', { action: 'party', room }));
          if (result) { toast(`Playing in ${result.joined + 1} rooms`); await refresh(); }
        });

        $('[data-stop]', sheet).addEventListener('click', async () => {
          haptic(12);
          closeSheet();
          await command(() => post('/api/sonos/transport', { room, action: 'stop' }));
          await refresh();
        });
      },
    });
  }

  // ---------- Chrome ----------

  function topbar(title, sub, { back } = {}) {
    return `
      <div class="topbar">
        ${back ? `<button class="topbar-back" data-back="${back}"><span class="chev">‹</span></button>` : '<div></div>'}
        <div style="flex:1;min-width:0;text-align:${back ? 'left' : 'left'}">
          <div class="topbar-title" style="font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
          <span class="topbar-sub">${esc(sub)}</span>
        </div>
        <div class="conn-badge" id="conn-badge"><span class="dot"></span><span id="conn-label">Connecting</span></div>
      </div>`;
  }

  function wireTopbar(app) {
    const back = $('[data-back]', app);
    if (back) back.addEventListener('click', () => navigate(back.dataset.back));
    // Music screens render their own topbar, so the badge has to be re-synced to the
    // already-open socket — otherwise it reads "Connecting" forever.
    if (typeof window.setConn === 'function') {
      window.setConn(window.wsIsOpen && window.wsIsOpen() ? 'live' : 'connecting');
    }
  }

  function navigate(path) { location.hash = path; }

  // ---------- Mini player ----------

  function paintMini() {
    const existing = $('.m-mini');
    const hash = location.hash.slice(1);
    const onNowPlaying = hash.startsWith('/music/z/');
    const playing = groupCards().find((c) => isPlaying(c.state));

    if (!playing || onNowPlaying || !hash.startsWith('/music')) {
      if (existing) existing.remove();
      return;
    }

    const d = displayTrack(playing);
    const where = playing.groupSize > 1 ? playing.groupName : playing.room;
    const html = `
      ${artHtml(d.art, 'm-mini-art', d.title)}
      <div class="m-mini-body">
        <div class="m-mini-title">${esc(d.title || where)}</div>
        <div class="m-mini-sub">${esc([d.subtitle, d.title ? where : null].filter(Boolean).join(' · ') || where)}</div>
      </div>
      <button class="m-mini-btn" data-mini-toggle>${ICONS.pause}</button>
      <button class="m-mini-btn" data-mini-next>${ICONS.next}</button>
      <div class="m-mini-progress"><i style="width:0%"></i></div>`;

    let bar = existing;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'm-mini';
      document.body.appendChild(bar);
    }
    bar.innerHTML = html;
    bar.onclick = (e) => {
      if (e.target.closest('[data-mini-toggle]') || e.target.closest('[data-mini-next]')) return;
      navigate('/music/z/' + encodeURIComponent(playing.room));
    };
    $('[data-mini-toggle]', bar).onclick = async () => {
      haptic();
      await command(() => post('/api/sonos/transport', { room: playing.room, action: 'toggle' }));
      setTimeout(refresh, 500);
    };
    $('[data-mini-next]', bar).onclick = async () => {
      haptic();
      await command(() => post('/api/sonos/transport', { room: playing.room, action: 'next' }));
      setTimeout(refresh, 700);
    };
  }

  // ---------- Refresh / live updates ----------

  async function refresh() {
    try {
      await loadState();
      repaintCurrent();
    } catch (_) {}
  }

  function repaintCurrent() {
    const hash = location.hash.slice(1);
    if (hash === '/' || hash === '') {
      if (typeof window.paintHubMusicTile === 'function') window.paintHubMusicTile();
      return;
    }
    if (hash === '/music') paintZones();
    else if (hash.startsWith('/music/z/')) {
      const room = decodeURIComponent(hash.slice('/music/z/'.length));
      const np = roomState(room);
      if (np) syncTick(np);
    }
    paintMini();
  }

  /**
   * Polling cadence. When the server has GENA push we still poll slowly, because
   * playback position is not evented and a stale scrub bar is very visible.
   */
  function startPolling() {
    stopPolling();
    const interval = () => {
      const anyPlaying = S.rooms.some((r) => isPlaying(r.state));
      if (S.mode === 'push') return anyPlaying ? 5000 : 20000;
      return anyPlaying ? 3000 : 9000;
    };
    const tick = async () => {
      if (!location.hash.startsWith('#/music')) { stopPolling(); return; }
      if (document.hidden) { pollTimer = setTimeout(tick, 4000); return; }
      await refresh();
      const hash = location.hash.slice(1);
      if (hash.startsWith('/music/z/')) {
        const room = decodeURIComponent(hash.slice('/music/z/'.length));
        await paintNowPlaying(room);
      }
      pollTimer = setTimeout(tick, interval());
    };
    pollTimer = setTimeout(tick, interval());
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  /** Server-pushed Sonos events arriving over the shared WebSocket. */
  function onMessage(msg) {
    if (!msg.type || !msg.type.startsWith('sonos:')) return;

    if (msg.type === 'sonos:topology') {
      S.topology = msg.topology;
      repaintCurrent();
      return;
    }
    if (msg.type === 'sonos:content') {
      S.favorites = []; S.playlists = [];
      return;
    }
    if (msg.type === 'sonos:rooms') {
      for (const room of msg.rooms || []) {
        const idx = S.rooms.findIndex((r) => r.room === room.room);
        if (idx >= 0) S.rooms[idx] = room; else S.rooms.push(room);
      }
      repaintCurrent();
      return;
    }
    if (msg.type === 'sonos:rendering' && msg.room) {
      const r = roomState(msg.room);
      if (r) {
        if (msg.volume != null) r.volume = msg.volume;
        if (msg.muted != null) r.muted = msg.muted;
      }
      return;
    }
    if (msg.type === 'sonos:transport' && msg.room) {
      const r = roomState(msg.room);
      if (r && msg.state) r.state = msg.state;
      // A transport change usually means the track changed too; pull the detail.
      const hash = location.hash.slice(1);
      if (hash === '/music') { paintZones(); paintMini(); }
      else if (hash === '/music/z/' + encodeURIComponent(msg.room)) paintNowPlaying(msg.room);
    }
  }

  // ---------- Entry ----------

  function render(app, hash) {
    stopPolling();
    if (hash === '/music') { renderZones(app); }
    else if (hash.startsWith('/music/z/')) { renderNowPlaying(app, decodeURIComponent(hash.slice('/music/z/'.length))); }
    else if (hash.startsWith('/music/q/')) { renderQueue(app, decodeURIComponent(hash.slice('/music/q/'.length))); }
    else if (hash === '/music/browse') { renderBrowse(app); }
    else if (hash === '/music/search') { renderSearch(app); }
    else { renderZones(app); }
    setTimeout(paintMini, 60);
  }

  function teardown() {
    stopPolling();
    stopTick();
    const mini = $('.m-mini');
    if (mini) mini.remove();
    closeSheet();
    document.documentElement.style.removeProperty('--m-art-1');
    document.documentElement.style.removeProperty('--m-art-2');
  }

  return { render, onMessage, teardown, refresh, fallbackArt, loadState, state: S };
})();

window.Music = Music;
