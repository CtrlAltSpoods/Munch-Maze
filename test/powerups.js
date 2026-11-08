'use strict';
/* Power-ups: crates, the paused slot reveal, and what each one does on the server. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const M = require('../shared/maze.js');
const PORT = 20000 + (Math.random() * 1000 | 0), DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-pu-'));
let srv;
const fail = msg => { console.error('FAIL:', msg); try { srv.kill(); } catch (e) { /* ignore */ } process.exit(1); };
setTimeout(() => fail('timed out'), 200000);
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
  const a = await client('host', seed), b = await client('guest', seed, { room: a.last.welcome.gid });
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
  await until(r.b, m => m.t === 'vote');
  send(r.a, { t: 'vote', y: true }); send(r.b, { t: 'vote', y: true });
  const pu = await until(r.b, m => m.t === 'pu');
  if (M.POWERUPS[pu.kind].id !== id) fail('expected ' + id);
  return pu;
}

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TEST_HOOKS: '1', TEST_MODE: 'true' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  if (!rev || rev[2] !== r.a.last.welcome.id || rev[1] < 5 || rev[1] > 6.01) fail('Reverse should run 6 s and name the opener');
  console.log('ok  Reverse Controls: 6 s for everyone');

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
  // the beam also zaps ghosts: sweep it round until one crosses it
  let zap = null;
  for (let k = 0; k < 60 && !zap; k++) { send(lz.a, { t: 'p', x: lv.sx, y: lv.sy, f: k % 4 }); await wait(140); zap = lz.b.msgs.find(m => m.t === 'zap'); }
  if (!zap) fail('a laser should zap a ghost on the beam');
  await until(lz.b, m => m.t === 's' && m.g.some(g => g[3] === 3), 1500);   // a zapped ghost goes home as eyes
  console.log('ok  Laser Beamz: zaps ghosts on the beam (sent home as eyes)');

  // nuke: stays paused, then the level is passed
  const nk = await room('pu-nuke', 4);
  await trigger(nk, 'nuke');
  const warn = await until(nk.b, m => m.t === 'nukewarn', 6000);
  await wait(300);
  const sw = lastS(nk.b);
  if (sw.ph !== 0 || !(sw.nk > M.NUKE_WARN - 1 && sw.nk <= M.NUKE_WARN)) fail('after the slot, play resumes with a ' + M.NUKE_WARN + ' s survival countdown');
  if (warn.s !== M.NUKE_WARN) fail('nukewarn should carry the countdown');
  const t0n = Date.now();
  await until(nk.b, m => m.t === 'nuke', (M.NUKE_WARN + 3) * 1000);
  const waited = (Date.now() - t0n) / 1000 + 0.3;
  if (waited < M.NUKE_WARN - 1) fail('the nuke arrived early (' + waited.toFixed(1) + ' s)');
  await wait(200);
  if (lastS(nk.b).ph !== 5) fail('the jet and blast keep the game paused');
  if (lastS(nk.b).nk) fail('countdown cleared once the nuke arrives');
  await until(nk.b, m => m.t === 's' && m.ph === 1, (M.NUKE_TIME + 2) * 1000);
  console.log('ok  Nuke: ' + M.NUKE_WARN + ' s survival countdown with play running, then a paused ' + M.NUKE_TIME + ' s strike, then the level is passed');

  // TEST_MODE: the host picks an effect; it goes through the paused slot with no randomness
  const tm = await room('pu-testmode', 3);
  if (!tm.a.last.welcome.testMode) fail('welcome should say test mode is on');
  tm.a.msgs.length = 0; tm.b.msgs.length = 0;
  send(tm.b, { t: 'testpu', kind: idx('bomb') }); await wait(300);
  if (tm.b.msgs.some(m => m.t === 'pu')) fail('only the host can fire test effects');
  for (const id of ['quake', 'autopilot', 'phone']) {
    send(tm.a, { t: 'testpu', kind: idx(id) });
    const tpu = await until(tm.b, m => m.t === 'pu' && m.test);
    if (M.POWERUPS[tpu.kind].id !== id) fail('test effect should be exactly the one picked');
    await wait(150); if (lastS(tm.b).ph !== 4) fail('test effect should pause for the slot');
    await until(tm.b, m => m.t === 'puon' && M.POWERUPS[m.kind].id === id, 6000);
    tm.b.msgs.length = 0; await wait(200);
  }
  console.log('ok  TEST_MODE: host-picked effects pause for the slot, land on the pick, then activate');

  // crate votes: the game pauses, everyone votes, and the slot only spins on a yes
  const vr = await room('pu-vote', 3);
  const crate = async () => {
    vr.a.msgs.length = 0; vr.b.msgs.length = 0;
    send(vr.a, { t: 'testcrate', kind: idx('quake') });
    const c = await until(vr.b, m => m.t === 'crate');
    send(vr.a, { t: 'grab', id: c.id });
    const v = await until(vr.b, m => m.t === 'vote');
    if (v.s !== M.VOTE_TIME || v.tot !== 2) fail('vote should carry the time limit and player count');
    await wait(150);
    if (lastS(vr.b).ph !== 6) fail('the game is paused (phase 6) while voting');
    if (vr.b.msgs.some(m => m.t === 'pu')) fail('the slot must not start before the vote ends');
  };
  await crate();
  send(vr.a, { t: 'vote', y: true }); send(vr.b, { t: 'vote', y: false });   // 1-1 tie opens it
  if (!(await until(vr.b, m => m.t === 'voted')).open) fail('a tie opens the crate');
  await until(vr.b, m => m.t === 'pu');
  await until(vr.b, m => m.t === 'puon', 6000);
  console.log('ok  crate vote: paused while voting; a tie opens it and the slot spins');
  await crate();
  send(vr.a, { t: 'vote', y: false }); await wait(150);
  const tally = vr.b.msgs.find(m => m.t === 'vt');
  if (!tally || tally.n !== 1 || tally.y !== 0) fail('votes are tallied live for everyone');
  send(vr.a, { t: 'vote', y: true }); send(vr.a, { t: 'vote', y: false });   // changing your mind is fine; last vote counts
  send(vr.b, { t: 'vote', y: false });
  const res = await until(vr.b, m => m.t === 'voted');
  if (res.open || res.n !== 2) fail('a no majority bins the crate');
  await wait(400);
  if (vr.b.msgs.some(m => m.t === 'pu' || m.t === 'puon')) fail('a binned crate never spins or activates');
  if (lastS(vr.b).ph !== 0 || lastS(vr.b).c.length) fail('play resumes and the crate is gone');
  console.log('ok  crate vote: a no majority bins the crate without spinning, play resumes');

  // only the opener's crate exists once; a second grab does nothing
  const one = await room('pu-once', 3);
  send(one.a, { t: 'testcrate', kind: idx('quake') });
  const cr = await until(one.b, m => m.t === 'crate');
  send(one.a, { t: 'grab', id: cr.id }); send(one.b, { t: 'grab', id: cr.id });
  await wait(300);
  if (one.b.msgs.filter(m => m.t === 'vote').length !== 1) fail('a crate can only be opened once');
  console.log('ok  a crate can only be opened once');

  console.log('\nAll power-up tests passed.');
  srv.kill(); process.exit(0);
})().catch(e => fail(e.stack));
