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

function client(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const c = { ws, name, msgs: [], last: {}, on: {} };
    ws.onopen = () => ws.send(JSON.stringify(Object.assign({ t: 'join', nm: name, seed: 'Smoke Test!', tok: name, lname: 'Smoke   Party' }, extra)));
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
  const css = await (await fetch(base + '/style.css')).text();
  if (!/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css)) fail('style.css must hide [hidden] elements (game-over overlay showed on load)');
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
  if (games[0].name !== 'Smoke Party') fail('lobby list should show the lobby name, got ' + games[0].name);
  if (JSON.stringify(games).includes('smoke-test')) fail('lobby list must not reveal the seed');
  if (!/^[A-Za-z0-9_-]{8}$/.test(games[0].id)) fail('lobby list entries need an opaque id');
  console.log('ok  lobby lists the maze by name, without its seed');
  const viaList = await client('carol', { seed: '', room: games[0].id, tok: 'carol' });
  if (viaList.last.welcome.seed !== 'smoke-test') fail('joining by list id should land in that maze');
  viaList.ws.close();
  await waitFor(a, 'leave');
  console.log('ok  joining from the list by id works');

  // both clients must build the same maze as the server
  const lv = M.genLevel(wa.seed, 1);
  // new mazes open in a lobby; only the host (alice) can start
  const lob = await waitFor(b, 's');
  if (lob.ph !== 3) fail('a new maze should start in the lobby (phase 3), got ' + lob.ph);
  if (!games.find(g => g.name === 'Smoke Party').lobby) fail('lobby list should mark the maze as in its lobby');
  b.ws.send(JSON.stringify({ t: 'ready' }));
  await new Promise(r => setTimeout(r, 300));
  if (b.last.s.ph !== 3) fail('a non-host must not start the game');
  // host picks a starting level in the lobby; others can't, and silly values are ignored
  b.ws.send(JSON.stringify({ t: 'startlv', lv: 4 }));
  a.ws.send(JSON.stringify({ t: 'startlv', lv: 99 }));
  await new Promise(r => setTimeout(r, 300));
  if (b.msgs.some(m => m.t === 'level' && m.lv !== 1)) fail('only the host may pick a starting level, within range');
  a.ws.send(JSON.stringify({ t: 'startlv', lv: 3 }));
  const pick = await waitFor(b, 'level', m => m.lv === 3, 3000);
  if (pick.ph !== 3) fail('picking a level must keep the maze in its lobby');
  console.log('ok  host can pick a starting level in the lobby (others cannot)');
  a.ws.send(JSON.stringify({ t: 'startlv', lv: 1 }));
  await waitFor(b, 'level', m => m.lv === 1 && m.ph === 3, 3000);
  b.msgs.length = 0;
  a.ws.send(JSON.stringify({ t: 'ready' }));
  const go = await waitFor(b, 'level', m => m.lv === 1, 3000);
  if (go.ph !== 0 || go.adv) fail('starting from the lobby should begin play without an extra life');
  console.log('ok  maze opens in a lobby; host starts the game');
  const s1 = await waitFor(b, 's', m => m.ph === 0);
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

  // after the celebration the maze waits for the host (alice joined first)
  const waiting = await waitFor(b, 's', m => m.ph === 2, 6000);
  if (waiting.h !== wa.id) fail('alice should be host');
  b.ws.send(JSON.stringify({ t: 'ready' }));
  await new Promise(r => setTimeout(r, 400));
  if (b.msgs.some(m => m.t === 'level' && m.lv === 2)) fail('a non-host must not be able to start the next level');
  if (b.last.s.ph !== 2) fail('maze should still be waiting for the host');
  console.log('ok  level waits for the host; other players cannot start it');
  a.ws.send(JSON.stringify({ t: 'ready' }));
  const lvl = await waitFor(b, 'level', m => m.lv === 2, 6000);
  const ratio = M.playerSpeed(2) / M.playerSpeed(1), gr = M.ghostSpeed(3) / M.ghostSpeed(1);
  if (Math.abs(ratio - 1.1) > 1e-9 || Math.abs(gr - 1.21) > 1e-9) fail('speed should grow 10% per level, compounding');
  console.log('ok  host started level 2; speed x' + ratio.toFixed(2) + ' (level 3: x' + gr.toFixed(2) + ')');
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
  const sAfter2 = await waitFor(b, 's', m => m.h === b.last.welcome.id, 3000);
  console.log('ok  host passed to bob when alice left');
  const a2 = await client('alice');
  if (a2.last.welcome.sc !== expected) fail('resume did not keep score');
  console.log('ok  reconnect resumed score', a2.last.welcome.sc);
  if (a2.last.welcome.host !== a2.last.welcome.id) fail('the player who started the maze should get host back on return');
  console.log('ok  alice is host again after reconnecting');

  // invite-only mazes
  const host = await client('host', { seed: 'Secret Base', vis: 'private', tok: 'host' });
  const hw = host.last.welcome;
  if (hw.vis !== 'private' || !/^[a-z0-9]{12}$/.test(hw.key)) fail('private maze should come back with a 12-char key');
  const listed = await (await fetch(base + '/api/games')).json();
  if (listed.length !== 1 || JSON.stringify(listed).includes('secret')) fail('private maze must not appear in the lobby');
  console.log('ok  invite-only maze is hidden from the lobby');
  const stranger = await client('stranger', { seed: 'secret-base', tok: 'stranger' });
  if (stranger.last.welcome.vis !== 'public' || stranger.last.welcome.roster.length !== 1) fail('same seed without the key must land in a different, public maze');
  console.log('ok  same seed without the link gets a separate public maze');
  const friend = await client('friend', { seed: 'secret-base', key: hw.key, tok: 'friend' });
  if (friend.last.welcome.vis !== 'private' || !friend.last.welcome.roster.some(r => r[1] === 'host')) fail('invite link should join the host\'s maze');
  await waitFor(host, 'join', m => m.nm === 'friend');
  console.log('ok  invite link joins the private maze');
  const bogus = await client('bogus', { seed: 'secret-base', key: 'NOT-A-KEY', tok: 'bogus' });
  if (bogus.last.welcome.vis !== 'public') fail('a malformed key must not create or join a private maze');
  console.log('ok  malformed keys are ignored');

  // password-protected public lobby
  const tryJoin = extra => new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.onopen = () => ws.send(JSON.stringify(Object.assign({ t: 'join', nm: 'pw-test', seed: 'locked-room' }, extra)));
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'welcome' || m.t === 'error') { res(m); ws.close(); } };
  });
  const owner = await client('owner', { seed: 'locked-room', setpw: 'hunter2', lname: 'Secret Club', tok: 'owner' });
  if (!owner.last.welcome.locked) fail('owner should see the lobby is password protected');
  const listedPw = (await (await fetch(base + '/api/games')).json()).find(g => g.name === 'Secret Club');
  if (!listedPw || !listedPw.locked) fail('password lobbies should be listed and marked locked');
  if ((await tryJoin({})).code !== 'pw_needed') fail('joining without a password should be refused');
  if ((await tryJoin({ pw: 'nope' })).code !== 'pw_wrong') fail('a wrong password should be refused');
  const okJoin = await tryJoin({ pw: 'hunter2' });
  if (okJoin.t !== 'welcome') fail('the right password should let you in');
  if ((await tryJoin({ room: listedPw.id, pw: 'hunter2' })).t !== 'welcome') fail('joining from the list with the password should work');
  const setpwIgnored = await tryJoin({ pw: 'hunter2', setpw: 'takeover' });
  if (setpwIgnored.t !== 'welcome' || (await tryJoin({ pw: 'takeover' })).code !== 'pw_wrong') fail('a joiner must not be able to change the password');
  console.log('ok  password lobby: listed as locked, wrong/missing refused, right one joins');
  let limited = false;
  for (let i = 0; i < 9 && !limited; i++) limited = (await tryJoin({ pw: 'guess' + i })).code === 'pw_limit';
  if (!limited) fail('repeated wrong passwords should be rate limited');
  console.log('ok  repeated wrong guesses are locked out');

  console.log('\nAll smoke tests passed.');
  cleanup(0);
})().catch(e => fail(e.message));
