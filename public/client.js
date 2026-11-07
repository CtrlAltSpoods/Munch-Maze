/* Munch Maze browser client. Talks to the server over a WebSocket at ./ws */
(function () {
'use strict';
const M = window.MazeCore;
const { DIRS } = M;
const $ = id => document.getElementById(id);
const A = window.MazeAudio || { unlock() {}, startMusic() {}, stopMusic() {}, setFright() {}, setMusicVolume() {}, setSfxVolume() {}, sfx() {} };
const PCOL = ['#ffcc33', '#7cf0a0', '#6fd3ff', '#ff8fd1', '#ffa24c', '#c79bff', '#f2f2f2', '#ff7a7a'];
const GCOL = ['#ff4d5e', '#ff9ad5', '#41e0f0', '#ffb347', '#7ee081', '#b48cff'];
const INK = '#0a0c1c', INK2 = '#10133a';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
};
let token = '';
try { token = sessionStorage.getItem('mm.tok') || ''; } catch (e) { /* ignore */ }
if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); try { sessionStorage.setItem('mm.tok', token); } catch (e) { /* ignore */ } }

/* ---------- state ---------- */
const S = {
  name: '', seed: '', color: store.get('mm.col') || PCOL[Math.random() * PCOL.length | 0],
  ws: null, id: 0, inGame: false, wantGame: false, reconnectT: 0,
  key: '', vis: 'public', inviteKey: '',   // inviteKey: from an invite link we arrived with
  L: 0, lvl: null, me: { tx: 0, ty: 0, d: -1, t: 0, want: -1, face: 2 },
  myBits: new Uint8Array(1), srvBits: new Uint8Array(1),
  sc: 0, li: 3, over: false, alive: true, deadT: 0, inv: 0, ge: [],
  ph: 0, fr: 0, fid: 0, roster: new Map(), players: [], gTarget: [], gv: [], ov: new Map(),
  streak: 0, streakT: 0, streakTier: 0, shownScore: 0, mazeGlow: null, bulbs: [],
  host: 0, eatQ: [],
  time: 0, lastT: performance.now(), bannerT: 0, camX: null, camY: null, mazeKey: '', mazeCv: null, mazeFlash: null
};
if (!PCOL.includes(S.color)) S.color = PCOL[0];

function respawn() { const lv = S.lvl; S.me = { tx: lv.sx, ty: lv.sy, d: -1, t: 0, want: -1, face: 2 }; S.inv = 2; S.camX = null; }
function loadLevel(L, b64) {
  S.L = L; S.lvl = M.genLevel(S.seed, L);
  S.myBits = new Uint8Array(S.lvl.bytes);
  S.srvBits = b64 ? M.fromB64(b64, S.lvl.bytes) : new Uint8Array(S.lvl.bytes);
  S.ge = []; S.gv = []; S.gTarget = []; S.ph = 0; S.fr = 0;
  S.alive = true; respawn(); S.mazeKey = '';
  const n = M.ghostCount(L);
  endStreak(true);
  MazeFX.bigText('LEVEL ' + L, S.lvl.W + ' × ' + S.lvl.H + ' maze · ' + n + (n > 1 ? ' ghosts' : ' ghost') + ' · speed ' + speedLabel(L), '#41e0f0', 1.9);
}

/* ---------- networking ---------- */
function send(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }
function connect() {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.hash = ''; url.search = '';
  const ws = new WebSocket(url.href);
  S.ws = ws;
  ws.onopen = () => send({ t: 'join', nm: S.name, seed: S.seed, col: S.color, tok: token, vis: S.vis, key: S.key || S.inviteKey });
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
      S.roster.clear(); for (const r of m.roster || []) S.roster.set(r[0], { nm: String(r[1]), col: String(r[2]) });
      S.sc = m.sc | 0; S.li = m.li | 0; S.over = !!m.over;
      loadLevel(m.lv | 0, m.b);
      S.inGame = true;
      $('startOv').hidden = true; $('overOv').hidden = !S.over; $('leaveBtn').hidden = false; $('app').classList.add('ingame');
      $('playBtn').disabled = false; $('playBtn').textContent = 'Enter the maze';
      S.key = typeof m.key === 'string' ? m.key : ''; S.vis = m.vis === 'private' ? 'private' : 'public';
      S.host = m.host | 0; S.ph = m.ph | 0; updateReady();
      $('seedBtn').textContent = S.seed;
      $('seedBtn').title = S.vis === 'private' ? 'Copy invite link (only people with it can join)' : 'Copy link to this maze';
      const chip = $('visChip'); chip.hidden = false; chip.textContent = S.vis === 'private' ? 'Invite only' : 'Public'; chip.classList.toggle('private', S.vis === 'private');
      try { history.replaceState(null, '', '#' + inviteHash()); } catch (e) { /* ignore */ }
      setNet('');
      A.startMusic(S.L); A.sfx('start');
      break;
    }
    case 'level': S.ph = 0; updateReady(); loadLevel(m.lv | 0, ''); A.startMusic(S.L); A.setFright(false); if (S.L > 1 && !S.over) A.sfx('life'); break;
    case 'join': S.roster.set(m.id, { nm: String(m.nm), col: String(m.col) }); A.sfx('join'); break;
    case 'leave': S.roster.delete(m.id); S.ov.delete(m.id); break;
    case 'pts': MazeFX.text(+m.x || 0, (+m.y || 0) - 0.3, String(m.v | 0), '#41e0f0', 0.95); break;
    case 'error':
      S.wantGame = false;
      $('joinErr').textContent = String(m.msg || 'Could not join.'); $('joinErr').hidden = false;
      $('playBtn').disabled = false; $('playBtn').textContent = 'Enter the maze';
      if (S.ws) S.ws.close();
      break;
    case 's': {
      if ((m.lv | 0) !== S.L) return;
      for (const i of m.e || []) if (i >= 0 && i < S.lvl.W * S.lvl.H) {
        if (!M.getBit(S.myBits, i) && !M.getBit(S.srvBits, i)) MazeFX.sparks(i % S.lvl.W, (i / S.lvl.W) | 0, '#ffdcae', 4, 4, 0.3);
        M.setBit(S.srvBits, i);
      }
      const wasPh = S.ph;
      S.ph = m.ph | 0; S.fr = +m.fr || 0; S.ct = +m.ct || 0;
      if (S.ph === 1 && wasPh !== 1) levelClear();
      const hostWas = S.host; S.host = m.h | 0;
      if (S.ph !== wasPh || S.host !== hostWas) updateReady();
      A.setFright(S.fr > 0 && S.ph === 0);
      if (m.fid !== S.fid) { S.fid = m.fid; }
      S.gTarget = (m.g || []).map((a, i) => ({ i, x: +a[0], y: +a[1], d: a[2] | 0, st: a[3] | 0, ep: a[4] | 0 }));
      const pl = [];
      for (const a of m.p || []) {
        const id = a[0], r = S.roster.get(id) || { nm: 'Player', col: '#ffcc33' };
        const p = { id, x: +a[1], y: +a[2], f: a[3] & 3, al: a[4] === 1, sc: a[5] | 0, li: a[6] | 0, over: a[7] === 1, nm: r.nm, col: /^#[0-9a-f]{6}$/i.test(r.col) ? r.col : '#ffcc33' };
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

/* ---------- local player ---------- */
const eaten = i => M.getBit(S.srvBits, i) || M.getBit(S.myBits, i);
function eatAt(x, y) {
  const lv = S.lvl, i = y * lv.W + x;
  if (!lv.p[i] || eaten(i)) return;
  M.setBit(S.myBits, i); S.eatQ.push(i);
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
  if (S.streak) { S.streakT += dt; if (S.streakT > STREAK_WINDOW) endStreak(false); }
  if (S.inv > 0) S.inv -= dt;
  // move in small steps and check for ghosts after each, so fast levels can't skip past one
  const dist = M.playerSpeed(S.L) * dt, steps = Math.max(1, Math.ceil(dist / 0.3));
  for (let k = 0; k < steps && S.alive; k++) { movePlayer(S.me, dist / steps); checkGhosts(); }
}
function checkGhosts() {
  const [px, py] = M.entPos(S.me);
  for (const g of S.gv) {
    if (g.st !== 1 && g.st !== 2) continue;
    if (Math.hypot(g.x - px, g.y - py) > 0.62) continue;
    if (g.st === 2) {
      S.ge.push([g.i, g.ep]); if (S.ge.length > 8) S.ge.shift();
      g.st = 3; send({ t: 'ghost', i: g.i, ep: g.ep }); A.sfx('ghost');
      MazeFX.ring(g.x, g.y, '#41e0f0', 3, 0.45); MazeFX.sparks(g.x, g.y, GCOL[g.i % GCOL.length], 22, 10, 0.55); MazeFX.coins(g.x, g.y, 5); MazeFX.shake(7); A.sfx('coin');
    } else if (S.inv <= 0) {
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
    next.push({ i: s.i, x: vx, y: vy, d: s.d, st, ep: s.ep });
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
    const box = $('games'); box.textContent = '';
    if (!list.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'No one is in a maze right now. Start one and share the seed.'; box.appendChild(d); }
    for (const g of list) {
      const b = document.createElement('button'); b.type = 'button';
      const a = document.createElement('span'); a.className = 's'; a.textContent = g.seed;
      const c = document.createElement('span'); c.className = 'c'; c.textContent = g.players + (g.players === 1 ? ' player' : ' players') + ' · L' + g.level;
      b.append(a, c); b.addEventListener('click', () => { clearInvite(); $('seedIn').value = g.seed; $('visIn').value = 'public'; updateVisHint(); join(); }); box.appendChild(b);
    }
  } catch (e) { /* server busy; try again later */ }
  try {
    const sc = await getJSON('api/scores');
    const ol = $('scores'); ol.textContent = '';
    if (!sc.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No scores yet.'; ol.appendChild(li); }
    for (const s of sc) {
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.n + ' ';
      const sm = document.createElement('small'); sm.textContent = 'L' + s.lv + ' · ' + s.seed; nm.appendChild(sm);
      const v = document.createElement('span'); v.className = 'sc'; v.textContent = (s.sc | 0).toLocaleString();
      li.append(nm, v); ol.appendChild(li);
    }
  } catch (e) { /* ignore */ }
}
getJSON('api/info').then(info => {
  lobbyOn = !!info.lobby; $('lobbyBox').hidden = !lobbyOn;
  if (info.name && info.name !== 'Munch Maze') document.title = info.name + ' · Munch Maze';
  if (info.defaultSeed && !$('seedIn').value) $('seedIn').placeholder = 'Leave blank for ' + info.defaultSeed;
}).catch(() => {});
refreshLobby(); setInterval(refreshLobby, 3000);

function join() {
  S.name = ($('nameIn').value.trim() || 'Player').slice(0, 16);
  store.set('mm.name', S.name); store.set('mm.col', S.color);
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

/* Background: slow drifting starfield tinted by the level colour. */
let stars = [];
function makeStars() {
  const n = Math.round(Math.min(220, CW * CH / 4500));
  stars = Array.from({ length: n }, () => ({ x: Math.random() * CW, y: Math.random() * CH, z: Math.random(), tw: Math.random() * 6 }));
}
new ResizeObserver(resize).observe(stage); resize();
function drawBackground(dt, hue, beat) {
  const g = ctx.createRadialGradient(CW / 2, CH / 2, 0, CW / 2, CH / 2, Math.max(CW, CH) * 0.75);
  g.addColorStop(0, `hsl(${hue} 55% ${10 + beat * 3}%)`); g.addColorStop(0.55, '#0b0d22'); g.addColorStop(1, '#05060f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  const drift = MazeFX.reduced() ? 0 : dt;
  ctx.fillStyle = '#ffffff';
  for (const s of stars) {
    s.y += drift * (6 + s.z * 22); if (s.y > CH) { s.y = -2; s.x = Math.random() * CW; }
    ctx.globalAlpha = 0.15 + s.z * 0.5 * (0.6 + 0.4 * Math.sin(S.time * 2 + s.tw));
    const r = 0.5 + s.z * 1.3; ctx.fillRect(s.x, s.y, r, r);
  }
  ctx.globalAlpha = 1;
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
  const m = buildMaze(lv, T, hsl(lv.hue, 85, 62), hsl(lv.hue, 100, 88)), f = buildMaze(lv, T, '#f4f6ff', '#ffffff');
  S.mazeCv = m.c; S.mazeGlow = m.gl; S.mazeFlash = f.c;
  // marquee bulbs sit on the outer wall
  S.bulbs = [];
  for (let x = 0; x < lv.W; x++) S.bulbs.push([x, 0]);
  for (let y = 1; y < lv.H; y++) S.bulbs.push([lv.W - 1, y]);
  for (let x = lv.W - 2; x >= 0; x--) S.bulbs.push([x, lv.H - 1]);
  for (let y = lv.H - 2; y > 0; y--) S.bulbs.push([0, y]);
  S.bulbs = S.bulbs.filter(([x, y]) => lv.t[y * lv.W + x] === 1);
}
function drawBulbs(T, beat) {
  const n = S.bulbs.length, clear = S.ph !== 0, hot = S.streakTier >= 3;
  const speed = clear ? 0 : hot ? 22 : 9, phase = Math.floor(S.time * speed), alt = Math.floor(S.time * 2.5) % 2;
  const reduced = MazeFX.reduced();
  for (let i = 0; i < n; i++) {
    const [x, y] = S.bulbs[i];
    let on = clear ? (i % 2 === alt) : reduced ? i % 3 === 0 : ((i + phase) % 4 === 0 || (hot && (i - phase + n * 4) % 4 === 0));
    const col = hot ? hsl((i * 12 + S.time * 200) % 360, 100, 60) : (i % 2 ? '#ffcc33' : '#ff9ad5');
    const cx = (x + .5) * T, cy = (y + .5) * T;
    if (on) blit(glowSprite(hot ? '#ffffff' : col, T * 0.1, T * 0.35, '#ffffff'), cx, cy, 1 + beat * 0.25);
    else { ctx.fillStyle = 'rgba(255,255,255,0.13)'; ctx.beginPath(); ctx.arc(cx, cy, T * 0.07, 0, Math.PI * 2); ctx.fill(); }
    if (hot && on) { ctx.globalCompositeOperation = 'lighter'; blit(glowSprite('#ff6a00', T * 0.05, T * 0.3), cx, cy); ctx.globalCompositeOperation = 'source-over'; }
  }
}

function drawPac(x, y, T, col, face, mouth, glow = true) {
  const cx = (x + .5) * T, cy = (y + .5) * T, r = T * .44, a = [0, Math.PI / 2, Math.PI, -Math.PI / 2][face & 3], m = Math.min(.999, mouth) * Math.PI;
  if (glow) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= 0.55; blit(glowSprite(col, T * 0.3, T * 0.55), cx, cy); ctx.globalAlpha /= 0.55; ctx.globalCompositeOperation = 'source-over'; }
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, col); g.addColorStop(1, shade(col, -0.25));
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a + m, a + 2 * Math.PI - m); ctx.closePath(); ctx.fill();
  const ea = face === 2 ? a + 1.1 : a - 1.1;   // eye sits on the upper side of the mouth
  ctx.fillStyle = '#0a0c1c'; ctx.beginPath(); ctx.arc(cx + Math.cos(ea) * r * 0.5, cy + Math.sin(ea) * r * 0.5, r * 0.11, 0, Math.PI * 2); ctx.fill();
}
function shade(hex, k) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(v + (k < 0 ? v * k : (255 - v) * k)))); return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`; }
function drawGhost(x, y, T, col, st, d, flash) {
  const cx = (x + .5) * T, cy = (y + .5) * T, r = T * .44;
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
  const clearFlash = S.inGame && S.ph === 1 && Math.floor(S.time * 2.5) % 2 === 0;   // ≤3 flashes/s
  ctx.drawImage(clearFlash ? S.mazeFlash : S.mazeCv, -T, -T);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.25 + beat * 0.45 + (S.streakTier >= 3 ? 0.25 : 0); ctx.drawImage(S.mazeGlow, -T, -T);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawBulbs(T, beat);
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
    for (const g of S.gv) drawGhost(g.x, g.y, T, GCOL[g.i % GCOL.length], g.st, g.d, fl);
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const kx = 1 - Math.exp(-dt * 16);
    for (const p of S.players) {
      if (!p.al || p.over) continue;
      let o = S.ov.get(p.id); if (!o || Math.hypot(o.x - p.x, o.y - p.y) > 3) { o = { x: p.x, y: p.y }; S.ov.set(p.id, o); }
      o.x += (p.x - o.x) * kx; o.y += (p.y - o.y) * kx;
      ctx.globalAlpha = .92; drawPac(o.x, o.y, T, p.col, p.f, .06 + .22 * Math.abs(Math.sin(S.time * 12 + p.id))); ctx.globalAlpha = 1;
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
      const tcol = S.streakTier >= 3 ? '#ff7a1a' : S.color;
      for (const p of trail) { const a = 1 - (S.time - p.t) / 0.22; ctx.globalAlpha = a * (S.streakTier >= 2 ? 0.7 : 0.4); blit(glowSprite(tcol, T * 0.18, T * 0.3), (p.x + .5) * T, (p.y + .5) * T, 0.6 + a * 0.5); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    if (!S.over) {
      if (!S.alive) { const prog = 1 - Math.max(0, S.deadT) / 1.4; if (prog < .95) drawPac(px, py, T, S.color, 3, .15 + .85 * prog); }
      else {
        const blink = S.inv > 0 && Math.floor(S.time * 10) % 2 === 0;
        if (!blink) drawPac(px, py, T, S.color, S.me.face, S.me.d >= 0 && S.ph === 0 ? .06 + .24 * Math.abs(Math.sin(S.time * 14)) : .18);
        ctx.strokeStyle = S.color; ctx.globalAlpha = .35 + beat * .3; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc((px + .5) * T, (py + .5) * T, T * (.62 + beat * .08), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }
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
  let left = 0; for (const i of lv.pList) if (!eaten(i)) left++;
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
addEventListener('keydown', e => { if (e.code === 'KeyM' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { toggleMute(); return; } if (!S.inGame || /INPUT|SELECT/.test(e.target.tagName)) return; if (e.code in KEYS) { S.me.want = KEYS[e.code]; e.preventDefault(); } });
let touch = null;
cv.addEventListener('touchstart', e => { const t = e.changedTouches[0]; touch = [t.clientX, t.clientY]; }, { passive: true });
cv.addEventListener('touchmove', e => {
  if (!touch || !S.inGame) return; const t = e.changedTouches[0], dx = t.clientX - touch[0], dy = t.clientY - touch[1];
  if (Math.max(Math.abs(dx), Math.abs(dy)) > 18) { S.me.want = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3); touch = [t.clientX, t.clientY]; }
  e.preventDefault();
}, { passive: false });
document.querySelectorAll('#dpad button').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); if (S.inGame) S.me.want = +b.dataset.d; }));
$('startForm').addEventListener('submit', e => { e.preventDefault(); join(); });
$('leaveBtn').addEventListener('click', leave);
$('againBtn').addEventListener('click', () => { send({ t: 'again' }); S.over = false; S.alive = true; respawn(); $('overOv').hidden = true; });
$('seedBtn').addEventListener('click', () => {
  const b = $('seedBtn'), s = S.seed; if (!s) return;
  const link = location.origin + location.pathname + '#' + inviteHash();
  const done = () => { b.textContent = 'Link copied'; setTimeout(() => { b.textContent = s; }, 1200); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link).then(done, () => prompt('Invite link', link));
  else prompt('Invite link', link);
});

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
    if (t >= 4) { MazeFX.confetti(t >= 5 || mega ? 220 : 140, CW); MazeFX.flash('#ffcc33', 0.25); MazeFX.shake(6); A.sfx('jackpot'); }
    else A.sfx('streak', t);
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
  streakEl.hidden = !on;
  if (!on) { lastStreakShown = -1; return; }
  if (S.streak !== lastStreakShown) {
    lastStreakShown = S.streak;
    $('streakN').textContent = '×' + S.streak;
    streakEl.dataset.tier = String(S.streakTier);
    streakEl.classList.remove('tick'); void streakEl.offsetWidth; streakEl.classList.add('tick');
  }
  $('streakBar').style.transform = 'scaleX(' + Math.max(0, 1 - S.streakT / STREAK_WINDOW).toFixed(3) + ')';
}
function levelClear() {
  A.sfx('clear'); endStreak(false);
  const nx = M.genLevel(S.seed, S.L + 1);
  const syms = [String(nx.W), '×', String(nx.H)];
  MazeFX.confetti(160, CW); MazeFX.flash('#ffcc33', 0.2);
  const [px, py] = M.entPos(S.me); MazeFX.coins(px, py, 14, 10);
  MazeFX.reels(syms, { title: 'LEVEL ' + S.L + ' CLEAR', sub: 'NEXT MAZE  ·  ' + M.ghostCount(S.L + 1) + (M.ghostCount(S.L + 1) > 1 ? ' GHOSTS' : ' GHOST') + '  ·  SPEED +10%', dur: 2.5,
    onStop: i => { A.sfx('reel'); if (i === syms.length - 1) { A.sfx('jackpot'); MazeFX.confetti(90, CW); } } });
}

/* ---------- between levels: the host starts the next one ---------- */
function speedLabel(L) { return '×' + M.speedMult(L).toFixed(2); }
function hostName() {
  if (S.host === S.id) return S.name;
  const r = S.roster.get(S.host); return r ? r.nm : 'the host';
}
function updateReady() {
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
function sendReady() { if (S.ph === 2 && S.host === S.id) { send({ t: 'ready' }); $('readyBtn').disabled = true; setTimeout(() => { $('readyBtn').disabled = false; }, 1500); A.sfx('start'); } }
$('readyBtn').addEventListener('click', sendReady);
addEventListener('keydown', e => { if ((e.code === 'Enter' || e.code === 'Space') && S.ph === 2 && S.host === S.id && e.target.tagName !== 'BUTTON' && !/INPUT|SELECT/.test(e.target.tagName)) { e.preventDefault(); sendReady(); } });

/* ---------- visibility ---------- */
function inviteHash() { return S.vis === 'private' && S.key ? S.seed + '~' + S.key : S.seed; }
function clearInvite() {
  S.inviteKey = '';
  $('inviteNote').hidden = true; $('visField').hidden = false; $('seedIn').readOnly = false;
}
function updateVisHint() {
  $('visHint').textContent = $('visIn').value === 'private'
    ? 'Your maze stays off the list. You’ll get a link to share; only people with it can join.'
    : 'Anyone on this server can see your maze and join it.';
}
$('visIn').addEventListener('change', updateVisHint);
$('ownBtn').addEventListener('click', () => {
  clearInvite(); $('seedIn').value = '';
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  $('seedIn').focus();
});

/* ---------- sound ---------- */
const VOL = { music: 20, sfx: 40 };
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
  MazeFX.update(dt);
  render(dt); hud(dt, now);
  requestAnimationFrame(frame);
}

/* ---------- boot ---------- */
$('nameIn').value = (store.get('mm.name') || '').slice(0, 16);
let rawHash = ''; try { rawHash = decodeURIComponent(location.hash.slice(1)); } catch (e) { /* ignore */ }
const [hashSeedPart, hashKey = ''] = rawHash.split('~');
const hashSeed = M.slug(hashSeedPart);
if (hashSeed) $('seedIn').value = hashSeed;
S.seed = hashSeed || M.randomSeed();
{ const v = store.get('mm.vis'); if (v === 'private' || v === 'public') $('visIn').value = v; }
if (hashSeed && /^[a-z0-9]{12}$/.test(hashKey)) {
  // Arrived from an invite link: join that private maze.
  S.inviteKey = hashKey;
  $('inviteNote').hidden = false; $('visField').hidden = true; $('seedIn').readOnly = true;
}
updateVisHint();
S.lvl = M.genLevel(S.seed, 1); S.L = 1;
requestAnimationFrame(frame);
})();
