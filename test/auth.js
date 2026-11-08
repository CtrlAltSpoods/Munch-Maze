'use strict';
/* Discord login end to end, against a fake Discord: identify-only scope, state check,
   account creation, session cookie, reserved names for guests, renaming, logout,
   and the one-off import of an old scores.json into the database. */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 18000 + Math.floor(Math.random() * 900), FAKE = PORT + 1000;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-auth-'));
const base = `http://127.0.0.1:${PORT}`;
let srv, fake;
const fail = msg => { console.error('FAIL:', msg); cleanup(1); };
function cleanup(code) { try { srv.kill(); } catch (e) { /* ignore */ } try { fake.close(); } catch (e) { /* ignore */ } fs.rmSync(DATA, { recursive: true, force: true }); process.exit(code); }
setTimeout(() => fail('timed out'), 30000);

// a stand-in for discord.com: code "alice" logs in as Alice, "bob" as Bob
const USERS = { alice: { id: '100000000000000001', username: 'alice_d', global_name: 'Alice' }, bob: { id: '100000000000000002', username: 'bob', global_name: 'Bob' } };
let revoked = 0, tokenForm = null; const hooks = [];
fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (req.url === '/oauth2/token') { tokenForm = new URLSearchParams(body); res.end(JSON.stringify({ access_token: 'tok-' + tokenForm.get('code'), token_type: 'Bearer' })); return; }
    if (req.url === '/oauth2/token/revoke') { revoked++; res.end('{}'); return; }
    if (req.url.startsWith('/api/webhooks/')) { hooks.push(JSON.parse(body)); res.writeHead(204); res.end(); return; }
    if (req.url === '/users/@me') { const u = USERS[String(req.headers.authorization).replace('Bearer tok-', '')]; res.writeHead(u ? 200 : 401); res.end(JSON.stringify(u || {})); return; }
    res.writeHead(404); res.end();
  });
}).listen(FAKE);

const get = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const cookieFrom = (res, name) => { for (const c of res.headers.getSetCookie()) if (c.startsWith(name + '=')) return c.split(';')[0]; return ''; };
function wsJoin(nm, cookie) {
  return new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', nm, tok: nm + Math.random() }));
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'welcome' || m.t === 'error') { res(m); ws.close(); } };
  });
}
async function login(code) {
  const start = await get('/auth/discord');
  const loc = new URL(start.headers.get('location')), st = cookieFrom(start, 'mm_oauth');
  const cb = await get(`/auth/discord/callback?code=${code}&state=${loc.searchParams.get('state')}`, st);
  return { cb, session: cookieFrom(cb, 'mm_session'), loc };
}

(async () => {
  fs.writeFileSync(path.join(DATA, 'scores.json'), JSON.stringify([{ n: 'Oldtimer', sc: 1234, lv: 4 }, { n: 'oldtimer', sc: 50, lv: 1 }]));
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DISCORD_CLIENT_ID: '424242', DISCORD_CLIENT_SECRET: 'app-secret-0123456789abcdefXYZ',
      DISCORD_API: `http://127.0.0.1:${FAKE}`, DISCORD_AUTHORIZE: `http://127.0.0.1:${FAKE}/authorize`, ADMIN_DISCORD_IDS: USERS.alice.id, TEST_HOOKS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (/listening/.test(d)) r(); }));

  // old scores.json moved into the database
  const sc = await (await get('/api/scores')).json();
  if (sc.length !== 1 || sc[0].n !== 'Oldtimer' || sc[0].sc !== 1234 || sc[0].reg) fail('scores.json should be imported into the database once: ' + JSON.stringify(sc));
  if (!fs.existsSync(path.join(DATA, 'munch-maze.db')) || fs.existsSync(path.join(DATA, 'scores.json'))) fail('scores now live in munch-maze.db; the old file is set aside');
  console.log('ok  scores live in munch-maze.db (old scores.json imported)');

  if (JSON.stringify(await (await get('/api/me')).json()) !== '{"discord":true,"user":null}') fail('/api/me logged out');

  // the login link asks Discord for "identify" only
  const start = await get('/auth/discord');
  const loc = new URL(start.headers.get('location'));
  if (start.status !== 302 || loc.searchParams.get('scope') !== 'identify' || loc.searchParams.get('client_id') !== '424242' || !loc.searchParams.get('state')) fail('authorize redirect: ' + loc);
  if (loc.searchParams.get('redirect_uri') !== base + '/auth/discord/callback') fail('redirect uri: ' + loc.searchParams.get('redirect_uri'));
  console.log('ok  Discord is asked for the identify scope only');

  // a callback with the wrong state is refused
  const forged = await get('/auth/discord/callback?code=alice&state=forged', 'mm_oauth=real-state');
  if (!/login=failed/.test(forged.headers.get('location')) || cookieFrom(forged, 'mm_session')) fail('a mismatched state must not log anyone in');
  console.log('ok  login without the matching state is refused');

  const al = await login('alice');
  if (!/login=new/.test(al.cb.headers.get('location')) || !al.session) fail('first login should create an account and a session');
  if (!al.cb.headers.getSetCookie().some(c => /mm_session=.*HttpOnly.*SameSite=Lax/.test(c))) fail('session cookie must be HttpOnly + SameSite');
  if (tokenForm.get('client_secret') !== 'app-secret-0123456789abcdefXYZ' || tokenForm.get('grant_type') !== 'authorization_code') fail('token exchange');
  await new Promise(r => setTimeout(r, 100));
  if (revoked < 1) fail('the Discord token should be revoked straight after use');
  const me = await (await get('/api/me', al.session)).json();
  if (!me.user || me.user.name !== 'Alice') fail('logged in as Alice: ' + JSON.stringify(me));
  console.log('ok  Discord login creates an account (Alice) with a session; Discord’s token is revoked');

  // names: guests can't take a registered name; logged-in players play as their account name
  const guest = await wsJoin('alice');
  if (guest.t !== 'error' || guest.code !== 'name_reserved') fail('a guest must not use a registered name: ' + JSON.stringify(guest));
  const asAlice = await wsJoin('SomethingElse', al.session);
  if (asAlice.t !== 'welcome' || !asAlice.roster.some(r => r[1] === 'Alice')) fail('logged in, you play as your account name');
  console.log('ok  guests can’t use “Alice”; Alice plays as Alice whatever the name box says');

  // renaming
  const post = (p, cookie, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base }, body: JSON.stringify(body || {}) });
  const rn = await post('/api/me/name', al.session, { name: 'Alicia' });
  if (rn.status !== 200 || (await rn.json()).name !== 'Alicia') fail('rename');
  const bob = await login('bob');
  if ((await post('/api/me/name', bob.session, { name: 'ALICIA' })).status !== 409) fail('another account can’t take that name');
  if ((await post('/api/me/name', '', { name: 'Hacker' })).status !== 401) fail('renaming needs a login');
  if ((await wsJoin('Alice')).t !== 'welcome') fail('the old name is free once Alice renames');
  if ((await wsJoin('alicia')).code !== 'name_reserved') fail('the new name is reserved');
  const evil = await fetch(base + '/api/me/name', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.session, Origin: 'https://evil.example' }, body: '{"name":"Pwned"}' });
  if (evil.status !== 403) fail('cross-site rename must be refused');
  console.log('ok  rename to Alicia; Bob can’t take it; old name freed; cross-site requests refused');

  // admin page: only listed Discord ids
  if ((await get('/api/admin/state', bob.session)).status !== 403) fail('non-admins get no admin state');
  if ((await post('/api/admin/reset', bob.session, { which: 'all' })).status !== 403) fail('non-admins can’t reset scores');
  const st = await (await get('/api/admin/state', al.session)).json();
  if (!st.settings || !Array.isArray(st.accounts) || st.accounts.length !== 2) fail('admin state: ' + JSON.stringify(st).slice(0, 200));
  let r2 = await post('/api/admin/settings', al.session, { serverName: 'Jake’s Arcade', showLobby: false, webhookUrl: 'https://evil.example/hook' });
  if (r2.status !== 400) fail('only Discord webhook URLs are accepted');
  r2 = await post('/api/admin/settings', al.session, { serverName: 'Jake’s Arcade', showLobby: false, webhookUrl: `http://127.0.0.1:${FAKE}/api/webhooks/1/abc` });
  if (r2.status !== 200 || (await (await get('/api/info')).json()).name !== 'Jake’s Arcade') fail('settings apply live');
  if ((await (await get('/api/games')).json()).length !== 0) fail('lobby list off when showLobby is off');
  await post('/api/admin/settings', al.session, { showLobby: true, testWebhook: true });
  await new Promise(r => setTimeout(r, 300));
  if (!hooks.length || !/connected/.test(hooks[0].content) || hooks[0].allowed_mentions.parse.length) fail('test webhook post (no pings allowed): ' + JSON.stringify(hooks));
  if ((await post('/api/admin/reserve', al.session, { name: 'Alicia' })).status !== 409) fail('can’t reserve a name a player owns');
  await post('/api/admin/reserve', al.session, { name: 'Moderator' });
  if ((await wsJoin('moderator')).code !== 'name_reserved') fail('reserved names are blocked for guests');
  if ((await post('/api/me/name', bob.session, { name: 'MODERATOR' })).status !== 409) fail('reserved names are blocked for accounts');
  const rn2 = await post('/api/admin/rename', al.session, { uid: (await (await get('/api/me', bob.session)).json()).user.uid, name: 'Bobby' });
  if (rn2.status !== 200 || (await (await get('/api/me', bob.session)).json()).user.name !== 'Bobby') fail('admin can rename an account');
  if ((await post('/api/admin/reset', al.session, { which: 'all' })).status !== 200 || (await (await get('/api/scores')).json()).length) fail('reset all scores');
  // kick
  const kws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`), kmsgs = [];
  await new Promise(res => { kws.onopen = () => kws.send(JSON.stringify({ t: 'join', nm: 'Pest', tok: 'pest-token' })); kws.onmessage = e => { const m = JSON.parse(e.data); kmsgs.push(m); if (m.t === 'welcome') res(); }; });
  const gid = kmsgs.find(m => m.t === 'welcome').gid;
  const kst = await (await get('/api/admin/state', al.session)).json(), kg = kst.games.find(g => g.id === gid);
  await post('/api/admin/kick', al.session, { game: gid, player: kg.players[0].id });
  await new Promise(r => setTimeout(r, 200));
  if (!kmsgs.some(m => m.t === 'kicked')) fail('kicked player is told');
  const back = await new Promise(res => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); w.onopen = () => w.send(JSON.stringify({ t: 'join', nm: 'Pest', tok: 'pest-token', room: gid })); w.onmessage = e => { res(JSON.parse(e.data)); w.close(); }; });
  if (back.t !== 'error' || back.code !== 'kicked') fail('a kicked player can’t walk straight back in');
  console.log('ok  admin: listed ids only; live settings; webhook (Discord URLs only, no pings); reserve; rename; reset; kick');

  // log out
  if ((await post('/auth/logout', al.session)).status !== 200) fail('logout');
  if ((await (await get('/api/me', al.session)).json()).user) fail('session should be gone after logout');
  console.log('ok  logout ends the session');

  console.log('\nAll account tests passed.');
  cleanup(0);
})().catch(e => fail(e.stack || e.message));
