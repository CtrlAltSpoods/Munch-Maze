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
  const wa = a.last.welcome;
  if (!/^[A-Za-z0-9_-]{8}$/.test(wa.gid || '')) fail('every game needs its own opaque id');
  const b = await client('bob', { room: wa.gid });
  if (wa.seed !== 'smoke-test') fail('seed not normalised: ' + wa.seed);
  if (b.last.welcome.roster.length !== 2) fail('roster should list both players');
  await waitFor(a, 'join', m => m.nm === 'bob');
  console.log('ok  two players joined seed', wa.seed);

  const games = await (await fetch(base + '/api/games')).json();
  if (games[0].players !== 2) fail('lobby count');
  if (games[0].name !== 'Smoke Party') fail('lobby list should show the lobby name, got ' + games[0].name);
  if (JSON.stringify(games).includes('smoke-test')) fail('lobby list must not reveal the seed');
  if (games[0].id !== wa.gid) fail('lobby list entries are the game id');
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
  if (typeof s1.left !== 'number') fail('state should carry the server pellet count');
  const full = await waitFor(b, 's', m => typeof m.b === 'string', 4000);
  if (M.fromB64(full.b, lv.bytes).length !== lv.bytes) fail('full pellet map should decode');
  console.log('ok  state carries the pellet count and a full pellet map every ~2 s');

  // alice walks to every pellet and eats it
  for (const i of lv.pList) {
    const x = i % lv.W, y = (i / lv.W) | 0;
    a.ws.send(JSON.stringify({ t: 'p', x, y, f: 0 }));
    a.ws.send(JSON.stringify({ t: 'eat', i, sk: i === lv.pList[5] ? 9999 : 0 }));   // a silly streak claim gets capped
    await new Promise(r => setTimeout(r, 40)); // stay under the rate limit
  }
  const far = lv.pList[0]; // a cheat: claiming a pellet from far away does nothing
  const sAfter = await waitFor(b, 's', m => m.ph === 1, 6000);
  const alice = sAfter.p.find(p => p[0] === wa.id);
  const expected = lv.pList.reduce((n, i) => n + (lv.p[i] === 2 ? 50 : 10), 0);
  if (alice[5] !== expected) fail(`score ${alice[5]} != ${expected}`);
  console.log('ok  all', lv.pList.length, 'pellets eaten, score', alice[5], '- level clear');
  const pws = b.msgs.filter(m => m.t === 'pw' && m.id === wa.id).length;
  if (pws !== lv.pList.filter(i => lv.p[i] === 2).length) fail('other players should hear every big pellet (got ' + pws + ')');
  console.log('ok  every big pellet is announced to the other players');
  const st = await waitFor(b, 'lvstats', () => true, 3000);
  const ra = st.rows.find(r => r[0] === wa.id), rb = st.rows.find(r => r[1] === 'bob');
  if (!ra || ra[2] !== lv.pList.length || ra[3] !== 100) fail('level stats: alice ate 100% of the pellets, got ' + JSON.stringify(ra));
  if (ra[4] !== 6) fail('level stats: streak claims are capped at pellets actually eaten (expected 6, got ' + ra[4] + ')');
  if (!rb || rb[2] !== 0 || rb[3] !== 0) fail('level stats list every player, including ones who ate nothing');
  if (st.rows[0][0] !== wa.id || st.total !== lv.pList.length) fail('level stats sorted by pellets, with the total');
  console.log('ok  level stats: pellet share and longest streak per player (alice 100%, bob 0%)');

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
  if (Math.abs(ratio - 1.05) > 1e-9 || Math.abs(gr - 1.1025) > 1e-9) fail('speed should grow 5% per level, compounding');
  {
    const r = (a, b) => M.speedMult(b) / M.speedMult(a);
    if (Math.abs(r(9, 10) - 1.05) > 1e-9 || Math.abs(r(10, 11) - 1.01) > 1e-9 || Math.abs(r(40, 41) - 1.01) > 1e-9) fail('speed: +5% a level to level 10, then +1%');
    const gap = L => M.ghostSpeed(L) / M.playerSpeed(L);
    if (Math.abs(gap(10) - gap(1)) > 1e-9 || !(gap(11) > gap(10)) || Math.abs(gap(11) / gap(10) - 1.005) > 1e-9) fail('ghosts close the gap on players by 0.5% a level after level 10');
    if (Math.abs(M.ghostSpeed(150) - M.playerSpeed(150)) > 1e-9 || M.ghostSpeed(84) > M.playerSpeed(84) + 1e-9) fail('ghosts end up exactly as fast as players, never faster');
    console.log('ok  speed: +5% a level to 10, then +1%; ghosts catch up 0.5% a level until they match');
  }
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
  const a2 = await client('alice', { room: wa.gid });
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
  if (hw.testMode) fail('test mode must be off unless TEST_MODE is set');
  host.msgs.length = 0; host.ws.send(JSON.stringify({ t: 'testpu', kind: 0 })); await new Promise(r => setTimeout(r, 300));
  if (host.msgs.some(m => m.t === 'pu')) fail('test effects must be ignored without TEST_MODE');
  console.log('ok  without TEST_MODE the effect menu is off and test triggers are ignored');
  const bogus = await client('bogus', { seed: 'secret-base', key: 'NOT-A-KEY', tok: 'bogus' });
  if (bogus.last.welcome.vis !== 'public') fail('a malformed key must not create or join a private maze');
  console.log('ok  malformed keys are ignored');

  // shared links use the lobby name, and open the maze straight away
  const pubLink = a2.last.welcome.link;
  if (pubLink !== 'smoke-party') fail('public link should be the lobby name, got ' + pubLink);
  const viaName = await client('linker', { seed: 'something-else', link: pubLink, tok: 'linker' });
  if (!viaName.last.welcome.roster.some(r => r[1] === 'alice')) fail('a lobby-name link should join that lobby');
  console.log('ok  link uses the lobby name (#' + pubLink + ') and joins it');
  const viaSeed = await client('oldlink', { seed: 'x', link: 'smoke-test', tok: 'oldlink' });
  if (!viaSeed.last.welcome.roster.some(r => r[1] === 'alice')) fail('an old seed link should still join the running maze');
  console.log('ok  old seed links still join the running maze');
  const privLink = hw.link + '~' + hw.key;
  const viaPriv = await client('friend2', { seed: 'x', link: privLink, tok: 'friend2' });
  if (viaPriv.last.welcome.vis !== 'private' || !viaPriv.last.welcome.roster.some(r => r[1] === 'host')) fail('a private name~key link should join the private maze');
  console.log('ok  invite link #' + privLink.replace(/~.*/, '~…') + ' joins the private maze');
  const closed = await new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', nm: 'late', seed: 'x', link: 'no-such-lobby', tok: 'late' }));
    ws.onmessage = ev => { res(JSON.parse(ev.data)); ws.close(); };
  });
  if (closed.t !== 'error' || closed.code !== 'closed') fail('a link to a closed lobby should say so, not open a new maze');
  console.log('ok  a link to a closed lobby says it has closed');

  // password-protected public lobby
  const tryJoin = extra => new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.onopen = () => ws.send(JSON.stringify(Object.assign({ t: 'join', nm: 'pw-test', room: ownerGid }, extra)));
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'welcome' || m.t === 'error') { res(m); ws.close(); } };
  });
  const owner = await client('owner', { seed: 'locked-room', setpw: 'hunter2', lname: 'Secret Club', tok: 'owner' });
  const ownerGid = owner.last.welcome.gid;
  if (!owner.last.welcome.locked) fail('owner should see the lobby is password protected');
  const listedPw = (await (await fetch(base + '/api/games')).json()).find(g => g.name === 'Secret Club');
  if (!listedPw || !listedPw.locked) fail('password lobbies should be listed and marked locked');
  if ((await tryJoin({})).code !== 'pw_needed') fail('joining without a password should be refused');
  if ((await tryJoin({ pw: 'nope' })).code !== 'pw_wrong') fail('a wrong password should be refused');
  const okJoin = await tryJoin({ pw: 'hunter2' });
  if (okJoin.t !== 'welcome') fail('the right password should let you in');
  if (listedPw.id !== ownerGid) fail('locked lobby listed under its game id');
  owner.ws.close(); await new Promise(r => setTimeout(r, 200));
  const ownerBack = await client('owner', { room: ownerGid, tok: 'owner' });
  if (!ownerBack.last.welcome || ownerBack.last.welcome.gid !== ownerGid) fail('the owner reconnecting needs no password');
  console.log('ok  reconnecting to your own locked lobby needs no password');
  const setpwIgnored = await tryJoin({ pw: 'hunter2', setpw: 'takeover' });
  if (setpwIgnored.t !== 'welcome' || (await tryJoin({ pw: 'takeover' })).code !== 'pw_wrong') fail('a joiner must not be able to change the password');
  console.log('ok  password lobby: listed as locked, wrong/missing refused, right one joins');
  let limited = false;
  for (let i = 0; i < 9 && !limited; i++) limited = (await tryJoin({ pw: 'guess' + i })).code === 'pw_limit';
  if (!limited) fail('repeated wrong passwords should be rate limited');
  console.log('ok  repeated wrong guesses are locked out');

  // same seed, separate games: "Start maze" never lands you in someone else's (or your old) game
  const s1g = await client('solo1', { seed: 'shared-seed', tok: 'solo1' });
  const s2g = await client('solo2', { seed: 'shared-seed', tok: 'solo2' });
  if (s1g.last.welcome.gid === s2g.last.welcome.gid || s2g.last.welcome.roster.length !== 1) fail('starting a maze on a seed already in use must make a separate game');
  if (s1g.last.welcome.seed !== s2g.last.welcome.seed) fail('both games should still use that seed');
  s1g.ws.send(JSON.stringify({ t: 'startlv', lv: 1 })); s1g.ws.send(JSON.stringify({ t: 'ready' }));
  await waitFor(s1g, 'level', m => m.ph === 0, 3000);
  s1g.ws.close(); await new Promise(r => setTimeout(r, 200));
  const again = await client('solo1', { seed: 'shared-seed', tok: 'solo1' });
  if (again.last.welcome.gid === s1g.last.welcome.gid || again.last.welcome.ph !== 3) fail('leaving and starting again on the same seed must give a fresh game in its lobby');
  console.log('ok  same seed, separate games: new mazes never resume an old one');

  console.log('\nAll smoke tests passed.');
  cleanup(0);
})().catch(e => fail(e.message));
