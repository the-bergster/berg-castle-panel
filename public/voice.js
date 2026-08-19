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
  let wakeInitiated = false; // opened by the wake word (=> greet on connect)
  let idleTimer = null; // auto-hangup after inactivity
  const IDLE_MS = 8000; // ~8s of no speech -> hang up
  let hangUpAfterSpeech = false; // set by end_conversation; teardown when audio stops
  let spokeThisTurn = false; // did the model speak audio in the current response turn?

  function emit() {
    for (const fn of listeners) { try { fn(status, { error: lastError, speaking }); } catch {} }
  }
  function setStatus(s, err) { status = s; lastError = err || null; emit(); }

  function armIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // No activity for a while — close the session and go back to wake-listening.
      teardown();
    }, IDLE_MS);
  }

  async function connect(opts) {
    if (status === 'connecting' || status === 'live') return;
    wakeInitiated = !!(opts && opts.wake);
    setStatus('connecting');
    try {
      // This device's room (set in Settings → Wall Panel → This iPad's Room).
      // Stored per-device in localStorage so each panel knows where it is; sent
      // so bare commands ("turn off the lights") resolve to this room.
      let panelRoom = '';
      try { panelRoom = (localStorage.getItem('bc.panelRoom') || '').trim(); } catch (_) {}
      const sessUrl = '/api/voice/session' + (panelRoom ? ('?room=' + encodeURIComponent(panelRoom)) : '');
      const sess = await fetch(sessUrl).then(r => r.json());
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

      // Acoustic echo cancellation: stop the mic from hearing Jony's own voice
      // out of the speaker (the cause of self-interrupt cut-offs on a wall panel).
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

      dc = pc.createDataChannel('oai-events');
      dc.addEventListener('message', onServerEvent);
      dc.addEventListener('open', () => {
        setStatus('live');
        armIdleTimer();
        // If the wake word opened this, prompt a short spoken greeting so the
        // user hears an acknowledgement and can then speak their request.
        if (wakeInitiated) {
          send({
            type: 'response.create',
            response: { instructions: 'Greet the person in one very short, natural phrase like "Yeah?" or "What\'s up?" and then stop and listen. Do not list capabilities.' },
          });
        }
      });

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

    // Any server event = activity; push back the idle auto-hangup.
    armIdleTimer();

    // New response turn begins — reset per-turn speech tracking so we can tell if
    // the model spoke a goodbye in the same turn it calls end_conversation.
    if (msg.type === 'response.created') spokeThisTurn = false;

    // Speaking state — for the dock animation.
    if (msg.type === 'output_audio_buffer.started' || msg.type === 'response.output_audio.delta') {
      spokeThisTurn = true; // model produced audio in this turn
      if (!speaking) { speaking = true; emit(); }
    } else if (msg.type === 'output_audio_buffer.stopped' || msg.type === 'response.done') {
      const wasSpeaking = speaking;
      if (speaking) { speaking = false; emit(); }
      // Sign-off pending: only hang up once the goodbye has ACTUALLY been spoken
      // (audio started then stopped). Requiring wasSpeaking avoids tearing down
      // on a silent/zero-audio stop, which was ending the call with no words.
      if (hangUpAfterSpeech && msg.type === 'output_audio_buffer.stopped' && wasSpeaking) {
        hangUpAfterSpeech = false;
        setTimeout(() => teardown(), 350);
      }
    }

    // Tool call.
    if (msg.type === 'response.function_call_arguments.done') {
      // Natural hang-up: the agent decided the conversation is over. Let its
      // sign-off audio ACTUALLY finish (output_audio_buffer.stopped), then tear
      // down. A fixed timer clipped longer goodbyes ("no problem, happy to...").
      // Safety fallback: if audio-stopped never arrives, hang up after 6s.
      if (msg.name === 'end_conversation') {
        // Acknowledge the tool.
        send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: msg.call_id, output: '{"ok":true}' },
        });
        hangUpAfterSpeech = true;
        // KEY: the model usually ALREADY speaks a goodbye in the same turn it
        // calls end_conversation ("Anytime, happy to help"). Forcing a second
        // sign-off response then double-taps it ("...help" then "...help bye").
        // So only force a spoken sign-off when it ended SILENTLY (no audio this
        // turn). If it already spoke, just let that goodbye finish and tear down.
        if (spokeThisTurn) {
          // Already said goodbye. If audio has finished stopping, tear down now;
          // otherwise the output_audio_buffer.stopped handler above will.
          if (!speaking) { hangUpAfterSpeech = false; setTimeout(() => teardown(), 300); }
        } else {
          // Silent tool call — explicitly ask for one short spoken sign-off.
          send({
            type: 'response.create',
            response: {
              instructions: 'Say a brief, warm, HUMAN sign-off the way a person ends a call — e.g. "No problem, catch you later!", "Anytime — bye!", "Sure thing, see you!". End with a natural closer like "bye", "catch you later", or "see you". Do NOT narrate the mechanics of ending (never say things like "let me close things out", "ending the call", or "hanging up now"). One short sentence, then stop. Do not ask another question.',
            },
          });
        }
        // Safety fallback: if we never tear down cleanly, hang up after 8s.
        setTimeout(() => { if (hangUpAfterSpeech) { hangUpAfterSpeech = false; teardown(); } }, 8000);
        return;
      }
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
    clearTimeout(idleTimer); idleTimer = null;
    wakeInitiated = false;
    hangUpAfterSpeech = false;
    try { if (dc) dc.close(); } catch {}
    try { if (pc) pc.close(); } catch {}
    try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch {}
    dc = null; pc = null; micStream = null; speaking = false;
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
  `;
  document.body.appendChild(dock);

  const btn = dock.querySelector('#vd-btn');
  const label = dock.querySelector('#vd-label');

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
  });
}
window.mountVoiceDock = mountVoiceDock;
