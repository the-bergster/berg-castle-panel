// watch-ws.js — Minimal dependency-free WebSocket client (RFC 6455) with custom
// headers, just enough for the OpenAI Realtime relay. Text frames only, no
// permessage-deflate. Node's built-in WebSocket can't set arbitrary request
// headers cleanly, and we don't want to pull in the `ws` package.

const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WatchWS extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(opts.headers || {}),
      },
    });

    req.on('upgrade', (res, socket) => {
      this.socket = socket;
      this._buf = Buffer.alloc(0);
      socket.on('data', (d) => this._onData(d));
      socket.on('close', () => this.emit('close'));
      socket.on('error', (e) => this.emit('error', e));
      this.emit('open');
    });
    req.on('error', (e) => this.emit('error', e));
    req.end();
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    // Parse as many frames as are complete in the buffer.
    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        len = Number(this._buf.readBigUInt64BE(2)); offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this._buf.length < offset + maskLen + len) return; // wait for more
      let payload = this._buf.slice(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this._buf.slice(offset, offset + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      this._buf = this._buf.slice(offset + maskLen + len);

      if (opcode === 0x8) { // close
        try { this.socket.end(); } catch (_) {}
        this.emit('close');
        return;
      } else if (opcode === 0x9) { // ping -> pong
        this._sendFrame(0xA, payload);
      } else if (opcode === 0x1 || opcode === 0x0) { // text / continuation
        const text = payload.toString('utf8');
        this.emit('message', text);
        try { this.emit('json', JSON.parse(text)); } catch (_) {}
      }
    }
  }

  _sendFrame(opcode, data) {
    if (!this.socket || this.socket.destroyed) return;
    const len = data.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) { this._sendFrame(0x1, Buffer.from(text, 'utf8')); }
  sendJson(obj) { this.send(JSON.stringify(obj)); }
  close() {
    try { this._sendFrame(0x8, Buffer.alloc(0)); this.socket && this.socket.end(); } catch (_) {}
  }
}

module.exports = WatchWS;
