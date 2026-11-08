'use strict';
/* One shared maze per room. A public room is just its seed; an invite-only room is
   seed + secret key, so it is never listed and can only be reached by its link.
   The server owns pellets, ghosts, scores and lives; clients own their own
   movement and report what they ate or hit. */
const M = require('../shared/maze.js');
const { DIRS } = M;

const RESUME_MS = 2 * 60 * 1000;   // keep a disconnected player's score/lives this long
const MAX_START_LEVEL = 50;       // highest level a host can start a new maze on

class Game {
  constructor(seed, key, opts) {
    this.seed = seed;          // drives maze generation
    this.key = key || '';      // secret for invite-only rooms; '' = public
    this.isPrivate = !!this.key;
    this.opts = opts;          // { onScore(entry) }
    this.players = new Map();  // id -> player
    this.resume = new Map();   // token -> { sc, li, over, at }
    this.emptySince = Date.now();
    this.tickNo = 0;
    // The host started this maze and decides when the next level begins.
    // If they leave, the longest-present player takes over; they get it back if they return.
    this.hostId = 0;
    this.creatorToken = '';
    this.startLevel(1, false, true);   // pre-game lobby: players gather until the host starts
  }

  /* ---------- levels ---------- */
  /** advance: true when moving on from a cleared level (that's when everyone earns a life). */
  startLevel(L, advance = false, lobby = false) {
    this.L = L;
    this.lv = M.genLevel(this.seed, L);
    this.bits = new Uint8Array(this.lv.bytes);
    this.left = this.lv.pList.length;
    this.ghosts = [];
    if (M.isBossLevel(L)) {   // one giant ghost with BOSS_HP hits, and two minions
      this.ghosts.push({ i: 0, tx: 0, ty: 0, d: -1, t: 0, st: 0, ep: 0, home: 2.5, rev: false, boss: true, hp: M.BOSS_HP });
      for (let i = 1; i <= 2; i++) this.ghosts.push({ i, tx: 0, ty: 0, d: -1, t: 0, st: 0, ep: 0, home: 4 + i * 3, rev: false });
    } else for (let i = 0; i < M.ghostCount(L); i++)
      this.ghosts.push({ i, tx: 0, ty: 0, d: -1, t: 0, st: 0, ep: 0, home: 1.5 + i * 2.5, rev: false });
    this.bullets = []; this.bossCd = 4; this.fruit = null; this.fruitsDone = 0; this.fruitSeq = this.fruitSeq || 0;
    this.downs = new Map(); this.teamEat = [0, 0]; this.bumpAt = new Map(); this.steals = new Map();
    this.fr = 0; this.fid = 0; this.ph = lobby ? 3 : 0; this.ct = 0; this.clock = 0; this.lastMode = -1;
    this.eatenSince = [];
    // loot crates: from level 3, 1 or 2 appear at random moments in the level
    this.crates = []; this.effects = []; this.pending = null; this.nukeIn = 0; this.lvStats = null; this.ghostEats = 0; this.crateSeq = this.crateSeq || 0;
    this.spawns = L >= M.POWERUP_FROM_LEVEL ? Array.from({ length: Math.random() < 0.5 ? 1 : 2 }, () => 6 + Math.random() * 30).sort((a, b) => a - b) : [];
    for (const p of this.players.values()) {
      p.x = this.lv.sx; p.y = this.lv.sy; p.combo = 0; p.lvEat = 0; p.lvBest = 0;
      if (!p.over) { p.al = true; p.spawnAt = Date.now(); if (advance) p.li = Math.min(5, p.li + 1); }
    }
    this.broadcast({ t: 'level', lv: L, ph: this.ph, adv: advance ? 1 : 0 });
  }

  /* ---------- membership ---------- */
  add(p, token) {
    if (!this.hostId && !this.creatorToken) this.creatorToken = token || ('id:' + p.id);
    if (!this.hostId || (token && token === this.creatorToken)) this.hostId = p.id;
    const r = token && this.resume.get(token);
    if (r) { p.sc = r.sc; p.li = r.li; p.over = r.over; this.resume.delete(token); }
    p.token = token;
    if (this.mode === 'versus') {   // even out the teams
      const r = r0 => [...this.players.values()].filter(q => q.team === r0).length;
      p.team = r(0) <= r(1) ? 0 : 1;
    } else p.team = 0;
    p.x = this.lv.sx; p.y = this.lv.sy;
    this.players.set(p.id, p);
    this.emptySince = 0;
    this.send(p, {
      t: 'welcome', id: p.id, seed: this.seed, key: this.key, vis: this.isPrivate ? 'private' : 'public', gid: this.gid, title: this.title || '', testMode: this.opts.testMode ? 1 : 0, link: this.link || '', locked: !!this.pass,
      lv: this.L, b: M.toB64(this.bits),
      roster: [...this.players.values()].map(q => [q.id, q.nm, q.col, q.mdl, q.ci, q.uid ? 1 : 0, q.uid || 0, q.team | 0]),
      mode: this.mode || 'coop', daily: this.daily || '',
      sc: p.sc, li: p.li, over: p.over, host: this.hostId, ph: this.ph,
      stats: (this.ph === 1 || this.ph === 2) ? this.lvStats : null,
      pu: this.pending ? { kind: this.pending.kind, by: this.pending.by, x: this.pending.x, y: this.pending.y } : null
    });
    this.broadcast({ t: 'join', id: p.id, nm: p.nm, col: p.col, mdl: p.mdl, ci: p.ci, reg: p.uid ? 1 : 0, uid: p.uid || 0, team: p.team | 0 }, p.id);
    if (this.ph === 6 && this.votes) {   // arrived mid-vote: they get a say too
      const pd = this.pending;
      this.send(p, { t: 'vote', by: pd.by, nm: pd.nm, x: pd.x, y: pd.y, crate: pd.crate, s: Math.round(this.ct * 10) / 10, tot: this.players.size });
      this.sendTally();
    }
  }

  remove(p) {
    if (!this.players.delete(p.id)) return;
    if (this.hostId === p.id) {
      const next = this.players.values().next().value;   // Map keeps join order
      this.hostId = next ? next.id : 0;
    }
    if (this.ph === 6 && this.votes) {   // a leaver's vote doesn't count; maybe everyone left has voted now
      this.votes.delete(p.id);
      if (this.players.size && this.votes.size >= this.players.size) this.endVote(); else this.sendTally();
    }
    // keep the run for a while so a reconnect resumes it; record the score once it expires
    if (p.token) this.resume.set(p.token, { sc: p.sc, li: p.li, over: p.over, nm: p.nm, uid: p.uid || 0, lv: this.L, at: Date.now() });
    else if (p.sc > 0 && !p.over) this.report(p);
    this.broadcast({ t: 'leave', id: p.id });
    if (!this.players.size) this.emptySince = Date.now();
  }

  /* ---------- messages from a player ---------- */
  onMessage(p, m) {
    switch (m.t) {
      case 'p': { // position
        const x = +m.x, y = +m.y;
        if (!isFinite(x) || !isFinite(y) || x < -1 || y < -1 || x > this.lv.W || y > this.lv.H) return;
        p.x = x; p.y = y; p.f = (m.f | 0) & 3;
        return;
      }
      case 'eat': {
        // Pellets eaten in the moment before a crate paused the game still count:
        // the player couldn't have known yet.
        const grace = (this.ph === 4 || this.ph === 6) && Date.now() - (this.pausedAt || 0) < 500;
        if ((this.ph !== 0 && !grace) || !p.al || p.over) return;
        if (m.x !== undefined) this.onMessage(p, { t: 'p', x: m.x, y: m.y, f: m.f });
        const list = Array.isArray(m.i) ? m.i.slice(0, 16) : [m.i];
        // the client counts its streak; it can't be longer than the pellets this player actually got
        const sk = (m.sk | 0) > 0 ? m.sk | 0 : 0;
        for (const raw of list) this.eat(p, raw | 0);
        if (sk) p.lvBest = Math.max(p.lvBest || 0, Math.min(sk, p.lvEat || 0));
        if (p.lvBest >= 100) this.achieve(p, 'streak100');
        return;
      }
      case 'ghost': {
        const g = this.ghosts[m.i | 0];
        if (!g || g.ep !== (m.ep | 0) || g.st !== 2 || !p.al) return;
        const [gx, gy] = M.entPos(g);
        // allow for latency: faster levels put client and server further apart
        if (Math.hypot(gx - p.x, gy - p.y) > 1.8 + M.ghostSpeed(this.L) * 0.15 + (g.boss ? 1 : 0)) return;
        if (g.boss) { this.hitBoss(g, p); return; }
        g.st = 3; g.ep++;
        if (p.fid !== this.fid) { p.fid = this.fid; p.combo = 0; }
        const pts = 200 * Math.pow(2, Math.min(p.combo, 3)); p.combo++;
        if (p.combo >= 4) this.achieve(p, 'quad');
        p.sc += pts;
        this.send(p, { t: 'pts', v: pts, x: gx, y: gy });
        return;
      }
      case 'fruit': {   // grabbed the bonus fruit
        const f = this.fruit;
        if (!f || f.id !== (m.id | 0) || !p.al || this.ph !== 0 || Math.hypot(f.x - p.x, f.y - p.y) > 1.6) return;
        const v = M.FRUITS[f.k].pts; p.sc += v; this.fruit = null;
        this.broadcast({ t: 'fruitgot', id: p.id, nm: p.nm, v, x: f.x, y: f.y, k: f.k });
        this.achieve(p, 'fruit');
        return;
      }
      case 'revive': {   // touched a fallen teammate's marker
        const d = this.downs.get(m.id | 0), o = this.players.get(m.id | 0);
        if (!d || !o || o === p || !p.al || Date.now() > d.until || Math.hypot(d.x - p.x, d.y - p.y) > 1.6) return;
        if (this.mode === 'versus' && o.team !== p.team) return;
        this.downs.delete(o.id);
        if (o.over) { o.over = false; o.li = 1; } else o.li = Math.min(5, o.li + 1);
        o.al = true; o.spawnAt = Date.now(); o.x = d.x; o.y = d.y;
        this.send(o, { t: 'revived', x: d.x, y: d.y, by: p.nm });
        this.broadcast({ t: 'revive', id: o.id, by: p.id, x: d.x, y: d.y });
        this.achieve(p, 'revive');
        return;
      }
      case 'bump': {   // versus: ran into an opponent. Whoever charged in steals the other's streak.
        const o = this.players.get(m.id | 0);
        if (this.mode !== 'versus' || !o || o === p || o.team === p.team || !o.al || !p.al || this.ph !== 0) return;
        const dx = o.x - p.x, dy = o.y - p.y, dist = Math.hypot(dx, dy);
        if (dist > 1.4) return;
        const key = Math.min(p.id, o.id) + '-' + Math.max(p.id, o.id), now = Date.now();
        if (now - (this.bumpAt.get(key) || 0) < 3000) return;
        const charging = (a, ux, uy) => { const [fx, fy] = DIRS[a.f & 3]; return dist < 0.05 || fx * ux + fy * uy > 0.5; };
        const pc = charging(p, dx / (dist || 1), dy / (dist || 1)), oc = charging(o, -dx / (dist || 1), -dy / (dist || 1));
        if (pc === oc) return;   // head-on (or nobody charging): nothing happens
        this.bumpAt.set(key, now);
        const thief = pc ? p : o, victim = pc ? o : p;
        this.steals.set(victim.id, { to: thief.id, at: now });
        this.send(victim, { t: 'bumped', by: thief.id, nm: thief.nm });
        return;
      }
      case 'give': {   // the bumped player hands over their streak
        const st = this.steals.get(p.id), o = st && this.players.get(st.to);
        if (!st || !o || Date.now() - st.at > 2000) return;
        this.steals.delete(p.id);
        const n = Math.max(0, Math.min(m.n | 0, p.lvEat || 0, 500));
        if (n) { this.send(o, { t: 'gain', n, nm: p.nm }); o.lvBest = Math.max(o.lvBest || 0, n); }
        this.broadcast({ t: 'steal', from: p.id, to: o.id, n });
        return;
      }
      case 'emo': {   // quick emote bubble over your character (keys 1-4)
        const e = m.e | 0, now = Date.now();
        if (e < 0 || e > 3 || now - (p.emoAt || 0) < 1200) return;
        p.emoAt = now; this.broadcast({ t: 'emo', id: p.id, e });
        return;
      }
      case 'cheer': {   // out of lives? you can still cheer the others on
        const e = m.e | 0, now = Date.now();
        if (!p.over || e < 0 || e > 2 || now - (p.cheerAt || 0) < 700) return;
        p.cheerAt = now; this.broadcast({ t: 'cheer', id: p.id, nm: p.nm, e });
        return;
      }
      case 'hf': {   // a high five (the client spotted it); both players must really be next to each other
        const o = this.players.get(m.id | 0);
        if (!o || o === p || !o.al || !p.al || Math.hypot(o.x - p.x, o.y - p.y) > 1.6) return;
        this.achieve(p, 'teamwork'); this.achieve(o, 'teamwork');
        return;
      }
      case 'die':
        if (!p.al || p.over || Date.now() - p.spawnAt < 1500) return;
        p.al = false; p.li = Math.max(0, p.li - 1);
        if (p.li === 0) { p.over = true; if (p.sc > 0) this.report(p); }
        if (this.players.size > 1) {   // a marker a teammate can touch to bring you back
          this.downs.set(p.id, { x: Math.round(p.x), y: Math.round(p.y), until: Date.now() + 8000 });
          this.broadcast({ t: 'down', id: p.id, x: Math.round(p.x), y: Math.round(p.y), s: 8 });
        }
        if (this.nukeIn > 0) {   // everyone had to survive: one death and the strike is called off
          this.nukeIn = 0;
          this.broadcast({ t: 'nukecancel', by: p.id, nm: p.nm });
        }
        return;
      case 'respawn':
        if (p.al || p.over || p.li <= 0) return;
        p.al = true; p.spawnAt = Date.now(); p.x = this.lv.sx; p.y = this.lv.sy;
        return;
      case 'ready':   // host starts the next level
        if (p.id !== this.hostId) return;
        if (this.ph === 2) this.startLevel(this.L + 1, true);
        else if (this.ph === 3) this.startLevel(this.L);   // whichever level the host picked in the lobby
        return;
      case 'startlv': {   // host picks the starting level in the lobby
        const lv = m.lv | 0;
        if (this.ph !== 3 || p.id !== this.hostId || lv < 1 || lv > MAX_START_LEVEL || lv === this.L || this.daily) return;   // the daily maze always starts at 1
        this.startLevel(lv, false, true);   // regenerate that maze for everyone, still in the lobby
        return;
      }
        return;
      case 'grab': {   // walked into a loot crate
        const c = this.crates.find(k => k.id === (m.id | 0));
        if (this.ph !== 0 || !c || !p.al || p.over) return;
        if (m.x !== undefined) this.onMessage(p, { t: 'p', x: m.x, y: m.y, f: m.f });
        let dx = Math.abs(p.x - c.x); dx = Math.min(dx, this.lv.W - dx);
        if (dx + Math.abs(p.y - c.y) > 1.6 + M.playerSpeed(this.L) * 0.08) return;
        this.crates = this.crates.filter(k => k !== c);
        // pause and let everyone vote on opening it; the slot only spins on a yes
        this.pending = { kind: -1, by: p.id, nm: p.nm, x: c.x, y: c.y, crate: c.id };
        this.ph = 6; this.ct = M.VOTE_TIME; this.pausedAt = Date.now();
        this.votes = new Map();
        this.broadcast({ t: 'vote', by: p.id, nm: p.nm, x: c.x, y: c.y, crate: c.id, s: M.VOTE_TIME, tot: this.players.size });
        return;
      }
      case 'vote': {   // yes / no on opening the crate
        if (this.ph !== 6 || !this.votes) return;
        this.votes.set(p.id, !!m.y);
        this.sendTally();
        if (this.votes.size >= this.players.size) this.endVote();
        return;
      }
      case 'testpu': {   // TEST_MODE: the host picks an effect; same pause and slot, no randomness
        const kind = m.kind | 0;
        if (!this.opts.testMode || p.id !== this.hostId || this.ph !== 0 || !M.POWERUPS[kind]) return;
        const x = Math.round(p.x), y = Math.round(p.y);
        this.pending = { kind, by: p.id, x, y };
        this.ph = 4; this.ct = M.PU_SPIN + M.PU_HOLD; this.pausedAt = Date.now();
        this.broadcast({ t: 'pu', kind, by: p.id, nm: p.nm, x, y, crate: 0, test: 1 });
        return;
      }
      case 'testfruit':   // tests only: pretend 70% of the pellets are gone so the fruit appears
        if (!this.opts.testHooks || this.ph !== 0) return;
        this.fruitsDone = 1; this.left = Math.max(1, Math.floor(this.lv.pList.length * 0.29)); this.checkFruit();
        return;
      case 'testcrate':   // tests only: put a crate right here (needs TEST_HOOKS=1)
        if (!this.opts.testHooks || this.ph !== 0) return;
        if (m.kind != null) this.opts.forcePowerup = m.kind | 0;
        { const c = { id: ++this.crateSeq, x: Math.round(p.x), y: Math.round(p.y) }; this.crates.push(c); this.broadcast({ t: 'crate', id: c.id, x: c.x, y: c.y }); }
        return;
      case 'again':
        if (!p.over) return;
        p.sc = 0; p.li = 3; p.over = false; p.al = true; p.spawnAt = Date.now();
        return;
    }
  }

  eat(p, i) {
    const lv = this.lv;
    if (i < 0 || i >= lv.W * lv.H || !lv.p[i] || M.getBit(this.bits, i)) return;
    // the player has to be close to the pellet they claim
    const tx = i % lv.W, ty = (i / lv.W) | 0;
    let dx = Math.abs(Math.round(p.x) - tx); dx = Math.min(dx, lv.W - dx);
    if (dx + Math.abs(Math.round(p.y) - ty) > 2 + M.playerSpeed(this.L) * 0.06 + (this.effect('magnet') ? 3 : 0) && !this.laserCanReach(p, tx, ty)) return;   // pellets eaten since the last update
    M.setBit(this.bits, i); this.left--; this.eatenSince.push(i);
    p.lvEat = (p.lvEat || 0) + 1;
    if (this.mode === 'versus') this.teamEat[p.team | 0]++;
    this.checkFruit();
    p.sc += lv.p[i] === 2 ? 50 : 10;
    if (lv.p[i] === 2) { this.frighten(); this.broadcast({ t: 'pw', id: p.id, i }); }   // everyone hears who powered up
    if (this.left <= 0) this.finishLevel(false);
  }

  /** Bonus fruit pops out at 30% and 70% of the pellets eaten. */
  checkFruit() {
    const total = this.lv.pList.length, eaten = total - this.left;
    if (this.fruitsDone < 2 && eaten >= total * (this.fruitsDone ? 0.7 : 0.3) && this.left > 0) {
      this.fruitsDone++;
      this.fruit = { id: ++this.fruitSeq, x: this.lv.sx, y: this.lv.sy, k: M.fruitFor(this.L), rem: M.FRUIT_TIME };
      this.broadcast({ t: 'fruit', id: this.fruit.id, x: this.fruit.x, y: this.fruit.y, k: this.fruit.k });
    }
  }
  /** A frightened boss got eaten: lose a hit and split, or go down for good. */
  hitBoss(g, p) {
    const [gx, gy] = M.entPos(g);
    g.hp--; g.ep++;
    if (g.hp <= 0) {
      g.st = 5;   // defeated: gone for the rest of the level
      for (const q of this.players.values()) if (!q.over) { q.sc += 2000; this.achieve(q, 'boss'); }
      this.bullets = [];
      this.broadcast({ t: 'boss', down: 1, x: gx, y: gy, by: p.id });
      return;
    }
    g.st = 3;   // back to the box as eyes, and it splits off two more ghosts
    for (let k = 0; k < 2; k++) this.ghosts.push({ i: this.ghosts.length, tx: Math.round(gx), ty: Math.round(gy), d: -1, t: 0, st: 1, ep: 0, home: 0, rev: false, split: true });
    p.sc += 1000;
    this.broadcast({ t: 'boss', hp: g.hp, x: gx, y: gy, by: p.id });
  }
  /** A hacked ghost eats the pellet on its tile. Counts towards clearing the level; scores nothing. */
  ghostEat(i) {
    const lv = this.lv;
    if (!lv.p[i] || M.getBit(this.bits, i)) return;
    M.setBit(this.bits, i); this.left--; this.eatenSince.push(i);
    this.ghostEats = (this.ghostEats || 0) + 1;
    this.checkFruit();
    if (this.left <= 0) this.finishLevel(false);
  }
  frighten(dur) {
    this.fr = dur || M.frightDuration(this.L); this.fid++;
    for (const g of this.ghosts) if (g.st === 1 || g.st === 2) { g.st = 2; g.rev = true; }
  }

  /** A finished run goes on the scoreboards (and the player's profile). */
  report(p) { this.opts.onScore({ uid: p.uid || 0, n: p.nm, sc: p.sc, lv: this.L, seed: this.seed, daily: this.daily || '', model: (M.MODELS[p.mdl] || {}).id || '' }); }
  /** Achievements only count for logged-in players; the server keeps track and says when one is new. */
  achieve(p, id) {
    if (!p || !p.uid || !this.opts.onAchieve) return;
    p.ach = p.ach || new Set(); if (p.ach.has(id)) return; p.ach.add(id);
    if (this.opts.onAchieve(p.uid, id)) this.send(p, { t: 'ach', id });
  }
  /** Level over: celebrate, and tell everyone who got what. */
  finishLevel(nuked) {
    this.ph = 1; this.ct = 3.9; this.nukeIn = 0;   // long enough for the slot reels to finish
    for (const p of this.players.values()) {
      if (p.over) continue;
      if (this.opts.onCleared && p.uid) this.opts.onCleared(p.uid, this.L);
      this.achieve(p, 'first'); if (this.L >= 10) this.achieve(p, 'level10'); if (this.L >= 25) this.achieve(p, 'level25');
    }
    const total = this.lv.pList.length || 1, rows = [];
    for (const p of this.players.values()) rows.push([p.id, p.nm, p.lvEat || 0, Math.round((p.lvEat || 0) * 1000 / total) / 10, p.lvBest || 0]);
    rows.sort((a, b) => b[2] - a[2] || b[4] - a[4]);
    const got = rows.reduce((s, r) => s + r[2], 0);
    let win = -2;
    if (this.mode === 'versus') {
      win = this.teamEat[0] === this.teamEat[1] ? -1 : this.teamEat[0] > this.teamEat[1] ? 0 : 1;
      for (const p of this.players.values()) if (p.team === win) this.achieve(p, 'versus');
    }
    this.fruit = null; this.bullets = [];
    this.lvStats = { lv: this.L, total, rows, teams: this.mode === 'versus' ? [...this.teamEat] : undefined, win, nuked: nuked ? Math.max(0, total - got - (this.ghostEats || 0)) : 0, ghosts: this.ghostEats || 0 };
    this.broadcast(Object.assign({ t: 'lvstats' }, this.lvStats));
  }

  /* ---------- crate votes ---------- */
  tally() { let y = 0, n = 0; for (const v of this.votes.values()) v ? y++ : n++; return { y, n }; }
  sendTally() { const { y, n } = this.tally(); this.broadcast({ t: 'vt', y, n, tot: this.players.size, s: Math.max(0, Math.round(this.ct * 10) / 10) }); }
  /** Majority of the votes cast decides; a tie, or nobody voting, opens it (someone did walk into it). */
  endVote() {
    const { y, n } = this.tally(), open = y >= n, pd = this.pending;
    this.votes = null;
    this.broadcast({ t: 'voted', open, y, n });
    if (!open) { this.pending = null; this.ph = 0; return; }   // binned: no spin, no effect
    pd.kind = this.opts.forcePowerup != null ? this.opts.forcePowerup : M.rollPowerup();   // forcing is for tests only
    this.ph = 4; this.ct = M.PU_SPIN + M.PU_HOLD;
    this.broadcast({ t: 'pu', kind: pd.kind, by: pd.by, nm: pd.nm, x: pd.x, y: pd.y, crate: pd.crate });
  }

  /* ---------- power-ups ---------- */
  effect(id) { return this.effects.find(e => M.POWERUPS[e.kind].id === id); }
  /** A laser reaches a pellet on the player's row or column with no wall in between. */
  laserCanReach(p, tx, ty) {
    if (!this.effect('laser')) return false;
    const lv = this.lv, px = Math.round(p.x), py = Math.round(p.y);
    if (px !== tx && py !== ty) return false;
    const sx = Math.sign(tx - px), sy = Math.sign(ty - py);
    for (let x = px, y = py, n = 0; n < lv.W + lv.H; n++) {
      if (x === tx && y === ty) return true;
      x += sx; y += sy;
      if (x < 0 || y < 0 || x >= lv.W || y >= lv.H || lv.t[y * lv.W + x] !== 0) return false;
    }
    return false;
  }
  tickPowerups(dt, players) {
    // spawn crates on schedule, away from players and the ghost box
    while (this.spawns.length && this.clock >= this.spawns[0]) {
      this.spawns.shift();
      const lv = this.lv, open = [];
      for (let y = 1; y < lv.H - 1; y++) for (let x = 1; x < lv.W - 1; x++) {
        if (lv.t[y * lv.W + x] !== 0) continue;
        if (Math.abs(x - lv.mid) <= 4 && Math.abs(y - lv.cy) <= 3) continue;
        if (players.some(p => Math.abs(p.x - x) + Math.abs(p.y - y) < 6)) continue;
        if (this.crates.some(c => c.x === x && c.y === y)) continue;
        open.push([x, y]);
      }
      if (!open.length) continue;
      const [x, y] = open[Math.random() * open.length | 0], c = { id: ++this.crateSeq, x, y };
      this.crates.push(c);
      this.broadcast({ t: 'crate', id: c.id, x, y });
    }
    // count down running effects
    for (const e of this.effects) e.rem -= dt;
    for (const e of this.effects.filter(e => e.rem <= 0)) this.expire(e);
    this.effects = this.effects.filter(e => e.rem > 0);
    if (this.effect('laser')) this.laserGhosts(players);
  }
  /** Laser Beamz also kills: any ghost on a beam is sent home as eyes. */
  laserGhosts(players) {
    const lv = this.lv;
    for (const p of players) {
      const f = p.f & 3, [dx, dy] = DIRS[f], px = Math.round(p.x), py = Math.round(p.y);
      let ex = px, ey = py;
      for (let n = 0; n < lv.W + lv.H; n++) {
        const nx = ex + dx, ny = ey + dy;
        if (nx < 0 || ny < 0 || nx >= lv.W || ny >= lv.H || lv.t[ny * lv.W + nx] !== 0) break;
        ex = nx; ey = ny;
      }
      for (const g of this.ghosts) {
        if (g.st !== 1 && g.st !== 2) continue;
        const [gx, gy] = M.entPos(g);
        // along the beam: from just behind the player to the far wall; across it: within 0.6 of a tile
        const along = dx ? (gx - p.x) * dx : (gy - p.y) * dy, reach = dx ? Math.abs(ex - p.x) : Math.abs(ey - p.y);
        const off = dx ? Math.abs(gy - py) : Math.abs(gx - px);
        if (off > 0.6 || along < -0.6 || along > reach + 0.5) continue;
        g.st = 3; g.ep++;
        p.sc += 200;
        this.send(p, { t: 'pts', v: 200, x: gx, y: gy });
        this.broadcast({ t: 'zap', x: gx, y: gy });
      }
    }
  }
  activate({ kind, by }) {
    const pu = M.POWERUPS[kind];
    switch (pu.id) {
      case 'megapellet': this.frighten(10); break;
      case 'bomb':   // every ghost out on the maze is sent back to the box as eyes
        for (const g of this.ghosts) if (g.st === 1 || g.st === 2) { g.st = 3; g.ep++; }
        break;
      case 'swap': {   // the opener trades places with the nearest ghost
        const p = this.players.get(by); if (!p) break;
        let best = null, bd = 1e9;
        for (const g of this.ghosts) if (g.st === 1 || g.st === 2) { const [gx, gy] = M.entPos(g), d = Math.hypot(gx - p.x, gy - p.y); if (d < bd) { bd = d; best = g; } }
        if (!best) break;
        const [gx, gy] = M.entPos(best), to = [Math.round(gx), Math.round(gy)];
        const here = this.openTileNear(p.x, p.y), lw = this.lv.W;
        best.tx = here % lw; best.ty = (here / lw) | 0; best.t = 0; best.d = -1;
        p.x = to[0]; p.y = to[1];
        this.send(p, { t: 'swapto', x: to[0], y: to[1] });
        break;
      }
      case 'phone': {
        const g = { i: this.ghosts.length, tx: this.lv.mid, ty: this.lv.cy - 2, d: -1, t: 0, st: 1, ep: 0, home: 0, rev: false, phone: true };
        this.ghosts.push(g);
        break;
      }
    }
    if (pu.dur > 0) {
      const same = this.effects.find(e => e.kind === kind);
      if (same && pu.id !== 'phone') { same.rem = pu.dur; same.by = by; }   // a repeat refreshes the timer
      else this.effects.push({ kind, by, rem: pu.dur });
    }
    this.broadcast({ t: 'puon', kind, by });
  }
  expire(e) {
    if (M.POWERUPS[e.kind].id === 'phone') {   // the extra ghost hangs up
      const idx = this.ghosts.findIndex(g => g.phone);
      if (idx >= 0) { this.ghosts.splice(idx, 1); this.ghosts.forEach((g, i) => { g.i = i; }); }
    }
  }

  /* ---------- ghost AI ---------- */
  target(g, players) {
    const lv = this.lv, corners = [[lv.W - 1, -2], [0, -2], [lv.W - 1, lv.H + 1], [0, lv.H + 1]];
    if (g.st === 3) return [lv.mid, lv.cy - 2];
    const scatter = (this.clock % 27) < 7;
    if (scatter || !players.length) return corners[g.i % 4];
    let best = null, bd = 1e9;
    for (const p of players) { const d = Math.abs(p.x - g.tx) + Math.abs(p.y - g.ty); if (d < bd) { bd = d; best = p; } }
    const px = Math.round(best.x), py = Math.round(best.y), [fx, fy] = DIRS[best.f & 3];
    switch (g.i % 4) {
      case 0: return [px, py];                                   // chaser
      case 1: return [px + 4 * fx, py + 4 * fy];                 // ambusher
      case 2: { const g0 = this.ghosts[0], ax = px + 2 * fx, ay = py + 2 * fy; return [2 * ax - g0.tx, 2 * ay - g0.ty]; } // flanker
      default: return bd > 8 ? [px, py] : corners[3];            // shy
    }
  }
  /** Nearest open tile to (x, y): ghost targets are often off the map or inside a wall. */
  openTileNear(x, y) {
    const lv = this.lv;
    x = Math.max(0, Math.min(lv.W - 1, Math.round(x))); y = Math.max(0, Math.min(lv.H - 1, Math.round(y)));
    if (lv.t[y * lv.W + x] === 0) return y * lv.W + x;
    for (let r = 1; r < lv.W + lv.H; r++) {
      let best = -1, bd = 1e9;
      for (let dy = -r; dy <= r; dy++) {
        const dx = r - Math.abs(dy);
        for (const sx of dx ? [-dx, dx] : [0]) {
          const nx = x + sx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= lv.W || ny >= lv.H || lv.t[ny * lv.W + nx] !== 0) continue;
          const d = sx * sx + dy * dy; if (d < bd) { bd = d; best = ny * lv.W + nx; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
  /** Walking distance from every tile to tile `to` (breadth-first, through the side tunnels). */
  distFrom(to) {
    const lv = this.lv, n = lv.W * lv.H;
    if (!this.dist || this.dist.length !== n) { this.dist = new Int32Array(n); this.bfsQ = new Int32Array(n); }
    const dist = this.dist, q = this.bfsQ; dist.fill(-1);
    dist[to] = 0; q[0] = to; let head = 0, tail = 1;
    while (head < tail) {
      const i = q[head++], x = i % lv.W, y = (i / lv.W) | 0;
      for (let d = 0; d < 4; d++) {
        if (!M.canGo(lv, x, y, d)) continue;
        const j = (y + DIRS[d][1]) * lv.W + M.wrapX(lv, x + DIRS[d][0]);
        if (dist[j] < 0) { dist[j] = dist[i] + 1; q[tail++] = j; }
      }
    }
    return dist;
  }
  chooseDir(g, players) {
    const lv = this.lv, back = g.d >= 0 ? (g.d + 2) % 4 : -1, o = [];
    for (let d = 0; d < 4; d++) { if (d === back) continue; if (M.canGo(lv, g.tx, g.ty, d)) o.push(d); }
    if (!o.length) return M.canGo(lv, g.tx, g.ty, back) ? back : -1;
    if (o.length === 1) return o[0];
    // Loop guard: a ghost that keeps coming back to the same junction wanders off for a few turns.
    const here = g.ty * lv.W + g.tx;
    g.hist = g.hist || []; g.hist.push(here); if (g.hist.length > 16) g.hist.shift();
    if (g.wander > 0 && g.st !== 3) { g.wander--; return o[Math.random() * o.length | 0]; }
    if (g.st !== 3 && g.hist.filter(h => h === here).length >= 4) { g.hist.length = 0; g.wander = 3; return o[Math.random() * o.length | 0]; }
    if (g.st === 2 || (g.st === 1 && !players.length)) return o[Math.random() * o.length | 0];
    // Head for the target along the real shortest path, not "whichever neighbour is closest
    // as the crow flies"; that rule is what sent ghosts circling the same block forever.
    const [tx, ty] = this.target(g, players), goal = this.openTileNear(tx, ty);
    const dist = goal >= 0 ? this.distFrom(goal) : null;
    let best = -1, bd = 1e9;
    for (const d of o) {
      const nx = M.wrapX(lv, g.tx + DIRS[d][0]), ny = g.ty + DIRS[d][1], dd = dist ? dist[ny * lv.W + nx] : -1;
      if (dd >= 0 && dd < bd) { bd = dd; best = d; }
    }
    if (best >= 0) return best;
    for (const d of o) { const nx = g.tx + DIRS[d][0], ny = g.ty + DIRS[d][1], dd = (nx - tx) ** 2 + (ny - ty) ** 2; if (dd < bd) { bd = dd; best = d; } }
    return best;
  }
  moveGhost(g, dist, players) {
    const lv = this.lv; let guard = 0;
    while (dist > 1e-6 && guard++ < 12) {
      if (g.rev) {
        g.rev = false;
        if (g.d >= 0) {
          if (g.t > 0) { g.tx = M.wrapX(lv, g.tx + DIRS[g.d][0]); g.ty += DIRS[g.d][1]; g.t = 1 - g.t; }
          g.d = (g.d + 2) % 4;
          if (g.t === 0 && !M.canGo(lv, g.tx, g.ty, g.d)) g.d = this.chooseDir(g, players);
        }
      }
      if (g.d < 0) { g.d = this.chooseDir(g, players); if (g.d < 0) return; }
      const rem = 1 - g.t;
      if (dist < rem) { g.t += dist; return; }
      dist -= rem; g.tx = M.wrapX(lv, g.tx + DIRS[g.d][0]); g.ty += DIRS[g.d][1]; g.t = 0;
      if ((g.st === 1 || g.st === 2) && this.effect('hacker')) this.ghostEat(g.ty * lv.W + g.tx);   // HACKER: ghosts munch pellets
      if (this.ph !== 0) return;   // that pellet may have finished the level
      if (g.st === 3 && g.tx === lv.mid && g.ty === lv.cy - 2) { g.st = 0; g.home = 1.2; g.d = -1; return; }
      g.d = this.chooseDir(g, players);
    }
  }

  /* ---------- simulation ---------- */
  tick(dt, sendState) {
    this.tickNo++;
    const now = Date.now();
    if (this.tickNo % 30 === 0) for (const [k, r] of this.resume) if (now - r.at > RESUME_MS) {
      this.resume.delete(k);
      if (r.sc > 0 && !r.over) this.opts.onScore({ uid: r.uid || 0, n: r.nm, sc: r.sc, lv: r.lv, seed: this.seed, daily: this.daily || '' });
    }
    if (!this.players.size) return;
    this.clock += dt;
    if (this.ph === 1) {             // celebrating
      this.ct -= dt;
      if (this.ct <= 0) { this.ph = 2; this.ct = 0; }
    } else if (this.ph === 6) {      // voting on a crate; everything is paused
      this.ct -= dt;
      if (this.ct <= 0) this.endVote();
    } else if (this.ph === 4) {      // power-up slot on screen; everything is paused
      this.ct -= dt;
      if (this.ct <= 0) {
        const pu = M.POWERUPS[this.pending.kind];
        if (pu.id === 'nuke') {   // play on: everyone has to survive until it arrives
          this.ph = 0; this.nukeIn = this.nukeIn > 0 ? Math.min(this.nukeIn, M.NUKE_WARN) : M.NUKE_WARN;
          this.broadcast({ t: 'nukewarn', s: this.nukeIn, by: this.pending.by });
          this.pending = null;
        }
        else { this.ph = 0; this.activate(this.pending); this.pending = null; }
      }
    } else if (this.ph === 0 && this.nukeIn > 0 && (this.nukeIn -= dt) <= 0) {   // it's here: jet, drop, blast
      this.nukeIn = 0; this.ph = 5; this.ct = M.NUKE_TIME;
      for (const i of this.lv.pList) M.setBit(this.bits, i);
      this.left = 0; this.crates = [];
      this.broadcast({ t: 'nuke' });
      for (const p of this.players.values()) if (!p.over) this.achieve(p, 'nuke');
    } else if (this.ph === 5) {      // nuke going off; still paused
      this.ct -= dt;
      if (this.ct <= 0) {
        this.pending = null; this.effects = [];
        this.finishLevel(true);   // level passed: on to the usual celebration
      }
    } else if (this.ph === 2 || this.ph === 3) {   // waiting for the host
      if (!this.players.has(this.hostId)) { const next = this.players.values().next().value; this.hostId = next ? next.id : 0; }
    } else {
      if (this.fr > 0) { this.fr -= dt; if (this.fr <= 0) { this.fr = 0; for (const g of this.ghosts) if (g.st === 2) g.st = 1; } }
      const mode = (this.clock % 27) < 7 ? 0 : 1;
      if (this.lastMode >= 0 && mode !== this.lastMode) for (const g of this.ghosts) if (g.st === 1) g.rev = true;
      this.lastMode = mode;
      const players = [];
      for (const p of this.players.values()) if (p.al && !p.over) players.push(p);
      const base = M.ghostSpeed(this.L), lv = this.lv;
      this.tickPowerups(dt, players);
      const frozen = !!this.effect('freeze');
      for (const g of this.ghosts) {
        if (g.st === 5) continue;   // a defeated boss
        if (frozen && g.st !== 3) continue;   // FREEZE: everything but eyes stands still
        if (g.st === 0) { g.home -= dt; if (g.home <= 0) { g.st = 1; g.tx = lv.mid; g.ty = lv.cy - 2; g.t = 0; g.d = -1; } continue; }
        this.moveGhost(g, (g.st === 3 ? M.eyesSpeed(this.L) : g.st === 2 ? M.frightGhostSpeed(this.L) : base) * (g.boss && g.st !== 3 ? 0.85 : 1) * dt, players);
      }
      if (this.ph !== 0) { if (sendState) this.sendState(); return; }
      // the boss shoots slow fireballs at the nearest player
      const boss = this.ghosts.find(g => g.boss && g.st === 1);
      if (boss && players.length && !frozen && (this.bossCd -= dt) <= 0) {
        this.bossCd = 3.2;
        const [bx, by] = M.entPos(boss);
        let tgt = players[0], bd = 1e9; for (const q of players) { const d = Math.hypot(q.x - bx, q.y - by); if (d < bd) { bd = d; tgt = q; } }
        const dx = tgt.x - bx, dy = tgt.y - by, n = Math.hypot(dx, dy) || 1, sp = 4.5 + this.L * 0.05;
        this.bullets.push({ x: bx, y: by, vx: dx / n * sp, vy: dy / n * sp, life: 4 });
      }
      this.bullets = this.bullets.filter(b => {
        b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
        const tx = Math.round(b.x), ty = Math.round(b.y);
        return b.life > 0 && tx >= 0 && ty >= 0 && tx < lv.W && ty < lv.H && lv.t[ty * lv.W + tx] === 0;
      });
      if (this.fruit && (this.fruit.rem -= dt) <= 0) this.fruit = null;
    }
    if (sendState) this.sendState();
  }

  sendState() {
    const r2 = v => Math.round(v * 100) / 100;
    const msg = JSON.stringify({
      t: 's', lv: this.L, ph: this.ph, ct: r2(this.ct), fr: r2(this.fr), fid: this.fid, h: this.hostId,
      g: this.ghosts.map(g => { const [x, y] = M.entPos(g); return [r2(x), r2(y), g.d, g.st, g.ep, g.phone ? 1 : 0, g.boss ? 1 : 0, g.hp | 0]; }),
      bl: this.bullets && this.bullets.length ? this.bullets.map(b => [r2(b.x), r2(b.y)]) : undefined,
      ft: this.fruit ? [this.fruit.id, this.fruit.x, this.fruit.y, this.fruit.k, r2(this.fruit.rem)] : undefined,
      tm: this.mode === 'versus' ? this.teamEat : undefined,
      fx: this.effects.map(e => [e.kind, r2(e.rem), e.by]),
      nk: this.nukeIn > 0 ? r2(this.nukeIn) : undefined,
      c: this.crates.map(c => [c.id, c.x, c.y]),
      p: [...this.players.values()].map(p => [p.id, r2(p.x), r2(p.y), p.f, p.al ? 1 : 0, p.sc, p.li, p.over ? 1 : 0]),
      e: this.eatenSince,
      left: this.left,
      b: (this.syncN = (this.syncN || 0) + 1) % 30 === 0 ? M.toB64(this.bits) : undefined   // full resync every ~2 s
    });
    this.eatenSince = [];
    for (const p of this.players.values()) p.ws.send(msg);
  }

  send(p, obj) { p.ws.send(JSON.stringify(obj)); }
  broadcast(obj, exceptId) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.id !== exceptId) p.ws.send(s);
  }
}

module.exports = { Game };
