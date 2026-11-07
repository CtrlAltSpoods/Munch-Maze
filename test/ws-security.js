'use strict';
/* WebSocket hardening tests: raw TCP clients send hand-built frames and
   handshakes, and we check the server refuses or closes the way RFC 6455 says. */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 19000 + (Math.random() * 1000 | 0);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-ws-'));
let srv, passed = 0;
const ok = msg => { passed++; console.log('ok  ' + msg); };
function done(code, msg) { if (msg) console.error('FAIL: ' + msg); try { srv.kill(); } catch (e) { /* ignore */ } process.exit(code); }
setTimeout(() => done(1, 'timed out'), 30000);

/* ---- raw client helpers ---- */
function handshake(headers = {}, method = 'GET') {
  return new Promise(resolve => {
    const s = net.connect(PORT, '127.0.0.1');
    const h = Object.assign({
      Host: `127.0.0.1:${PORT}`, Upgrade: 'websocket', Connection: 'Upgrade',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
    }, headers);
    let head = `${method} /ws HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) if (v !== null) head += `${k}: ${v}\r\n`;
    s.write(head + '\r\n');
    let buf = Buffer.alloc(0), settled = false;
    const finish = status => { if (!settled) { settled = true; resolve({ s, status, rest: () => buf }); } };
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (!settled && i >= 0) { const status = +buf.toString('latin1', 9, 12); buf = buf.subarray(i + 4); finish(status); }
    });
    s.on('close', () => finish(0));
    s.on('error', () => finish(0));
  });
}
function frame(op, payload, { fin = true, mask = true, rsv = 0, lenOverride } = {}) {
  payload = Buffer.from(payload);
  const len = lenOverride !== undefined ? lenOverride : payload.length;
  const parts = [];
  let b1 = (fin ? 0x80 : 0) | rsv | op, b2 = mask ? 0x80 : 0;
  if (len < 126) parts.push(Buffer.from([b1, b2 | len]));
  else if (len < 65536) { const h = Buffer.alloc(4); h[0] = b1; h[1] = b2 | 126; h.writeUInt16BE(len, 2); parts.push(h); }
  else { const h = Buffer.alloc(10); h[0] = b1; h[1] = b2 | 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); parts.push(h); }
  if (mask) {
    const m = crypto.randomBytes(4), p = Buffer.from(payload);
    for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
    parts.push(m, p);
  } else parts.push(payload);
  return Buffer.concat(parts);
}
/** Resolve with the close code the server sends (or 'eof' if it just hung up). */
function closeCode(conn, ms = 3000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve('none'), ms);
    const scan = () => {
      const b = conn.rest();
      for (let i = 0; i + 1 < b.length;) {
        const op = b[i] & 0x0f; let len = b[i + 1] & 0x7f, off = i + 2;
        if (len === 126) { if (b.length < i + 4) return; len = b.readUInt16BE(i + 2); off = i + 4; }
        if (b.length < off + len) return;
        if (op === 0x8) { clearTimeout(t); return resolve(len >= 2 ? b.readUInt16BE(off) : 'empty'); }
        i = off + len;
      }
    };
    conn.s.on('data', () => setImmediate(scan));
    conn.s.on('close', () => { scan(); setTimeout(() => { clearTimeout(t); resolve('eof'); }, 50); });
    scan();
  });
}
const join = JSON.stringify({ t: 'join', nm: 'probe', seed: 'ws-test' });
async function expectClose(name, bytes, want) {
  const c = await handshake();
  if (c.status !== 101) return done(1, `${name}: handshake ${c.status}`);
  c.s.write(bytes);
  const code = await closeCode(c);
  if (code !== want) return done(1, `${name}: expected close ${want}, got ${code}`);
  ok(`${name} -> close ${want}`);
  c.s.destroy();
}
async function expectStatus(name, headers, want, method) {
  const c = await handshake(headers, method);
  const good = want === 'refused' ? (c.status >= 400 || c.status === 0) : c.status === want;
  if (!good) return done(1, `${name}: expected HTTP ${want}, got ${c.status}`);
  ok(`${name} -> HTTP ${c.status || 'connection closed'}`);
  c.s.destroy();
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, MAX_CONNECTIONS_PER_IP: '3', MAX_CONNECTIONS: '50', ALLOWED_ORIGINS: 'https://friends.example' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  srv.on('exit', c => done(1, 'server exited with ' + c));
  await new Promise(r => srv.stdout.on('data', d => { if (/listening/.test(d)) r(); }));

  // A normal client still works.
  {
    const c = await handshake({ Origin: `http://127.0.0.1:${PORT}` });
    if (c.status !== 101) return done(1, 'same-origin handshake ' + c.status);
    c.s.write(frame(0x1, join));
    await sleep(300);
    if (!c.rest().toString('latin1').includes('"welcome"')) return done(1, 'no welcome after join');
    ok('same-origin client joins a maze');
    // a join split across fragments is reassembled
    c.s.destroy();
    const f = await handshake();
    const half = Math.floor(join.length / 2);
    f.s.write(Buffer.concat([frame(0x1, join.slice(0, half), { fin: false }), frame(0x0, join.slice(half))]));
    await sleep(300);
    if (!f.rest().toString('latin1').includes('"welcome"')) return done(1, 'fragmented join not reassembled');
    ok('fragmented message is reassembled');
    f.s.destroy();
  }

  // Handshake validation and Origin policy.
  await expectStatus('cross-site Origin', { Origin: 'https://evil.example' }, 403);
  await expectStatus('allow-listed Origin', { Origin: 'https://friends.example' }, 101);
  await expectStatus('missing Connection: Upgrade', { Connection: 'keep-alive' }, 'refused');
  await expectStatus('POST upgrade', {}, 'refused', 'POST');
  await expectStatus('malformed Sec-WebSocket-Key', { 'Sec-WebSocket-Key': 'short' }, 400);
  await expectStatus('wrong protocol version', { 'Sec-WebSocket-Version': '8' }, 426);

  // Frame-level protocol rules.
  await expectClose('unmasked frame', frame(0x1, join, { mask: false }), 1002);
  await expectClose('reserved bits set', frame(0x1, join, { rsv: 0x40 }), 1002);
  await expectClose('ping payload over 125 bytes', frame(0x9, Buffer.alloc(126)), 1002);
  await expectClose('fragmented ping', frame(0x9, 'x', { fin: false }), 1002);
  await expectClose('new text frame mid-fragment', Buffer.concat([frame(0x1, '{"t":', { fin: false }), frame(0x1, '{}')]), 1002);
  await expectClose('continuation with nothing to continue', frame(0x0, 'x'), 1002);
  await expectClose('invalid UTF-8', frame(0x1, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), 1007);
  await expectClose('binary frame', frame(0x2, Buffer.from([1, 2, 3])), 1003);
  await expectClose('single frame over 16 KB', frame(0x1, Buffer.alloc(16 * 1024 + 1, 0x20)), 1009);
  {
    const parts = [frame(0x1, Buffer.alloc(8000, 0x20), { fin: false })];
    for (let i = 0; i < 3; i++) parts.push(frame(0x0, Buffer.alloc(8000, 0x20), { fin: false }));
    await expectClose('fragments totalling over 16 KB', Buffer.concat(parts), 1009);
  }
  {
    const many = [frame(0x1, ' ', { fin: false })];
    for (let i = 0; i < 4000; i++) many.push(frame(0x0, ' ', { fin: false }));
    const t0 = Date.now();
    const c = await handshake(); c.s.write(Buffer.concat(many));
    await sleep(200);
    if (Date.now() - t0 > 1500) return done(1, 'thousands of tiny fragments were slow');
    ok('4000 one-byte fragments handled quickly');
    c.s.destroy();
  }
  {
    // ping is answered with a pong carrying the same payload
    const c = await handshake(); c.s.write(frame(0x9, 'hi'));
    await sleep(200);
    const b = c.rest();
    if (!(b[0] === 0x8a && b[1] === 2 && b.toString('latin1', 2, 4) === 'hi')) return done(1, 'ping not answered with pong');
    ok('ping answered with matching pong');
    c.s.destroy();
  }

  // Connection limits: 3 per IP in this test.
  await sleep(300); // let the closed test sockets be counted down
  {
    const held = [];
    for (let i = 0; i < 3; i++) { const c = await handshake(); if (c.status !== 101) return done(1, `per-IP slot ${i + 1} refused (${c.status})`); held.push(c); }
    const extra = await handshake();
    if (extra.status !== 429) return done(1, 'fourth connection from one IP should get 429, got ' + extra.status);
    ok('fourth connection from one IP -> HTTP 429');
    held[0].s.destroy(); await sleep(200);
    const again = await handshake();
    if (again.status !== 101) return done(1, 'slot was not freed after a client left');
    ok('slot freed when a client disconnects');
    held.slice(1).forEach(c => c.s.destroy()); again.s.destroy();
  }

  // Malformed URLs must not crash the server.
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/%E0%A4%A`);
    if (r.status !== 400) return done(1, 'malformed URL should be 400, got ' + r.status);
    const h = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (!h.ok) return done(1, 'server unhealthy after malformed URL');
    ok('malformed URL -> HTTP 400, server keeps running');
  }

  console.log(`\nAll ${passed} WebSocket security tests passed.`);
  srv.removeAllListeners('exit');
  done(0);
})().catch(e => done(1, e.stack));
