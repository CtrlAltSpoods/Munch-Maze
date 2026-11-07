'use strict';
/* Power-ups: crates, the paused slot reveal, and what each one does on the server. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const M = require('../shared/maze.js');
const PORT = 20000 + (Math.random() * 1000 | 0), DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-pu-'));
let srv;
const fail = msg => { console.error('FAIL:', msg); try { srv.kill(); } catch (e) { /* ignore */ } process.exit(1); };
setTimeout(() => fail('timed out'), 150000);
const wait = ms => new Promise(r => setTimeout(r, ms));
const idx = id => M.POWERUPS.findIndex(p => p.id === id);

function client(name, seed, extra = {}) {
  return new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`), c = { ws, msgs: [], last: {} };
    ws.onopen = () => ws.send(JSON.stringify(Object.assign({ t: 'join', nm: name, seed, tok: name + seed }, extra)));
    ws.onmessage = e => { const m = JSON.parse(e.data); c.msgs.push(m); c.last[m.t] = m; if (m.t === 'welcome') res(c); };
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const until = async (c, pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = c.msgs.find(pred); if (m) return m; await wait(30); } fail('timed out waiting'); };
const lastS = c => c.last.s;

async function room(seed, level) {
  const a = await client('host', seed), b = await client('guest', seed);
  send(a, { t: 'startlv', lv: level }); await wait(150);
  send(a, { t: 'ready' }); await until(b, m => m.t === 'level' && m.ph === 0);
  // park both at the spawn point
  const lv = M.genLevel(lastS(b) ? seed : seed, level);
  for (const c of [a, b]) send(c, { t: 'p', x: lv.sx, y: lv.sy, f: 0 });
  await wait(100);
  return { a, b, lv };
}
async function trigger(r, id) {
  r.a.msgs.length = 0; r.b.msgs.length = 0;
  send(r.a, { t: 'testcrate', kind: idx(id) });
  const cr = await until(r.b, m => m.t === 'crate');
  send(r.a, { t: 'grab', id: cr.id });
  const pu = await until(r.b, m => m.t === 'pu');
  if (M.POWERUPS[pu.kind].id !== id) fail('expected ' + id);
  return pu;
}

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TEST_HOOKS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (/listening/.test(d)) r(); }));

  // natural spawns: nothing before level 3, 1-2 crates from level 3
  const early = await room('pu-early', 2);
  await wait(200);
  if (lastS(early.b).c.length) fail('no crates before level 3');
  const late = await room('pu-late', 3);
  const t0 = Date.now(); await until(late.b, m => m.t === 'crate', 40000);
  console.log('ok  no crates before level 3; one appeared on level 3 after ' + Math.round((Date.now() - t0) / 1000) + ' s');

  // the slot pauses everyone, then the power-up activates as play resumes
  const r = await room('pu-main', 5);
  const pu = await trigger(r, 'megapellet');
  await wait(200);
  const g0 = JSON.stringify(lastS(r.b).g); await wait(500);
  if (lastS(r.b).ph !== 4) fail('game should be paused (phase 4) while the slot is up');
  if (JSON.stringify(lastS(r.b).g) !== g0) fail('ghosts must not move while paused');
  send(r.b, { t: 'eat', i: [r.lv.pList[0]] });
  const on = await until(r.b, m => m.t === 'puon', 5000);
  await wait(150);
  if (lastS(r.b).ph !== 0) fail('play should resume after the reveal');
  console.log('ok  grabbing a crate pauses everyone for the slot, then resumes and activates');
  await wait(150);
  if (lastS(r.b).fr < 9) fail('Mega Pellet should frighten ghosts for 10 s, got ' + lastS(r.b).fr);
  console.log('ok  Mega Pellet: ghosts blue for 10 s at level 5 (normal would be ' + M.frightDuration(5) + ' s)');

  // bomb: every ghost out of the box becomes eyes
  await wait(2500);
  await trigger(r, 'bomb'); await until(r.b, m => m.t === 'puon', 5000); await wait(120);
  if (lastS(r.b).g.some(g => g[3] === 1 || g[3] === 2)) fail('Just A Lil Bomb should send every active ghost home');
  console.log('ok  Just A Lil Bomb: all ghosts sent back to the box');

  // phone a ghost: one more ghost, gone after 20 s (we just check it arrives and is flagged)
  const n0 = lastS(r.b).g.length;
  await trigger(r, 'phone'); await until(r.b, m => m.t === 'puon', 5000); await wait(120);
  const gs = lastS(r.b).g;
  if (gs.length !== n0 + 1 || !gs[gs.length - 1][5]) fail('Phone A Ghost should add one flagged ghost');
  if (!lastS(r.b).fx.some(f => M.POWERUPS[f[0]].id === 'phone' && f[1] > 19)) fail('phone effect should run 20 s');
  console.log('ok  Phone A Ghost: an extra ghost joins for 20 s');

  // timed effects are shared with everyone, with who opened the crate
  await trigger(r, 'reverse'); await until(r.b, m => m.t === 'puon', 5000); await wait(120);
  const rev = lastS(r.b).fx.find(f => M.POWERUPS[f[0]].id === 'reverse');
  if (!rev || rev[2] !== r.a.last.welcome.id || rev[1] < 14) fail('Reverse should run 15 s and name the opener');
  console.log('ok  Reverse Controls: 15 s for the opener (others stop at 10 s client-side)');

  // laser: eat a pellet far down a straight corridor
  const lz = await room('pu-laser', 3);
  await trigger(lz, 'laser'); await until(lz.b, m => m.t === 'puon', 5000);
  const lv = lz.lv, y = lv.sy;
  let far = -1; for (let x = lv.sx + 1; x < lv.W && lv.t[y * lv.W + x] === 0; x++) if (lv.p[y * lv.W + x] === 1 && x - lv.sx >= 4) far = y * lv.W + x;
  if (far < 0) { let x = lv.sx; for (; x >= 0 && lv.t[y * lv.W + x] === 0; x--) if (lv.p[y * lv.W + x] === 1 && lv.sx - x >= 4) far = y * lv.W + x; }
  if (far >= 0) {
    const sc0 = lastS(lz.b).p.find(p => p[0] === lz.a.last.welcome.id)[5];
    send(lz.a, { t: 'eat', i: [far], x: lv.sx, y: lv.sy, f: 0 }); await wait(250);
    const sc1 = lastS(lz.b).p.find(p => p[0] === lz.a.last.welcome.id)[5];
    if (sc1 !== sc0 + 10) fail('a laser should eat a pellet down a clear corridor');
    console.log('ok  Laser Beamz: eats a pellet ' + Math.abs((far % lv.W) - lv.sx) + ' tiles down the corridor');
  } else console.log('ok  Laser Beamz: (no long corridor from spawn on this seed; skipped distance check)');

  // nuke: stays paused, then the level is passed
  const nk = await room('pu-nuke', 4);
  await trigger(nk, 'nuke');
  await until(nk.b, m => m.t === 'nuke', 6000);
  if (lastS(nk.b).ph !== 5 && lastS(nk.b).ph !== 4) fail('nuke keeps the game paused');
  await until(nk.b, m => m.t === 's' && m.ph === 1, 6000);
  console.log('ok  Nuke: stays paused through the blast, then the level is passed');

  // only the opener's crate exists once; a second grab does nothing
  const one = await room('pu-once', 3);
  send(one.a, { t: 'testcrate', kind: idx('quake') });
  const cr = await until(one.b, m => m.t === 'crate');
  send(one.a, { t: 'grab', id: cr.id }); send(one.b, { t: 'grab', id: cr.id });
  await wait(400);
  if (one.b.msgs.filter(m => m.t === 'pu').length !== 1) fail('a crate can only be opened once');
  console.log('ok  a crate can only be opened once');

  console.log('\nAll power-up tests passed.');
  srv.kill(); process.exit(0);
})().catch(e => fail(e.stack));
