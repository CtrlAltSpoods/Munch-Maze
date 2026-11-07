'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('../shared/maze.js');
const { handleUpgrade } = require('./ws.js');
const { Game } = require('./game.js');
const Scores = require('./scores.js');

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
};

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SCORES_FILE = path.join(CFG.dataDir, 'scores.json');

/* ---------- data dir + privilege drop (Unraid PUID/PGID) ---------- */
function prepareDataDir() {
  try { fs.mkdirSync(CFG.dataDir, { recursive: true }); } catch (e) { /* read-only is fine */ }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot && Number.isInteger(CFG.puid) && Number.isInteger(CFG.pgid)) {
    try {
      fs.chownSync(CFG.dataDir, CFG.puid, CFG.pgid);
      if (fs.existsSync(SCORES_FILE)) fs.chownSync(SCORES_FILE, CFG.puid, CFG.pgid);
    } catch (e) { console.warn('[data] could not chown', CFG.dataDir, e.message); }
    try { process.setgid(CFG.pgid); process.setuid(CFG.puid); console.log(`[boot] running as ${CFG.puid}:${CFG.pgid}`); }
    catch (e) { console.warn('[boot] could not drop privileges:', e.message); }
  }
}

/* ---------- high scores (persisted in /data) ---------- */
let scores = [];
let scoresDirty = false;
function loadScores() {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); } catch (e) { raw = []; }
  scores = Scores.dedupe(raw);
  // merge duplicates left by older versions and save the cleaned table
  if (Array.isArray(raw) && raw.length !== scores.length) { scoresDirty = true; console.log(`[scores] merged ${raw.length} entries into ${scores.length} (one per name)`); }
}
function addScore(e) {
  const next = Scores.add(scores, e);
  if (next) { scores = next; scoresDirty = true; }
}
setInterval(() => {
  if (!scoresDirty) return; scoresDirty = false;
  fs.writeFile(SCORES_FILE + '.tmp', JSON.stringify(scores, null, 1), err => {
    if (err) { console.warn('[scores] save failed:', err.message); return; }
    fs.rename(SCORES_FILE + '.tmp', SCORES_FILE, () => {});
  });
}, 5000).unref();

/* ---------- games ---------- */
const games = new Map(); // room id ("seed" or "seed~key") -> Game
const KEY_RE = /^[a-z0-9]{12}$/;
function newKey() { // 12 chars of a-z0-9 from a CSPRNG (~62 bits)
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; let k = '';
  for (const b of crypto.randomBytes(24)) { if (b < 252) k += abc[b % 36]; if (k.length === 12) break; }
  return k.length === 12 ? k : newKey();
}
function getGame(seed, key) {
  const id = key ? seed + '~' + key : seed;
  let g = games.get(id);
  if (!g) {
    if (games.size >= CFG.maxMazes) return null;
    g = new Game(seed, key, { onScore: addScore });
    games.set(id, g);
  }
  return g;
}
const EMPTY_TTL = 5 * 60 * 1000;
let tickCount = 0, lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  tickCount++;
  const sendState = tickCount % 2 === 0; // state goes out at half the tick rate
  for (const [seed, g] of games) {
    if (!g.players.size && g.emptySince && now - g.emptySince > EMPTY_TTL) { games.delete(seed); continue; }
    g.tick(dt, sendState);
  }
}, 1000 / CFG.tickRate);

/* ---------- players / sockets ---------- */
let nextId = 1;
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯]/g, '').trim().slice(0, 16) || 'Player';

function onSocket(ws) {
  let p = null, game = null, budget = 60, lastRefill = Date.now();
  ws.on('message', text => {
    const now = Date.now();
    budget = Math.min(60, budget + (now - lastRefill) * 0.06); lastRefill = now; // ~60 msgs/s
    if (budget < 1) return; budget--;
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      if (game) return;
      const seed = M.slug(m.seed) || CFG.defaultSeed || M.randomSeed();
      // An invite link carries its key; choosing "Invite only" mints a fresh one.
      const key = typeof m.key === 'string' && KEY_RE.test(m.key) ? m.key : (m.vis === 'private' ? newKey() : '');
      const g = getGame(seed, key);
      if (!g) { ws.send(JSON.stringify({ t: 'error', msg: 'This server is at its maze limit. Try a seed that is already running.' })); return; }
      if (CFG.maxPlayersPerMaze && g.players.size >= CFG.maxPlayersPerMaze) { ws.send(JSON.stringify({ t: 'error', msg: 'That maze is full. Try another seed.' })); return; }
      const look = M.pickModel(m.mdl, m.ci);   // validated character + colour
      p = { id: nextId++, ws, nm: cleanName(m.nm), col: look.col, mdl: look.mdl, x: 0, y: 0, f: 2, al: true, sc: 0, li: 3, over: false, spawnAt: Date.now(), fid: -1, combo: 0 };
      game = g;
      g.add(p, typeof m.tok === 'string' ? m.tok.slice(0, 64) : '');
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
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
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
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (p === '/healthz') return json(res, { ok: true, mazes: games.size, players: [...games.values()].reduce((n, g) => n + g.players.size, 0) });
  if (p === '/api/info') return json(res, { name: CFG.serverName, lobby: CFG.showLobby, defaultSeed: CFG.defaultSeed, maxPlayersPerMaze: CFG.maxPlayersPerMaze });
  if (p === '/api/games') {
    if (!CFG.showLobby) return json(res, []);
    const list = [...games.values()].filter(g => g.players.size && !g.isPrivate).map(g => ({ seed: g.seed, players: g.players.size, level: g.L, lobby: g.ph === 3 }))
      .sort((a, b) => b.players - a.players).slice(0, 20);
    return json(res, list);
  }
  if (p === '/api/scores') return json(res, scores.slice(0, 10));
  if (p === '/maze.js') return sendFile(res, path.join(ROOT, 'shared', 'maze.js'));
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
    onSocket(ws);
  });
});

// Slow or idle HTTP clients can't hold sockets open for long.
server.headersTimeout = 15000;
server.requestTimeout = 20000;
if (CFG.maxConnections) server.maxConnections = CFG.maxConnections + 256; // room for page loads

prepareDataDir();
loadScores();
server.listen(CFG.port, () => console.log(`[boot] ${CFG.serverName} listening on :${CFG.port} (tick ${CFG.tickRate}/s, lobby ${CFG.showLobby ? 'on' : 'off'})`));

function shutdown() {
  console.log('[boot] shutting down');
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 1)); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
