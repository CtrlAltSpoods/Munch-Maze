'use strict';
/* Storage in one SQLite file (data/munch-maze.db), using node:sqlite, built into Node 22.
   Tables:
     accounts  one row per Discord login: our own uid, the Discord user id, and the name
               the player has chosen (unique, ignoring case and repeated spaces).
     sessions  logged-in browsers. Only a SHA-256 hash of each session token is kept.
     scores    the high-score table, best run per player: registered players by uid
               (so renaming keeps their scores), guests by name.
   No passwords are stored anywhere: accounts can only be created by logging in with Discord. */

// node:sqlite prints an "experimental" warning when first loaded; it's stable enough for this.
const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) { if (/sqlite/i.test(String((w && w.message) || w))) return; return emit.call(process, w, ...rest); };
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;
const crypto = require('crypto');
const Scores = require('./scores.js');

const SESSION_DAYS = 30;
const nameKey = Scores.nameKey;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function open(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      uid        INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      name_key   TEXT NOT NULL UNIQUE,
      created    INTEGER NOT NULL,
      last_login INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      uid        INTEGER NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
      expires    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
      pkey  TEXT PRIMARY KEY,          -- 'u:<uid>' for accounts, 'g:<name key>' for guests
      uid   INTEGER REFERENCES accounts(uid) ON DELETE SET NULL,
      name  TEXT NOT NULL,             -- the name used for that run (accounts show their current name)
      score INTEGER NOT NULL,
      level INTEGER NOT NULL,
      seed  TEXT NOT NULL DEFAULT '',
      at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_by_score ON scores(score DESC);
    -- time-limited leaderboards: board = 'week:2026-W45' or 'day:2026-11-08' (the daily maze)
    CREATE TABLE IF NOT EXISTS boards (
      board TEXT NOT NULL, pkey TEXT NOT NULL, uid INTEGER, name TEXT NOT NULL,
      score INTEGER NOT NULL, level INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (board, pkey)
    );
    CREATE TABLE IF NOT EXISTS achievements (
      uid INTEGER NOT NULL REFERENCES accounts(uid) ON DELETE CASCADE,
      aid TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (uid, aid)
    );
    -- names nobody may use (set from the admin page)
    CREATE TABLE IF NOT EXISTS reserved (name_key TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL);
    -- settings changed from the admin page (override the container's environment)
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  // profile columns, added to databases made by earlier versions
  const cols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
  for (const [c, def] of [['games', 'INTEGER NOT NULL DEFAULT 0'], ['best_score', 'INTEGER NOT NULL DEFAULT 0'], ['best_level', 'INTEGER NOT NULL DEFAULT 0'],
    ['cleared', 'INTEGER NOT NULL DEFAULT 0'], ['models', "TEXT NOT NULL DEFAULT '{}'"]]) if (!cols.has(c)) db.exec(`ALTER TABLE accounts ADD COLUMN ${c} ${def}`);

  const q = {
    best: db.prepare('SELECT score FROM scores WHERE pkey = ?'),
    upsert: db.prepare(`INSERT INTO scores (pkey, uid, name, score, level, seed, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pkey) DO UPDATE SET name = excluded.name, score = excluded.score, level = excluded.level, seed = excluded.seed, at = excluded.at
      WHERE excluded.score > scores.score`),
    top: db.prepare(`SELECT COALESCE(a.name, s.name) AS n, s.score AS sc, s.level AS lv, s.uid IS NOT NULL AS reg
      FROM scores s LEFT JOIN accounts a ON a.uid = s.uid ORDER BY s.score DESC, s.at ASC LIMIT ?`),
    count: db.prepare('SELECT COUNT(*) AS n FROM scores'),
    byDiscord: db.prepare('SELECT uid, name FROM accounts WHERE discord_id = ?'),
    byUid: db.prepare('SELECT uid, name FROM accounts WHERE uid = ?'),
    byKey: db.prepare('SELECT uid FROM accounts WHERE name_key = ?'),
    create: db.prepare('INSERT INTO accounts (discord_id, name, name_key, created, last_login) VALUES (?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE accounts SET last_login = ? WHERE uid = ?'),
    rename: db.prepare('UPDATE accounts SET name = ?, name_key = ? WHERE uid = ?'),
    newSession: db.prepare('INSERT INTO sessions (token_hash, uid, expires) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT a.uid, a.name FROM sessions s JOIN accounts a ON a.uid = s.uid WHERE s.token_hash = ? AND s.expires > ?'),
    endSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    boardBest: db.prepare('SELECT score FROM boards WHERE board = ? AND pkey = ?'),
    boardUpsert: db.prepare(`INSERT INTO boards (board, pkey, uid, name, score, level, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(board, pkey) DO UPDATE SET name = excluded.name, score = excluded.score, level = excluded.level, at = excluded.at WHERE excluded.score > boards.score`),
    boardTop: db.prepare(`SELECT COALESCE(a.name, b.name) AS n, b.score AS sc, b.level AS lv, b.uid AS uid
      FROM boards b LEFT JOIN accounts a ON a.uid = b.uid WHERE b.board = ? ORDER BY b.score DESC, b.at ASC LIMIT ?`),
    topUid: db.prepare(`SELECT s.uid AS uid FROM scores s ORDER BY s.score DESC, s.at ASC LIMIT ?`),
    profile: db.prepare('SELECT uid, name, created, games, best_score, best_level, cleared, models FROM accounts WHERE uid = ?'),
    gamePlayed: db.prepare('UPDATE accounts SET games = games + 1, best_score = MAX(best_score, ?), best_level = MAX(best_level, ?), models = ? WHERE uid = ?'),
    setProgress: db.prepare('UPDATE accounts SET cleared = MAX(cleared, ?), best_level = MAX(best_level, ?) WHERE uid = ?'),
    award: db.prepare('INSERT OR IGNORE INTO achievements (uid, aid, at) VALUES (?, ?, ?)'),
    achs: db.prepare('SELECT aid, at FROM achievements WHERE uid = ? ORDER BY at'),
    resIns: db.prepare('INSERT OR REPLACE INTO reserved (name_key, name, at) VALUES (?, ?, ?)'),
    resDel: db.prepare('DELETE FROM reserved WHERE name_key = ?'),
    resGet: db.prepare('SELECT name FROM reserved WHERE name_key = ?'),
    resAll: db.prepare('SELECT name FROM reserved ORDER BY name'),
    setGet: db.prepare('SELECT v FROM settings WHERE k = ?'),
    setPut: db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)'),
    setDel: db.prepare('DELETE FROM settings WHERE k = ?'),
    accounts: db.prepare('SELECT uid, name, games, best_score, last_login FROM accounts ORDER BY last_login DESC LIMIT ?')
  };

  /** Record a finished run; keeps only each player's best. Returns true if it was a new best. */
  function addScore({ uid = null, n, sc, lv, seed = '', boards = [] }) {
    sc = Math.max(0, sc | 0); lv = Math.max(0, lv | 0);
    const name = String(n || 'Player').slice(0, 16), key = uid ? 'u:' + uid : 'g:' + nameKey(name);
    if (sc <= 0 || key === 'g:') return false;
    const now = Date.now();
    for (const b of boards) { const cur = q.boardBest.get(b, key); if (!cur || cur.score < sc) q.boardUpsert.run(b, key, uid || null, name, sc, lv, now); }
    const cur = q.best.get(key);
    if (cur && cur.score >= sc) return false;
    q.upsert.run(key, uid || null, name, sc, lv, String(seed).slice(0, 40), now);
    return true;
  }
  /** All-time table, or a time-limited board ('week:…' / 'day:…'). */
  function topScores(limit = 10, board = '') {
    if (board) return q.boardTop.all(board, limit).map(r => ({ n: r.n, sc: r.sc, lv: r.lv, reg: !!r.uid, uid: r.uid || 0 }));
    return db.prepare(`SELECT COALESCE(a.name, s.name) AS n, s.score AS sc, s.level AS lv, s.uid AS uid
      FROM scores s LEFT JOIN accounts a ON a.uid = s.uid ORDER BY s.score DESC, s.at ASC LIMIT ?`).all(limit).map(r => ({ n: r.n, sc: r.sc, lv: r.lv, reg: !!r.uid, uid: r.uid || 0 }));
  }
  /** Highest all-time score right now (0 if none). */
  const topScore = () => { const r = q.top.get(1); return r ? r.sc : 0; };

  /* ---------- profiles, achievements, progress ---------- */
  function recordGame(uid, { sc, lv, model }) {
    const a = q.profile.get(uid); if (!a) return;
    let m = {}; try { m = JSON.parse(a.models) || {}; } catch (e) { /* ignore */ }
    if (model) m[model] = (m[model] | 0) + 1;
    q.gamePlayed.run(sc | 0, lv | 0, JSON.stringify(m), uid);
  }
  const setProgress = (uid, cleared, best) => q.setProgress.run(Math.min(999, cleared | 0), Math.min(999, best | 0), uid);
  /** Returns true the first time this account earns that achievement. */
  const award = (uid, aid) => !!uid && q.award.run(uid, String(aid), Date.now()).changes > 0;
  function profile(uid) {
    const a = q.profile.get(uid); if (!a) return null;
    let m = {}; try { m = JSON.parse(a.models) || {}; } catch (e) { /* ignore */ }
    const fav = Object.entries(m).sort((x, y) => y[1] - x[1])[0];
    return { uid: a.uid, name: a.name, since: a.created, games: a.games, best: a.best_score, bestLevel: a.best_level, cleared: a.cleared,
      fav: fav ? fav[0] : '', achievements: q.achs.all(uid).map(r => ({ id: r.aid, at: r.at })) };
  }

  /* ---------- admin helpers ---------- */
  const reserveName = name => q.resIns.run(nameKey(name), String(name).slice(0, 16), Date.now());
  const unreserveName = name => q.resDel.run(nameKey(name));
  const isReserved = name => !!q.resGet.get(nameKey(name));
  const reservedNames = () => q.resAll.all().map(r => r.name);
  const getSetting = k => { const r = q.setGet.get(k); return r ? r.v : null; };
  const putSetting = (k, v) => (v === null || v === undefined ? q.setDel.run(k) : q.setPut.run(k, String(v)));
  const listAccounts = (limit = 200) => q.accounts.all(limit);
  function resetScores(which) {
    if (which === 'all') { db.exec('DELETE FROM scores; DELETE FROM boards;'); return; }
    if (which === 'week' || which === 'day') db.prepare('DELETE FROM boards WHERE board LIKE ?').run(which + ':%');
  }

  /** One-off import of the old scores.json (all guests). */
  function importLegacy(list) {
    if (q.count.get().n > 0) return 0;
    let n = 0;
    for (const e of Scores.dedupe(list)) if (addScore({ n: e.n, sc: e.sc, lv: e.lv, seed: e.seed })) n++;
    return n;
  }

  /** The uid that owns a name (ignoring case/spacing), or 0. Reserved names are owned by uid -1. */
  const nameOwner = name => { const r = q.byKey.get(nameKey(name)); return r ? r.uid : (q.resGet.get(nameKey(name)) ? -1 : 0); };

  /** Log in with a Discord user: finds the account, or creates one with a free name. */
  function loginDiscord(discordId, wantName) {
    const now = Date.now();
    const found = q.byDiscord.get(String(discordId));
    if (found) { q.touch.run(now, found.uid); return { uid: found.uid, name: found.name, created: false }; }
    const base = String(wantName || 'Player').slice(0, 13) || 'Player';
    let name = base;
    for (let i = 2; nameOwner(name); i++) name = base + i;
    const r = q.create.run(String(discordId), name, nameKey(name), now, now);
    return { uid: Number(r.lastInsertRowid), name, created: true };
  }

  /** Change an account's name. Fails if another account has it. */
  function rename(uid, name) {
    const owner = nameOwner(name);
    if (owner && owner !== uid) return { ok: false, error: 'taken' };
    q.rename.run(name, nameKey(name), uid);
    return { ok: true, name };
  }
  const account = uid => q.byUid.get(uid) || null;

  /** Sessions: the browser keeps the token; we keep its hash. */
  function newSession(uid) {
    const token = crypto.randomBytes(32).toString('base64url');
    q.newSession.run(sha(token), uid, Date.now() + SESSION_DAYS * 864e5);
    return token;
  }
  const sessionUser = token => (token && typeof token === 'string' && token.length < 100 ? q.session.get(sha(token), Date.now()) || null : null);
  const endSession = token => { if (token) q.endSession.run(sha(token)); };
  const purgeSessions = () => q.purge.run(Date.now());

  return { addScore, topScores, topScore, recordGame, setProgress, award, profile, reserveName, unreserveName, isReserved, reservedNames, getSetting, putSetting, listAccounts, resetScores, importLegacy, nameOwner, loginDiscord, rename, account, newSession, sessionUser, endSession, purgeSessions, SESSION_DAYS, close: () => db.close() };
}

module.exports = { open, nameKey };
