'use strict';
/* Player levels, XP, daily/weekly challenges and cosmetic unlocks (trails, exit effects). */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const M = require('../shared/maze.js');
const DB = require('../server/db.js');

const PORT = 18000 + Math.floor(Math.random() * 900), FAKE = PORT + 1000;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-prog-'));
const base = `http://127.0.0.1:${PORT}`;
let srv, fake;
const fail = msg => { console.error('FAIL:', msg); cleanup(1); };
function cleanup(code) { try { srv.kill(); } catch (e) { /* ignore */ } try { fake.close(); } catch (e) { /* ignore */ } fs.rmSync(DATA, { recursive: true, force: true }); process.exit(code); }
setTimeout(() => fail('timed out'), 40000);

/* ---------- shared rules ---------- */
if (M.playerLevel(0) !== 1 || M.playerLevel(99) !== 1 || M.playerLevel(100) !== 2 || M.playerLevel(M.xpFor(10)) !== 10 || M.playerLevel(1e12) !== M.MAX_PLEVEL) fail('level curve');
if (M.pickCosmetic(M.TRAILS, 3, 9) !== 0 || M.pickCosmetic(M.TRAILS, 3, 10) !== 3 || M.pickCosmetic(M.TRAILS, 99, 100) !== 0 || M.pickCosmetic(M.DEATHFX, -1, 50) !== 0) fail('cosmetics unlock by level');
{
  const a = M.challengesFor('day:2026-11-08'), b = M.challengesFor('day:2026-11-08'), c = M.challengesFor('week:2026-W45');
  if (JSON.stringify(a) !== JSON.stringify(b) || a.length !== 3 || new Set(a.map(x => x.id)).size !== 3) fail('daily challenges are 3, distinct, and the same for everyone');
  if (c.length !== 3 || c.some(x => !(x.goal > 0))) fail('weekly challenges');
  const days = new Set(); for (let d = 1; d <= 20; d++) days.add(M.challengesFor('day:2026-11-' + String(d).padStart(2, '0')).map(x => x.id).join());
  if (days.size < 5) fail('challenges should change from day to day');
}
console.log('ok  level curve, unlock rules and challenge picks');

/* ---------- storage ---------- */
{
  const db = DB.open(':memory:');
  const a = db.loginDiscord('100000000000000009', 'Tess');
  if (db.getXp(a.uid) !== 0) fail('new accounts start at 0 XP');
  const r = db.addXp(a.uid, 250); if (r.before !== 0 || r.after !== 250) fail('addXp');
  if (db.bumpChallenge(a.uid, 'day:x', 'pellets', 'sum', 600, 1500)) fail('not done yet');
  if (!db.bumpChallenge(a.uid, 'day:x', 'pellets', 'sum', 900, 1500)) fail('sum challenge completes at the goal');
  if (db.bumpChallenge(a.uid, 'day:x', 'pellets', 'sum', 900, 1500)) fail('a done challenge only completes once');
  if (db.bumpChallenge(a.uid, 'day:x', 'streak', 'max', 40, 60) || db.bumpChallenge(a.uid, 'day:x', 'streak', 'max', 30, 60)) fail('max: not yet');
  if (db.challengeProgress(a.uid, 'day:x').find(p => p.cid === 'streak').value !== 40) fail('max keeps the best');
  if (!db.bumpChallenge(a.uid, 'day:x', 'streak', 'max', 61, 60)) fail('max challenge completes');
  db.purgeProgress('day:y', 'week:y'); if (db.challengeProgress(a.uid, 'day:x').length) fail('old periods are purged');
  if (db.profile(a.uid).xp !== 250) fail('profile shows XP');
  db.close();
}
console.log('ok  XP and challenge progress are stored');

/* ---------- end to end ---------- */
const USERS = { alice: { id: '100000000000000001', username: 'alice_d', global_name: 'Alice' } };
fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (req.url === '/oauth2/token') { const f = new URLSearchParams(body); res.end(JSON.stringify({ access_token: 'tok-' + f.get('code'), token_type: 'Bearer' })); return; }
    if (req.url === '/oauth2/token/revoke') { res.end('{}'); return; }
    if (req.url === '/users/@me') { const u = USERS[String(req.headers.authorization).replace('Bearer tok-', '')]; res.writeHead(u ? 200 : 401); res.end(JSON.stringify(u || {})); return; }
    res.writeHead(404); res.end();
  });
}).listen(FAKE);
const get = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const cookieFrom = (res, name) => { for (const c of res.headers.getSetCookie()) if (c.startsWith(name + '=')) return c.split(';')[0]; return ''; };
async function login(code) {
  const start = await get('/auth/discord');
  const loc = new URL(start.headers.get('location')), st = cookieFrom(start, 'mm_oauth');
  const cb = await get(`/auth/discord/callback?code=${code}&state=${loc.searchParams.get('state')}`, st);
  return cookieFrom(cb, 'mm_session');
}
function client(join, cookie) {
  return new Promise(res => {
    const c = { msgs: [], last: {} };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined);
    c.ws = ws; c.send = o => ws.send(JSON.stringify(o));
    c.wait = (pred, ms = 8000) => new Promise((ok, no) => { const f = c.msgs.find(pred); if (f) return ok(f); const t = setTimeout(() => no(new Error('waited too long')), ms); c.waiters.push([pred, m => { clearTimeout(t); ok(m); }]); });
    c.waiters = [];
    ws.onopen = () => c.send(Object.assign({ t: 'join', tok: 'tok' + Math.random() }, join));
    ws.onmessage = e => { const m = JSON.parse(e.data); c.msgs.push(m); c.last[m.t] = m; for (const w of c.waiters.slice()) if (w[0](m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w[1](m); } if (m.t === 'welcome') res(c); };
  });
}
const dayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DISCORD_CLIENT_ID: '424242', DISCORD_CLIENT_SECRET: 'app-secret',
      DISCORD_API: `http://127.0.0.1:${FAKE}`, DISCORD_AUTHORIZE: `http://127.0.0.1:${FAKE}/authorize`, TEST_HOOKS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (/listening/.test(d)) r(); }));
  const session = await login('alice');
  if (!session) fail('login');

  // level 1: asking for locked cosmetics gets the defaults
  const a = await client({ nm: 'x', trail: 3, dfx: 2, seed: 'prog-test' }, session);
  const me = a.last.welcome.roster.find(r => r[0] === a.last.welcome.id);
  if (me[8] !== 0 || me[9] !== 0 || me[10] !== 1) fail('level 1 gets the default trail and exit effect: ' + JSON.stringify(me));
  console.log('ok  locked trails and exit effects are refused at join');

  // eat real pellets next to the spawn: XP arrives a few seconds later
  a.send({ t: 'ready' }); await a.wait(m => m.t === 'level' && m.ph === 0);
  const lv = M.genLevel(a.last.welcome.seed, 1), near = lv.pList.filter(i => Math.abs(i % lv.W - lv.sx) + Math.abs(((i / lv.W) | 0) - lv.sy) <= 2);
  a.send({ t: 'eat', i: near, x: lv.sx, y: lv.sy, f: 0 });
  const xp1 = await a.wait(m => m.t === 'xp');
  if (xp1.gain !== near.length || xp1.xp !== near.length) fail('1 XP per pellet: ' + JSON.stringify(xp1) + ' ate ' + near.length);
  console.log('ok  pellets turn into XP (' + near.length + ' XP), sent within a few seconds');

  // a big chunk: level up, unlocks, and the "Rising Star" achievement at level 10
  a.send({ t: 'teststat', st: { clearXp: M.xpFor(10) } });
  const up = await a.wait(m => m.t === 'lvlup');
  if (up.lv < 10) fail('should reach level 10: ' + JSON.stringify(up));
  await a.wait(m => m.t === 'ach' && m.id === 'plevel10');
  const meApi = await (await get('/api/me', session)).json();
  if (M.playerLevel(meApi.user.xp) !== up.lv) fail('/api/me shows the XP');
  console.log('ok  level up to ' + up.lv + ' with the Rising Star achievement');

  // today's first challenge: do it, get the bonus and the Challenger achievement
  const today = M.challengesFor('day:' + dayKey())[0];
  const before = (await (await get('/api/challenges', session)).json());
  if (!before.loggedIn || before.day.list.length !== 3 || before.week.list.length !== 3 || before.day.list[0].id !== today.id) fail('challenge list: ' + JSON.stringify(before));
  a.send({ t: 'teststat', st: { [today.stat]: today.goal } });
  const ch = await a.wait(m => m.t === 'chal');
  if (ch.w !== 0 || ch.xp !== M.XP.daily || ch.text !== today.text) fail('daily challenge done message: ' + JSON.stringify(ch));
  await a.wait(m => m.t === 'ach' && m.id === 'chal');
  const after = await (await get('/api/challenges', session)).json();
  if (!after.day.list[0].done || after.day.list[0].value !== today.goal) fail('progress should show done: ' + JSON.stringify(after.day.list[0]));
  const guest = await (await get('/api/challenges')).json();
  if (guest.loggedIn || guest.day.list.some(c => c.value)) fail('guests see the challenges without progress');
  console.log('ok  daily challenge "' + today.text + '" completes for +' + M.XP.daily + ' XP and the Challenger achievement');
  a.ws.close();

  // now level 10+: the rainbow trail (10) and confetti exit (8) are allowed, and others see them
  const b = await client({ nm: 'x', trail: 3, dfx: 2, seed: 'prog-test-2' }, session);
  const row = b.last.welcome.roster.find(r => r[0] === b.last.welcome.id);
  if (row[8] !== 3 || row[9] !== 2 || row[10] < 10) fail('unlocked cosmetics should be kept: ' + JSON.stringify(row));
  const watcher = await client({ nm: 'Watcher', room: b.last.welcome.gid });
  const wrow = watcher.last.welcome.roster.find(r => r[0] === b.last.welcome.id);
  if (!wrow || wrow[8] !== 3 || wrow[9] !== 2) fail('other players see your trail and exit effect');
  b.send({ t: 'ready' }); await b.wait(m => m.t === 'level' && m.ph === 0);
  await new Promise(r => setTimeout(r, 1700));   // just-spawned players can't die straight away
  b.send({ t: 'die' });
  const died = await watcher.wait(m => m.t === 'died');
  if (died.id !== b.last.welcome.id || died.fx !== 2) fail('a death is broadcast with the exit effect: ' + JSON.stringify(died));
  const prof = await (await get('/api/profile?uid=' + row[6])).json();
  if (!(prof.xp >= M.xpFor(10)) || !prof.achievements.some(x => x.id === 'plevel10')) fail('profile shows XP and achievements');
  console.log('ok  unlocked trail + exit effect are used, shown to others, and played when you go down');
  cleanup(0);
})().catch(e => fail(e.stack || e.message));
