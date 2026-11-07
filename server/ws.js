'use strict';
/* Minimal RFC 6455 WebSocket server (text frames, ping/pong, close).
   No dependencies, so the Docker image needs nothing but Node. */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024;          // clients only send small JSON messages
const MAX_BUFFERED = 2 * 1024 * 1024;   // drop clients that can't keep up

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    this.lastSeen = Date.now();
    sock.on('data', d => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  _data(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this.close(1009);
        len = b.readUInt32BE(6); off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009);
      if (!masked) return this.close(1002);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.lastSeen = Date.now();

      switch (op) {
        case 0x0: // continuation
          if (!this.frag) return this.close(1002);
          this.frag.push(payload);
          if (this.frag.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return this.close(1009);
          if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = null; this.emit('message', msg); }
          break;
        case 0x1: // text
          if (fin) this.emit('message', payload.toString('utf8')); else this.frag = [payload];
          break;
        case 0x2: break;                    // binary: not used
        case 0x8: this.close(1000); return; // close
        case 0x9: this._frame(0xA, payload); break; // ping -> pong
        case 0xA: break;                    // pong
        default: return this.close(1002);
      }
    }
  }

  _frame(op, payload) {
    if (this.closed || this.sock.destroyed) return;
    if (this.sock.writableLength > MAX_BUFFERED) { this.terminate(); return; }
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    this.sock.write(Buffer.concat([head, payload]));
  }

  send(text) { this._frame(0x1, Buffer.from(text, 'utf8')); }
  ping() { this._frame(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    try { this._frame(0x8, p); this.sock.end(); } catch (e) { /* ignore */ }
    this._closed();
  }
  terminate() { try { this.sock.destroy(); } catch (e) { /* ignore */ } this._closed(); }
  _closed() { if (this.closed) return; this.closed = true; this.emit('close'); }
}

function handleUpgrade(req, sock, onSocket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  onSocket(new Socket(sock));
}

module.exports = { handleUpgrade };
