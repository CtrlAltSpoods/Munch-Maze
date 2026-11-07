'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('../shared/maze.js');
const { handleUpgrade } = require('./ws.js');
const { Game } = require('./game.js');

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
  try { const s = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); if (Array.isArray(s)) scores = s.slice(0, 25); }
  catch (e) { scores = []; }
}
function addScore(e) {
  scores.push({ n: String(e.n).slice(0, 16), sc: e.sc | 0, lv: e.lv | 0, seed: String(e.seed).slice(0, 40), at: new Date().toISOString() });
  scores.sort((a, b) => b.sc - a.sc);
  scores = scores.slice(0, 25);
  scoresDirty = true;
}
setInterval(() => {
  if (!scoresDirty) return; scoresDirty = false;
  fs.writeFile(SCORES_FILE + '.tmp', JSON.stringify(scores, null, 1), err => {
    if (err) { console.warn('[scores] save failed:', err.message); return; }
    fs.rename(SCORES_FILE + '.tmp', SCORES_FILE, () => {});
  });
}, 5000).unref();

/* ---------- games ---------- */
const games = new Map(); // seed -> Game
function getGame(seed) {
  let g = games.get(seed);
  if (!g) {
    if (games.size >= CFG.maxMazes) return null;
    g = new Game(seed, { onScore: addScore });
    games.set(seed, g);
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
const COLORS = ['#ffcc33', '#7cf0a0', '#6fd3ff', '#ff8fd1', '#ffa24c', '#c79bff', '#f2f2f2', '#ff7a7a'];
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
      const g = getGame(seed);
      if (!g) { ws.send(JSON.stringify({ t: 'error', msg: 'This server is at its maze limit. Try a seed that is already running.' })); return; }
      if (CFG.maxPlayersPerMaze && g.players.size >= CFG.maxPlayersPerMaze) { ws.send(JSON.stringify({ t: 'error', msg: 'That maze is full. Try another seed.' })); return; }
      const col = COLORS.includes(m.col) ? m.col : COLORS[Math.random() * COLORS.length | 0];
      p = { id: nextId++, ws, nm: cleanName(m.nm), col, x: 0, y: 0, f: 2, al: true, sc: 0, li: 3, over: false, spawnAt: Date.now(), fid: -1, combo: 0 };
      game = g;
      g.add(p, typeof m.tok === 'string' ? m.tok.slice(0, 64) : '');
      return;
    }
    if (game && p) game.onMessage(p, m);
  });
  ws.on('close', () => { if (game && p) game.remove(p); game = null; });
}

// keep connections honest: ping idle sockets, drop dead ones
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
    const list = [...games.values()].filter(g => g.players.size).map(g => ({ seed: g.seed, players: g.players.size, level: g.L }))
      .sort((a, b) => b.players - a.players).slice(0, 20);
    return json(res, list);
  }
  if (p === '/api/scores') return json(res, scores.slice(0, 10));
  if (p === '/maze.js') return sendFile(res, path.join(ROOT, 'shared', 'maze.js'));
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file);
});

server.on('upgrade', (req, sock) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* ignore */ }
  if (!pathname.endsWith('/ws')) { sock.destroy(); return; }
  handleUpgrade(req, sock, ws => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); onSocket(ws); });
});

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
