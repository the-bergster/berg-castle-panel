// Cameras — viewer + publisher, both in one module.
//
// VIEWER (any device): reads /api/cameras/list, renders a tile per room, plays
// each via HLS (native on Safari/iOS; hls.js elsewhere). Playing a tile signals
// the hub a viewer is watching, so the source iPad turns its camera ON; leaving
// signals stop, camera OFF. On-demand, exactly.
//
// PUBLISHER (the wall iPad): when this device is registered as a camera and the
// hub says someone's watching, it captures the front camera and publishes via
// WHIP. Stops the instant nobody's watching.
//
// Landscape-native: capture 16:9, tiles + fullscreen 16:9.

(function () {
  const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';

  // ---------- shared ----------
  function slugify(room) {
    return String(room || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  }
  async function api(path, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const r = await fetch(path, opts);
    return r.json().catch(() => ({}));
  }

  // ================= VIEWER =================

  const activeViewers = new Map(); // slug -> { video, hls, tile }

  function hlsUrl(slug) { return `/hls/cam-${slug}/index.m3u8`; }

  let hlsJsLoading = null;
  function ensureHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsJsLoading) return hlsJsLoading;
    hlsJsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_JS; s.onload = () => resolve(window.Hls); s.onerror = reject;
      document.head.appendChild(s);
    });
    return hlsJsLoading;
  }

  async function startFeed(slug, video) {
    // Tell the hub someone's watching -> source iPad starts publishing.
    api('/api/cameras/view', { slug, action: 'start' });
    const url = hlsUrl(slug);

    // Native HLS (Safari, iOS) — just set src.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.play().catch(() => {});
      activeViewers.set(slug, { video, hls: null });
      return;
    }
    // Everywhere else: hls.js.
    try {
      const Hls = await ensureHlsJs();
      if (Hls && Hls.isSupported()) {
        // Non-low-latency to match the fmp4 (non-LL) hub variant; LL mode expects
        // parts and stalls without them. backBuffer small since it's live.
        const hls = new Hls({ lowLatencyMode: false, backBufferLength: 6, liveSyncDurationCount: 3 });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        activeViewers.set(slug, { video, hls });
        return;
      }
    } catch (_) {}
    // Fallback: try native anyway.
    video.src = url; video.play().catch(() => {});
    activeViewers.set(slug, { video, hls: null });
  }

  function stopFeed(slug) {
    const v = activeViewers.get(slug);
    if (v) {
      try { if (v.hls) v.hls.destroy(); } catch (_) {}
      try { v.video.pause(); v.video.removeAttribute('src'); v.video.load(); } catch (_) {}
      activeViewers.delete(slug);
    }
    api('/api/cameras/view', { slug, action: 'stop' });
  }

  function stopAllFeeds() {
    for (const slug of [...activeViewers.keys()]) stopFeed(slug);
  }

  async function fetchList() {
    const j = await api('/api/cameras/list');
    return (j && j.cameras) || [];
  }

  // ================= PUBLISHER (wall iPad) =================

  const pub = {
    deviceId: null,
    room: null,
    slug: null,
    pc: null,
    stream: null,
    publishing: false,
    poll: null,
    resourceUrl: null,
  };

  function deviceId() {
    let id = '';
    try { id = localStorage.getItem('bc.deviceId') || ''; } catch (_) {}
    if (!id) {
      id = 'ipad-' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('bc.deviceId', id); } catch (_) {}
    }
    return id;
  }

  // Called by the native shell (or auto in wall mode) to make THIS device an
  // available camera for its room. Idempotent.
  async function enablePublisher(room) {
    pub.room = room || (localStorage.getItem('bc.panelRoom') || '').trim();
    if (!pub.room) return { ok: false, error: 'no room set for this device' };
    pub.deviceId = deviceId();
    pub.slug = slugify(pub.room);
    await api('/api/cameras/register', { deviceId: pub.deviceId, room: pub.room });
    if (!pub.poll) pub.poll = setInterval(tick, 3000);
    tick();
    return { ok: true, slug: pub.slug };
  }

  async function disablePublisher() {
    if (pub.poll) { clearInterval(pub.poll); pub.poll = null; }
    await stopPublishing();
    if (pub.deviceId) api('/api/cameras/unregister', { deviceId: pub.deviceId });
  }

  // Heartbeat + on-demand: ask the hub if we should be publishing right now.
  // Also RE-REGISTER each tick so a hub/panel restart (which clears the in-memory
  // registry) is self-healing — the iPad reappears in the Cameras list within a
  // few seconds without needing an app refresh.
  async function tick() {
    if (!pub.deviceId) return;
    let sp = { publish: false };
    try {
      sp = await api('/api/cameras/should-publish?deviceId=' + encodeURIComponent(pub.deviceId));
    } catch (_) {}
    // If the hub doesn't know us (restart wiped the registry), re-register.
    if (sp && sp.slug == null && pub.room) {
      try { await api('/api/cameras/register', { deviceId: pub.deviceId, room: pub.room }); } catch (_) {}
    }
    if (sp.publish && !pub.publishing) startPublishing();
    else if (!sp.publish && pub.publishing) stopPublishing();
  }

  async function startPublishing() {
    if (pub.publishing) return;
    pub.publishing = true;
    emitPubState();
    try {
      pub.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      pub.pc = new RTCPeerConnection();
      for (const track of pub.stream.getTracks()) pub.pc.addTrack(track, pub.stream);
      const offer = await pub.pc.createOffer();
      await pub.pc.setLocalDescription(offer);
      // Wait for ICE gathering (or 1.5s max) so the SDP has candidates.
      await iceComplete(pub.pc, 1500);
      const res = await fetch('/whip/cam-' + pub.slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pub.pc.localDescription.sdp,
      });
      if (!res.ok) throw new Error('WHIP ' + res.status);
      pub.resourceUrl = res.headers.get('Location') || null;
      const answer = await res.text();
      await pub.pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (e) {
      console.error('[camera publish]', e.message);
      pub.publishing = false;
      cleanupPub();
      emitPubState();
    }
  }

  async function stopPublishing() {
    if (!pub.publishing && !pub.pc) return;
    pub.publishing = false;
    // Tell the hub to tear down the WHIP session if we have its resource URL.
    if (pub.resourceUrl) {
      try {
        // Resource URL may be absolute to MediaMTX; route DELETE via our proxy.
        const rel = pub.resourceUrl.startsWith('http') ? new URL(pub.resourceUrl).pathname : pub.resourceUrl;
        fetch(rel, { method: 'DELETE' }).catch(() => {});
      } catch (_) {}
    }
    cleanupPub();
    emitPubState();
  }

  function cleanupPub() {
    try { if (pub.pc) pub.pc.close(); } catch (_) {}
    try { if (pub.stream) pub.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    pub.pc = null; pub.stream = null; pub.resourceUrl = null;
  }

  function iceComplete(pc, timeoutMs) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(done, timeoutMs);
    });
  }

  // Publisher state -> lets the app show a "camera live" indicator on the iPad.
  const pubListeners = new Set();
  function emitPubState() { for (const fn of pubListeners) { try { fn(pub.publishing); } catch (_) {} } }

  window.Cameras = {
    slugify, fetchList, startFeed, stopFeed, stopAllFeeds, hlsUrl,
    // publisher
    enablePublisher, disablePublisher, isPublishing: () => pub.publishing,
    onPublishState: (fn) => { pubListeners.add(fn); return () => pubListeners.delete(fn); },
  };
})();
