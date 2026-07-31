// Persistent Lutron RadioRA2 client with live monitoring.

const net = require('net');
const EventEmitter = require('events');

const PROCESSOR_IP = '192.168.2.158';
const TELNET_PORT = 23;
const USER = 'josh';
const PASS = '1234';
const RECONNECT_DELAY_MS = 3000;

class LutronClient extends EventEmitter {
  constructor(ip = PROCESSOR_IP) {
    super();
    this.ip = ip;
    this.socket = null;
    this.buffer = '';
    this.state = new Map();
    this.ready = false;
    this.connecting = null;
    this.knownOutputIds = new Set();
  }

  setKnownOutputIds(ids) { this.knownOutputIds = new Set(ids); }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = new net.Socket();
      s.setKeepAlive(true, 30000);
      let loggedIn = false;
      let stage = 'login';

      const cleanup = (err) => {
        this.ready = false;
        this.socket = null;
        this.connecting = null;
        try { s.destroy(); } catch (_) {}
        this.emit('disconnect', err);
        setTimeout(() => this.connect().catch(() => {}), RECONNECT_DELAY_MS);
      };

      s.on('error', (e) => {
        if (!this.ready && this.connecting) reject(e);
        cleanup(e);
      });
      s.on('close', () => cleanup(new Error('connection closed')));
      s.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        if (stage === 'login' && this.buffer.includes('login:')) {
          this.buffer = '';
          s.write(USER + '\r\n');
          stage = 'password';
        } else if (stage === 'password' && this.buffer.includes('password:')) {
          this.buffer = '';
          s.write(PASS + '\r\n');
          stage = 'authing';
        } else if ((stage === 'authing' || stage === 'ready') && this.buffer.includes('GNET>')) {
          if (!loggedIn) {
            loggedIn = true;
            stage = 'ready';
            this.socket = s;
            this.ready = true;
            this.connecting = null;
            this.emit('connect');
            s.write('#MONITORING,255,1\r\n');
            setTimeout(() => this._primeState(), 200);
            resolve();
          }
          this.buffer = this.buffer.substring(this.buffer.indexOf('GNET>') + 5);
        }
        this._parseEvents();
      });
      s.connect(TELNET_PORT, this.ip);
    });
    return this.connecting;
  }

  _primeState() {
    if (!this.socket || !this.ready) return;
    for (const id of this.knownOutputIds) this.socket.write(`?OUTPUT,${id},1\r\n`);
  }

  _parseEvents() {
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.substring(0, idx);
      this.buffer = this.buffer.substring(idx + 2);
      if (!line) continue;
      const outMatch = line.match(/^~OUTPUT,(\d+),(\d+),([\d.]+)/);
      if (outMatch) {
        const id = parseInt(outMatch[1], 10);
        const action = parseInt(outMatch[2], 10);
        const level = parseFloat(outMatch[3]);
        if (action === 1) {
          const prev = this.state.get(id);
          this.state.set(id, level);
          if (prev !== level) this.emit('change', { id, level, prev });
        }
        continue;
      }
      const devMatch = line.match(/^~DEVICE,(\d+),(\d+),(\d+)/);
      if (devMatch) {
        this.emit('device', {
          id: parseInt(devMatch[1], 10),
          button: parseInt(devMatch[2], 10),
          action: parseInt(devMatch[3], 10),
        });
      }
    }
  }

  async waitReady(timeoutMs = 10000) {
    if (this.ready) return;
    const start = Date.now();
    while (!this.ready && Date.now() - start < timeoutMs) await new Promise(r => setTimeout(r, 50));
    if (!this.ready) throw new Error('Lutron not ready');
  }

  async setOutput(id, level, fadeSeconds = 1) {
    await this.waitReady();
    const fadeHMS = `00:00:${String(Math.max(0, Math.floor(fadeSeconds))).padStart(2, '0')}`;
    this.socket.write(`#OUTPUT,${id},1,${level.toFixed(2)},${fadeHMS}\r\n`);
    this.state.set(id, level);
    return level;
  }

  async setMany(commands) {
    await this.waitReady();
    for (const c of commands) {
      const fadeHMS = `00:00:${String(Math.max(0, Math.floor(c.fade || 1))).padStart(2, '0')}`;
      this.socket.write(`#OUTPUT,${c.id},1,${c.level.toFixed(2)},${fadeHMS}\r\n`);
      this.state.set(c.id, c.level);
    }
  }

  // Virtually press a Pico button — repeater fires the pre-programmed scene at native speed.
  // Sequence per Lutron: press (3), release (4). Some scenes only need press.
  async pressPicoButton(picoId, componentNumber) {
    await this.waitReady();
    const sock = this.socket;
    try { sock.write(`#DEVICE,${picoId},${componentNumber},3\r\n`); }
    catch (e) { console.error('[Lutron] press write failed:', e && e.message); return; }
    // Small delay then release for a clean single-tap event. Guard against socket
    // dying in the 100ms window — a naked write() throw here would kill the process
    // (unhandled sync throw from a setTimeout callback).
    setTimeout(() => {
      try {
        if (this.socket && this.socket === sock && !sock.destroyed) {
          sock.write(`#DEVICE,${picoId},${componentNumber},4\r\n`);
        }
      } catch (e) {
        console.error('[Lutron] release write failed:', e && e.message);
      }
    }, 100);
  }

  getState() { return Object.fromEntries(this.state); }
}

module.exports = { LutronClient };
