'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('../shared/maze.js');
const { handleUpgrade } = require('./ws.js');
const { Game } = require('./game.js');
const DB = require('./db.js');

/* ---------- configuration (environment variables) ---------- */
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const bool = v => /^(1|true|yes|on)$/i.test(String(v));
const CFG = {
  port: parseInt(env('PORT', '8080'), 10),
  serverName: String(env('SERVER_NAME', 'Munch Maze')).slice(0, 40),
  maxPlayersPerMaze: parseInt(env('MAX_PLAYERS_PER_MAZE', '0'), 10) || 0, // 0 = unlimited
  maxMazes: parseInt(env('MAX_MAZES', '200'), 10) || 200,
  showLobby: bool(env('SHOW_LOBBY', 'true')),
  defaultSeed: M.slug(env('DEFAULT_SEED', '')),
  tickRate: Math.min(60, Math.max(10, parseInt(env('TICK_RATE', '30'), 10) || 30)),
  dataDir: env('DATA_DIR', '/data'),
  puid: parseInt(env('PUID', ''), 10),
  pgid: parseInt(env('PGID', ''), 10),
  // Connection limits. 0 turns a limit off.
  maxConnections: Math.max(0, parseInt(env('MAX_CONNECTIONS', '1000'), 10) || 0),
  maxConnectionsPerIp: Math.max(0, parseInt(env('MAX_CONNECTIONS_PER_IP', '20'), 10) || 0),
  // Browsers on other sites may not open game connections unless listed here.
  // Comma-separated origins (https://game.example.com), or * to allow any site.
  allowedOrigins: String(env('ALLOWED_ORIGINS', '')).split(',').map(s => s.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean),
  // Behind a reverse proxy, read the client address and host from X-Forwarded-* headers.
  trustProxy: bool(env('TRUST_PROXY', 'false')),
  testMode: bool(env('TEST_MODE', 'false')),   // hosts get a menu to fire any power-up on demand
  // Discord login (optional). Create an application at discord.com/developers, add the redirect
  // <PUBLIC_URL>/auth/discord/callback under OAuth2, and paste its client id and secret here.
  discordId: String(env('DISCORD_CLIENT_ID', '')).trim(),
  discordSecret: String(env('DISCORD_CLIENT_SECRET', '')).trim(),
  publicUrl: String(env('PUBLIC_URL', '')).trim().replace(/\/+$/, ''),   // e.g. http://10.0.10.160:8080
  discordApi: String(env('DISCORD_API', 'https://discord.com/api')).replace(/\/+$/, ''),   // tests point this at a fake
  discordAuthorize: String(env('DISCORD_AUTHORIZE', 'https://discord.com/oauth2/authorize')),
  // Admin page (/admin.html): Discord user ids allowed in, comma-separated.
  adminIds: String(env('ADMIN_DISCORD_IDS', '')).split(',').map(s => s.trim()).filter(s => /^\d{5,25}$/.test(s)),
  // Discord webhook for announcements (new #1 score, level 20+ clears). Can also be set on the admin page.
  webhookUrl: String(env('DISCORD_WEBHOOK_URL', '')).trim(),
};
const discordOn = () => !!(CFG.discordId && CFG.discordSecret);

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SCORES_FILE = path.join(CFG.dataDir, 'scores.json');   // older versions; imported once into the database
const DB_FILE = path.join(CFG.dataDir, 'munch-maze.db');

/* ---------- data dir + privilege drop (Unraid PUID/PGID) ---------- */
function prepareDataDir() {
  try { fs.mkdirSync(CFG.dataDir, { recursive: true }); } catch (e) { /* read-only is fine */ }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot && Number.isInteger(CFG.puid) && Number.isInteger(CFG.pgid)) {
    try {
      fs.chownSync(CFG.dataDir, CFG.puid, CFG.pgid);
      for (const f of [SCORES_FILE, DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) if (fs.existsSync(f)) fs.chownSync(f, CFG.puid, CFG.pgid);
    } catch (e) { console.warn('[data] could not chown', CFG.dataDir, e.message); }
    try { process.setgid(CFG.pgid); process.setuid(CFG.puid); console.log(`[boot] running as ${CFG.puid}:${CFG.pgid}`); }
    catch (e) { console.warn('[boot] could not drop privileges:', e.message); }
  }
}

/* ---------- storage: accounts, sessions and high scores in data/munch-maze.db ---------- */
let db = null;
function openDb() {
  try { db = DB.open(DB_FILE); }
  catch (e) { console.warn('[db] could not open', DB_FILE, '-', e.message, '- keeping everything in memory'); db = DB.open(':memory:'); }
  // bring over the old scores.json once
  try {
    const raw = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
    const n = db.importLegacy(raw);
    fs.renameSync(SCORES_FILE, SCORES_FILE + '.imported');
    console.log(`[db] imported ${n} scores from scores.json`);
  } catch (e) { /* no old file */ }
  setInterval(() => { try { db.purgeSessions(); db.purgeProgress('day:' + dayKey(), 'week:' + weekKey()); } catch (e) { /* ignore */ } }, 3600e3).unref();
  applySettings();
}
/* Settings saved from the admin page override the container's environment, live. */
const LIVE_SETTINGS = {
  serverName: v => String(v).slice(0, 40) || 'Munch Maze',
  showLobby: v => v === true || v === 'true',
  testMode: v => v === true || v === 'true',
  maxPlayersPerMaze: v => Math.max(0, Math.min(500, parseInt(v, 10) || 0)),
  webhookUrl: v => (validWebhook(String(v)) ? String(v) : '')
};
function applySettings() {
  for (const k of Object.keys(LIVE_SETTINGS)) {
    const v = db.getSetting(k);
    if (v !== null) CFG[k] = LIVE_SETTINGS[k](v);
  }
}

/* ---------- Discord webhook: announce big moments in a channel ---------- */
const validWebhook = u => /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u)
  || (process.env.TEST_HOOKS === '1' && /^http:\/\/127\.0\.0\.1:\d+\/api\/webhooks\/\d+\/[\w-]+$/.test(u));   // tests use a local fake
const mdSafe = s => String(s).replace(/[\\*_`~|>#\[\]()@]/g, m => (m === '@' ? '@\u200b' : '\\' + m));
const hookQueue = []; let hookBusy = false;
function announce(text) {
  if (!CFG.webhookUrl || !validWebhook(CFG.webhookUrl)) return;
  if (hookQueue.length < 20) hookQueue.push(text);
  if (hookBusy) return;
  hookBusy = true;
  (async function drain() {
    while (hookQueue.length) {
      const content = hookQueue.shift();
      try {
        await fetch(CFG.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: CFG.serverName || 'Munch Maze', content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(8000) });
      } catch (e) { console.warn('[webhook]', e.message); }
      await new Promise(r => setTimeout(r, 2000));   // stay well under Discord's rate limits
    }
    hookBusy = false;
  })();
}
/* Leaderboard periods, in the server's local time (set TZ on the container): weeks start Monday. */
function dayKey(d = new Date()) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function weekKey(d = new Date()) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (t.getDay() + 6) % 7;   // Monday = 0
  t.setDate(t.getDate() - wd + 3);                                                                   // Thursday of this week
  const y = t.getFullYear(), first = new Date(y, 0, 4), w = 1 + Math.round(((t - first) / 864e5 - 3 + ((first.getDay() + 6) % 7)) / 7);
  return y + '-W' + String(w).padStart(2, '0');
}
function addScore(e) {
  try {
    const before = db.topScore();
    if (e.sc > before && before > 0) announce(`🏆 New high score on ${mdSafe(CFG.serverName)}! **${mdSafe(e.n)}** scored **${(e.sc | 0).toLocaleString('en')}** (level ${e.lv | 0}), beating ${before.toLocaleString('en')}.`);
    const boards = ['week:' + weekKey()];
    if (e.daily) boards.push('day:' + e.daily);
    db.addScore({ ...e, boards });
    if (e.uid && e.model !== undefined) db.recordGame(e.uid, { sc: e.sc, lv: e.lv, model: e.model });
    if (e.uid && e.daily && e.sc > 0) {
      db.award(e.uid, 'daily');
      // counts once per day towards "play the daily maze" challenges
      if (db.bumpChallenge(e.uid, 'day:' + dayKey(), '_dailyrun', 'max', 1, 1)) onStats(e.uid, { dailyrun: 1 });
    }
  } catch (err) { console.warn('[db] score not saved:', err.message); }
}
/* ---------- XP, player levels and challenges ----------
   The game batches what each logged-in player did (pellets, ghosts, clears...) and hands it
   over every few seconds. Returns messages for that player: XP, level ups, challenges done. */
const sumXp = st => ['pellet', 'ghost', 'boss', 'fruit', 'crate', 'highfive', 'revive'].reduce((n, k) => n + (st[k === 'pellet' ? 'pellets' : k === 'ghost' ? 'ghosts' : k === 'crate' ? 'crates' : k] | 0) * M.XP[k], 0)
  + (st.clearXp | 0) + (st.ach | 0) * M.XP.ach;
function onStats(uid, st) {
  const out = []; let xp = sumXp(st);
  const now = new Date();
  for (const [period, weekly] of [['day:' + dayKey(now), false], ['week:' + weekKey(now), true]]) {
    for (const c of M.challengesFor(period)) {
      const v = st[c.stat] | 0; if (!v) continue;
      if (!db.bumpChallenge(uid, period, c.id, c.kind, v, c.goal)) continue;
      const bonus = weekly ? M.XP.weekly : M.XP.daily; xp += bonus;
      out.push({ t: 'chal', w: weekly ? 1 : 0, text: c.text, xp: bonus });
      const aid = weekly ? 'chalw' : 'chal';
      if (db.award(uid, aid)) { xp += M.XP.ach; out.push({ t: 'ach', id: aid }); }
    }
  }
  let { before, after } = db.addXp(uid, xp);
  const l0 = M.playerLevel(before), l1 = M.playerLevel(after);
  if (l1 > l0) {
    for (const [n, aid] of [[10, 'plevel10'], [25, 'plevel25']]) if (l1 >= n && db.award(uid, aid)) { after = db.addXp(uid, M.XP.ach).after; xp += M.XP.ach; out.push({ t: 'ach', id: aid }); }
    out.push({ t: 'lvlup', lv: M.playerLevel(after) });
  }
  out.push({ t: 'xp', xp: after, gain: xp });
  return out;
}
/** Today's and this week's challenges, with the player's progress if they're logged in. */
function challengeState(uid) {
  const now = new Date(), tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7 - ((now.getDay() + 6) % 7));
  const one = (period, ends) => {
    const got = uid ? new Map(db.challengeProgress(uid, period).map(r => [r.cid, r])) : new Map();
    return { ends: ends.getTime(), list: M.challengesFor(period).map(c => { const r = got.get(c.id); return { id: c.id, text: c.text, goal: c.goal, value: r ? Math.min(r.value, c.goal) : 0, done: !!(r && r.done) }; }) };
  };
  return { day: one('day:' + dayKey(now), tomorrow), week: one('week:' + weekKey(now), monday), xp: { daily: M.XP.daily, weekly: M.XP.weekly } };
}

/* ---------- games ---------- */
const games = new Map(); // room id ("seed" or "seed~key") -> Game
const KEY_RE = /^[a-z0-9]{12}$/;
function newKey() { // 12 chars of a-z0-9 from a CSPRNG (~62 bits)
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; let k = '';
  for (const b of crypto.randomBytes(24)) { if (b < 252) k += abc[b % 36]; if (k.length === 12) break; }
  return k.length === 12 ? k : newKey();
}
/** Every game gets its own random id. The seed only decides the maze layouts, so two games can
    share a seed and "Start maze" always makes a fresh game rather than resuming an old one. */
function createGame(seed, key) {
  if (games.size >= CFG.maxMazes) return null;
  const g = new Game(seed, key, { onScore: addScore, testHooks: process.env.TEST_HOOKS === '1',
    onAchieve: (uid, id) => { try { return db.award(uid, id); } catch (e) { return false; } },
    onCleared: (uid, L) => { try { db.setProgress(uid, L, L + 1); } catch (e) { /* ignore */ } },
    onStats,
    onLevelClear: game => {   // level 20, then every 10th: tell the Discord channel
      if (game.L >= 20 && game.L % 10 === 0) announce(`🎉 **${mdSafe(game.title || 'A maze')}** just cleared **level ${game.L}**! Players: ${[...game.players.values()].filter(p => !p.over).map(p => mdSafe(p.nm)).join(', ') || 'nobody left standing'}.`);
    },
    get testMode() { return CFG.testMode; } });
  g.title = '';
  do { g.gid = crypto.randomBytes(6).toString('base64url'); } while (games.has(g.gid));
  if (key) byKey.set(key, g);
  games.set(g.gid, g);
  return g;
}
const EMPTY_TTL = 5 * 60 * 1000;
let tickCount = 0, lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  tickCount++;
  const sendState = tickCount % 2 === 0; // state goes out at half the tick rate
  for (const [gid, g] of games) {
    if (!g.players.size && g.emptySince && now - g.emptySince > EMPTY_TTL) { games.delete(gid); if (g.key) byKey.delete(g.key); if (byLink.get(g.link) === g) byLink.delete(g.link); continue; }
    g.tick(dt, sendState);
  }
}, 1000 / CFG.tickRate);

/* ---------- players / sockets ---------- */
let nextId = 1;
const stripCtl = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯]/g, '').replace(/\s+/g, ' ').trim();
const cleanName = s => stripCtl(s).slice(0, 16) || 'Player';
const cleanTitle = s => stripCtl(s).slice(0, 32);
// games: gid -> Game. Public mazes are listed by name with that opaque id, so the list never shows seeds.
const byKey = new Map();        // invite key -> private Game
const byLink = new Map();       // lobby-name slug ("friday-night-munch") -> public Game
/** A short, unique, readable name for links: the lobby name, or the seed if it has none. */
function linkName(g) {
  if (g.isPrivate) return M.slug(g.title).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || g.seed;
  const base = M.slug(g.title).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || g.seed;
  let name = base;
  for (let n = 2; byLink.has(name) && byLink.get(name) !== g; n++) name = base + '-' + n;
  byLink.set(name, g);
  return name;
}
/** Resolve a link ("name" or "name~key"): an open lobby by name, a running public maze by seed, or a private maze by key. */
function resolveLink(raw) {
  const [name, key = ''] = String(raw).slice(0, 80).split('~'), slug = M.slug(name);
  if (key) { const g = KEY_RE.test(key) && byKey.get(key); return g || null; }
  let g = byLink.get(slug);
  if (!g) for (const x of games.values()) if (x.seed === slug && !x.isPrivate && x.players.size) { g = x; break; }   // old #seed links
  return g && !g.isPrivate && g.players.size ? g : null;
}

/* ---------- lobby passwords ----------
   Stored only as a salted scrypt hash. Wrong guesses are limited per address. */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt, hash: crypto.scryptSync(pw, salt, 32) };
}
function checkPassword(stored, pw) {
  if (typeof pw !== 'string' || !pw) return false;
  const h = crypto.scryptSync(pw.slice(0, 64), stored.salt, 32);
  return crypto.timingSafeEqual(h, stored.hash);
}
const PW_MAX_FAILS = 8, PW_WINDOW = 10 * 60 * 1000;
const pwFails = new Map();   // ip -> { n, since }
function pwBlocked(ip) { const f = pwFails.get(ip); if (!f) return false; if (Date.now() - f.since > PW_WINDOW) { pwFails.delete(ip); return false; } return f.n >= PW_MAX_FAILS; }
function pwFailed(ip) { const f = pwFails.get(ip); if (!f || Date.now() - f.since > PW_WINDOW) pwFails.set(ip, { n: 1, since: Date.now() }); else f.n++; }
setInterval(() => { const now = Date.now(); for (const [ip, f] of pwFails) if (now - f.since > PW_WINDOW) pwFails.delete(ip); }, 60000).unref();

function onSocket(ws, ip = '?', account = null) {
  let p = null, game = null, budget = 60, lastRefill = Date.now();
  ws.on('message', text => {
    const now = Date.now();
    budget = Math.min(60, budget + (now - lastRefill) * 0.06); lastRefill = now; // ~60 msgs/s
    if (budget < 1) return; budget--;
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      if (game) return;
      // Which game? (1) by id: from the lobby list, or reconnecting to the game you were in;
      // (2) a shared link; (3) an invite key; otherwise (4) a brand-new game.
      let g = null, opening = false;
      if (typeof m.room === 'string' && m.room) {
        g = games.get(m.room.slice(0, 16)) || null;
        if (g && g.isPrivate && m.key !== g.key) g = null;   // private games also need their key
        if (!g) { ws.send(JSON.stringify({ t: 'error', code: 'closed', msg: 'That maze has closed. Pick another one or start your own.' })); return; }
      } else if (typeof m.link === 'string' && m.link) {
        g = resolveLink(m.link);
        if (!g) { ws.send(JSON.stringify({ t: 'error', code: 'closed', msg: 'That maze has closed. Start your own or pick one from the list.' })); return; }
      } else if (typeof m.key === 'string' && KEY_RE.test(m.key) && byKey.has(m.key)) {
        g = byKey.get(m.key);
      } else {
        const daily = m.daily === true ? dayKey() : '';   // the daily maze: same layouts for everyone today
        const seed = daily ? 'daily-' + daily : M.slug(m.seed) || CFG.defaultSeed || M.randomSeed();
        g = createGame(seed, m.vis === 'private' ? newKey() : '');   // "Invite only" mints a fresh key
        if (g) { g.daily = daily; g.mode = m.mode === 'versus' ? 'versus' : 'coop'; }
        if (!g) { ws.send(JSON.stringify({ t: 'error', msg: 'This server is at its maze limit. Join one of the running mazes instead.' })); return; }
        opening = true;
      }
      // Names: logged-in players always play as their account name; guests can't use a name an account owns.
      let nm = cleanName(m.nm);
      if (account) { const a = db.account(account.uid); if (a) nm = a.name; }
      else if (db.nameOwner(nm)) {
        if (opening) { games.delete(g.gid); if (g.key) byKey.delete(g.key); }
        ws.send(JSON.stringify({ t: 'error', code: 'name_reserved', msg: '“' + nm + '” belongs to a registered player. Pick another name, or log in with Discord if it’s yours.' }));
        return;
      }
      if (CFG.maxPlayersPerMaze && g.players.size >= CFG.maxPlayersPerMaze) { ws.send(JSON.stringify({ t: 'error', msg: 'That maze is full. Try another one.' })); return; }
      const tok = typeof m.tok === 'string' ? m.tok.slice(0, 64) : '';
      if (g.kicked && g.kicked.has(tok || ip)) { ws.send(JSON.stringify({ t: 'error', code: 'kicked', msg: 'The server admin removed you from that maze.' })); return; }
      const returning = tok && (tok === g.creatorToken || g.resume.has(tok));   // already let in once: no password again on reconnect
      if (g.pass && !opening && !returning) {
        const err = code => { ws.send(JSON.stringify({ t: 'error', code, name: g.title || '', msg: code === 'pw_limit' ? 'Too many wrong passwords. Try again in a few minutes.' : m.pw ? 'That password isn’t right.' : 'This lobby needs a password.' })); };
        if (pwBlocked(ip)) return err('pw_limit');
        if (!checkPassword(g.pass, m.pw)) { if (m.pw) pwFailed(ip); return err(m.pw ? 'pw_wrong' : 'pw_needed'); }
      }
      if (opening) {
        g.title = cleanTitle(m.lname) || (g.daily ? 'Daily maze · ' + nm : nm + (g.mode === 'versus' ? '’s versus maze' : '’s maze'));   // whoever opens a public maze names it
        const pw = typeof m.setpw === 'string' && !g.isPrivate ? m.setpw.slice(0, 64) : '';
        g.pass = pw ? hashPassword(pw) : null;
        g.link = linkName(g);
      }
      const look = M.pickModel(m.mdl, m.ci);   // validated character + colour
      // trail and death effect: only what the account's player level has unlocked
      const plv = account ? M.playerLevel(db.getXp(account.uid)) : 0;
      p = { id: nextId++, ws, uid: account ? account.uid : 0, nm, col: look.col, mdl: look.mdl, ci: look.ci, x: 0, y: 0, f: 2, al: true, sc: 0, li: 3, over: false, spawnAt: Date.now(), fid: -1, combo: 0,
        plv, trail: M.pickCosmetic(M.TRAILS, m.trail, plv), dfx: M.pickCosmetic(M.DEATHFX, m.dfx, plv) };
      game = g;
      g.add(p, tok);
      return;
    }
    if (game && p) game.onMessage(p, m);
  });
  ws.on('close', () => { if (game && p) game.remove(p); game = null; });
}

// Heartbeat: ping every 15 s; a client silent for 45 s (no frames, no pongs) is dropped.
const sockets = new Set();
setInterval(() => {
  const now = Date.now();
  for (const s of sockets) { if (now - s.lastSeen > 45000) s.terminate(); else s.ping(); }
}, 15000).unref();

/* ---------- HTTP ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const etags = new Map();

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    let tag = etags.get(file);
    if (!tag) { tag = '"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 16) + '"'; etags.set(file, tag); }
    if (res.req.headers['if-none-match'] === tag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: tag });
    res.end(buf);
  });
}
/* ---------- Discord login ----------
   Standard OAuth2 code flow with the "identify" scope only: we learn the Discord user id
   (and their display name to suggest a starting name), then forget Discord's token. */
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = req => (CFG.publicUrl ? CFG.publicUrl.startsWith('https:') : CFG.trustProxy && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '')));
function setCookie(res, req, name, value, maxAge, cookiePath = '/') {
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [].concat(prev, `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`));
}
function baseUrl(req) {
  if (CFG.publicUrl) return CFG.publicUrl;
  return (isHttps(req) ? 'https://' : 'http://') + requestHost(req);
}
const redirectUri = req => baseUrl(req) + '/auth/discord/callback';
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }
function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
const sessionOf = req => { try { return db.sessionUser(cookies(req).mm_session); } catch (e) { return null; } };
async function discordCallback(req, res, url) {
  const c = cookies(req), state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  setCookie(res, req, 'mm_oauth', '', 0, '/auth');
  const ok = c.mm_oauth && state && c.mm_oauth.length === state.length && crypto.timingSafeEqual(Buffer.from(c.mm_oauth), Buffer.from(state));
  if (!ok || !code) return redirect(res, '/?login=' + (url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed'));
  try {
    const tok = await fetch(CFG.discordApi + '/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CFG.discordId, client_secret: CFG.discordSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri(req) }),
      signal: AbortSignal.timeout(8000)
    }).then(r => r.ok ? r.json() : Promise.reject(new Error('token ' + r.status)));
    const me = await fetch(CFG.discordApi + '/users/@me', { headers: { Authorization: 'Bearer ' + tok.access_token }, signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('user ' + r.status)));
    // we only needed the id: hand the token straight back
    fetch(CFG.discordApi + '/oauth2/token/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CFG.discordId, client_secret: CFG.discordSecret, token: tok.access_token }), signal: AbortSignal.timeout(8000) }).catch(() => {});
    if (!/^\d{5,25}$/.test(String(me.id || ''))) throw new Error('no user id');
    const acct = db.loginDiscord(String(me.id), cleanName(me.global_name || me.username));
    setCookie(res, req, 'mm_session', db.newSession(acct.uid), db.SESSION_DAYS * 86400);
    console.log(`[auth] ${acct.created ? 'new account' : 'login'} uid ${acct.uid}`);
    return redirect(res, '/?login=' + (acct.created ? 'new' : 'ok'));
  } catch (e) {
    console.warn('[auth] discord login failed:', e.message);
    return redirect(res, '/?login=failed');
  }
}
/* ---------- admin page API (Discord ids listed in ADMIN_DISCORD_IDS only) ---------- */
function adminOf(req) { const me = sessionOf(req); return me && CFG.adminIds.includes(String(me.discordId)) ? me : null; }
function adminState() {
  return {
    settings: { serverName: CFG.serverName, showLobby: CFG.showLobby, testMode: CFG.testMode, maxPlayersPerMaze: CFG.maxPlayersPerMaze, webhookUrl: CFG.webhookUrl ? CFG.webhookUrl.replace(/\/[\w-]+$/, '/••••••') : '', webhookSet: !!CFG.webhookUrl },
    games: [...games.values()].map(g => ({ id: g.gid, name: g.title || '(opening)', seed: g.seed, level: g.L, mode: g.mode || 'coop', daily: !!g.daily, private: !!g.isPrivate, locked: !!g.pass, phase: g.ph,
      players: [...g.players.values()].map(p => ({ id: p.id, name: p.nm, score: p.sc, lives: p.li, over: !!p.over, uid: p.uid || 0 })) })),
    accounts: db.listAccounts(200), reserved: db.reservedNames()
  };
}
async function handleAdmin(req, res, p) {
  const me = adminOf(req); if (!me) return json(res, { error: 'Admins only.' }, 403);
  let body = {}; try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch (e) { return json(res, { error: 'Bad request.' }, 400); }
  if (p === '/api/admin/kick') {
    const g = games.get(String(body.game || '')), pl = g && g.players.get(body.player | 0);
    if (!pl) return json(res, { error: 'No such player.' }, 404);
    g.kicked = g.kicked || new Set(); g.kicked.add(pl.token || ''); 
    try { pl.ws.send(JSON.stringify({ t: 'kicked' })); } catch (e) { /* ignore */ }
    g.remove(pl); try { pl.ws.close(); } catch (e) { /* ignore */ }
    console.log(`[admin] uid ${me.uid} kicked "${pl.nm}" from ${g.gid}`);
    return json(res, { ok: true, state: adminState() });
  }
  if (p === '/api/admin/rename') {
    const name = stripCtl(body.name).slice(0, 16), uid = body.uid | 0;
    if (!name || !db.account(uid)) return json(res, { error: 'Pick a name.' }, 400);
    const r = db.rename(uid, name); if (!r.ok) return json(res, { error: 'That name is taken or reserved.' }, 409);
    for (const g of games.values()) for (const pl of g.players.values()) if (pl.uid === uid) pl.nm = name;
    return json(res, { ok: true, state: adminState() });
  }
  if (p === '/api/admin/reserve') {
    const name = stripCtl(body.name).slice(0, 16); if (!name) return json(res, { error: 'Pick a name.' }, 400);
    if (body.on === false) db.unreserveName(name);
    else { const owner = db.nameOwner(name); if (owner > 0) return json(res, { error: 'A player already owns that name. Rename them first.' }, 409); db.reserveName(name); }
    return json(res, { ok: true, state: adminState() });
  }
  if (p === '/api/admin/reset') {
    if (!['week', 'day', 'all'].includes(body.which)) return json(res, { error: 'Bad request.' }, 400);
    db.resetScores(body.which); console.log(`[admin] uid ${me.uid} reset scores: ${body.which}`);
    return json(res, { ok: true, state: adminState() });
  }
  if (p === '/api/admin/settings') {
    for (const k of Object.keys(LIVE_SETTINGS)) {
      if (!(k in body)) continue;
      if (k === 'webhookUrl' && body[k] !== '' && !validWebhook(String(body[k]))) return json(res, { error: 'That doesn’t look like a Discord webhook URL.' }, 400);
      db.putSetting(k, String(body[k])); CFG[k] = LIVE_SETTINGS[k](body[k]);
    }
    if (body.testWebhook && CFG.webhookUrl) announce(`👋 ${mdSafe(CFG.serverName)} is connected. Big moments will show up here.`);
    return json(res, { ok: true, state: adminState() });
  }
  return json(res, { error: 'not found' }, 404);
}

const renameAt = new Map();   // uid -> last rename time
async function handleApiPost(req, res, p) {
  if (!originAllowed(req)) return json(res, { error: 'forbidden' }, 403);
  if (p === '/auth/logout') {
    try { db.endSession(cookies(req).mm_session); } catch (e) { /* ignore */ }
    setCookie(res, req, 'mm_session', '', 0);
    return json(res, { ok: true });
  }
  if (p === '/api/me/progress') {   // unlocks earned before logging in (browser cookies) move onto the account
    const me = sessionOf(req); if (!me) return json(res, { error: 'Log in first.' }, 401);
    let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, { error: 'Bad request.' }, 400); }
    db.setProgress(me.uid, Math.min(300, body.cleared | 0), Math.min(301, body.best | 0));
    const pr = db.profile(me.uid); return json(res, { cleared: pr.cleared, best: pr.bestLevel });
  }
  if (p === '/api/me/name') {
    const me = sessionOf(req); if (!me) return json(res, { error: 'Log in first.' }, 401);
    if (Date.now() - (renameAt.get(me.uid) || 0) < 3000) return json(res, { error: 'Slow down a moment.' }, 429);
    let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, { error: 'Bad request.' }, 400); }
    const name = stripCtl(body && body.name).slice(0, 16);
    if (!name) return json(res, { error: 'Pick a name.' }, 400);
    const r = db.rename(me.uid, name);
    if (!r.ok) return json(res, { error: 'Someone already has that name.' }, 409);
    renameAt.set(me.uid, Date.now());
    for (const g of games.values()) for (const pl of g.players.values()) if (pl.uid === me.uid) pl.nm = name;   // live games pick it up
    return json(res, { ok: true, name });
  }
  return json(res, { error: 'not found' }, 404);
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
  const p = url.pathname;
  if (req.method === 'POST' && p.startsWith('/api/admin/')) {
    if (!originAllowed(req)) return json(res, { error: 'forbidden' }, 403);
    handleAdmin(req, res, p).catch(e => { console.warn('[admin]', e.message); json(res, { error: 'failed' }, 500); }); return;
  }
  if (req.method === 'POST' && (p === '/auth/logout' || p === '/api/me/name' || p === '/api/me/progress')) { handleApiPost(req, res, p).catch(() => json(res, { error: 'failed' }, 500)); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (p === '/api/me') { const me = sessionOf(req), pr = me ? db.profile(me.uid) : null; return json(res, { discord: discordOn(), user: me ? { uid: me.uid, name: me.name, cleared: pr ? pr.cleared : 0, best: pr ? pr.bestLevel : 0, xp: pr ? pr.xp : 0 } : null }); }
  if (p === '/api/challenges') { const me = sessionOf(req); let st = null; try { st = challengeState(me ? me.uid : 0); } catch (e) { /* ignore */ } return st ? json(res, Object.assign(st, { loggedIn: !!me })) : json(res, { error: 'failed' }, 500); }
  if (p === '/auth/discord') {
    if (!discordOn()) { res.writeHead(404); res.end(); return; }
    const state = crypto.randomBytes(16).toString('base64url');
    setCookie(res, req, 'mm_oauth', state, 600, '/auth');
    const q = new URLSearchParams({ client_id: CFG.discordId, response_type: 'code', redirect_uri: redirectUri(req), scope: 'identify', state, prompt: 'none' });
    return redirect(res, CFG.discordAuthorize + '?' + q);
  }
  if (p === '/auth/discord/callback') {
    if (!discordOn()) { res.writeHead(404); res.end(); return; }
    discordCallback(req, res, url); return;
  }
  if (p === '/healthz') return json(res, { ok: true, mazes: games.size, players: [...games.values()].reduce((n, g) => n + g.players.size, 0) });
  if (p === '/api/info') return json(res, { name: CFG.serverName, lobby: CFG.showLobby, defaultSeed: CFG.defaultSeed, maxPlayersPerMaze: CFG.maxPlayersPerMaze });
  if (p === '/api/games') {
    if (!CFG.showLobby) return json(res, []);
    const list = [...games.values()].filter(g => g.players.size && !g.isPrivate).map(g => ({ id: g.gid, name: g.title || 'Unnamed maze', players: g.players.size, level: g.L, lobby: g.ph === 3, locked: !!g.pass, mode: g.mode || 'coop', daily: !!g.daily }))
      .sort((a, b) => b.players - a.players).slice(0, 20);
    return json(res, list);
  }
  if (p === '/api/scores') {
    const which = url.searchParams.get('board'), board = which === 'week' ? 'week:' + weekKey() : which === 'day' ? 'day:' + dayKey() : '';
    let top = []; try { top = db.topScores(10, board); } catch (e) { /* ignore */ } return json(res, top);
  }
  if (p === '/api/admin/state') { const me = adminOf(req); return me ? json(res, adminState()) : json(res, { error: 'Admins only.', loggedIn: !!sessionOf(req), discord: discordOn() }, 403); }
  if (p === '/api/profile') {
    let pr = null; try { pr = db.profile(parseInt(url.searchParams.get('uid'), 10) || 0); } catch (e) { /* ignore */ }
    return pr ? json(res, pr) : json(res, { error: 'not found' }, 404);
  }
  if (p === '/maze.js') return sendFile(res, path.join(ROOT, 'shared', 'maze.js'));
  // Optional sound files the server owner drops into the data folder (kept out of the image)
  if (p === '/custom/peanut.mp3') return sendFile(res, path.join(CFG.dataDir, 'peanut.mp3'));
  let rel;
  try { rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, ''); }
  catch (e) { res.writeHead(400); res.end(); return; }          // malformed %-escape
  if (rel.includes('\0')) { res.writeHead(400); res.end(); return; }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file);
});

/* ---------- who may open a game connection ---------- */
const firstHeader = v => String(Array.isArray(v) ? v[0] : (v || '')).split(',')[0].trim();
function clientIp(req) {
  const ip = (CFG.trustProxy && firstHeader(req.headers['x-forwarded-for'])) || req.socket.remoteAddress || '?';
  return ip.replace(/^::ffff:/, '');
}
function requestHost(req) {
  return ((CFG.trustProxy && firstHeader(req.headers['x-forwarded-host'])) || String(req.headers.host || '')).toLowerCase();
}
/* Browsers always send Origin on WebSocket requests. Same-origin pages (the game itself)
   are allowed; other sites only if listed in ALLOWED_ORIGINS. Non-browser clients send
   no Origin and can't be stopped this way, so the connection limits below still apply. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (CFG.allowedOrigins.includes('*')) return true;
  let u; try { u = new URL(origin); } catch (e) { return false; }
  if (u.host.toLowerCase() === requestHost(req)) return true;
  return CFG.allowedOrigins.includes(u.origin.toLowerCase());
}
const perIp = new Map(); // ip -> open game connections
function admit(req) {
  if (!originAllowed(req)) { console.warn('[ws] refused origin', String(req.headers.origin).slice(0, 100)); return [403, 'Forbidden']; }
  if (CFG.maxConnections && sockets.size >= CFG.maxConnections) return [503, 'Service Unavailable'];
  const ip = clientIp(req);
  if (CFG.maxConnectionsPerIp && (perIp.get(ip) || 0) >= CFG.maxConnectionsPerIp) return [429, 'Too Many Requests'];
  return null;
}

server.on('upgrade', (req, sock) => {
  sock.on('error', () => {});   // a reset during the handshake must not crash the server
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* ignore */ }
  if (!pathname.endsWith('/ws')) { sock.destroy(); return; }
  handleUpgrade(req, sock, admit, ws => {
    const ip = clientIp(req);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    sockets.add(ws);
    ws.on('close', () => {
      sockets.delete(ws);
      const n = (perIp.get(ip) || 1) - 1;
      if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
    });
    onSocket(ws, ip, sessionOf(req));   // logged in with Discord? (session cookie on the upgrade)
  });
});

// Slow or idle HTTP clients can't hold sockets open for long.
server.headersTimeout = 15000;
server.requestTimeout = 20000;
if (CFG.maxConnections) server.maxConnections = CFG.maxConnections + 256; // room for page loads

prepareDataDir();
openDb();
server.listen(CFG.port, () => console.log(`[boot] ${CFG.serverName} listening on :${CFG.port} (tick ${CFG.tickRate}/s, lobby ${CFG.showLobby ? 'on' : 'off'}${CFG.testMode ? ', TEST MODE' : ''})`));

function shutdown() {
  console.log('[boot] shutting down');
  try { db.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
