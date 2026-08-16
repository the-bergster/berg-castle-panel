// Voice agent client — OpenAI Realtime over WebRTC.
//
// Flow:
//   1. GET /api/voice/session  -> ephemeral key (ek_...) + model.
//   2. Open RTCPeerConnection, add mic track, create a data channel for events.
//   3. SDP offer -> POST to OpenAI realtime endpoint with the ephemeral key.
//   4. Remote audio plays through a hidden <audio> element.
//   5. When the model emits a function_call, run it via /api/voice/tool and send
//      the result back over the data channel.
//
// The real OpenAI key never touches this file — only the short-lived ek_.

const Voice = (() => {
  let pc = null;
  let dc = null;
  let micStream = null;
  let audioEl = null;
  let status = 'idle'; // idle | connecting | live | error
  let onStatus = () => {};
  let lastError = null;

  function setStatus(s, err) {
    status = s;
    lastError = err || null;
    onStatus(s, err);
  }

  async function connect() {
    if (status === 'connecting' || status === 'live') return;
    setStatus('connecting');
    try {
      // 1. Ephemeral key.
      const sess = await fetch('/api/voice/session').then(r => r.json());
      if (!sess.value) throw new Error(sess.error || 'no session key');

      // 2. Peer connection + remote audio.
      pc = new RTCPeerConnection();
      audioEl = document.getElementById('voice-audio') || (() => {
        const a = document.createElement('audio');
        a.id = 'voice-audio';
        a.autoplay = true;
        document.body.appendChild(a);
        return a;
      })();
      pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

      // 3. Mic.
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

      // 4. Data channel for events (tool calls, transcripts).
      dc = pc.createDataChannel('oai-events');
      dc.addEventListener('message', onServerEvent);
      dc.addEventListener('open', () => setStatus('live'));

      // 5. SDP offer/answer with OpenAI.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // GA endpoint: model binds via the ephemeral key, not a query param.
      const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: {
          'Authorization': `Bearer ${sess.value}`,
          'Content-Type': 'application/sdp',
        },
      });
      if (!sdpResp.ok) throw new Error('realtime handshake failed: ' + sdpResp.status);
      const answer = { type: 'answer', sdp: await sdpResp.text() };
      await pc.setRemoteDescription(answer);
    } catch (e) {
      console.error('[voice] connect error', e);
      setStatus('error', e.message);
      teardown();
    }
  }

  async function onServerEvent(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    // Function call requested by the model.
    if (msg.type === 'response.function_call_arguments.done') {
      const name = msg.name;
      let args = {};
      try { args = JSON.parse(msg.arguments || '{}'); } catch {}
      let result;
      try {
        result = await fetch('/api/voice/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, args }),
        }).then(r => r.json());
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      // Return the tool output to the model, then ask it to respond.
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: msg.call_id,
          output: JSON.stringify(result),
        },
      });
      send({ type: 'response.create' });
    }
  }

  function send(obj) {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  function teardown() {
    try { if (dc) dc.close(); } catch {}
    try { if (pc) pc.close(); } catch {}
    try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch {}
    dc = null; pc = null; micStream = null;
    if (status !== 'error') setStatus('idle');
  }

  function isActive() { return status === 'live' || status === 'connecting'; }

  return {
    connect,
    teardown,
    isActive,
    getStatus: () => status,
    getError: () => lastError,
    setOnStatus: (fn) => { onStatus = fn; },
  };
})();

window.Voice = Voice;

// ---- Voice page render (called by app.js router) ----
function renderVoice() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="topbar">
      <button class="topbar-back" data-back-hub><span class="chev">‹</span></button>
      <div>
        <div class="topbar-title">Voice</div>
        <span class="topbar-sub">Talk to the house</span>
      </div>
      <div class="conn-badge" id="conn-badge"><span class="dot"></span><span id="conn-label">Connecting</span></div>
    </div>

    <div class="voice-shell fade-in">
      <button class="voice-orb" id="voice-orb" aria-label="Talk">
        <span class="voice-orb-ring"></span>
        <span class="voice-orb-core">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <path d="M12 19v3M8 22h8"/>
          </svg>
        </span>
      </button>
      <div class="voice-status" id="voice-status">Tap to start talking</div>
      <div class="voice-hint">Try: "Dim the lounge to 30", "Turn on the dining fireplace", "What's on right now?", "All off"</div>
    </div>
  `;

  const backBtn = app.querySelector('[data-back-hub]');
  if (backBtn) backBtn.addEventListener('click', () => { Voice.teardown(); navigate('/'); });

  const orb = document.getElementById('voice-orb');
  const statusEl = document.getElementById('voice-status');

  const paint = (s, err) => {
    orb.classList.toggle('connecting', s === 'connecting');
    orb.classList.toggle('live', s === 'live');
    orb.classList.toggle('error', s === 'error');
    statusEl.textContent =
      s === 'live' ? 'Listening… tap to stop'
      : s === 'connecting' ? 'Connecting…'
      : s === 'error' ? ('Error: ' + (err || 'try again'))
      : 'Tap to start talking';
    setConn(s === 'live' ? 'live' : s === 'connecting' ? 'connecting' : 'offline');
  };

  Voice.setOnStatus(paint);
  paint(Voice.getStatus(), Voice.getError());

  orb.addEventListener('click', () => {
    if (Voice.isActive()) Voice.teardown();
    else Voice.connect();
  });

  connectWS();
}
window.renderVoice = renderVoice;
