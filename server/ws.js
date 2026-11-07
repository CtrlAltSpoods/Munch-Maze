'use strict';
/* Minimal RFC 6455 WebSocket server (text frames, ping/pong, close).
   No dependencies, so the Docker image needs nothing but Node.
   Admission policy (Origin checks, connection limits) lives in index.js and
   is passed in through handleUpgrade's `admit` callback. */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024;          // clients only send small JSON messages
const MAX_CONTROL = 125;                // RFC 6455 §5.5: control frame payload limit
const MAX_PENDING = MAX_MESSAGE + 14;   // largest incomplete frame we will wait for
const MAX_BUFFERED = 2 * 1024 * 1024;   // drop clients that can't keep up

// Close codes (RFC 6455 §7.4.1)
const NORMAL = 1000, PROTOCOL_ERROR = 1002, UNSUPPORTED = 1003, BAD_DATA = 1007, TOO_BIG = 1009;

const utf8 = new TextDecoder('utf-8', { fatal: true });

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = null;      // pieces of a fragmented text message
    this.fragLen = 0;      // running total of this.frag
    this.closed = false;
    this.lastSeen = Date.now();
    this._onData = d => this._data(d);
    sock.on('data', this._onData);
    // Node's HTTP server keeps sockets half-open; when the client hangs up, close our side too
    // so the connection (and its per-IP slot) is released at once instead of at the next heartbeat.
    sock.on('end', () => this.terminate());
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  _data(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0, rsv = b[0] & 0x70, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      const control = (op & 0x08) !== 0;
      if (rsv) return this.close(PROTOCOL_ERROR);       // no extensions negotiated
      if (!masked) return this.close(PROTOCOL_ERROR);   // clients must mask
      let len = b[1] & 0x7f, off = 2;
      if (control && (!fin || len > MAX_CONTROL)) return this.close(PROTOCOL_ERROR);
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) break;
        if (b.readUInt32BE(2) !== 0) return this.close(TOO_BIG);
        len = b.readUInt32BE(6); off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(TOO_BIG);
      if (b.length < off + 4 + len) break;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.lastSeen = Date.now();

      switch (op) {
        case 0x0: // continuation
          if (!this.frag) return this.close(PROTOCOL_ERROR);
          this.fragLen += payload.length;
          if (this.fragLen > MAX_MESSAGE) return this.close(TOO_BIG);
          this.frag.push(payload);
          if (fin) { const whole = Buffer.concat(this.frag, this.fragLen); this.frag = null; this.fragLen = 0; this._deliver(whole); }
          break;
        case 0x1: // text
          if (this.frag) return this.close(PROTOCOL_ERROR); // new message before the last one finished
          if (fin) this._deliver(payload); else { this.frag = [payload]; this.fragLen = payload.length; }
          break;
        case 0x2: return this.close(UNSUPPORTED);           // binary: not used by this game
        case 0x8: return this.close(NORMAL);                // close
        case 0x9: this._frame(0xA, payload); break;         // ping -> pong (payload ≤125 bytes)
        case 0xA: break;                                     // pong
        default: return this.close(PROTOCOL_ERROR);
      }
    }
    // Anything left is one incomplete frame; it can never legitimately exceed this.
    if (!this.closed && this.buf.length > MAX_PENDING) this.close(TOO_BIG);
  }

  _deliver(bytes) {
    let text;
    try { text = utf8.decode(bytes); } catch (e) { return this.close(BAD_DATA); }
    this.emit('message', text);
  }

  _frame(op, payload) {
    if (this.closed || this.sock.destroyed || !this.sock.writable) return;
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

  close(code = NORMAL) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    try { this._frame(0x8, p); this.sock.end(); } catch (e) { /* ignore */ }
    this._closed();
    // Give the peer a moment to finish the close handshake, then drop the TCP connection.
    setTimeout(() => { try { this.sock.destroy(); } catch (e) { /* ignore */ } }, 2000).unref();
  }
  terminate() { try { this.sock.destroy(); } catch (e) { /* ignore */ } this._closed(); }
  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.buf = Buffer.alloc(0); this.frag = null; this.fragLen = 0;
    this.sock.removeListener('data', this._onData);   // nothing more is parsed after close
    this.emit('close');
  }
}

function reject(sock, status, text) {
  if (sock.writable) sock.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  sock.destroy();
}

/**
 * Complete a WebSocket handshake.
 * `admit(req)` returns null to accept, or [status, reason] to refuse
 * (used for Origin checks and connection limits).
 */
function handleUpgrade(req, sock, admit, onSocket) {
  const key = String(req.headers['sec-websocket-key'] || '');
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase().split(',').map(s => s.trim());
  const version = String(req.headers['sec-websocket-version'] || '');
  if (req.method !== 'GET' || upgrade !== 'websocket' || !connection.includes('upgrade')) return reject(sock, 400, 'Bad Request');
  if (version !== '13') { if (sock.writable) sock.write('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return sock.destroy(); }
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject(sock, 400, 'Bad Request'); // base64 of 16 bytes
  const refusal = admit(req);
  if (refusal) return reject(sock, refusal[0], refusal[1]);
  if (sock.destroyed || !sock.writable) return;   // client already went away
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  onSocket(new Socket(sock));
}

module.exports = { handleUpgrade, MAX_MESSAGE };
