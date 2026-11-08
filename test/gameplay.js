'use strict';
/* Gameplay additions: daily maze, boss levels, versus teams and bumps, revives, bonus fruit,
   and the Magnet / Ghost Swap / Freeze items on the server. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const M = require('../shared/maze.js');
const PORT = 21000 + (Math.random() * 900 | 0), DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-gp-'));
let srv;
const fail = msg => { console.error('FAIL:', msg); try { srv.kill(); } catch (e) { /* ignore */ } process.exit(1); };
setTimeout(() => fail('timed out'), 120000);
const wait = ms => new Promise(r => setTimeout(r, ms));
const idx = id => M.POWERUPS.findIndex(p => p.id === id);
function client(name, extra = {}) {
  return new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`), c = { ws, msgs: [], last: {} };
    ws.onopen = () => ws.send(JSON.stringify(Object.assign({ t: 'join', nm: name, tok: name + Math.random() }, extra)));
    ws.onmessage = e => { const m = JSON.parse(e.data); c.msgs.push(m); c.last[m.t] = m; if (m.t === 'welcome' || m.t === 'error') res(c); };
  });
}
const send = (c, o) => { if (o.t === 'p') c.pos = [o.x, o.y]; c.ws.send(JSON.stringify(o)); };
const until = async (c, pred, ms = 6000, what = 'message') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = c.msgs.find(pred); if (m) return m; await wait(30); } fail('timed out waiting for ' + what); };
async function room(level, extra = {}) {
  const a = await client('host', extra), b = await client('guest', { room: a.last.welcome.gid });
  if (level > 1) { send(a, { t: 'startlv', lv: level }); await wait(150); }
  send(a, { t: 'ready' }); await until(b, m => m.t === 'level' && m.ph === 0, 6000, 'level start');
  const lv = M.genLevel(a.last.welcome.seed, level);
  for (const c of [a, b]) send(c, { t: 'p', x: lv.sx, y: lv.sy, f: 0 });
  await wait(100);
  return { a, b, lv };
}
async function power(r, id) {
  send(r.a, { t: 'testcrate', kind: idx(id) });
  const cr = await until(r.b, m => m.t === 'crate' && m.x === Math.round(r.a.pos[0]) && m.y === Math.round(r.a.pos[1]) && !m.seen && (m.seen = true), 6000, 'crate');   // ours, not a natural one
  send(r.a, { t: 'grab', id: cr.id });
  await until(r.b, m => m.t === 'vote' && m.crate === cr.id, 6000, 'vote');
  send(r.a, { t: 'vote', y: true }); send(r.b, { t: 'vote', y: true });
  return until(r.b, m => m.t === 'puon' && M.POWERUPS[m.kind].id === id && !m.seen && (m.seen = true), 8000, id);
}

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TEST_HOOKS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (/listening/.test(d)) r(); }));

  // daily maze: today's seed, always level 1, its own board
  const d = await client('daily', { daily: true });
  const today = new Date(), key = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  if (d.last.welcome.seed !== 'daily-' + key || d.last.welcome.daily !== key) fail('daily maze uses today’s seed: ' + d.last.welcome.seed);
  send(d, { t: 'startlv', lv: 5 }); await wait(250);
  if (d.msgs.some(m => m.t === 'level' && m.lv !== 1)) fail('the daily maze always starts at level 1');
  const d2 = await client('daily2', { daily: true });
  if (d2.last.welcome.gid === d.last.welcome.gid || d2.last.welcome.seed !== d.last.welcome.seed) fail('each daily run is its own game on the same seed');
  console.log('ok  daily maze: today’s seed for everyone, level 1, separate games');

  // boss level
  const bz = await room(10);
  await wait(3500);
  const bs = bz.b.last.s, boss = bs.g[0];
  if (!M.isBossLevel(10) || boss[6] !== 1 || boss[7] !== M.BOSS_HP || bs.g.length !== 3) fail('level 10 has a boss with ' + M.BOSS_HP + ' hits and two minions: ' + JSON.stringify(bs.g));
  await until(bz.b, m => m.t === 's' && Array.isArray(m.bl) && m.bl.length, 8000, 'boss fireball');
  console.log('ok  boss level: giant ghost, 3 hits, fires at players');
  await power(bz, 'megapellet');
  await until(bz.b, m => m.t === 's' && m.g[0][3] === 2, 3000, 'frightened boss');
  const fb = bz.b.last.s.g[0];
  send(bz.a, { t: 'p', x: fb[0], y: fb[1], f: 0 }); await wait(60);
  send(bz.a, { t: 'ghost', i: 0, ep: fb[4] });
  const hit = await until(bz.b, m => m.t === 'boss', 2000, 'boss hit');
  if (hit.hp !== M.BOSS_HP - 1) fail('a hit takes one off the boss');
  await wait(200);
  if (bz.b.last.s.g.length !== 5) fail('the boss splits into two more ghosts when hit');
  console.log('ok  eating a frightened boss takes a hit and splits it');

  // fruit
  const fr = await room(4);
  send(fr.a, { t: 'testfruit' });
  const f = await until(fr.b, m => m.t === 'fruit', 2000, 'fruit');
  const before = fr.a.last.s ? fr.a.last.s.p.find(p => p[0] === fr.a.last.welcome.id)[5] : 0;
  send(fr.a, { t: 'p', x: f.x, y: f.y, f: 0 }); await wait(60); send(fr.a, { t: 'fruit', id: f.id });
  const got = await until(fr.b, m => m.t === 'fruitgot', 2000, 'fruit grab');
  if (got.v !== M.FRUITS[M.fruitFor(4)].pts) fail('fruit worth its level value');
  await wait(150);
  if (fr.a.last.s.p.find(p => p[0] === fr.a.last.welcome.id)[5] !== before + got.v || fr.b.last.s.ft) fail('fruit scores once and disappears');
  console.log('ok  bonus fruit: appears, scores ' + got.v + ', disappears');

  // revive
  const rv = await room(1);
  await wait(1700);
  send(rv.a, { t: 'die' });
  const down = await until(rv.b, m => m.t === 'down', 2000, 'down marker');
  send(rv.b, { t: 'p', x: down.x, y: down.y, f: 0 }); await wait(60); send(rv.b, { t: 'revive', id: down.id });
  await until(rv.a, m => m.t === 'revived', 2000, 'revived');
  await wait(150);
  const ra = rv.a.last.s.p.find(p => p[0] === rv.a.last.welcome.id);
  if (ra[6] !== 3 || ra[4] !== 1) fail('revived: alive with the life given back: ' + JSON.stringify(ra));
  console.log('ok  revive: a teammate touching your marker brings you back with your life');

  // versus
  const vs = await room(1, { mode: 'versus' });
  const ros = vs.b.last.welcome.roster;
  if (vs.a.last.welcome.mode !== 'versus' || ros.length !== 2 || ros[0][7] === ros[1][7]) fail('versus splits players into two teams');
  const L = vs.lv; let tx = L.sx, ty = L.sy;   // stand side by side: host charging right into the guest
  send(vs.a, { t: 'p', x: tx, y: ty, f: 0 }); send(vs.b, { t: 'p', x: tx + 1, y: ty, f: 0 }); await wait(80);
  send(vs.a, { t: 'bump', id: vs.b.last.welcome.id });
  const bumped = await until(vs.b, m => m.t === 'bumped', 2000, 'bump');
  if (bumped.by !== vs.a.last.welcome.id) fail('the one charging in steals');
  send(vs.b, { t: 'give', n: 5 });
  await until(vs.a, m => m.t === 'steal', 2000, 'steal');
  if (!Array.isArray(vs.a.last.s.tm)) fail('versus state carries team pellet counts');
  console.log('ok  versus: two teams, charging into an opponent steals their streak, team counts in state');

  // new items
  const it = await room(3);
  await wait(1500);
  await power(it, 'freeze');
  const g0 = it.b.last.s.g.map(g => g[0] + ',' + g[1]).join(); await wait(800);
  if (it.b.last.s.g.map(g => g[0] + ',' + g[1]).join() !== g0) fail('frozen ghosts don’t move');
  console.log('ok  Freeze: ghosts stand still');
  await wait(6000);
  await power(it, 'swap');
  const sw = await until(it.a, m => m.t === 'swapto', 2000, 'swap');
  if (!Number.isInteger(sw.x) || !Number.isInteger(sw.y)) fail('swap sends the opener to a tile');
  send(it.a, { t: 'p', x: sw.x, y: sw.y, f: 0 }); await wait(60);   // the client follows the swap
  console.log('ok  Ghost Swap: the opener is moved to the nearest ghost’s spot');
  await power(it, 'magnet');
  console.log('ok  Magnet activates (pellets within reach count while it lasts)');

  // emotes (rate limited) and cheers (only once you're out)
  const em = await room(1);
  send(em.a, { t: 'emo', e: 2 }); send(em.a, { t: 'emo', e: 1 }); send(em.a, { t: 'emo', e: 9 });
  await wait(300);
  const emos = em.b.msgs.filter(m => m.t === 'emo');
  if (emos.length !== 1 || emos[0].e !== 2) fail('one emote per 1.2 s, valid ones only: ' + JSON.stringify(emos));
  send(em.a, { t: 'cheer', e: 0 }); await wait(200);
  if (em.b.msgs.some(m => m.t === 'cheer')) fail('only players who are out can cheer');
  await wait(1600); send(em.a, { t: 'die' }); await wait(100);   // down: spectating until the next level
  await wait(200); send(em.a, { t: 'cheer', e: 1 });
  const ch = await until(em.b, m => m.t === 'cheer', 2000, 'cheer');
  if (ch.e !== 1 || ch.nm !== 'host') fail('cheer carries who and which');
  send(em.a, { t: 'respawn' }); await wait(200);
  if (em.b.last.s.p.find(p => p[0] === em.a.last.welcome.id)[4] !== 0) fail('no respawning mid-level');
  console.log('ok  emotes are rate limited; players who are down can cheer; no respawning mid-level');

  // a crate vote can revive the fallen (third option when someone's down)
  em.a.msgs.length = 0; em.b.msgs.length = 0;
  send(em.b, { t: 'testcrate', kind: idx('quake') });
  const rc = await until(em.a, m => m.t === 'crate', 3000, 'crate');
  send(em.b, { t: 'grab', id: rc.id });
  const rvote = await until(em.a, m => m.t === 'vote', 3000, 'vote');
  if (rvote.rv !== 1) fail('the vote offers a revive when someone is down');
  send(em.a, { t: 'vote', r: true }); send(em.b, { t: 'vote', y: true });   // 1-1: revive wins ties
  const rres = await until(em.a, m => m.t === 'voted', 3000, 'voted');
  if (!rres.revive || rres.r !== 1) fail('revive wins a tie: ' + JSON.stringify(rres));
  await until(em.a, m => m.t === 'revived', 2000, 'revived');
  await wait(150);
  if (em.b.last.s.p.find(p => p[0] === em.a.last.welcome.id)[4] !== 1 || em.b.msgs.some(m => m.t === 'pu')) fail('revived, and no slot spins');
  console.log('ok  crate vote: “revive the fallen” brings everyone back instead of opening it');

  // everyone down: the level starts again
  await wait(1700); send(em.a, { t: 'die' }); send(em.b, { t: 'die' });
  const wipe = await until(em.b, m => m.t === 'wipe', 3000, 'wipe');
  await until(em.b, m => m.t === 'level' && m.lv === wipe.lv && m.ph === 0, 3000, 'restart');
  console.log('ok  team wipe: everyone down restarts the level');

  console.log('\nAll gameplay tests passed.');
  srv.kill(); process.exit(0);
})().catch(e => fail(e.stack));
