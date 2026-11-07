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
    for (let i = 0; i < M.ghostCount(L); i++)
      this.ghosts.push({ i, tx: 0, ty: 0, d: -1, t: 0, st: 0, ep: 0, home: 1.5 + i * 2.5, rev: false });
    this.fr = 0; this.fid = 0; this.ph = lobby ? 3 : 0; this.ct = 0; this.clock = 0; this.lastMode = -1;
    this.eatenSince = [];
    // loot crates: from level 3, 1 or 2 appear at random moments in the level
    this.crates = []; this.effects = []; this.pending = null; this.crateSeq = this.crateSeq || 0;
    this.spawns = L >= M.POWERUP_FROM_LEVEL ? Array.from({ length: Math.random() < 0.5 ? 1 : 2 }, () => 6 + Math.random() * 30).sort((a, b) => a - b) : [];
    for (const p of this.players.values()) {
      p.x = this.lv.sx; p.y = this.lv.sy; p.combo = 0;
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
    p.x = this.lv.sx; p.y = this.lv.sy;
    this.players.set(p.id, p);
    this.emptySince = 0;
    this.send(p, {
      t: 'welcome', id: p.id, seed: this.seed, key: this.key, vis: this.isPrivate ? 'private' : 'public', title: this.title || '', testMode: this.opts.testMode ? 1 : 0, link: this.link || '', locked: !!this.pass,
      lv: this.L, b: M.toB64(this.bits),
      roster: [...this.players.values()].map(q => [q.id, q.nm, q.col, q.mdl, q.ci]),
      sc: p.sc, li: p.li, over: p.over, host: this.hostId, ph: this.ph,
      pu: this.pending ? { kind: this.pending.kind, by: this.pending.by, x: this.pending.x, y: this.pending.y } : null
    });
    this.broadcast({ t: 'join', id: p.id, nm: p.nm, col: p.col, mdl: p.mdl, ci: p.ci }, p.id);
  }

  remove(p) {
    if (!this.players.delete(p.id)) return;
    if (this.hostId === p.id) {
      const next = this.players.values().next().value;   // Map keeps join order
      this.hostId = next ? next.id : 0;
    }
    // keep the run for a while so a reconnect resumes it; record the score once it expires
    if (p.token) this.resume.set(p.token, { sc: p.sc, li: p.li, over: p.over, nm: p.nm, lv: this.L, at: Date.now() });
    else if (p.sc > 0 && !p.over) this.opts.onScore({ n: p.nm, sc: p.sc, lv: this.L, seed: this.seed });
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
        const grace = this.ph === 4 && (M.PU_SPIN + M.PU_HOLD) - this.ct < 0.5;
        if ((this.ph !== 0 && !grace) || !p.al || p.over) return;
        if (m.x !== undefined) this.onMessage(p, { t: 'p', x: m.x, y: m.y, f: m.f });
        const list = Array.isArray(m.i) ? m.i.slice(0, 16) : [m.i];
        for (const raw of list) this.eat(p, raw | 0);
        return;
      }
      case 'ghost': {
        const g = this.ghosts[m.i | 0];
        if (!g || g.ep !== (m.ep | 0) || g.st !== 2 || !p.al) return;
        const [gx, gy] = M.entPos(g);
        // allow for latency: faster levels put client and server further apart
        if (Math.hypot(gx - p.x, gy - p.y) > 1.8 + M.ghostSpeed(this.L) * 0.15) return;
        g.st = 3; g.ep++;
        if (p.fid !== this.fid) { p.fid = this.fid; p.combo = 0; }
        const pts = 200 * Math.pow(2, Math.min(p.combo, 3)); p.combo++;
        p.sc += pts;
        this.send(p, { t: 'pts', v: pts, x: gx, y: gy });
        return;
      }
      case 'die':
        if (!p.al || p.over || Date.now() - p.spawnAt < 1500) return;
        p.al = false; p.li = Math.max(0, p.li - 1);
        if (p.li === 0) { p.over = true; if (p.sc > 0) this.opts.onScore({ n: p.nm, sc: p.sc, lv: this.L, seed: this.seed }); }
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
        if (this.ph !== 3 || p.id !== this.hostId || lv < 1 || lv > MAX_START_LEVEL || lv === this.L) return;
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
        const kind = this.opts.forcePowerup != null ? this.opts.forcePowerup : M.rollPowerup();   // forcing is for tests only
        this.pending = { kind, by: p.id, x: c.x, y: c.y };
        this.ph = 4; this.ct = M.PU_SPIN + M.PU_HOLD;
        this.broadcast({ t: 'pu', kind, by: p.id, nm: p.nm, x: c.x, y: c.y, crate: c.id });
        return;
      }
      case 'testpu': {   // TEST_MODE: the host picks an effect; same pause and slot, no randomness
        const kind = m.kind | 0;
        if (!this.opts.testMode || p.id !== this.hostId || this.ph !== 0 || !M.POWERUPS[kind]) return;
        const x = Math.round(p.x), y = Math.round(p.y);
        this.pending = { kind, by: p.id, x, y };
        this.ph = 4; this.ct = M.PU_SPIN + M.PU_HOLD;
        this.broadcast({ t: 'pu', kind, by: p.id, nm: p.nm, x, y, crate: 0, test: 1 });
        return;
      }
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
    if (dx + Math.abs(Math.round(p.y) - ty) > 2 + M.playerSpeed(this.L) * 0.06 && !this.laserCanReach(p, tx, ty)) return;   // pellets eaten since the last update
    M.setBit(this.bits, i); this.left--; this.eatenSince.push(i);
    p.sc += lv.p[i] === 2 ? 50 : 10;
    if (lv.p[i] === 2) { this.frighten(); this.broadcast({ t: 'pw', id: p.id, i }); }   // everyone hears who powered up
    if (this.left <= 0) { this.ph = 1; this.ct = 3.9; }   // long enough for the slot reels to finish
  }

  frighten(dur) {
    this.fr = dur || M.frightDuration(this.L); this.fid++;
    for (const g of this.ghosts) if (g.st === 1 || g.st === 2) { g.st = 2; g.rev = true; }
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
      if (r.sc > 0 && !r.over) this.opts.onScore({ n: r.nm, sc: r.sc, lv: r.lv, seed: this.seed });
    }
    if (!this.players.size) return;
    this.clock += dt;
    if (this.ph === 1) {             // celebrating
      this.ct -= dt;
      if (this.ct <= 0) { this.ph = 2; this.ct = 0; }
    } else if (this.ph === 4) {      // power-up slot on screen; everything is paused
      this.ct -= dt;
      if (this.ct <= 0) {
        const pu = M.POWERUPS[this.pending.kind];
        if (pu.id === 'nuke') {
          this.ph = 5; this.ct = M.NUKE_TIME;
          for (const i of this.lv.pList) M.setBit(this.bits, i);
          this.left = 0;
          this.broadcast({ t: 'nuke', x: this.pending.x, y: this.pending.y });
        }
        else { this.ph = 0; this.activate(this.pending); this.pending = null; }
      }
    } else if (this.ph === 5) {      // nuke going off; still paused
      this.ct -= dt;
      if (this.ct <= 0) {
        this.pending = null; this.effects = [];
        this.ph = 1; this.ct = 3.9;   // level passed: on to the usual celebration
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
      for (const g of this.ghosts) {
        if (g.st === 0) { g.home -= dt; if (g.home <= 0) { g.st = 1; g.tx = lv.mid; g.ty = lv.cy - 2; g.t = 0; g.d = -1; } continue; }
        this.moveGhost(g, (g.st === 3 ? M.eyesSpeed(this.L) : g.st === 2 ? M.frightGhostSpeed(this.L) : base) * dt, players);
      }
    }
    if (sendState) this.sendState();
  }

  sendState() {
    const r2 = v => Math.round(v * 100) / 100;
    const msg = JSON.stringify({
      t: 's', lv: this.L, ph: this.ph, ct: r2(this.ct), fr: r2(this.fr), fid: this.fid, h: this.hostId,
      g: this.ghosts.map(g => { const [x, y] = M.entPos(g); return [r2(x), r2(y), g.d, g.st, g.ep, g.phone ? 1 : 0]; }),
      fx: this.effects.map(e => [e.kind, r2(e.rem), e.by]),
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
