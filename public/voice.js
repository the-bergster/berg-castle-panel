// Voice agent client — OpenAI Realtime over WebRTC.
//
// The dock is a PERSISTENT element mounted once at boot and pinned to the bottom
// of every screen. Tapping the mic connects a speech-to-speech session that can
// call tools (lights / fireplaces / scenes) from anywhere in the app. The audio
// + session survive route changes because the dock lives outside the router's
// #app container.
//
// The real OpenAI key never touches this file — only a short-lived ek_ token.

const Voice = (() => {
  let pc = null;
  let dc = null;
  let micStream = null;
  let audioEl = null;
  let status = 'idle'; // idle | connecting | live | error
  let listeners = new Set();
  let lastError = null;
  let speaking = false; // model is talking
  let lastCaption = '';

  function emit() {
    for (const fn of listeners) { try { fn(status, { error: lastError, speaking, caption: lastCaption }); } catch {} }
  }
  function setStatus(s, err) { status = s; lastError = err || null; emit(); }

  async function connect() {
    if (status === 'connecting' || status === 'live') return;
    setStatus('connecting');
    try {
      const sess = await fetch('/api/voice/session').then(r => r.json());
      if (!sess.value) throw new Error(sess.error || 'no session key');

      pc = new RTCPeerConnection();
      audioEl = document.getElementById('voice-audio') || (() => {
        const a = document.createElement('audio');
        a.id = 'voice-audio';
        a.autoplay = true;
        document.body.appendChild(a);
        return a;
      })();
      pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

      dc = pc.createDataChannel('oai-events');
      dc.addEventListener('message', onServerEvent);
      dc.addEventListener('open', () => setStatus('live'));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: { 'Authorization': `Bearer ${sess.value}`, 'Content-Type': 'application/sdp' },
      });
      if (!sdpResp.ok) throw new Error('handshake ' + sdpResp.status);
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpResp.text() });
    } catch (e) {
      console.error('[voice] connect error', e);
      setStatus('error', e.message);
      teardown();
    }
  }

  async function onServerEvent(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    // Speaking state — for the dock animation.
    if (msg.type === 'output_audio_buffer.started' || msg.type === 'response.output_audio.delta') {
      if (!speaking) { speaking = true; emit(); }
    } else if (msg.type === 'output_audio_buffer.stopped' || msg.type === 'response.done') {
      if (speaking) { speaking = false; emit(); }
    }

    // Live caption from model transcript.
    if (msg.type === 'response.output_audio_transcript.delta' && msg.delta) {
      lastCaption = (lastCaption + msg.delta).slice(-140);
      emit();
    } else if (msg.type === 'response.created') {
      lastCaption = '';
      emit();
    }

    // Tool call.
    if (msg.type === 'response.function_call_arguments.done') {
      let args = {};
      try { args = JSON.parse(msg.arguments || '{}'); } catch {}
      let result;
      try {
        result = await fetch('/api/voice/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: msg.name, args }),
        }).then(r => r.json());
      } catch (e) { result = { ok: false, error: e.message }; }
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify(result) },
      });
      send({ type: 'response.create' });
    }
  }

  function send(obj) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj)); }

  function teardown() {
    try { if (dc) dc.close(); } catch {}
    try { if (pc) pc.close(); } catch {}
    try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch {}
    dc = null; pc = null; micStream = null; speaking = false; lastCaption = '';
    if (status !== 'error') setStatus('idle');
  }

  function toggle() { isActive() ? teardown() : connect(); }
  function isActive() { return status === 'live' || status === 'connecting'; }

  return {
    connect, teardown, toggle, isActive,
    getStatus: () => status,
    getError: () => lastError,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
window.Voice = Voice;

// ---- Persistent dock (mounted once, pinned bottom) ----
function mountVoiceDock() {
  if (document.getElementById('voice-dock')) return;
  const dock = document.createElement('div');
  dock.id = 'voice-dock';
  dock.innerHTML = `
    <button class="vd-btn" id="vd-btn" aria-label="Talk to the house">
      <span class="vd-orb">
        <span class="vd-wave"><i></i><i></i><i></i><i></i><i></i></span>
        <svg class="vd-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <path d="M12 19v3M8 22h8"/>
        </svg>
      </span>
      <span class="vd-label" id="vd-label">Talk to the house</span>
      <span class="vd-x" id="vd-x" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </span>
    </button>
    <div class="vd-caption" id="vd-caption"></div>
  `;
  document.body.appendChild(dock);

  const btn = dock.querySelector('#vd-btn');
  const label = dock.querySelector('#vd-label');
  const caption = dock.querySelector('#vd-caption');

  btn.addEventListener('click', () => Voice.toggle());

  Voice.onChange((s, meta) => {
    dock.className = ''; // reset
    dock.classList.add('vd-' + s);
    if (meta.speaking) dock.classList.add('vd-speaking');
    label.textContent =
      s === 'live' ? (meta.speaking ? 'Speaking…' : 'Listening…')
      : s === 'connecting' ? 'Connecting…'
      : s === 'error' ? 'Tap to retry'
      : 'Talk to the house';
    caption.textContent = (s === 'live' && meta.caption) ? meta.caption : '';
    caption.classList.toggle('show', !!(s === 'live' && meta.caption));
  });
}
window.mountVoiceDock = mountVoiceDock;
