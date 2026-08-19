// voice-stream.js — Freeflow (continuous, barge-in) voice for the Watch.
//
// Unlike watch-relay.js (one-shot press-to-talk), this keeps a persistent
// bridge open for the whole conversation:
//
//   Watch  ⟷  Mac (this)  ⟷  OpenAI Realtime WebSocket
//
// The Watch holds one WebSocket to the Mac (path /ws/voice) and streams mic
// PCM16 up continuously. The Mac forwards audio to OpenAI with server-side VAD
// (semantic turn detection) ON, so OpenAI decides when the user stopped talking,
// responds, and the reply audio streams straight back down to the Watch — which
// can talk over it (barge-in) because the mic never stops.
//
// Tool calls (Lutron / Sonos / climate) run through the same runVoiceTool the
// browser + press-to-talk paths use.
//
// Wire protocol Watch <-> Mac (all JSON text frames except raw audio):
//   Watch -> Mac:
//     { "type":"start" }                              once, after socket open
//     { "type":"audio", "pcm16": "<base64>" }         streamed mic chunks (24k mono)
//     { "type":"stop" }                               optional, ends turn early
//   Mac -> Watch:
//     { "type":"ready" }                              session live, start talking
//     { "type":"user_transcript", "text": "..." }     what OpenAI heard
//     { "type":"reply_delta", "text": "..." }         assistant text (streaming)
//     { "type":"audio", "pcm16": "<base64>" }          assistant audio (streaming, 24k)
//     { "type":"speech_started" }                     VAD: user began speaking (barge-in cue)
//     { "type":"turn_done" }                          assistant finished a turn
//     { "type":"tool", "name":"...", "ok":true }      a device tool ran
//     { "type":"error", "message":"..." }

const WebSocket = require('ws');
const voice = require('./voice');

const REALTIME_MODEL = 'gpt-realtime-2.1';
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

// Attach a freeflow voice session to one incoming Watch<->Mac socket.
// deps: { buildSessionConfig, runToolFn, log }
function attachSession(watchWs, deps) {
  const { sessionConfig, runToolFn, log = () => {} } = deps;
  const apiKey = voice.loadApiKey();
  if (!apiKey) {
    safeSend(watchWs, { type: 'error', message: 'OpenAI key not configured' });
    try { watchWs.close(); } catch (_) {}
    return;
  }

  let oa = null;                       // OpenAI socket
  let oaReady = false;
  const preOpenAudio = [];             // mic chunks that arrive before OA is ready
  const pendingToolCalls = new Map();  // call_id -> { name, args }
  let closed = false;

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    log('[voice-stream] shutdown:', reason || '');
    try { oa && oa.close(); } catch (_) {}
    try { watchWs.close(); } catch (_) {}
  };

  // ---- Connect to OpenAI Realtime ----
  oa = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${apiKey}` } });

  oa.on('open', () => {
    log('[voice-stream] OpenAI socket open, configuring freeflow session');
    // Freeflow: server-side semantic VAD decides turn boundaries and auto-creates
    // responses. This is what makes it continuous + barge-in instead of push-to-talk.
    oaSend({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: sessionConfig.instructions,
        tools: sessionConfig.tools,
        tool_choice: sessionConfig.tool_choice || 'auto',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: {
              type: 'semantic_vad',
              create_response: true,       // auto-respond when the user stops
              interrupt_response: true,    // barge-in: new speech cancels current reply
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: (sessionConfig.audio?.output?.voice) || 'cedar',
          },
        },
      },
    });
  });

  oa.on('message', async (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    switch (evt.type) {
      case 'session.updated':
        if (!oaReady) {
          oaReady = true;
          // Flush any mic audio buffered while connecting.
          for (const b64 of preOpenAudio) oaSend({ type: 'input_audio_buffer.append', audio: b64 });
          preOpenAudio.length = 0;
          safeSend(watchWs, { type: 'ready' });
          log('[voice-stream] session ready — freeflow live; sent {ready} to watch');
        }
        break;

      case 'input_audio_buffer.speech_started':
        // VAD heard the user start — tell the Watch so it can duck/stop playback (barge-in).
        safeSend(watchWs, { type: 'speech_started' });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) safeSend(watchWs, { type: 'user_transcript', text: evt.transcript });
        break;

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (evt.delta) safeSend(watchWs, { type: 'audio', pcm16: evt.delta });
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (evt.delta) safeSend(watchWs, { type: 'reply_delta', text: evt.delta });
        break;

      case 'response.output_item.added':
        if (evt.item && evt.item.type === 'function_call') {
          pendingToolCalls.set(evt.item.call_id, { name: evt.item.name, args: '' });
        }
        break;

      case 'response.function_call_arguments.delta':
        if (pendingToolCalls.has(evt.call_id)) pendingToolCalls.get(evt.call_id).args += evt.delta || '';
        break;

      case 'response.function_call_arguments.done': {
        const call = pendingToolCalls.get(evt.call_id) || { name: evt.name, args: evt.arguments };
        let result;
        try {
          const args = JSON.parse(call.args || evt.arguments || '{}');
          log('[voice-stream] tool:', call.name, args);
          result = await runToolFn(call.name, args);
          safeSend(watchWs, { type: 'tool', name: call.name, ok: !(result && result.ok === false) });
        } catch (e) {
          result = { ok: false, error: e.message };
          safeSend(watchWs, { type: 'tool', name: call.name, ok: false });
        }
        oaSend({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify(result) },
        });
        oaSend({ type: 'response.create' }); // let it speak the confirmation
        pendingToolCalls.delete(evt.call_id);
        break;
      }

      case 'response.done':
        safeSend(watchWs, { type: 'turn_done' });
        break;

      case 'error':
        log('[voice-stream] OpenAI error:', JSON.stringify(evt.error || evt));
        safeSend(watchWs, { type: 'error', message: (evt.error && evt.error.message) || 'realtime error' });
        break;
    }
  });

  oa.on('error', (e) => { safeSend(watchWs, { type: 'error', message: e.message }); shutdown('oa error'); });
  oa.on('close', () => shutdown('oa closed'));

  // ---- Watch -> Mac ----
  let audioChunks = 0;
  watchWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'start':
        log('[voice-stream] <- watch: start');
        break;
      case 'audio':
        if (!msg.pcm16) break;
        audioChunks++;
        if (audioChunks === 1 || audioChunks % 25 === 0) log(`[voice-stream] <- watch: audio chunk #${audioChunks} (${msg.pcm16.length}b64)`);
        if (oaReady) oaSend({ type: 'input_audio_buffer.append', audio: msg.pcm16 });
        else preOpenAudio.push(msg.pcm16); // buffer until OA ready
        break;
      case 'stop':
        // Optional manual end-of-turn (VAD normally handles this).
        if (oaReady) { oaSend({ type: 'input_audio_buffer.commit' }); oaSend({ type: 'response.create' }); }
        break;
      case 'bye':
        shutdown('watch bye');
        break;
    }
  });

  watchWs.on('close', () => shutdown('watch closed'));
  watchWs.on('error', () => shutdown('watch error'));

  function oaSend(o) { try { oa.readyState === WebSocket.OPEN && oa.send(JSON.stringify(o)); } catch (_) {} }
}

function safeSend(ws, obj) {
  try { ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj)); } catch (_) {}
}

module.exports = { attachSession, REALTIME_MODEL };
