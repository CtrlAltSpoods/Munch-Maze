/* Munch Maze browser client. Talks to the server over a WebSocket at ./ws */
(function () {
'use strict';
const M = window.MazeCore;
const { DIRS } = M;
const $ = id => document.getElementById(id);
const A = window.MazeAudio || { unlock() {}, startMusic() {}, stopMusic() {}, setFright() {}, setMusicVolume() {}, setSfxVolume() {}, sfx() {} };
const GCOL = ['#ff4d5e', '#ff9ad5', '#41e0f0', '#ffb347', '#7ee081', '#b48cff'];
const INK = '#0a0c1c', INK2 = '#10133a';
/* Highest level reached, kept in a cookie for a little over a year (the most browsers allow). */
const cookie = {
  get(k) { try { const m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; } },
  set(k, v) { try { document.cookie = k + '=' + encodeURIComponent(v) + '; Max-Age=34560000; Path=/; SameSite=Lax'; } catch (e) { /* ignore */ } }
};
const MAX_START_LEVEL = 50;
let bestLevel = Math.max(1, parseInt(cookie.get('mm_best_level'), 10) || 1);
function recordLevel(L) { if (L > bestLevel) { bestLevel = L; cookie.set('mm_best_level', String(L)); } }
// Highest level cleared, which unlocks characters and colours. Reaching level N means N-1 was cleared.
let clearedLevel = Math.max(parseInt(cookie.get('mm_cleared'), 10) || 0, bestLevel - 1);
function recordCleared(L) { if (L > clearedLevel) { clearedLevel = L; cookie.set('mm_cleared', String(L)); refreshPicker(); } }
const modelOpen = i => clearedLevel >= M.modelUnlock(i);
const colourOpen = k => clearedLevel >= M.colourUnlock(k);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
};
let token = '';
try { token = sessionStorage.getItem('mm.tok') || ''; } catch (e) { /* ignore */ }
if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); try { sessionStorage.setItem('mm.tok', token); } catch (e) { /* ignore */ } }

/* ---------- state ---------- */
const S = {
  name: '', seed: '', color: '#ffcc33', model: 0, ci: 0,
  ws: null, id: 0, inGame: false, wantGame: false, reconnectT: 0,
  key: '', vis: 'public', inviteKey: '', room: '', lname: '', title: '',   // inviteKey: from an invite link we arrived with
  L: 0, lvl: null, me: { tx: 0, ty: 0, d: -1, t: 0, want: -1, face: 2 },
  myBits: new Uint8Array(1), srvBits: new Uint8Array(1),
  sc: 0, li: 3, over: false, alive: true, deadT: 0, inv: 0, ge: [],
  ph: 0, fr: 0, fid: 0, roster: new Map(), players: [], gTarget: [], gv: [], ov: new Map(),
  streak: 0, streakT: 0, streakTier: 0, shownScore: 0, mazeGlow: null, bulbs: [],
  host: 0, eatQ: [], pend: new Map(), left: -1,
  crates: [], fx: [], grabbing: 0, nuked: false, prevFx: '',
  time: 0, lastT: performance.now(), bannerT: 0, camX: null, camY: null, mazeKey: '', mazeCv: null, mazeFlash: null
};
{ // remembered character and colour
  const mdl = parseInt(store.get('mm.model'), 10), ci = parseInt(store.get('mm.ci'), 10);
  let look = M.pickModel(Number.isFinite(mdl) ? mdl : 0, Number.isFinite(ci) ? ci : 0);
  if (!modelOpen(look.mdl) || !colourOpen(look.ci)) look = M.pickModel(modelOpen(look.mdl) ? look.mdl : 0, colourOpen(look.ci) ? look.ci : 0);   // fall back if a saved pick is still locked
  S.model = look.mdl; S.ci = look.ci; S.color = look.col; S.paint = look.paint;
}

function respawn() { const lv = S.lvl; S.me = { tx: lv.sx, ty: lv.sy, d: -1, t: 0, want: -1, face: 2 }; S.inv = 2; S.camX = null; }
function loadLevel(L, b64, ph = 0) {
  S.L = L; S.lvl = M.genLevel(S.seed, L);
  S.myBits = new Uint8Array(S.lvl.bytes);
  S.srvBits = b64 ? M.fromB64(b64, S.lvl.bytes) : new Uint8Array(S.lvl.bytes);
  S.ge = []; S.gv = []; S.gTarget = []; S.ph = ph; S.fr = 0; S.crates = []; S.fx = []; S.grabbing = 0; S.nuked = false; S.pend.clear(); S.left = -1;
  S.alive = true; respawn(); S.mazeKey = '';
  const n = M.ghostCount(L);
  endStreak(true);
  if (ph === 0) MazeFX.bigText('LEVEL ' + L, S.lvl.W + ' × ' + S.lvl.H + ' maze · ' + n + (n > 1 ? ' ghosts' : ' ghost') + ' · speed ' + speedLabel(L), '#41e0f0', 1.9);
}

/* ---------- networking ---------- */
function send(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }
function connect() {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.hash = ''; url.search = '';
  const ws = new WebSocket(url.href);
  S.ws = ws;
  ws.onopen = () => send({ t: 'join', nm: S.name, seed: S.seed, mdl: S.model, ci: S.ci, tok: token, vis: S.vis, key: S.key || S.inviteKey, room: S.room || undefined, lname: S.lname, setpw: S.setpw || undefined, pw: S.pw || undefined });
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m); };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ws = null;
    if (S.wantGame) { setNet('Connection lost. Reconnecting…'); S.reconnectT = setTimeout(connect, 1500); }
  };
}
function onMsg(m) {
  switch (m.t) {
    case 'welcome': {
      S.id = m.id; S.seed = m.seed;
      S.roster.clear(); for (const r of m.roster || []) S.roster.set(r[0], { nm: String(r[1]), col: String(r[2]), mdl: r[3] | 0, paint: M.pickModel(r[3], r[4]).paint });
      S.sc = m.sc | 0; S.li = m.li | 0; S.over = !!m.over;
      loadLevel(m.lv | 0, m.b, m.ph | 0);
      S.inGame = true;
      $('startOv').hidden = true; $('overOv').hidden = !S.over; $('leaveBtn').hidden = false; $('app').classList.add('ingame');
      $('playBtn').disabled = false; $('playBtn').textContent = S.inviteKey ? 'Join maze' : 'Start maze';
      S.key = typeof m.key === 'string' ? m.key : ''; S.vis = m.vis === 'private' ? 'private' : 'public';
      S.title = typeof m.title === 'string' ? m.title : ''; S.locked = !!m.locked; S.room = '';
      S.setpw = '';   // only sent when opening the lobby
      $('joinPwField').hidden = true; S.pwRoom = '';
      S.host = m.host | 0; S.ph = m.ph | 0; updateReady();
      $('seedBtn').textContent = S.seed;
      $('seedBtn').title = S.vis === 'private' ? 'Copy invite link (only people with it can join)' : 'Copy link to this maze';
      const chip = $('visChip'); chip.hidden = false; chip.textContent = S.vis === 'private' ? 'Invite only' : 'Public'; chip.classList.toggle('private', S.vis === 'private');
      try { history.replaceState(null, '', '#' + inviteHash()); } catch (e) { /* ignore */ }
      setNet('');
      A.startMusic(S.L); A.sfx('start');
      break;
    }
    case 'level':
      loadLevel(m.lv | 0, '', m.ph | 0); updateReady();
      A.startMusic(S.L); A.setFright(false);
      if (S.ph === 0) recordLevel(S.L);
      if (m.adv && !S.over) A.sfx('life');
      break;
    case 'join': S.roster.set(m.id, { nm: String(m.nm), col: String(m.col), mdl: m.mdl | 0, paint: M.pickModel(m.mdl, m.ci).paint }); A.sfx('join'); updateLobby(); break;
    case 'leave': S.roster.delete(m.id); S.ov.delete(m.id); updateLobby(); break;
    case 'pw': {   // a big pellet was eaten; we already played our own
      if ((m.id | 0) === S.id || !S.lvl) break;
      const x = (m.i | 0) % S.lvl.W, y = ((m.i | 0) / S.lvl.W) | 0;
      A.sfx('powerOther', soundAt(x, y));
      MazeFX.ring(x, y, '#ffcc33', 3.2, 0.5); MazeFX.sparks(x, y, '#ffcc33', 14, 7, 0.5);
      break;
    }
    case 'crate': {   // a loot crate appeared
      if (!S.lvl) break;
      A.sfx('crate'); MazeFX.ring(m.x, m.y, '#ffcc33', 2.5, 0.6); MazeFX.sparks(m.x, m.y, '#ffcc33', 12, 5, 0.6);
      if (!S.crates.some(c => c[0] === m.id)) S.crates.push([m.id, m.x, m.y]);
      break;
    }
    case 'pu': {   // someone opened a crate: everyone sees the slot
      const pu = M.POWERUPS[m.kind | 0]; if (!pu) break;
      S.crates = S.crates.filter(c => c[0] !== m.crate);
      MazeFX.coins(m.x, m.y, 10, 8); MazeFX.ring(m.x, m.y, '#ffcc33', 3, 0.5); MazeFX.flash('#ffcc33', 0.2);
      A.sfx('puOpen');
      MazeFX.powerSlot({ items: M.POWERUPS, final: m.kind | 0, by: (m.by | 0) === S.id ? 'You' : String(m.nm || 'Someone'), spin: M.PU_SPIN, hold: M.PU_HOLD, onLand: () => A.sfx('puLand', pu.good) });
      break;
    }
    case 'puon': powerupStarted(m.kind | 0, m.by | 0); break;
    case 'nuke': nukeStarted(m.x, m.y); break;
    case 'pts': MazeFX.text(+m.x || 0, (+m.y || 0) - 0.3, String(m.v | 0), '#41e0f0', 0.95); break;
    case 'error':
      S.wantGame = false;
      $('joinErr').textContent = String(m.msg || 'Could not join.'); $('joinErr').hidden = false;
      if (m.code === 'pw_needed' || m.code === 'pw_wrong') askPassword(S.room, '');
      $('playBtn').disabled = false; $('playBtn').textContent = S.inviteKey ? 'Join maze' : 'Start maze';
      if (S.ws) S.ws.close();
      break;
    case 's': {
      if ((m.lv | 0) !== S.L) return;
      let heard = -1;
      for (const i of m.e || []) if (i >= 0 && i < S.lvl.W * S.lvl.H) {
        if (!M.getBit(S.myBits, i) && !M.getBit(S.srvBits, i)) {   // eaten by someone else
          MazeFX.sparks(i % S.lvl.W, (i / S.lvl.W) | 0, '#ffdcae', 4, 4, 0.3);
          if (S.lvl.p[i] === 1) heard = i;
        }
        M.setBit(S.srvBits, i);
      }
      if (heard >= 0) A.sfx('eatOther', soundAt(heard % S.lvl.W, (heard / S.lvl.W) | 0));
      reconcilePellets(m);
      const wasPh = S.ph;
      S.ph = m.ph | 0; S.fr = +m.fr || 0; S.ct = +m.ct || 0;
      if (S.ph === 1 && wasPh !== 1) levelClear();
      if (S.ph === 0) recordLevel(S.L);
      const hostWas = S.host; S.host = m.h | 0;
      if (S.ph !== wasPh || S.host !== hostWas) updateReady();
      A.setFright(S.fr > 0 && S.ph === 0);
      if (m.fid !== S.fid) { S.fid = m.fid; }
      S.gTarget = (m.g || []).map((a, i) => ({ i, x: +a[0], y: +a[1], d: a[2] | 0, st: a[3] | 0, ep: a[4] | 0, phone: a[5] === 1 }));
      S.crates = (m.c || []).filter(c => Array.isArray(c));
      S.fx = (m.fx || []).map(f => ({ id: (M.POWERUPS[f[0] | 0] || {}).id, rem: +f[1] || 0, by: f[2] | 0 })).filter(f => f.id);
      effectEdges();
      const pl = [];
      for (const a of m.p || []) {
        const id = a[0], r = S.roster.get(id) || { nm: 'Player', col: '#ffcc33' };
        const p = { id, x: +a[1], y: +a[2], f: a[3] & 3, al: a[4] === 1, sc: a[5] | 0, li: a[6] | 0, over: a[7] === 1, nm: r.nm, col: /^#[0-9a-f]{6}$/i.test(r.col) ? r.col : '#ffcc33', mdl: r.mdl | 0, paint: r.paint || r.col };
        if (id === S.id) {
          S.sc = p.sc; S.li = p.li;
          if (p.over && !S.over) { S.over = true; A.sfx('over'); endStreak(true); $('overTxt').textContent = 'You scored ' + S.sc.toLocaleString() + ' and reached level ' + S.L + '.'; $('overOv').hidden = false; }
          if (!p.over && S.over) { S.over = false; $('overOv').hidden = true; }
        } else pl.push(p);
      }
      S.players = pl;
      break;
    }
  }
}
setInterval(() => {
  if (!S.inGame || !S.lvl) return;
  const [x, y] = M.entPos(S.me), pos = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, f: S.me.face };
  // pellets eaten since the last update travel with the current position
  if (S.eatQ.length) send(Object.assign({ t: 'eat', i: S.eatQ.splice(0, 16) }, pos));
  else send(Object.assign({ t: 'p' }, pos));
}, 50);

/* Stereo position and loudness for a sound happening at tile (x, y), relative to you. */
function soundAt(x, y) {
  const [px, py] = M.entPos(S.me), half = Math.max(8, S.lvl.W / 2);
  return { pan: (x - px) / half, near: 1 - Math.min(1, Math.hypot(x - px, y - py) / 30) };
}

/* ---------- local player ---------- */
const eaten = i => M.getBit(S.srvBits, i) || M.getBit(S.myBits, i);
const clearBit = (u, i) => { u[i >> 3] &= ~(1 << (i & 7)); };
/* Keep pellets in step with the server. Pellets you ate show as gone straight away;
   if the server hasn't confirmed one within 1.5 s it didn't count, so it comes back.
   Every ~2 s the server sends its full pellet map, which replaces ours. */
const PEND_MS = 1500;
// read-only, for tests: how many pellets this browser is showing
window.__munchVisible = () => S.lvl ? S.lvl.pList.filter(i => !eaten(i)).length : -1;
function reconcilePellets(m) {
  for (const i of m.e || []) S.pend.delete(i);
  if (typeof m.left === 'number') S.left = m.left;
  if (typeof m.b === 'string') S.srvBits = M.fromB64(m.b, S.lvl.bytes);
  const now = performance.now();
  for (const [i, t] of S.pend) {
    if (M.getBit(S.srvBits, i)) S.pend.delete(i);
    else if (now - t > PEND_MS) { clearBit(S.myBits, i); S.pend.delete(i); }
  }
  if (typeof m.b === 'string') {   // anything we think we ate that the server doesn't know about and isn't pending
    for (let k = 0; k < S.myBits.length; k++) if (S.myBits[k] & ~S.srvBits[k]) {
      for (let b = 0; b < 8; b++) { const i = k * 8 + b; if ((S.myBits[k] >> b & 1) && !M.getBit(S.srvBits, i) && !S.pend.has(i)) clearBit(S.myBits, i); }
    }
  }
}
function eatAt(x, y) {
  const lv = S.lvl, i = y * lv.W + x;
  if (!lv.p[i] || eaten(i)) return;
  M.setBit(S.myBits, i); S.eatQ.push(i); S.pend.set(i, performance.now());
  if (lv.p[i] === 2) {
    A.sfx('power');
    MazeFX.ring(x, y, '#ffcc33', 3.2, 0.5); MazeFX.ring(x, y, '#41e0f0', 5, 0.7);
    MazeFX.sparks(x, y, '#ffcc33', 26, 9, 0.6); MazeFX.flash('#2f45ff', 0.3); MazeFX.shake(4);
  } else {
    A.sfx('eat', S.streak);
    MazeFX.sparks(x, y, S.streakTier >= 3 ? '#ff7a1a' : '#ffdcae', 3 + Math.min(5, S.streakTier), 5, 0.3);
  }
  bumpStreak(x, y);
}
function movePlayer(e, dist) {
  const lv = S.lvl; let guard = 0;
  while (dist > 1e-6 && guard++ < 8) {
    if (e.d < 0) { if (e.want >= 0 && M.canGo(lv, e.tx, e.ty, e.want)) { e.d = e.want; e.face = e.d; } else return; }
    if (e.want >= 0 && e.want === (e.d + 2) % 4 && e.t > 0) { e.tx = M.wrapX(lv, e.tx + DIRS[e.d][0]); e.ty += DIRS[e.d][1]; e.t = 1 - e.t; e.d = e.want; e.face = e.d; }
    const rem = 1 - e.t;
    if (dist < rem) { e.t += dist; return; }
    dist -= rem; e.tx = M.wrapX(lv, e.tx + DIRS[e.d][0]); e.ty += DIRS[e.d][1]; e.t = 0;
    eatAt(e.tx, e.ty);
    if (e.want >= 0 && M.canGo(lv, e.tx, e.ty, e.want)) e.d = e.want;
    else if (!M.canGo(lv, e.tx, e.ty, e.d)) { e.d = -1; return; }
    e.face = e.d;
  }
}
function playerStep(dt) {
  if (S.over) return;
  if (!S.alive) {
    S.deadT -= dt;
    if (S.deadT <= 0 && S.li > 0) { S.alive = true; respawn(); send({ t: 'respawn' }); A.sfx('respawn'); MazeFX.ring(S.me.tx, S.me.ty, S.color, 2, 0.5); }
    return;
  }
  if (S.ph !== 0) return;
  for (const f of S.fx) f.rem -= dt;   // count down locally between server updates
  if (S.streak && !effectOn('autopilot')) { S.streakT += dt; if (S.streakT > STREAK_WINDOW) endStreak(false); }   // autopilot holds the streak
  if (effectOn('autopilot')) S.me.want = autoDir();
  if (effectOn('unplugged')) { checkGhosts(); return; }   // controller died: you stand still
  if (S.inv > 0) S.inv -= dt;
  // move in small steps and check for ghosts after each, so fast levels can't skip past one
  const dist = M.playerSpeed(S.L) * dt, steps = Math.max(1, Math.ceil(dist / 0.3));
  for (let k = 0; k < steps && S.alive; k++) { movePlayer(S.me, dist / steps); checkGhosts(); }
  if (effectOn('laser')) laserEat();
}
function checkGhosts() {
  const [px, py] = M.entPos(S.me);
  for (const c of S.crates) if (c[0] !== S.grabbing && Math.hypot(c[1] - px, c[2] - py) < 0.75) { S.grabbing = c[0]; send({ t: 'grab', id: c[0], x: Math.round(px * 100) / 100, y: Math.round(py * 100) / 100, f: S.me.face }); }
  for (const g of S.gv) {
    if (g.st !== 1 && g.st !== 2) continue;
    if (Math.hypot(g.x - px, g.y - py) > (effectOn('megaghost') ? 1.05 : 0.62)) continue;   // mega ghosts reach further
    if (g.st === 2) {
      S.ge.push([g.i, g.ep]); if (S.ge.length > 8) S.ge.shift();
      g.st = 3; send({ t: 'ghost', i: g.i, ep: g.ep }); A.sfx('ghost');
      MazeFX.ring(g.x, g.y, '#41e0f0', 3, 0.45); MazeFX.sparks(g.x, g.y, GCOL[g.i % GCOL.length], 22, 10, 0.55); MazeFX.coins(g.x, g.y, 5); MazeFX.shake(7); A.sfx('coin');
    } else if (S.inv <= 0 && !effectOn('autopilot')) {   // autopilot never gets caught
      S.alive = false; S.deadT = 1.4; send({ t: 'die' }); A.sfx('die');
      MazeFX.sparks(px, py, S.color, 40, 9, 0.9); MazeFX.ring(px, py, '#ff4d5e', 3, 0.6); MazeFX.flash('#ff4d5e', 0.35); MazeFX.shake(12); endStreak(true); break;
    }
  }
}
function updateGhostView(dt) {
  const lv = S.lvl, k = 1 - Math.exp(-dt * 14), next = [];
  for (const s of S.gTarget) {
    let x = s.x, y = s.y;
    if (s.st === 0) { x = lv.mid - 2 + (s.i % 5); y = lv.cy + Math.sin(S.time * 4 + s.i) * 0.12; }
    let st = s.st; if (st === 2 && S.ge.some(a => a[0] === s.i && a[1] === s.ep)) st = 3;
    const prev = S.gv.find(g => g.i === s.i);
    let vx = x, vy = y;
    if (prev && Math.hypot(prev.x - x, prev.y - y) < 2.5) { vx = prev.x + (x - prev.x) * k; vy = prev.y + (y - prev.y) * k; }
    next.push({ i: s.i, x: vx, y: vy, d: s.d, st, ep: s.ep, phone: s.phone });
  }
  S.gv = next;
}

/* ---------- lobby ---------- */
async function getJSON(u) { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
let lobbyOn = true;
async function refreshLobby() {
  if (S.inGame) return;
  if (lobbyOn) try {
    const list = await getJSON('api/games');
    const sig = JSON.stringify(list);
    if (sig !== refreshLobby.sig) {   // only rebuild when something changed
      refreshLobby.sig = sig;
      const box = $('games'); box.textContent = '';
      if (!list.length) {
        const d = document.createElement('div'); d.className = 'empty';
        const t = document.createElement('b'); t.textContent = 'No public mazes right now.';
        const h = document.createElement('span'); h.textContent = 'Start one on the right. It appears here for everyone on this server.';
        d.append(t, h); box.appendChild(d);
      }
      for (const g of list) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'lrow';
        const main = document.createElement('span'); main.className = 'lr-main';
        const nm = document.createElement('span'); nm.className = 'lr-name'; nm.textContent = g.name; main.appendChild(nm);
        if (g.locked) { const lk = document.createElement('span'); lk.className = 'chip private'; lk.textContent = 'Password'; main.appendChild(lk); }
        const meta = document.createElement('span'); meta.className = 'lr-meta';
        const st = document.createElement('span'); st.className = 'lr-status ' + (g.lobby ? 'open' : 'playing');
        st.textContent = g.lobby ? 'In lobby' : 'Level ' + g.level;
        const pl = document.createElement('span'); pl.textContent = g.players + (g.players === 1 ? ' player' : ' players');
        meta.append(st, pl);
        const go = document.createElement('span'); go.className = 'lr-go'; go.textContent = 'Join';
        b.append(main, meta, go);
        b.title = g.locked ? 'Password protected' : 'Join ' + g.name;
        b.addEventListener('click', () => {
          clearInvite(); setVis('public');
          if (g.locked && ($('joinPwField').hidden || S.pwRoom !== g.id)) { $('joinErr').hidden = true; askPassword(g.id, g.name); return; }
          join(g.id);
        });
        box.appendChild(b);
      }
    }
  } catch (e) { /* server busy; try again later */ }
  try {
    const sc = await getJSON('api/scores');
    const ol = $('scores'); ol.textContent = '';
    if (!sc.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No scores yet.'; ol.appendChild(li); }
    for (const s of sc) {
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.n + ' ';
      const sm = document.createElement('small'); sm.textContent = 'level ' + s.lv; nm.appendChild(sm);
      const v = document.createElement('span'); v.className = 'sc'; v.textContent = (s.sc | 0).toLocaleString();
      li.append(nm, v); ol.appendChild(li);
    }
  } catch (e) { /* ignore */ }
}
getJSON('api/info').then(info => {
  lobbyOn = !!info.lobby;
  if (!lobbyOn) { const g = $('games'); g.textContent = ''; const d = document.createElement('div'); d.className = 'empty'; const t = document.createElement('b'); t.textContent = 'This server keeps its mazes unlisted.'; const h = document.createElement('span'); h.textContent = 'Ask a friend for their invite link or seed, or start your own.'; d.append(t, h); g.appendChild(d); document.querySelector('.join-col .live').hidden = true; }
  if (info.name && info.name !== 'Munch Maze') document.title = info.name + ' · Munch Maze';
  if (info.defaultSeed && !$('seedIn').value) $('seedIn').placeholder = 'Leave blank for ' + info.defaultSeed;
}).catch(() => {});
refreshLobby(); setInterval(refreshLobby, 3000);

function askPassword(room, name) {
  S.pwRoom = room || '';   // remembered so pressing Enter the maze retries the same lobby
  $('joinPwLabel').textContent = name ? 'Password for ' + name : 'Lobby password';
  $('joinPwField').hidden = false; $('joinPwIn').value = ''; updateVisHint(); $('joinPwIn').focus();
}
function join(roomId) {
  if (typeof roomId !== 'string' && !$('joinPwField').hidden && S.pwRoom) roomId = S.pwRoom;   // retrying a locked lobby
  S.room = typeof roomId === 'string' ? roomId : '';   // set when joining from the list
  S.pw = $('joinPwField').hidden ? '' : $('joinPwIn').value.slice(0, 64);
  S.setpw = $('visIn').value === 'public' && !S.inviteKey ? $('setpwIn').value.slice(0, 64) : '';
  S.lname = $('lnameIn').value.trim().slice(0, 32); store.set('mm.lname', S.lname);
  S.name = ($('nameIn').value.trim() || 'Player').slice(0, 16);
  store.set('mm.name', S.name); store.set('mm.model', String(S.model)); store.set('mm.ci', String(S.ci));
  S.seed = M.slug($('seedIn').value);
  S.vis = S.inviteKey ? 'private' : ($('visIn').value === 'private' ? 'private' : 'public');
  S.key = '';
  store.set('mm.vis', $('visIn').value);
  A.unlock();
  $('joinErr').hidden = true;
  $('playBtn').disabled = true; $('playBtn').textContent = 'Connecting…';
  S.wantGame = true; clearTimeout(S.reconnectT);
  if (S.ws) { const old = S.ws; S.ws = null; old.close(); }
  connect();
}
function leave() {
  S.wantGame = false; S.inGame = false; clearTimeout(S.reconnectT);
  if (S.ws) { const old = S.ws; S.ws = null; old.close(); }
  $('startOv').hidden = false; $('overOv').hidden = true; $('leaveBtn').hidden = true; $('app').classList.remove('ingame');
  $('seedIn').value = S.seed; setNet('Not in a maze yet.');
  A.stopMusic(); A.setFright(false); MazeFX.clear(); endStreak(true); S.eatQ = []; S.ph = 0; S.host = 0; updateReady();
  $('visChip').hidden = true; S.key = ''; clearInvite();
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  refreshLobby();
}

/* ---------- rendering ---------- */
const cv = $('cv'), ctx = cv.getContext('2d'), stage = $('stage');
let CW = 1, CH = 1, DPR = 1;
function resize() { const r = stage.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); CW = Math.max(1, r.width); CH = Math.max(1, r.height); cv.width = Math.round(CW * DPR); cv.height = Math.round(CH * DPR); S.mazeKey = ''; makeStars(); }

/* Cached sprites: glowing dots for pellets, bulbs and player auras. */
const spriteCache = new Map();
function glowSprite(color, core, glow, coreColor) {
  const key = color + '|' + core + '|' + glow + '|' + (coreColor || '');
  let c = spriteCache.get(key); if (c) return c;
  const R = Math.ceil(core + glow), s = R * 2 + 2; c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), m = s / 2;
  const rg = g.createRadialGradient(m, m, 0, m, m, R);
  rg.addColorStop(0, coreColor || '#ffffff'); rg.addColorStop(Math.min(0.95, core / R), color);
  rg.addColorStop(Math.min(0.98, core / R + 0.08), hexA(color, 0.35)); rg.addColorStop(1, hexA(color, 0));
  g.fillStyle = rg; g.fillRect(0, 0, s, s);
  if (spriteCache.size > 200) spriteCache.clear();
  spriteCache.set(key, c); return c;
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
function hsl(h, s, l) { return `hsl(${h} ${s}% ${l}%)`; }
function blit(sp, x, y, scale = 1) { const w = sp.width * scale; ctx.drawImage(sp, x - w / 2, y - w / 2, w, w); }

/* Background: flying through space (see space.js). Warp speed follows the game:
   a slow cruise in the lobby, faster as levels speed up, and a hyperspace burst between levels. */
function makeStars() { /* space.js sizes itself */ }
new ResizeObserver(resize).observe(stage); resize();
const STREAK_WARP = 1.1;   // star speed at a 100+ streak (level clear hyperspace is 0.55)
function warpTarget() {
  if (!S.inGame) return 0.07;
  if (S.ph === 3) return 0.06;                 // lobby: cruising
  if (S.ph === 1) return 0.55;                 // level clear: jump to hyperspace
  if (S.ph === 2) return 0.1;
  const base = 0.12 * Math.min(2.5, Math.pow(M.speedMult(S.L), 0.8));
  // the streak pushes towards full warp, reached at a 100 streak; the curve makes even short streaks visible
  const k = Math.sqrt(Math.min(S.streak, 100) / 100);
  return base + (STREAK_WARP - base) * k;
}
function drawBackground(dt, hue, beat) {
  const g = ctx.createRadialGradient(CW / 2, CH / 2, 0, CW / 2, CH / 2, Math.max(CW, CH) * 0.75);
  g.addColorStop(0, `hsl(${hue} 50% ${9 + beat * 2}%)`); g.addColorStop(0.55, '#090b1e'); g.addColorStop(1, '#04050d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  if (window.MazeSpace) MazeSpace.draw(ctx, dt, CW, CH, { warp: warpTarget(), hue, reduced: MazeFX.reduced() });
}

/* Maze: neon tubes with a baked glow, plus a separate glow layer that pulses with the beat. */
function buildMaze(lv, T, col, hot) {
  const P = T;   // padding so the outer glow isn't clipped
  const c = document.createElement('canvas'); c.width = lv.W * T + 2 * P; c.height = lv.H * T + 2 * P; const g = c.getContext('2d'); g.translate(P, P);
  const isW = (x, y) => x >= 0 && y >= 0 && x < lv.W && y < lv.H && lv.t[y * lv.W + x] === 1;
  g.fillStyle = 'rgba(255,154,213,0.07)';
  for (let x = lv.mid - 2; x <= lv.mid + 2; x++) g.fillRect(x * T, lv.cy * T, T, T);
  const path = new Path2D();
  for (let y = 0; y < lv.H; y++) for (let x = 0; x < lv.W; x++) {
    if (!isW(x, y)) continue; const cx = (x + .5) * T, cy = (y + .5) * T;
    path.moveTo(cx, cy); path.lineTo(cx + .01, cy);
    if (isW(x + 1, y)) { path.moveTo(cx, cy); path.lineTo(cx + T, cy); }
    if (isW(x, y + 1)) { path.moveTo(cx, cy); path.lineTo(cx, cy + T); }
  }
  g.lineCap = 'round'; g.lineJoin = 'round';
  const w = T * 0.62, rim = Math.max(1.5, T * 0.1);
  g.shadowColor = col; g.shadowBlur = T * 0.7; g.strokeStyle = col; g.lineWidth = w; g.stroke(path);
  g.shadowBlur = 0; g.strokeStyle = '#0c0f30'; g.lineWidth = Math.max(1, w - 2 * rim); g.stroke(path);
  g.strokeStyle = hot; g.globalAlpha = 0.55; g.lineWidth = Math.max(1, rim * 0.45);
  g.save(); g.translate(-rim * 0.35, -rim * 0.35); g.stroke(path); g.restore(); g.globalAlpha = 1;
  g.fillStyle = '#ff9ad5'; g.shadowColor = '#ff9ad5'; g.shadowBlur = T * 0.4; g.fillRect(lv.mid * T, (lv.cy - 1) * T + T * .42, T, T * .16); g.shadowBlur = 0;
  // glow layer
  const gl = document.createElement('canvas'); gl.width = c.width; gl.height = c.height; const q = gl.getContext('2d'); q.translate(P, P);
  q.lineCap = 'round'; q.lineJoin = 'round'; q.filter = `blur(${Math.max(2, T * 0.35)}px)`; q.strokeStyle = col; q.lineWidth = w * 1.1; q.stroke(path);
  return { c, gl };
}
function ensureMaze(T) {
  const lv = S.lvl, key = S.seed + '|' + lv.L + '|' + T; if (S.mazeKey === key) return;
  S.mazeKey = key;
  const m = buildMaze(lv, T, hsl(lv.hue, 85, 62), hsl(lv.hue, 100, 88));
  S.mazeCv = m.c; S.mazeGlow = m.gl;
  // marquee bulbs sit on the outer wall
  S.bulbs = [];
  for (let x = 0; x < lv.W; x++) S.bulbs.push([x, 0]);
  for (let y = 1; y < lv.H; y++) S.bulbs.push([lv.W - 1, y]);
  for (let x = lv.W - 2; x >= 0; x--) S.bulbs.push([x, lv.H - 1]);
  for (let y = lv.H - 2; y > 0; y--) S.bulbs.push([0, y]);
  S.bulbs = S.bulbs.filter(([x, y]) => lv.t[y * lv.W + x] === 1);
}
function drawBulbs(T) {
  // Marquee bulbs on the outer wall: small, soft and slow so they frame the maze without glaring.
  const n = S.bulbs.length, hot = S.streakTier >= 3, between = S.ph === 1 || S.ph === 2;
  const speed = MazeFX.reduced() ? 0 : hot ? 14 : between ? 4 : 6, phase = Math.floor(S.time * speed);
  ctx.save();
  for (let i = 0; i < n; i++) {
    const [x, y] = S.bulbs[i], cx = (x + .5) * T, cy = (y + .5) * T;
    const on = (i + phase) % 5 === 0;
    if (on) {
      const col = hot ? hsl((i * 12 + S.time * 120) % 360, 80, 62) : (i % 2 ? '#e8b84a' : '#e58cc0');
      ctx.globalAlpha = hot ? 0.75 : 0.55;
      blit(glowSprite(col.startsWith('#') ? col : '#ff9a3c', T * 0.07, T * 0.18, col.startsWith('#') ? '#fff0d0' : '#ffffff'), cx, cy);
    } else {
      ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.arc(cx, cy, T * 0.06, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function drawPac(x, y, T, paint, face, mouth, glow = true, mdl = 0, dying = 0) {
  const cx = (x + .5) * T, cy = (y + .5) * T, r = T * .44, col = MazeModels.colorAt(paint, S.time);
  if (glow) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= 0.55; blit(glowSprite(col, T * 0.3, T * 0.55), cx, cy); ctx.globalAlpha /= 0.55; ctx.globalCompositeOperation = 'source-over'; }
  const chew = Math.max(0, Math.min(1, (mouth - 0.06) / 0.24));
  if (dying > 0) {   // shrink and spin away
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(dying * 9); ctx.scale(1 - dying, 1 - dying);
    MazeModels.draw(ctx, mdl, 0, 0, r, paint, face, 1, S.time); ctx.restore(); return;
  }
  MazeModels.draw(ctx, mdl, cx, cy, r, paint, face, chew, S.time);
}
function shade(hex, k) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(v + (k < 0 ? v * k : (255 - v) * k)))); return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`; }
function drawGhost(x, y, T, col, st, d, flash, scale = 1) {
  const cx = (x + .5) * T, cy = (y + .5) * T, r = T * .44 * scale;
  if (st !== 3) {
    const body = st === 2 ? (flash ? '#e8ecff' : '#2f45ff') : col;
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5; blit(glowSprite(st === 2 ? '#2f45ff' : col, T * 0.3, T * 0.5), cx, cy); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r); g.addColorStop(0, shade(body.startsWith('#') ? body : '#2f45ff', 0.35)); g.addColorStop(1, body);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy - r * .1, r, Math.PI, 0);
    const base = cy + r * .85, n = 3, w = 2 * r / n, ph = Math.floor(S.time * 8) % 2;
    ctx.lineTo(cx + r, base);
    for (let k = 0; k < n; k++) { const x0 = cx + r - k * w; ctx.lineTo(x0 - w / 2, base - r * (ph ? .28 : .12)); ctx.lineTo(x0 - w, base); }
    ctx.closePath(); ctx.fill();
  }
  if (st === 2) {
    ctx.fillStyle = flash ? '#ff4d5e' : '#ffdcae';
    ctx.fillRect(cx - r * .42, cy - r * .32, r * .22, r * .22); ctx.fillRect(cx + r * .2, cy - r * .32, r * .22, r * .22);
    ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = Math.max(1, T * .06); ctx.beginPath();
    for (let k = 0; k <= 4; k++) { const px = cx - r * .5 + k * r * .25, py = cy + r * .3 + (k % 2 ? -1 : 1) * r * .1; k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke();
    return;
  }
  const [dx, dy] = d >= 0 ? DIRS[d] : [0, 0];
  for (const s of [-1, 1]) {
    const ex = cx + s * r * .38, ey = cy - r * .2;
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(ex + dx * r * .06, ey + dy * r * .06, r * .25, r * .31, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a2bff'; ctx.beginPath(); ctx.arc(ex + dx * r * .16, ey + dy * r * .16, r * .13, 0, Math.PI * 2); ctx.fill();
  }
}

const trail = [];
function render(dt) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const lv = S.lvl; if (!lv) return;
  const beat = A.beat ? A.beat() : 0;
  drawBackground(dt, lv.hue, beat);
  const fit = Math.min((CW - 16) / lv.W, (CH - 16) / lv.H);
  const T = Math.max(14, Math.min(34, Math.floor(fit)));
  ensureMaze(T);
  const mw = lv.W * T, mh = lv.H * T;
  const [mx, my] = S.inGame ? M.entPos(S.me) : [lv.mid, lv.cy];
  const tx = mw <= CW ? (CW - mw) / 2 : Math.min(8, Math.max(CW - mw - 8, CW / 2 - (mx + .5) * T));
  const ty = mh <= CH ? (CH - mh) / 2 : Math.min(8, Math.max(CH - mh - 8, CH / 2 - (my + .5) * T));
  if (S.camX === null || Math.abs(S.camX - tx) > CW) { S.camX = tx; S.camY = ty; }
  const kk = 1 - Math.exp(-dt * 10); S.camX += (tx - S.camX) * kk; S.camY += (ty - S.camY) * kk;
  const ox = Math.round(S.camX + MazeFX.shakeX), oy = Math.round(S.camY + MazeFX.shakeY);
  ctx.save(); ctx.translate(ox, oy);
  // maze + beat pulse
  // a dark floor under the maze keeps the space scenery outside the play area
  ctx.fillStyle = 'rgba(6,7,20,0.86)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(T * 0.2, T * 0.2, mw - T * 0.4, mh - T * 0.4, T * 0.5) : ctx.rect(0, 0, mw, mh); ctx.fill();
  ctx.drawImage(S.mazeCv, -T, -T);
  const swell = S.inGame && S.ph === 1 ? 0.25 + 0.2 * Math.sin(S.time * 4) : 0;   // gentle glow on level clear, no flashing
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.18 + beat * 0.18 + (S.streakTier >= 3 ? 0.12 : 0) + swell; ctx.drawImage(S.mazeGlow, -T, -T);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawBulbs(T);
  // pellets
  const x0 = Math.max(0, Math.floor(-ox / T) - 1), x1 = Math.min(lv.W - 1, Math.ceil((CW - ox) / T) + 1);
  const y0 = Math.max(0, Math.floor(-oy / T) - 1), y1 = Math.min(lv.H - 1, Math.ceil((CH - oy) / T) + 1);
  const dot = glowSprite('#ffdcae', Math.max(1.6, T * 0.1), T * 0.22, '#fffaf0');
  const power = glowSprite('#ffcc33', T * 0.22, T * 0.5, '#ffffff');
  const pulse = .8 + .2 * Math.sin(S.time * 7);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * lv.W + x, k = lv.p[i]; if (!k) continue;
    if (S.inGame && eaten(i)) continue;
    const cx = (x + .5) * T, cy = (y + .5) * T;
    if (k === 1) {
      const tw = ((x * 7 + y * 13 + Math.floor(S.time * 3)) % 23 === 0) ? 1.6 : 1;   // a few twinkle at a time
      blit(dot, cx, cy, tw);
    } else {
      blit(power, cx, cy, pulse);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(S.time * 2); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,220,120,0.55)';
      for (let r = 0; r < 4; r++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(0, -T * 0.05); ctx.lineTo(T * 0.62 * pulse, 0); ctx.lineTo(0, T * 0.05); ctx.fill(); }
      ctx.restore();
    }
  }
  if (S.inGame) {
    const fl = S.fr > 0 && S.fr < 2 && Math.floor(S.time * 5) % 2 === 0;
    drawCrates(T);
    const mega = effectOn('megaghost') ? 2 : 1;
    if (!S.nuked) for (const g of S.gv) {
      if (mega > 1 && g.st !== 3) { ctx.globalAlpha = 0.35; blit(glowSprite('#7a0020', T * 0.6, T * 0.9), (g.x + .5) * T, (g.y + .5) * T); ctx.globalAlpha = 1; }
      drawGhost(g.x, g.y, T, g.phone ? '#ffcc33' : GCOL[g.i % GCOL.length], g.st, g.d, fl, g.st === 3 ? 1 : mega);
      if (g.phone && g.st !== 3) MazeFX.icon(ctx, 'phone', (g.x + .5) * T, (g.y + .5) * T - T * 0.75 * mega, T * 0.55, S.time);
    }
    drawLasers(T);
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const kx = 1 - Math.exp(-dt * 16);
    for (const p of S.players) {
      if (!p.al || p.over) continue;
      let o = S.ov.get(p.id); if (!o || Math.hypot(o.x - p.x, o.y - p.y) > 3) { o = { x: p.x, y: p.y }; S.ov.set(p.id, o); }
      o.x += (p.x - o.x) * kx; o.y += (p.y - o.y) * kx;
      // trail and ring, like your own, so other players stand out against the maze
      const pc = MazeModels.colorAt(p.paint, S.time), moved = !o.lx || Math.hypot(o.x - o.lx, o.y - o.ly) > 0.01;
      o.lx = o.x; o.ly = o.y; o.trail = o.trail || [];
      if (moved && S.ph === 0) o.trail.push({ x: o.x, y: o.y, t: S.time });
      while (o.trail.length && S.time - o.trail[0].t > 0.22) o.trail.shift();
      ctx.globalCompositeOperation = 'lighter';
      for (const q of o.trail) { const a = 1 - (S.time - q.t) / 0.22; ctx.globalAlpha = a * 0.4; blit(glowSprite(pc, T * 0.18, T * 0.3), (q.x + .5) * T, (q.y + .5) * T, 0.6 + a * 0.5); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      drawPac(o.x, o.y, T, p.paint, p.f, .06 + .22 * Math.abs(Math.sin(S.time * 12 + p.id)), true, p.mdl);
      ctx.strokeStyle = pc; ctx.globalAlpha = .3 + beat * .25; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc((o.x + .5) * T, (o.y + .5) * T, T * (.62 + beat * .08), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.font = '600 ' + Math.max(10, Math.round(T * .42)) + 'px "IBM Plex Mono", ui-monospace, monospace';
      ctx.lineWidth = 3; ctx.strokeStyle = '#0a0c1c'; ctx.strokeText(p.nm, (o.x + .5) * T, (o.y + .5) * T - T * .5);
      ctx.fillStyle = '#eef0ff'; ctx.fillText(p.nm, (o.x + .5) * T, (o.y + .5) * T - T * .5);
    }
    const [px, py] = M.entPos(S.me);
    // motion trail
    if (S.alive && S.me.d >= 0 && S.ph === 0) trail.push({ x: px, y: py, t: S.time }); 
    while (trail.length && S.time - trail[0].t > 0.22) trail.shift();
    if (!S.over && S.alive) {
      ctx.globalCompositeOperation = 'lighter';
      const myCol = MazeModels.colorAt(S.paint, S.time), tcol = S.streakTier >= 3 ? '#ff7a1a' : myCol;
      for (const p of trail) { const a = 1 - (S.time - p.t) / 0.22; ctx.globalAlpha = a * (S.streakTier >= 2 ? 0.7 : 0.4); blit(glowSprite(tcol, T * 0.18, T * 0.3), (p.x + .5) * T, (p.y + .5) * T, 0.6 + a * 0.5); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    if (!S.over) {
      if (!S.alive) { const prog = 1 - Math.max(0, S.deadT) / 1.4; if (prog < .95) drawPac(px, py, T, S.paint, S.me.face, .3, true, S.model, prog); }
      else {
        const blink = S.inv > 0 && Math.floor(S.time * 10) % 2 === 0;
        if (!blink) drawPac(px, py, T, S.paint, S.me.face, S.me.d >= 0 && S.ph === 0 ? .06 + .24 * Math.abs(Math.sin(S.time * 14)) : .18, true, S.model);
        ctx.strokeStyle = MazeModels.colorAt(S.paint, S.time); ctx.globalAlpha = .35 + beat * .3; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc((px + .5) * T, (py + .5) * T, T * (.62 + beat * .08), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }
  drawEffectMarks(T);
  MazeFX.drawWorld(ctx, T);
  ctx.restore();
  // screen-space: fright tint, vignette, then banners and confetti
  if (S.inGame && S.fr > 0 && S.ph === 0) {
    const v = ctx.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.3, CW / 2, CH / 2, Math.max(CW, CH) * 0.7);
    v.addColorStop(0, 'rgba(47,69,255,0)'); v.addColorStop(1, `rgba(47,69,255,${0.28 + 0.08 * Math.sin(S.time * 6)})`);
    ctx.fillStyle = v; ctx.fillRect(0, 0, CW, CH);
  }
  const vg = ctx.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.45, CW / 2, CH / 2, Math.max(CW, CH) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, CW, CH);
  MazeFX.drawScreen(ctx, CW, CH);
}

/* ---------- HUD ---------- */
const bannerEl = $('banner');
function showBanner(t, s, dur) { $('bannerT').textContent = t; $('bannerS').textContent = s; bannerEl.hidden = false; S.bannerT = dur; }
const setTxt = (id, v) => { const e = $(id); v = String(v); if (e.textContent !== v) e.textContent = v; };
function setNet(msg) {
  const net = $('netState'); net.textContent = '';
  if (msg) { net.textContent = msg; return; }
  const b = document.createElement('b'); b.textContent = 'Live';
  net.append(b, S.vis === 'private'
    ? ' · invite only. Only people with your link can join: click the seed to copy it.'
    : ' · public. This maze is listed for everyone; click the seed to copy a link.');
}
let lastLives = -1, boardAt = 0;
function hud(dt, now) {
  const lv = S.lvl; if (!lv) return;
  setTxt('hLevel', S.L || 1); setTxt('hSize', lv.W + '×' + lv.H); setTxt('hSpeed', speedLabel(S.L || 1));
  // rolling score: counts up like a payout meter
  if (S.shownScore > S.sc) S.shownScore = S.sc;
  if (S.shownScore < S.sc) {
    const gap = S.sc - S.shownScore;
    S.shownScore = Math.min(S.sc, S.shownScore + Math.max(1, Math.ceil(gap * Math.min(1, dt * 7))));
    const el = $('hScore'); if (gap >= 150 && !el.classList.contains('bump')) { el.classList.add('bump'); setTimeout(() => el.classList.remove('bump'), 450); }
  }
  setTxt('hScore', S.shownScore.toLocaleString());
  drawStreakHud();
  if (lastLives !== S.li) { lastLives = S.li; const b = $('hLives'); b.textContent = ''; for (let i = 0; i < S.li; i++) { const s = document.createElement('span'); s.className = 'life'; b.appendChild(s); } }
  if (S.bannerT > 0) { S.bannerT -= dt; if (S.bannerT <= 0) bannerEl.hidden = true; }
  if (now - boardAt < 300) return; boardAt = now;
  if (!S.inGame) { setTxt('pCount', '0'); return; }
  let left = S.left;   // the server's count is the one that matters
  if (left < 0) { left = 0; for (const i of lv.pList) if (!eaten(i)) left++; }
  setTxt('pLeft', left); setTxt('gCount', M.ghostCount(S.L));
  const rows = [{ nm: S.name, col: S.color, sc: S.sc, al: S.alive && !S.over, me: true, host: S.host === S.id }];
  for (const p of S.players) rows.push({ nm: p.nm, col: p.col, sc: p.sc, al: p.al && !p.over, me: false, host: p.id === S.host });
  rows.sort((a, b) => b.sc - a.sc);
  setTxt('pCount', rows.length);
  const ol = $('board'); ol.textContent = '';
  for (const r of rows.slice(0, 60)) {
    const li = document.createElement('li'); if (!r.al) li.className = 'dead';
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = r.col;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.nm;
    if (r.me || r.host) { const sm = document.createElement('small'); sm.textContent = [r.host ? 'host' : '', r.me ? 'you' : ''].filter(Boolean).join(' · '); nm.appendChild(sm); }
    const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = r.sc.toLocaleString();
    li.append(sw, nm, sc); ol.appendChild(li);
  }
  if (rows.length > 60) { const li = document.createElement('li'); li.textContent = '+' + (rows.length - 60) + ' more'; ol.appendChild(li); }
}

/* ---------- input ---------- */
const KEYS = { ArrowRight: 0, KeyD: 0, ArrowDown: 1, KeyS: 1, ArrowLeft: 2, KeyA: 2, ArrowUp: 3, KeyW: 3 };
addEventListener('keydown', e => { if (e.code === 'KeyM' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { toggleMute(); return; } if (!S.inGame || /INPUT|SELECT/.test(e.target.tagName)) return; if (e.code in KEYS) { setWant(KEYS[e.code]); e.preventDefault(); } });
let touch = null;
cv.addEventListener('touchstart', e => { const t = e.changedTouches[0]; touch = [t.clientX, t.clientY]; }, { passive: true });
cv.addEventListener('touchmove', e => {
  if (!touch || !S.inGame) return; const t = e.changedTouches[0], dx = t.clientX - touch[0], dy = t.clientY - touch[1];
  if (Math.max(Math.abs(dx), Math.abs(dy)) > 18) { setWant(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3)); touch = [t.clientX, t.clientY]; }
  e.preventDefault();
}, { passive: false });
document.querySelectorAll('#dpad button').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); if (S.inGame) setWant(+b.dataset.d); }));
$('startForm').addEventListener('submit', e => { e.preventDefault(); join(); });
$('pwJoinBtn').addEventListener('click', () => join());
$('pwCancelBtn').addEventListener('click', () => { $('joinPwField').hidden = true; S.pwRoom = ''; $('joinErr').hidden = true; updateVisHint(); });
$('seedIn').addEventListener('input', () => { if (!$('joinPwField').hidden && S.pwRoom) { $('joinPwField').hidden = true; S.pwRoom = ''; $('joinErr').hidden = true; updateVisHint(); } });
$('leaveBtn').addEventListener('click', leave);
$('againBtn').addEventListener('click', () => { send({ t: 'again' }); S.over = false; S.alive = true; respawn(); $('overOv').hidden = true; });
$('seedBtn').addEventListener('click', () => {
  const b = $('seedBtn'), s = S.seed; if (!s) return;
  const link = location.origin + location.pathname + '#' + inviteHash();
  const done = () => { b.textContent = 'Link copied'; setTimeout(() => { b.textContent = s; }, 1200); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link).then(done, () => prompt('Invite link', link));
  else prompt('Invite link', link);
});

/* ---------- power-ups ---------- */
/** Seconds left on an effect for *you*. Reverse lasts 15 s for whoever opened it and 10 s for everyone else. */
function effectLeft(id) {
  let best = 0;
  for (const f of S.fx) if (f.id === id) best = Math.max(best, id === 'reverse' && f.by !== S.id ? f.rem - 5 : f.rem);
  return best;
}
const effectOn = id => S.ph === 0 && effectLeft(id) > 0;
function setWant(d) { S.me.want = effectOn('reverse') ? (d + 2) % 4 : d; }
/** Sounds for effects ending (computed from what's active now vs before). */
function effectEdges() {
  const now = ['unplugged', 'autopilot', 'reverse'].filter(effectOn).join(',');
  if (now === S.prevFx) return;
  const had = S.prevFx.split(','); S.prevFx = now;
  if (had.includes('unplugged') && !now.includes('unplugged')) A.sfx('replugged');
  if (had.includes('autopilot') && !now.includes('autopilot')) A.sfx('autopilotOff');
}
function powerupStarted(kind, by) {
  const pu = M.POWERUPS[kind]; if (!pu) return;
  S.grabbing = 0;
  const lv = S.lvl, [px, py] = M.entPos(S.me);
  switch (pu.id) {
    case 'megaghost': A.sfx('megaghost'); MazeFX.flash('#7a0020', 0.3); MazeFX.shake(5); for (const g of S.gv) MazeFX.ring(g.x, g.y, '#ff4d5e', 3, 0.6); break;
    case 'reverse': A.sfx('reverse'); MazeFX.flash('#9b5fd6', 0.3); MazeFX.ring(px, py, '#c77dff', 3, 0.6); break;
    case 'laser': A.sfx('laser'); MazeFX.flash('#ff3d5e', 0.2); break;
    case 'megapellet': A.sfx('megapellet'); MazeFX.flash('#2f45ff', 0.35); for (const g of S.gv) MazeFX.ring(g.x, g.y, '#41e0f0', 2.5, 0.5); break;
    case 'bomb':
      A.sfx('bomb');
      setTimeout(() => { for (const g of S.gv) { MazeFX.sparks(g.x, g.y, '#ff9a3c', 26, 10, 0.7); MazeFX.ring(g.x, g.y, '#ffcc33', 3, 0.5); } MazeFX.shake(10); MazeFX.flash('#ff9a3c', 0.3); }, 350);
      break;
    case 'quake': A.sfx('quake'); MazeFX.flash('#8a5a2a', 0.25); break;
    case 'unplugged': A.sfx('unplugged'); MazeFX.flash('#000000', 0.45); break;
    case 'autopilot': A.sfx('autopilot'); MazeFX.ring(px, py, '#41e0f0', 3, 0.6); break;
    case 'phone': A.sfx('phone'); MazeFX.ring(lv.mid, lv.cy - 2, '#ffcc33', 3, 0.7); break;
  }
}
function nukeStarted(x, y) {
  A.sfx('nukeSiren');
  setTimeout(() => {
    if (!S.lvl) return;
    const lv = S.lvl, pel = [];
    for (const i of lv.pList) if (!eaten(i)) pel.push([i % lv.W, (i / lv.W) | 0]);
    for (let k = pel.length - 1; k > 0; k--) { const j = Math.random() * (k + 1) | 0; [pel[k], pel[j]] = [pel[j], pel[k]]; }
    MazeFX.nuke(x, y, pel.slice(0, 500), S.gv.map(g => [g.x, g.y]));
    A.sfx('nukeBlast');
    for (const i of lv.pList) M.setBit(S.srvBits, i);   // everything is gone
    S.nuked = true; S.crates = [];
  }, 500);
}
/* Autopilot: head for the nearest pellet, never through tiles a ghost is on or next to. */
function autoDir() {
  const lv = S.lvl, W = lv.W, H = lv.H, e = S.me;
  let sx = e.tx, sy = e.ty;
  if (e.d >= 0 && e.t > 0.5) { sx = M.wrapX(lv, sx + DIRS[e.d][0]); sy += DIRS[e.d][1]; }
  const danger = new Uint8Array(W * H);
  for (const g of S.gv) if (g.st === 1) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > 1) continue;
    const x = M.wrapX(lv, Math.round(g.x) + dx), y = Math.round(g.y) + dy; if (y >= 0 && y < H) danger[y * W + x] = 1;
  }
  const prev = new Int16Array(W * H).fill(-1), first = new Int8Array(W * H).fill(-1), q = [sy * W + sx];
  prev[q[0]] = q[0];
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % W, y = (i / W) | 0;
    if (h > 0 && lv.p[i] && !eaten(i)) return first[i];
    for (let d = 0; d < 4; d++) {
      if (!M.canGo(lv, x, y, d)) continue;
      const nx = M.wrapX(lv, x + DIRS[d][0]), ny = y + DIRS[d][1], j = ny * W + nx;
      if (prev[j] !== -1 || danger[j]) continue;
      prev[j] = i; first[j] = h === 0 ? d : first[i]; q.push(j);
    }
  }
  // nothing reachable safely: move away from the nearest ghost
  let best = e.d, bd = -1;
  for (let d = 0; d < 4; d++) {
    if (!M.canGo(lv, sx, sy, d)) continue;
    const nx = sx + DIRS[d][0], ny = sy + DIRS[d][1];
    const dist = Math.min(99, ...S.gv.filter(g => g.st === 1).map(g => Math.abs(g.x - nx) + Math.abs(g.y - ny)));
    if (dist > bd) { bd = dist; best = d; }
  }
  return best;
}
/* Laser Beamz: your beam eats every pellet down the corridor you're facing. */
function beamEnd(x, y, face) {
  const lv = S.lvl; let cx = Math.round(x), cy = Math.round(y), n = 0;
  while (n++ < lv.W + lv.H) {
    const nx = cx + DIRS[face][0], ny = cy + DIRS[face][1];
    if (nx < 0 || ny < 0 || nx >= lv.W || ny >= lv.H || lv.t[ny * lv.W + nx] !== 0) break;
    cx = nx; cy = ny;
  }
  return [cx, cy];
}
function laserEat() {
  const lv = S.lvl, [px, py] = M.entPos(S.me), face = S.me.face & 3, [ex, ey] = beamEnd(px, py, face);
  let x = Math.round(px), y = Math.round(py), n = 0, got = 0;
  while (n++ < lv.W + lv.H) {
    const i = y * lv.W + x;
    if (lv.p[i] && !eaten(i)) { M.setBit(S.myBits, i); S.eatQ.push(i); S.pend.set(i, performance.now()); bumpStreak(x, y); MazeFX.sparks(x, y, '#ff6b8b', 4, 4, 0.3); got++; if (lv.p[i] === 2) A.sfx('power'); }
    if (x === ex && y === ey) break;
    x += DIRS[face][0]; y += DIRS[face][1];
  }
  if (got) A.sfx('eat', S.streak);
}
function drawLasers(T) {
  if (!effectOn('laser')) return;
  const beams = [];
  if (S.alive && !S.over) { const [px, py] = M.entPos(S.me); beams.push([px, py, S.me.face & 3]); }
  for (const p of S.players) if (p.al && !p.over) { const o = S.ov.get(p.id) || p; beams.push([o.x, o.y, p.f & 3]); }
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  const flick = 0.85 + 0.15 * Math.sin(S.time * 40);
  for (const [x, y, f] of beams) {
    const [ex, ey] = beamEnd(x, y, f), x0 = (x + .5 + DIRS[f][0] * 0.35) * T, y0 = (y + .5 + DIRS[f][1] * 0.35) * T, x1 = (ex + .5) * T, y1 = (ey + .5) * T;
    ctx.strokeStyle = `rgba(255,40,70,${0.35 * flick})`; ctx.lineWidth = T * 0.5; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = `rgba(255,120,140,${0.7 * flick})`; ctx.lineWidth = T * 0.2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = '#fff0f3'; ctx.lineWidth = Math.max(1.5, T * 0.07); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    blit(glowSprite('#ff3d5e', T * 0.12, T * 0.4, '#ffffff'), x1, y1, 0.8 + 0.3 * Math.sin(S.time * 30));
  }
  ctx.restore();
}
/* The loot crate: same glowing icon whatever is inside. */
function drawCrates(T) {
  for (const [, x, y] of S.crates) {
    const cx = (x + .5) * T, cy = (y + .5) * T - T * 0.08 * Math.sin(S.time * 3 + x), s = T * 0.78;
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55 + 0.25 * Math.sin(S.time * 4);
    blit(glowSprite('#ffcc33', T * 0.35, T * 0.75), cx, cy); ctx.restore();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.sin(S.time * 2 + y) * 0.06);
    const g = ctx.createLinearGradient(0, -s / 2, 0, s / 2); g.addColorStop(0, '#8a5cff'); g.addColorStop(1, '#3a1f8a');
    ctx.fillStyle = g; ctx.fillRect(-s / 2, -s / 2 + s * 0.12, s, s * 0.88);                 // body
    ctx.fillStyle = '#a77bff'; ctx.fillRect(-s / 2 - s * 0.04, -s / 2, s * 1.08, s * 0.24);  // lid
    ctx.fillStyle = '#ffcc33';
    ctx.fillRect(-s / 2 - s * 0.04, -s / 2 + s * 0.2, s * 1.08, s * 0.07);                     // gold band
    ctx.fillRect(-s * 0.07, -s / 2, s * 0.14, s);                                               // gold strap
    ctx.fillRect(-s / 2, s / 2 - s * 0.08, s, s * 0.08);
    ctx.fillStyle = '#fff3b0'; ctx.beginPath(); ctx.arc(0, -s * 0.12, s * 0.11, 0, Math.PI * 2); ctx.fill();   // lock
    ctx.fillStyle = '#3a1f8a'; ctx.fillRect(-s * 0.025, -s * 0.13, s * 0.05, s * 0.08);
    ctx.restore();
    if (Math.floor(S.time * 5 + x) % 6 === 0) MazeFX.sparks(x + (Math.random() - 0.5) * 0.6, y - 0.3, '#fff3b0', 1, 1.5, 0.5);
  }
}
/* Markers on players for active effects. */
function drawEffectMarks(T) {
  // header badges with time left
  const badges = M.POWERUPS.filter(p => p.dur > 0 && effectOn(p.id)).map(p => [p, effectLeft(p.id)]);
  const sig = badges.map(([p, r]) => p.id + Math.ceil(r)).join(',');
  if (sig !== drawEffectMarks.sig) {
    drawEffectMarks.sig = sig;
    const box = $('fxBadges'); box.textContent = ''; $('fxPanel').hidden = !badges.length;
    for (const [p, r] of badges) { const b = document.createElement('span'); b.className = 'fxb ' + (p.good ? 'good' : 'bad'); b.textContent = p.name + ' ' + Math.ceil(r) + 's'; box.appendChild(b); }
  }
  if (!S.inGame || S.ph !== 0) return;
  const [px, py] = M.entPos(S.me), cx = (px + .5) * T, cy = (py + .5) * T;
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.font = '600 ' + Math.max(9, Math.round(T * .34)) + 'px "IBM Plex Mono", ui-monospace, monospace';
  const tag = (txt, col) => { ctx.lineWidth = 3; ctx.strokeStyle = '#0a0c1c'; ctx.strokeText(txt, cx, cy - T * 0.62); ctx.fillStyle = col; ctx.fillText(txt, cx, cy - T * 0.62); };
  if (effectOn('autopilot')) {
    ctx.strokeStyle = '#41e0f0'; ctx.setLineDash([T * 0.15, T * 0.1]); ctx.lineDashOffset = -S.time * 20; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, T * 0.7, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); tag('AUTO', '#41e0f0');
  }
  if (effectOn('unplugged')) {
    for (let k = 0; k < 14; k++) { ctx.fillStyle = `rgba(${200 + Math.random() * 55 | 0},${200 + Math.random() * 55 | 0},255,${Math.random() * 0.5})`; ctx.fillRect(cx - T * 0.5 + Math.random() * T, cy - T * 0.5 + Math.random() * T, T * 0.12, T * 0.04); }
    tag('NO SIGNAL', '#ff4d5e');
  }
  if (effectOn('reverse')) {
    ctx.strokeStyle = '#c77dff'; ctx.lineWidth = 2;
    for (let k = 0; k < 2; k++) { const a = -S.time * 4 + k * Math.PI; ctx.beginPath(); ctx.arc(cx, cy, T * 0.72, a, a + 1.6); ctx.stroke(); }
    if (!effectOn('autopilot') && !effectOn('unplugged')) tag('REVERSED', '#c77dff');
  }
  ctx.restore();

}

/* ---------- streaks & jackpots ----------
   Eat pellets back to back to build a streak. Stop for STREAK_WINDOW seconds and it ends.
   Visual and sound rewards only: scores always come from the server. */
const STREAK_WINDOW = 1.4;
const TIERS = [[10, 'NICE!', '#7ee081'], [25, 'SWEET!', '#41e0f0'], [50, 'ON FIRE!', '#ff7a1a'], [100, 'JACKPOT!', '#ffcc33'], [200, 'MEGA JACKPOT!', '#ff4d5e']];
function tierFor(n) { let t = 0; for (let i = 0; i < TIERS.length; i++) if (n >= TIERS[i][0]) t = i + 1; return t; }
function bumpStreak(x, y) {
  S.streak++; S.streakT = 0;
  const t = tierFor(S.streak);
  const mega = S.streak >= 300 && S.streak % 100 === 0;
  if (t > S.streakTier || mega) {
    S.streakTier = t;
    const [, name, col] = TIERS[t - 1];
    MazeFX.bigText(name, 'STREAK ×' + S.streak, col, t >= 4 ? 1.9 : 1.3);
    MazeFX.coins(x, y, 4 + t * 3, 7 + t);
    MazeFX.ring(x, y, col, 2 + t, 0.6);
    if (t >= 4) { MazeFX.confetti(t >= 5 || mega ? 220 : 140, CW); MazeFX.flash('#ffcc33', 0.25); MazeFX.shake(6); A.sfx('jackpot', S.streak); }
    else A.sfx('streak', S.streak);
  }
}
function endStreak(silent) {
  if (!silent && S.streak >= 10) { const [px, py] = M.entPos(S.me); MazeFX.text(px, py - 0.6, 'STREAK ' + S.streak, '#ffcc33', 0.55); }
  S.streak = 0; S.streakT = 0; S.streakTier = 0;
}
const streakEl = $('streak');
let lastStreakShown = -1;
function drawStreakHud() {
  const on = S.inGame && S.streak >= 3;
  streakEl.classList.toggle('idle', !on);
  if (!on) { if (lastStreakShown !== -1) { lastStreakShown = -1; $('streakN').textContent = '—'; streakEl.dataset.tier = '0'; $('streakBar').style.transform = 'scaleX(0)'; } return; }
  if (S.streak !== lastStreakShown) {
    lastStreakShown = S.streak;
    $('streakN').textContent = '×' + S.streak;
    streakEl.dataset.tier = String(S.streakTier);
    streakEl.classList.remove('tick'); void streakEl.offsetWidth; streakEl.classList.add('tick');
  }
  $('streakBar').style.transform = 'scaleX(' + Math.max(0, 1 - S.streakT / STREAK_WINDOW).toFixed(3) + ')';
}
function levelClear() {
  if (S.alive || !S.over) recordCleared(S.L);
  A.sfx('drop'); A.sfx('levelup'); A.fadeOutMusic(A.DROP_TIME); endStreak(false);
  const nx = M.genLevel(S.seed, S.L + 1);
  const syms = [String(nx.W), '×', String(nx.H)];
  MazeFX.confetti(160, CW); MazeFX.flash('#ffcc33', 0.2);
  const [px, py] = M.entPos(S.me); MazeFX.coins(px, py, 14, 10);
  MazeFX.reels(syms, { title: 'LEVEL ' + S.L + ' CLEAR', sub: 'NEXT MAZE  ·  ' + M.ghostCount(S.L + 1) + (M.ghostCount(S.L + 1) > 1 ? ' GHOSTS' : ' GHOST') + '  ·  SPEED +10%', dur: 3.7,
    onStop: i => { A.sfx('reel'); if (i === syms.length - 1) { A.sfx('jackpot'); MazeFX.confetti(90, CW); } } });
}

/* ---------- between levels: the host starts the next one ---------- */
function speedLabel(L) { return '×' + M.speedMult(L).toFixed(2); }
function hostName() {
  if (S.host === S.id) return S.name;
  const r = S.roster.get(S.host); return r ? r.nm : 'the host';
}
function updateReady() {
  updateLobby();
  const show = S.inGame && S.ph === 2;
  const ov = $('readyOv'); ov.hidden = !show;
  if (!show) return;
  const next = S.L + 1, nx = M.genLevel(S.seed, next), g = M.ghostCount(next), isHost = S.host === S.id;
  $('readyTitle').textContent = 'Level ' + S.L + ' clear';
  $('readyNext').textContent = 'Next: ' + nx.W + ' × ' + nx.H + ' maze · ' + g + (g > 1 ? ' ghosts' : ' ghost') + ' · speed ' + speedLabel(next) + ' (+10%)';
  $('readyBtn').hidden = !isHost; $('readyHint').hidden = !isHost;
  $('readyBtn').textContent = 'Start level ' + next;
  $('readyWait').hidden = isHost;
  $('readyWait').textContent = 'Waiting for ' + hostName() + ' to start level ' + next + '…';
  if (isHost) setTimeout(() => { if (!$('readyOv').hidden) $('readyBtn').focus({ preventScroll: true }); }, 50);
}
/* Pre-game lobby: everyone gathers on the maze until the host presses Start. */
function inviteLink() { return location.origin + location.pathname + '#' + inviteHash(); }
function updateLobby() {
  const show = S.inGame && S.ph === 3;
  const ov = $('lobbyOv'), wasHidden = ov.hidden; ov.hidden = !show;
  if (!show) return;
  const isHost = S.host === S.id, lv = S.lvl, g = M.ghostCount(S.L);
  $('lobbyTitle').textContent = 'Lobby · ' + (S.vis === 'private' ? 'Private maze' : (S.title || S.seed));
  $('lobbyVis').textContent = S.vis === 'private' ? 'Invite only' : 'Public';
  $('lobbyVis').classList.toggle('private', S.vis === 'private');
  $('lobbyLock').hidden = !S.locked;
  const facts = ['Level ' + S.L, lv.W + ' × ' + lv.H, g + (g > 1 ? ' ghosts' : ' ghost'), 'Speed ' + speedLabel(S.L), S.vis === 'private' ? 'Link only' : 'Listed publicly'];
  const fsig = facts.join('|');
  if ($('lobbyMaze').dataset.sig !== fsig) {
    $('lobbyMaze').dataset.sig = fsig; $('lobbyMaze').textContent = '';
    for (const f of facts) { const c = document.createElement('span'); c.className = 'fact'; c.textContent = f; $('lobbyMaze').appendChild(c); }
  }
  if ($('lobbyLink').value !== inviteLink()) $('lobbyLink').value = inviteLink();
  $('lobbyStart').hidden = !isHost; $('lobbyHint').hidden = !isHost; $('lobbyWait').hidden = isHost;
  $('lobbyWait').textContent = 'Waiting for ' + hostName() + ' to start the game…';
  renderLobbyPlayers();
  renderLevelSelect(isHost);
  $('lobbyStart').textContent = S.L > 1 ? 'Start at level ' + S.L : 'Start game';
  if (isHost && wasHidden) setTimeout(() => { if (!$('lobbyOv').hidden) $('lobbyStart').focus({ preventScroll: true }); }, 50);
}
/* Starting level: the host can continue from any level their browser has reached. */
let levelSig = '';
function renderLevelSelect(isHost) {
  $('lobbyLevelField').hidden = !isHost;
  if (!isHost) return;
  const top = Math.min(MAX_START_LEVEL, Math.max(bestLevel, S.L)), sig = top + '|' + S.seed;
  const sel = $('lobbyLevel');
  if (sig !== levelSig) {
    levelSig = sig; sel.textContent = '';
    for (let L = top; L >= 1; L--) {   // highest unlocked level first
      const lv = M.genLevel(S.seed, L), o = document.createElement('option');
      o.value = String(L); o.textContent = 'Level ' + L + ' · ' + lv.W + '×' + lv.H + ' · ' + speedLabel(L) + (L === bestLevel && L > 1 ? ' · your best' : '');
      sel.appendChild(o);
    }
  }
  sel.value = String(S.L);
  $('lobbyLevelHint').textContent = bestLevel > 1
    ? 'You’ve reached level ' + bestLevel + ' on this browser, so you can start anywhere from 1 to ' + Math.min(bestLevel, MAX_START_LEVEL) + '.'
    : 'Reach higher levels to unlock them here.';
  sel.disabled = top <= 1;
}
$('lobbyLevel').addEventListener('change', e => { const L = parseInt(e.target.value, 10); if (L >= 1 && S.host === S.id && S.ph === 3) send({ t: 'startlv', lv: L }); });

let lobbySig = '';
function renderLobbyPlayers() {
  const ids = [...S.roster.keys()];
  const sig = ids.join(',') + '|' + S.host;
  if (sig === lobbySig) return; lobbySig = sig;
  $('lobbyCount').textContent = String(ids.length);
  const ul = $('lobbyPlayers'); ul.textContent = '';
  for (const id of ids) {
    const r = S.roster.get(id), li = document.createElement('li');
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; cv.className = 'av';
    const paint = id === S.id ? S.paint : (r.paint || r.col);
    MazeModels.draw(cv.getContext('2d'), id === S.id ? S.model : r.mdl | 0, 32, 34, 22, paint, 0, 0.45, 0);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.nm;
    const tags = [id === S.host ? 'Host' : '', id === S.id ? 'You' : ''].filter(Boolean);
    li.append(cv, nm);
    for (const t of tags) { const c = document.createElement('span'); c.className = 'tag' + (t === 'Host' ? ' host' : ''); c.textContent = t; li.appendChild(c); }
    ul.appendChild(li);
  }
}

$('lobbyStart').addEventListener('click', () => sendReady());
$('lobbyCopy').addEventListener('click', () => {
  const link = inviteLink(), b = $('lobbyCopy');
  const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); };
  const select = () => { const i = $('lobbyLink'); i.focus(); i.select(); b.textContent = 'Press Ctrl+C'; setTimeout(() => { b.textContent = 'Copy'; }, 1800); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link).then(done, select); else select();
});
function sendReady() { if ((S.ph === 2 || S.ph === 3) && S.host === S.id) { send({ t: 'ready' }); $('readyBtn').disabled = true; $('lobbyStart').disabled = true; setTimeout(() => { $('readyBtn').disabled = false; $('lobbyStart').disabled = false; }, 1500); A.sfx('start'); } }
$('readyBtn').addEventListener('click', sendReady);
addEventListener('keydown', e => { if ((e.code === 'Enter' || e.code === 'Space') && (S.ph === 2 || S.ph === 3) && S.host === S.id && e.target.tagName !== 'BUTTON' && !/INPUT|SELECT/.test(e.target.tagName)) { e.preventDefault(); sendReady(); } });

/* ---------- character picker ---------- */
const pickerCanvases = [];
function lockText(level) { return 'Clear level ' + level; }
function buildPicker() {
  const grid = $('modelGrid'); grid.textContent = '';
  M.MODELS.forEach((m, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'model';
    b.setAttribute('role', 'radio'); b.dataset.i = String(i);
    const cv = document.createElement('canvas'); cv.width = 112; cv.height = 112;
    const lb = document.createElement('span'); lb.className = 'mname';
    const lock = document.createElement('span'); lock.className = 'lock'; lock.textContent = 'Lvl ' + M.modelUnlock(i);
    b.append(cv, lb, lock); grid.appendChild(b); pickerCanvases[i] = cv;
    b.addEventListener('click', () => {
      if (!modelOpen(i)) { flashLock(b); return; }
      S.model = i; refreshPicker(); A.unlock(); A.sfx('eat');
    });
  });
  grid.addEventListener('keydown', e => {   // arrow keys move through the unlocked characters
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 5, ArrowUp: -5 }[e.key]; if (d === undefined) return;
    e.preventDefault();
    let i = S.model; for (let n = 0; n < M.MODELS.length; n++) { i = (i + d + M.MODELS.length) % M.MODELS.length; if (modelOpen(i)) break; }
    S.model = i; refreshPicker(); grid.children[S.model].focus();
  });
  refreshPicker();
}
function flashLock(el) { el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope'); A.unlock(); A.sfx('reel'); }
function refreshPicker() {
  if (!$('modelGrid').children.length) return;
  if (!modelOpen(S.model)) S.model = 0;
  if (!colourOpen(S.ci)) S.ci = 0;
  const m = M.MODELS[S.model], look = M.pickModel(S.model, S.ci);
  S.color = look.col; S.paint = look.paint;
  const prem = S.ci >= 5 ? M.PREMIUM[S.ci - 5].name : '';
  $('charName').textContent = m.name + (prem ? ' · ' + prem : '');
  [...$('modelGrid').children].forEach((b, i) => {
    const on = i === S.model, open = modelOpen(i);
    b.classList.toggle('on', on); b.classList.toggle('locked', !open);
    b.querySelector('.mname').textContent = open ? M.MODELS[i].name : '???';
    b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-disabled', String(!open));
    b.setAttribute('aria-label', open ? M.MODELS[i].name : 'Locked: ' + lockText(M.modelUnlock(i)));
    b.title = open ? M.MODELS[i].name : lockText(M.modelUnlock(i)) + ' to unlock';
    b.tabIndex = on ? 0 : -1;
  });
  const sw = $('swatches'); sw.textContent = '';
  const addSwatch = (k, paint, label) => {
    const open = colourOpen(k), b = document.createElement('button'); b.type = 'button';
    b.className = 'swatch' + (k === S.ci ? ' on' : '') + (open ? '' : ' locked') + (k >= 5 ? ' premium p-' + M.PREMIUM[k - 5].id : '');
    b.style.setProperty('--c', open ? MazeModels.swatchCss(paint) : 'transparent');
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === S.ci));
    b.setAttribute('aria-label', open ? label : label + ', locked: ' + lockText(M.colourUnlock(k)));
    b.title = open ? label : lockText(M.colourUnlock(k)) + ' to unlock ' + label;
    if (!open) { const l = document.createElement('span'); l.textContent = String(M.colourUnlock(k)); b.appendChild(l); }
    b.addEventListener('click', () => { if (!colourOpen(k)) { flashLock(b); return; } S.ci = k; refreshPicker(); });
    sw.appendChild(b);
  };
  m.colors.forEach((col, k) => addSwatch(k, col, 'Colour ' + (k + 1)));
  const sep = document.createElement('span'); sep.className = 'swsep'; sep.textContent = 'Premium'; sw.appendChild(sep);
  M.PREMIUM.forEach((p, j) => addSwatch(5 + j, 'p:' + p.id, p.name));
  $('unlockHint').textContent = clearedLevel >= 50 ? 'Everything unlocked. Nice.'
    : 'Levels cleared: ' + clearedLevel + '. Clear more to unlock characters, colours and premium finishes (every 10 levels).';
  store.set('mm.model', String(S.model)); store.set('mm.ci', String(S.ci));
}
function animatePicker(t) {
  if ($('startOv').hidden) return;
  pickerCanvases.forEach((cv, i) => {
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    const on = i === S.model, open = modelOpen(i);
    const paint = on ? S.paint : M.MODELS[i].colors[0];
    const chew = on ? 0.5 + 0.5 * Math.sin(t * 10) : 0.35;
    if (!open) { g.globalAlpha = 0.9; g.filter = 'brightness(0)'; }
    MazeModels.draw(g, i, 56, 60, on ? 34 : 30, paint, 0, chew, on ? t : 0);
    g.filter = 'none'; g.globalAlpha = 1;
  });
}
buildPicker();

/* ---------- visibility ---------- */
function inviteHash() { return S.vis === 'private' && S.key ? S.seed + '~' + S.key : S.seed; }
function clearInvite() {
  S.inviteKey = '';
  $('inviteNote').hidden = true; $('visField').hidden = false; $('seedIn').readOnly = false; updateVisHint();
  $('createTitle').textContent = 'Start a new maze'; $('playBtn').textContent = 'Start maze';
}
function updateVisHint() {
  $('lnameField').hidden = $('visIn').value === 'private' || !!S.inviteKey || !!S.pwRoom;   // no create options while joining someone's locked lobby
  $('visHint').textContent = $('visIn').value === 'private'
    ? 'Your maze stays off the list. You’ll get a link to share; only people with it can join.'
    : 'Anyone on this server can see your maze and join it.';
}
function setVis(v) {
  $('visIn').value = v === 'private' ? 'private' : 'public';
  for (const b of document.querySelectorAll('.seg-b')) { const on = b.dataset.vis === $('visIn').value; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
  updateVisHint();
}
for (const b of document.querySelectorAll('.seg-b')) b.addEventListener('click', () => { setVis(b.dataset.vis); store.set('mm.vis', b.dataset.vis); });
$('visIn').addEventListener('change', updateVisHint);
$('ownBtn').addEventListener('click', () => {
  clearInvite(); $('seedIn').value = '';
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  $('seedIn').focus();
});

/* ---------- sound ---------- */
const VOL = { music: 10, sfx: 40 };
{ const m = parseInt(store.get('mm.music'), 10), f = parseInt(store.get('mm.sfx'), 10);
  if (m >= 0 && m <= 100) VOL.music = m; if (f >= 0 && f <= 100) VOL.sfx = f; }
let muted = null; // remembered levels while muted with M
function applyVol(kind, v, save = true) {
  VOL[kind] = v;
  $(kind === 'music' ? 'musicVol' : 'sfxVol').value = v;
  $(kind === 'music' ? 'musicOut' : 'sfxOut').textContent = v + '%';
  if (kind === 'music') A.setMusicVolume(v / 100); else A.setSfxVolume(v / 100);
  if (save) store.set(kind === 'music' ? 'mm.music' : 'mm.sfx', String(v));
}
$('musicVol').addEventListener('input', e => { A.unlock(); muted = null; applyVol('music', +e.target.value); });
$('sfxVol').addEventListener('input', e => { A.unlock(); muted = null; applyVol('sfx', +e.target.value); });
$('sfxVol').addEventListener('change', () => A.sfx('eat'));   // preview the level
function toggleMute() {
  A.unlock();
  if (muted) { applyVol('music', muted.music); applyVol('sfx', muted.sfx); muted = null; }
  else { muted = { music: VOL.music, sfx: VOL.sfx }; applyVol('music', 0, false); applyVol('sfx', 0, false); }
}
applyVol('music', VOL.music, false); applyVol('sfx', VOL.sfx, false);
// Browsers only allow audio after the first click or key press.
addEventListener('pointerdown', () => A.unlock(), { once: true });
addEventListener('keydown', () => A.unlock(), { once: true });

/* ---------- loop ---------- */
function frame() {
  const now = performance.now(), dt = Math.min(.05, (now - S.lastT) / 1000); S.lastT = now; S.time += dt;
  if (S.inGame && S.lvl) { playerStep(dt); updateGhostView(dt); }
  MazeFX.setRumble(S.inGame && effectOn('quake') ? 11 : S.inGame && S.streak >= 100 ? 1.6 : 0);   // earthquake, or a small steady shake from a 100 streak
  MazeFX.update(dt);
  animatePicker(S.time);
  render(dt); hud(dt, now);
  requestAnimationFrame(frame);
}

/* ---------- boot ---------- */
$('nameIn').value = (store.get('mm.name') || '').slice(0, 16);
$('lnameIn').value = (store.get('mm.lname') || '').slice(0, 32);
let rawHash = ''; try { rawHash = decodeURIComponent(location.hash.slice(1)); } catch (e) { /* ignore */ }
const [hashSeedPart, hashKey = ''] = rawHash.split('~');
const hashSeed = M.slug(hashSeedPart);
if (hashSeed) $('seedIn').value = hashSeed;
S.seed = hashSeed || M.randomSeed();
{ const v = store.get('mm.vis'); if (v === 'private' || v === 'public') setVis(v); }
if (hashSeed && /^[a-z0-9]{12}$/.test(hashKey)) {
  // Arrived from an invite link: join that private maze.
  S.inviteKey = hashKey;
  $('inviteNote').hidden = false; $('visField').hidden = true; $('lnameField').hidden = true; $('seedIn').readOnly = true;
  $('createTitle').textContent = 'Join private maze'; $('playBtn').textContent = 'Join maze';
}
updateVisHint();
S.lvl = M.genLevel(S.seed, 1); S.L = 1;
requestAnimationFrame(frame);
})();
