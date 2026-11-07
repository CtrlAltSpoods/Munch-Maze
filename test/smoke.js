'use strict';
/* End-to-end smoke test: boots the server, connects two players to one seed,
   has one of them eat every pellet, and checks that both move to level 2. */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const M = require('../shared/maze.js');

const PORT = 18000 + (Math.random() * 1000 | 0);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-'));
const base = `http://127.0.0.1:${PORT}`;
const fail = msg => { console.error('FAIL:', msg); cleanup(1); };
let srv;
function cleanup(code) { try { srv.kill(); } catch (e) { /* ignore */ } process.exit(code); }
setTimeout(() => fail("timed out"), 30000);

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const c = { ws, name, msgs: [], last: {}, on: {} };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', nm: name, seed: 'Smoke Test!', tok: name }));
    ws.onerror = e => reject(new Error('socket error ' + name));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data); c.msgs.push(m); c.last[m.t] = m;
      if (c.on[m.t]) c.on[m.t](m);
      if (m.t === 'welcome') resolve(c);
    };
  });
}
const waitFor = (c, t, pred = () => true, ms = 8000) => new Promise((res, rej) => {
  const found = c.msgs.find(m => m.t === t && pred(m)); if (found) return res(found);
  const timer = setTimeout(() => rej(new Error(`${c.name} never got ${t}`)), ms);
  c.on[t] = m => { if (pred(m)) { clearTimeout(timer); c.on[t] = null; res(m); } };
});

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (/listening/.test(d)) r(); }));

  const health = await (await fetch(base + '/healthz')).json();
  if (!health.ok) fail('healthz');
  const html = await (await fetch(base + '/')).text();
  if (!html.includes('client.js')) fail('index.html not served');
  const core = await (await fetch(base + '/maze.js')).text();
  if (!core.includes('genLevel')) fail('maze.js not served');
  if ((await fetch(base + '/../server/index.js')).status === 200) fail('path traversal');

  const a = await client('alice');
  const b = await client('bob');
  const wa = a.last.welcome;
  if (wa.seed !== 'smoke-test') fail('seed not normalised: ' + wa.seed);
  if (b.last.welcome.roster.length !== 2) fail('roster should list both players');
  await waitFor(a, 'join', m => m.nm === 'bob');
  console.log('ok  two players joined seed', wa.seed);

  const games = await (await fetch(base + '/api/games')).json();
  if (games[0].players !== 2) fail('lobby count');
  console.log('ok  lobby lists the maze');

  // both clients must build the same maze as the server
  const lv = M.genLevel(wa.seed, 1);
  const s1 = await waitFor(b, 's');
  if (s1.g.length !== M.ghostCount(1)) fail('ghost count');
  console.log('ok  state stream running,', s1.g.length, 'ghost(s)');

  // alice walks to every pellet and eats it
  for (const i of lv.pList) {
    const x = i % lv.W, y = (i / lv.W) | 0;
    a.ws.send(JSON.stringify({ t: 'p', x, y, f: 0 }));
    a.ws.send(JSON.stringify({ t: 'eat', i }));
    await new Promise(r => setTimeout(r, 40)); // stay under the rate limit
  }
  const far = lv.pList[0]; // a cheat: claiming a pellet from far away does nothing
  const sAfter = await waitFor(b, 's', m => m.ph === 1, 6000);
  const alice = sAfter.p.find(p => p[0] === wa.id);
  const expected = lv.pList.reduce((n, i) => n + (lv.p[i] === 2 ? 50 : 10), 0);
  if (alice[5] !== expected) fail(`score ${alice[5]} != ${expected}`);
  console.log('ok  all', lv.pList.length, 'pellets eaten, score', alice[5], '- level clear');

  const lvl = await waitFor(b, 'level', m => m.lv === 2, 6000);
  const lv2 = M.genLevel(wa.seed, 2);
  console.log('ok  both moved to level', lvl.lv, `(${lv2.W}x${lv2.H}, ${M.ghostCount(2)} ghosts)`);

  // far-away eat claim is rejected
  b.ws.send(JSON.stringify({ t: 'p', x: lv2.sx, y: lv2.sy, f: 0 }));
  const farIdx = lv2.pList.find(i => Math.abs((i % lv2.W) - lv2.sx) + Math.abs(((i / lv2.W) | 0) - lv2.sy) > 6);
  b.ws.send(JSON.stringify({ t: 'eat', i: farIdx }));
  await new Promise(r => setTimeout(r, 300));
  const sb = b.last.s, bob = sb.p.find(p => p[0] === b.last.welcome.id);
  if (bob[5] !== 0) fail('far-away pellet claim was accepted');
  console.log('ok  far-away pellet claims are rejected');

  // reconnect with the same token resumes the score
  a.ws.close();
  await waitFor(b, 'leave');
  const a2 = await client('alice');
  if (a2.last.welcome.sc !== expected) fail('resume did not keep score');
  console.log('ok  reconnect resumed score', a2.last.welcome.sc);

  console.log('\nAll smoke tests passed.');
  cleanup(0);
})().catch(e => fail(e.message));
