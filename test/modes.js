'use strict';
/* Maze themes, host challenge modifiers (score bonus, one life, no big pellets) and co-op roles. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const M = require('../shared/maze.js');
const PORT = 22000 + (Math.random() * 900 | 0), DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'munch-modes-'));
let srv;
const fail = msg => { console.error('FAIL:', msg); try { srv.kill(); } catch (e) { /* ignore */ } fs.rmSync(DATA, { recursive: true, force: true }); process.exit(1); };
setTimeout(() => fail('timed out'), 90000);
const wait = ms => new Promise(r => setTimeout(r, ms));
function client(name, extra = {}) {
  return new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`), c = { ws, msgs: [], last: {} };
    ws.onopen = () => ws.send(JSON.stringify(Object.assign({ t: 'join', nm: name, tok: name + Math.random() }, extra)));
    ws.onmessage = e => { const m = JSON.parse(e.data); c.msgs.push(m); c.last[m.t] = m; if (m.t === 'welcome' || m.t === 'error') res(c); };
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const until = async (c, pred, ms = 6000, what = 'message') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = c.msgs.find(pred); if (m) return m; await wait(30); } fail('timed out waiting for ' + what); };
const me = c => c.last.s.p.find(r => r[0] === c.last.welcome.id);

/* shared rules */
if (M.themeFor(1).id !== 'neon' || M.themeFor(10).id !== 'neon' || M.themeFor(11).id !== 'ice' || M.themeFor(21).id !== 'lava' || M.themeFor(31).id !== 'deep' || M.themeFor(41).id !== 'space' || M.themeFor(51).id !== 'neon') fail('themes change every 10 levels and cycle');
if (M.modMult(0) !== 1 || M.modMult(1) !== 1.5 || M.modMult(M.MODS_ALL) !== 2.25) fail('modifier multipliers');
console.log('ok  themes every 10 levels; modifier score bonuses');

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TEST_HOOKS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (/listening/.test(d)) r(); }));

  // only the host, only in the lobby
  const a = await client('host', { seed: 'mods-1' }), b = await client('guest', { room: a.last.welcome.gid });
  send(b, { t: 'setup', mods: 15 }); await wait(150);
  if (b.last.setup) fail('only the host can pick modifiers');
  send(a, { t: 'setup', mods: 1 | 4 }); await until(b, m => m.t === 'setup' && m.mods === 5, 3000, 'setup');
  send(a, { t: 'ready' }); await until(b, m => m.t === 'level' && m.ph === 0, 6000, 'start');
  await until(a, m => m.t === 's' && m.ph === 0);
  await wait(200);
  if (me(a)[6] !== 1 || me(b)[6] !== 1) fail('one life: everyone starts with 1 life: ' + JSON.stringify(a.last.s.p));
  send(a, { t: 'setup', mods: 0 }); await wait(150);
  if (a.msgs.some(m => m.t === 'setup' && m.mods === 0)) fail('modifiers lock once the game starts');
  console.log('ok  host-only, lobby-only modifiers; One life gives everyone a single life');

  // score bonus (×1.75 here) and big pellets are just pellets
  const lv = M.genLevel(a.last.welcome.seed, 1), d = i => Math.abs(i % lv.W - lv.sx) + Math.abs(((i / lv.W) | 0) - lv.sy);
  const dot = lv.pList.find(i => lv.p[i] === 1 && d(i) <= 2);
  send(a, { t: 'eat', i: [dot], x: lv.sx, y: lv.sy, f: 0 }); await wait(250);
  if (me(a)[5] !== Math.round(10 * 1.75)) fail('a pellet scores 10 × 1.75 = 18: ' + me(a)[5]);
  const big = lv.pList.find(i => lv.p[i] === 2);
  send(a, { t: 'p', x: big % lv.W, y: (big / lv.W) | 0, f: 0 }); await wait(80);
  send(a, { t: 'eat', i: [big], x: big % lv.W, y: (big / lv.W) | 0, f: 0 }); await wait(250);
  if (me(a)[5] !== 36 || a.msgs.some(m => m.t === 'pw') || a.last.s.fr > 0) fail('no big pellets: worth a plain pellet, no fright: ' + me(a)[5]);
  console.log('ok  modifiers boost scores (×1.75) and No big pellets makes them plain');

  // one life: one death and you're out, and the run goes on the board with its modifiers
  await wait(1400);
  send(a, { t: 'die' }); await wait(250);
  if (me(a)[7] !== 1) fail('one life: one hit and you’re out');
  const sc = await (await fetch(`http://127.0.0.1:${PORT}/api/scores?board=week`)).json();
  if (!sc.some(r => r.n === 'host' && r.mods === 5)) fail('scores keep the modifiers they were set with: ' + JSON.stringify(sc));
  a.ws.close(); b.ws.close();
  console.log('ok  One life ends the run at the first hit; the board shows the modifiers');

  // the daily maze can't be modded
  const dly = await client('daily', { daily: true });
  send(dly, { t: 'setup', mods: 3 }); await until(dly, m => m.t === 'setup');
  if (dly.last.setup.mods !== 0) fail('no modifiers on the daily maze');
  dly.ws.close();

  // roles: co-op only, host toggles, players pick
  const vs = await client('vhost', { mode: 'versus', seed: 'roles-v' });
  send(vs, { t: 'setup', roles: true }); await until(vs, m => m.t === 'setup');
  if (vs.last.setup.roles) fail('no roles in versus');
  vs.ws.close();
  const h = await client('h', { seed: 'roles-1' }), medic = await client('medic', { room: h.last.welcome.gid }), tank = await client('tank', { room: h.last.welcome.gid });
  send(medic, { t: 'role', r: 3 }); await wait(150);
  if (medic.msgs.some(m => m.t === 'role')) fail('can’t pick a role until the host turns them on');
  send(h, { t: 'setup', roles: true }); await until(medic, m => m.t === 'setup' && m.roles === 1);
  send(medic, { t: 'role', r: 3 }); send(tank, { t: 'role', r: 2 });
  await until(h, m => m.t === 'role' && m.r === 3); await until(h, m => m.t === 'role' && m.r === 2);
  const late = await client('late', { room: h.last.welcome.gid });
  const row = late.last.welcome.roster.find(r => r[1] === 'medic');
  if (row[11] !== 3 || late.last.welcome.roles !== 1) fail('roles are in the roster for late joiners');
  console.log('ok  roles: co-op only, host switch, everyone picks (Medic, Tank)');

  send(h, { t: 'ready' }); await until(medic, m => m.t === 'level' && m.ph === 0);
  const lv2 = M.genLevel(h.last.welcome.seed, 1);
  await wait(1700);
  // h goes down at the spawn; a Medic 2.5 tiles away can bring them back, a plain player can't
  for (const c of [h, medic, tank, late]) send(c, { t: 'p', x: lv2.sx, y: lv2.sy, f: 0 });
  await wait(80);
  send(h, { t: 'die' }); await until(late, m => m.t === 'down');
  send(late, { t: 'p', x: lv2.sx + 2.5, y: lv2.sy, f: 0 }); await wait(80);
  send(late, { t: 'revive', id: h.last.welcome.id }); await wait(200);
  if (h.msgs.some(m => m.t === 'revived')) fail('a non-medic must be next to the marker');
  send(medic, { t: 'p', x: lv2.sx + 2.5, y: lv2.sy, f: 0 }); await wait(80);
  send(medic, { t: 'revive', id: h.last.welcome.id });
  await until(h, m => m.t === 'revived', 3000, 'medic revive');
  console.log('ok  a Medic revives from 2.5 tiles away; others have to touch the marker');

  send(tank, { t: 'shield' }); await until(h, m => m.t === 'shield');
  const n = h.msgs.filter(m => m.t === 'shield').length;
  send(tank, { t: 'shield' }); send(medic, { t: 'shield' }); await wait(200);
  if (h.msgs.filter(m => m.t === 'shield').length !== n) fail('one shield per level, tanks only');
  console.log('ok  a Tank’s shield works once a level');

  // reconnect grace: drop while down, come back: same place, still down (no free respawn)
  const drop = await client('drop', { room: h.last.welcome.gid, tok: 'drop-tok' });
  await wait(1700);
  send(drop, { t: 'die' }); await until(h, m => m.t === 'down' && m.id === drop.last.welcome.id);
  drop.ws.close(); await until(h, m => m.t === 'away' && m.id === drop.last.welcome.id, 3000, 'away');
  const back = await client('drop', { room: h.last.welcome.gid, tok: 'drop-tok' });
  if (back.last.welcome.id !== drop.last.welcome.id || !back.last.welcome.you || back.last.welcome.you.al !== 0) fail('a dropped player comes back to the same place, still down: ' + JSON.stringify(back.last.welcome.you));
  await until(h, m => m.t === 'back' && m.id === drop.last.welcome.id, 3000, 'back');
  console.log('ok  reconnect grace: same player, same state (down stays down)');

  srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log('\nAll modifier, role and theme tests passed.');
  process.exit(0);
})().catch(e => fail(e.stack || e.message));
