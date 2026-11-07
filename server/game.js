'use strict';
/* One shared maze per room. A public room is just its seed; an invite-only room is
   seed + secret key, so it is never listed and can only be reached by its link.
   The server owns pellets, ghosts, scores and lives; clients own their own
   movement and report what they ate or hit. */
const M = require('../shared/maze.js');
const { DIRS } = M;

const RESUME_MS = 2 * 60 * 1000; // keep a disconnected player's score/lives this long

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
    this.startLevel(1);
    this.ph = 3;   // pre-game lobby: players gather until the host starts
  }

  /* ---------- levels ---------- */
  startLevel(L) {
    this.L = L;
    this.lv = M.genLevel(this.seed, L);
    this.bits = new Uint8Array(this.lv.bytes);
    this.left = this.lv.pList.length;
    this.ghosts = [];
    for (let i = 0; i < M.ghostCount(L); i++)
      this.ghosts.push({ i, tx: 0, ty: 0, d: -1, t: 0, st: 0, ep: 0, home: 1.5 + i * 2.5, rev: false });
    this.fr = 0; this.fid = 0; this.ph = 0; this.ct = 0; this.clock = 0; this.lastMode = -1;
    this.eatenSince = [];
    for (const p of this.players.values()) {
      p.x = this.lv.sx; p.y = this.lv.sy; p.combo = 0;
      if (!p.over) { p.al = true; p.spawnAt = Date.now(); if (L > 1) p.li = Math.min(5, p.li + 1); }
    }
    this.broadcast({ t: 'level', lv: L });
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
      t: 'welcome', id: p.id, seed: this.seed, key: this.key, vis: this.isPrivate ? 'private' : 'public',
      lv: this.L, b: M.toB64(this.bits),
      roster: [...this.players.values()].map(q => [q.id, q.nm, q.col, q.mdl]),
      sc: p.sc, li: p.li, over: p.over, host: this.hostId, ph: this.ph
    });
    this.broadcast({ t: 'join', id: p.id, nm: p.nm, col: p.col, mdl: p.mdl }, p.id);
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
        if (this.ph !== 0 || !p.al || p.over) return;
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
        if (this.ph === 2) this.startLevel(this.L + 1);
        else if (this.ph === 3) this.startLevel(1);
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
    if (dx + Math.abs(Math.round(p.y) - ty) > 2 + M.playerSpeed(this.L) * 0.06) return;   // pellets eaten since the last update
    M.setBit(this.bits, i); this.left--; this.eatenSince.push(i);
    p.sc += lv.p[i] === 2 ? 50 : 10;
    if (lv.p[i] === 2) this.frighten();
    if (this.left <= 0) { this.ph = 1; this.ct = 2.6; }
  }

  frighten() {
    this.fr = M.frightDuration(this.L); this.fid++;
    for (const g of this.ghosts) if (g.st === 1 || g.st === 2) { g.st = 2; g.rev = true; }
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
  chooseDir(g, players) {
    const lv = this.lv, back = g.d >= 0 ? (g.d + 2) % 4 : -1, o = [];
    for (let d = 0; d < 4; d++) { if (d === back) continue; if (M.canGo(lv, g.tx, g.ty, d)) o.push(d); }
    if (!o.length) return M.canGo(lv, g.tx, g.ty, back) ? back : -1;
    if (g.st === 2) return o[Math.random() * o.length | 0];
    const [tx, ty] = this.target(g, players);
    let best = o[0], bd = 1e9;
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
      g: this.ghosts.map(g => { const [x, y] = M.entPos(g); return [r2(x), r2(y), g.d, g.st, g.ep]; }),
      p: [...this.players.values()].map(p => [p.id, r2(p.x), r2(p.y), p.f, p.al ? 1 : 0, p.sc, p.li, p.over ? 1 : 0]),
      e: this.eatenSince
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
