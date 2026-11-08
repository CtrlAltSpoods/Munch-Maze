'use strict';
/* Server hardening: security headers, static file safety, JSON-only POSTs, rate limits,
   maze-opening limits, name cleaning, bad messages, and how the Discord secret is handled. */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os'), fs = require('fs'), path = require('path');
const PORT = 23000 + (Math.random() * 400 | 0), PORT2 = PORT + 500;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-hard-')), DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-hard2-'));
const SECRET = 'S3cr3t-file-0123456789abcdefghij';
const procs = [];
const fail = msg => { console.error('FAIL:', msg); done(1); };
function done(code) { for (const p of procs) try { p.kill(); } catch (e) { /* ignore */ } for (const d of [DATA, DATA2]) fs.rmSync(d, { recursive: true, force: true }); process.exit(code); }
setTimeout(() => fail('timed out'), 60000);
const wait = ms => new Promise(r => setTimeout(r, ms));
function start(port, env) {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(srv); srv.out = '';
  srv.stdout.on('data', d => { srv.out += d; }); srv.stderr.on('data', d => { srv.out += d; });
  return new Promise(r => { const t = setInterval(() => { if (/listening/.test(srv.out)) { clearInterval(t); r(srv); } }, 50); });
}
/* raw request: lets us send odd paths and Host headers that fetch would tidy up */
function raw(port, reqPath, headers = {}, method = 'GET', body = '') {
  return new Promise(res => {
    const r = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, rs => { let b = ''; rs.on('data', c => b += c); rs.on('end', () => res({ status: rs.statusCode, headers: rs.headers, body: b })); });
    r.on('error', e => res({ status: 0, error: e.message })); r.end(body);
  });
}
function client(port, join) {
  return new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), c = { ws, msgs: [], last: {} };
    ws.onopen = () => ws.send(JSON.stringify(Object.assign({ t: 'join', tok: 'h' + Math.random() }, join)));
    ws.onmessage = e => { const m = JSON.parse(e.data); c.msgs.push(m); c.last[m.t] = m; if (m.t === 'welcome' || m.t === 'error') res(c); };
    ws.onerror = () => res(c);
  });
}

(async () => {
  const srv = await start(PORT, { DATA_DIR: DATA });

  // headers
  const home = await raw(PORT, '/');
  const csp = home.headers['content-security-policy'] || '';
  if (!/default-src 'self'/.test(csp) || !/script-src 'self'(;|$)/.test(csp) || !/frame-ancestors 'none'/.test(csp) || /unsafe-(inline|eval)/.test(csp)) fail('strict CSP: ' + csp);
  if (home.headers['x-frame-options'] !== 'DENY' || home.headers['x-content-type-options'] !== 'nosniff' || home.headers['referrer-policy'] !== 'no-referrer' || !home.headers['permissions-policy']) fail('security headers');
  if (home.headers['strict-transport-security']) fail('no HSTS on plain http');
  console.log('ok  security headers (strict CSP, no framing, nosniff, no referrer)');

  // static files: no way out of public/, no dotfiles, no sneaky encodings
  for (const p of ['/../server/index.js', '/%2e%2e/server/index.js', '/..%2fserver%2findex.js', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/.git/config', '/sounds/../../package.json', '/foo%00.js', '/%E0%A4%A']) {
    const r = await raw(PORT, p);
    if (r.status === 200 || /require\(|"scripts"|root:/.test(r.body || '')) fail('must not serve ' + p + ' (' + r.status + ')');
  }
  if ((await raw(PORT, '/' + 'a'.repeat(600))).status !== 414) fail('very long paths are refused');
  if ((await raw(PORT, '/', {}, 'PUT')).status !== 405) fail('only GET/HEAD/POST');
  console.log('ok  static files: no path traversal, no dotfiles, odd methods and huge paths refused');

  // POSTs must be JSON (a form on another site can't send JSON without asking first)
  const form = await raw(PORT, '/api/me/name', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', 'name=x');
  if (form.status !== 415) fail('form posts are refused: ' + form.status);
  const cross = await raw(PORT, '/api/me/name', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, 'POST', '{"name":"x"}');
  if (cross.status !== 403) fail('cross-site posts are refused: ' + cross.status);
  const big = await raw(PORT, '/api/me/name', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ name: 'x'.repeat(5000) }));
  if (big.status === 200) fail('oversized bodies are refused');
  console.log('ok  POSTs: JSON only, same site only, small bodies only');

  // player text is cleaned: no invisible/bidi/control characters; look-alike full-width letters normalised
  const nm = await client(PORT, { nm: '‮Ｂｏｂ​\u0007⁦', seed: 'names', lname: 'Party\u0000‮ Time' });
  const row = nm.last.welcome.roster[0];
  if (row[1] !== 'Bob' || nm.last.welcome.title !== 'Party Time') fail('names cleaned: ' + JSON.stringify(row[1]) + ' / ' + JSON.stringify(nm.last.welcome.title));
  const zalgo = await client(PORT, { nm: 'Ź̂̃̄̅a', seed: 'names2' });
  if (zalgo.last.welcome.roster[0][1] !== 'Z\u0301\u0302\u0303a'.normalize('NFKC')) fail('stacked accents are trimmed: ' + JSON.stringify(zalgo.last.welcome.roster[0][1]));
  console.log('ok  names and lobby names: normalised, invisible and control characters removed');

  // junk messages: ignored, and the server keeps going
  const junk = nm.ws;
  for (const m of ['[1,2,3]', 'null', '"x"', '{"t":5}', '{"t":"eat","i":{"length":1e9}}', '{"t":"p","x":"1e999","y":null}', '{"t":"eat","i":[1e300,-5,"x",null]}',
    '{"t":"vote","y":{"toString":1}}', '{"__proto__":{"t":"ready"}}', '{"t":"setup","mods":"9999999999"}', '{"t":"role","r":-1}', '{"t":"teststat","st":{"clearXp":999999}}',
    '{"t":"join","nm":{"a":1}}', '{"t":"emo","e":"constructor"}', '{"t":"grab","id":{}}', '{"t":"' + 'x'.repeat(1000) + '"}']) junk.send(m);
  await wait(300);
  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  if (!health.ok || junk.readyState !== 1) fail('junk messages must not hurt the server');
  if (nm.msgs.some(m => m.t === 'xp')) fail('test hooks are off on a normal server');
  console.log('ok  malformed and hostile messages are ignored; test cheats are off');

  if (/\[ws\] message .* failed/.test(srv.out)) fail('a junk message hit a code path that threw: ' + srv.out.split('\n').filter(l => /failed/.test(l)).join(' | '));
  // opening mazes is limited per address
  let refused = 0;
  for (let i = 0; i < 16; i++) { const c = await client(PORT, { nm: 'm' + i, seed: 'spam' + i }); if (c.last.error) refused++; c.ws.close(); }
  if (refused < 1) fail('opening lots of mazes from one address is limited');
  console.log('ok  one address can’t open endless mazes (' + refused + ' refused)');

  // API rate limit (the page itself isn't limited)
  let limited = 0;
  for (let i = 0; i < 260; i++) if ((await raw(PORT, '/api/info')).status === 429) limited++;
  if (!limited || (await raw(PORT, '/')).status !== 200) fail('API requests are rate limited per address');
  console.log('ok  API requests are rate limited per address');

  // ---------- the Discord secret ----------
  const secFile = path.join(DATA2, 'discord_secret'); fs.writeFileSync(secFile, SECRET + '\n');
  const fakeHits = []; const fake = http.createServer((q, r) => { fakeHits.push(q.url); r.end('{}'); }).listen(PORT2 + 1);
  const s2 = await start(PORT2, { DATA_DIR: DATA2, DISCORD_CLIENT_ID: '424242', DISCORD_CLIENT_SECRET_FILE: secFile, DISCORD_API: `http://127.0.0.1:${PORT2 + 1}`, DISCORD_AUTHORIZE: `http://127.0.0.1:${PORT2 + 1}/authorize` });
  const me = await (await fetch(`http://127.0.0.1:${PORT2}/api/me`)).json();
  if (!me.discord) fail('the secret can come from a file (DISCORD_CLIENT_SECRET_FILE)');
  if (s2.out.includes(SECRET)) fail('the secret must never be logged');
  const login = await raw(PORT2, '/auth/discord', { Host: 'evil.example/x?' });
  const to = new URL(login.headers.location);
  if (to.origin !== 'https://discord.com') fail('outside tests, logins always go to discord.com: ' + to.origin);
  if (to.searchParams.get('redirect_uri') !== 'http://localhost/auth/discord/callback') fail('a junk Host header can’t steer the redirect: ' + to.searchParams.get('redirect_uri'));
  if (!/PUBLIC_URL is not set/.test(s2.out) || !/ignored/.test(s2.out)) fail('boot warnings for a missing PUBLIC_URL and test-only settings');
  // a callback (even a forged one) never sends the secret anywhere but Discord
  const st = String(login.headers['set-cookie'] || '').match(/mm_oauth=([^;]+)/)[1];
  await raw(PORT2, '/auth/discord/callback?code=x&state=' + st, { Cookie: 'mm_oauth=' + st });
  await wait(300);
  if (fakeHits.length) fail('the secret must only ever be sent to discord.com');
  for (const p of ['/api/me', '/api/info', '/api/admin/state', '/', '/admin.html']) { const r = await raw(PORT2, p); if ((r.body || '').includes(SECRET)) fail('secret leaked in ' + p); }
  fake.close();
  // a pasted-wrong secret turns logins off instead of being used
  const s3 = await start(PORT2 + 2, { DATA_DIR: DATA2, DISCORD_CLIENT_ID: '424242', DISCORD_CLIENT_SECRET: 'oops my secret' });
  if ((await (await fetch(`http://127.0.0.1:${PORT2 + 2}/api/me`)).json()).discord || !/doesn’t look like/.test(s3.out) || s3.out.includes('oops my secret')) fail('a malformed secret disables login without printing it');
  console.log('ok  Discord secret: read from a file or variable, never logged or served, only ever sent to discord.com; junk Host headers can’t steer logins');

  done(0);
})().catch(e => fail(e.stack || e.message));
