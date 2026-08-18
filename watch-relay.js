// watch-relay.js — Press-to-talk voice relay for the Berg Castle Watch app.
//
// The Watch can't do WebRTC (no native lib) or the Cloudflare Access OTP login.
// So instead of the browser's speech-to-speech WebRTC path, the Watch uses a
// simple, robust round-trip:
//
//   Watch records a clip  ──▶  POST /api/watch/voice (WAV, 16k mono)
//                                  │
//                                  ▼
//                    this relay opens a short OpenAI Realtime
//                    WebSocket session, sends the audio, lets the
//                    SAME "Jony" agent (same instructions + tools)
//                    transcribe → decide → call tools → speak
//                                  │
//                    tool calls run through runVoiceTool (Lutron/
//                    Sonos/climate) exactly like the browser path
//                                  │
//                                  ▼
//   Watch plays reply  ◀──  { transcript, reply_text, audio(base64 WAV) }
//
// Auth: a static bearer token (Watch service token) scoped to just this route,
// injected by cloudflared as a header OR checked here. The Watch never touches
// the OpenAI key — it stays on the Mac.

const https = require('https');
const crypto = require('crypto');
const WebSocketish = require('./watch-ws'); // tiny WS client (no deps)

const REALTIME_MODEL = 'gpt-realtime-2.1';
const REALTIME_HOST = 'api.openai.com';
const REALTIME_PATH = `/v1/realtime?model=${REALTIME_MODEL}`;

// One press-to-talk turn. Given the caller-supplied session config (same one the
// browser uses, built from live house data) + the recorded PCM16 audio, returns
// { transcript, replyText, audioB64 }.
//
// runToolFn(name, args) -> result  is the server's runVoiceTool, passed in so we
// don't duplicate the device-control logic.
async function runTurn({ apiKey, sessionConfig, audioPcm16Base64, runToolFn, log = () => {} }) {
  return new Promise((resolve, reject) => {
    // GA Realtime API (the Beta header path was retired 2026).
    const ws = new WebSocketish(`wss://${REALTIME_HOST}${REALTIME_PATH}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    let replyText = '';
    let userTranscript = '';
    const audioChunks = [];
    let settled = false;
    const pendingToolCalls = new Map(); // call_id -> {name, argsBuffer}

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) {}
      err ? reject(err) : resolve(val);
    };

    const failTimer = setTimeout(() => done(new Error('relay timeout')), 30000);

    ws.on('open', () => {
      log('[watch-relay] ws open, configuring session');
      // Configure the session in GA shape. sessionConfig carries our Jony
      // instructions + tools; we layer the audio I/O + press-to-talk settings.
      ws.sendJson({
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
              // NOTE: input transcription (whisper-1) intentionally omitted — it
              // hit a separate quota wall on this org, and the Realtime model
              // understands the speech natively without a separate transcript.
              // Watch sends a complete clip; no server VAD, we commit manually.
              turn_detection: null,
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: (sessionConfig.audio && sessionConfig.audio.output && sessionConfig.audio.output.voice) || 'cedar',
            },
          },
        },
      });

      // Push the recorded audio as one buffer, commit, ask for a response.
      ws.sendJson({ type: 'input_audio_buffer.append', audio: audioPcm16Base64 });
      ws.sendJson({ type: 'input_audio_buffer.commit' });
      ws.sendJson({ type: 'response.create' });
    });

    ws.on('json', async (evt) => {
      switch (evt.type) {
        case 'conversation.item.input_audio_transcription.completed':
          userTranscript = evt.transcript || '';
          log('[watch-relay] heard:', userTranscript);
          break;

        // GA event names use the output_audio.* prefix.
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          if (evt.delta) audioChunks.push(Buffer.from(evt.delta, 'base64'));
          break;

        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta':
          replyText += evt.delta || '';
          break;

        case 'response.output_item.added':
          if (evt.item && evt.item.type === 'function_call') {
            pendingToolCalls.set(evt.item.call_id, { name: evt.item.name, args: '' });
          }
          break;

        case 'response.function_call_arguments.delta':
          if (pendingToolCalls.has(evt.call_id)) {
            pendingToolCalls.get(evt.call_id).args += evt.delta || '';
          }
          break;

        case 'response.function_call_arguments.done': {
          // Execute the tool via the server's runVoiceTool, feed result back,
          // then ask the model to continue (speak its confirmation).
          const call = pendingToolCalls.get(evt.call_id) || { name: evt.name, args: evt.arguments };
          let result;
          try {
            const args = JSON.parse(call.args || evt.arguments || '{}');
            log('[watch-relay] tool:', call.name, args);
            result = await runToolFn(call.name, args);
          } catch (e) {
            result = { ok: false, error: e.message };
          }
          ws.sendJson({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: evt.call_id,
              output: JSON.stringify(result),
            },
          });
          ws.sendJson({ type: 'response.create' });
          break;
        }

        case 'response.done': {
          // If there were no tool calls (or the follow-up response finished),
          // and we have audio, we're done. Guard against the intermediate
          // response.done that precedes a tool follow-up.
          const stillPending = [...pendingToolCalls.values()].some(c => !c.done);
          const status = evt.response && evt.response.status;
          const hasFunctionCall = evt.response && (evt.response.output || []).some(o => o.type === 'function_call');
          if (hasFunctionCall) {
            // mark handled; wait for the follow-up response after tool output
            for (const c of pendingToolCalls.values()) c.done = true;
            break;
          }
          clearTimeout(failTimer);
          const audio = Buffer.concat(audioChunks);
          done(null, {
            transcript: userTranscript,
            replyText: replyText.trim(),
            audioPcm16: audio, // raw PCM16 24k mono from OpenAI
          });
          break;
        }

        case 'error':
          log('[watch-relay] openai error:', JSON.stringify(evt.error || evt));
          done(new Error((evt.error && evt.error.message) || 'realtime error'));
          break;
      }
    });

    ws.on('error', (e) => done(e));
    ws.on('close', () => { if (!settled) done(new Error('ws closed early')); });
  });
}

module.exports = { runTurn, REALTIME_MODEL };
