/* Munch Maze browser client. Talks to the server over a WebSocket at ./ws */
(function () {
'use strict';
const M = window.MazeCore;
const { DIRS } = M;
const $ = id => document.getElementById(id);
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
  L: 0, lvl: null, me: { tx: 0, ty: 0, d: -1, t: 0, want: -1, face: 2 },
  myBits: new Uint8Array(1), srvBits: new Uint8Array(1),
  sc: 0, li: 3, over: false, alive: true, deadT: 0, inv: 0, ge: [],
  ph: 0, fr: 0, fid: 0, roster: new Map(), players: [], gTarget: [], gv: [], ov: new Map(), pops: [],
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
  showBanner('Level ' + L, S.lvl.W + ' × ' + S.lvl.H + ' maze · ' + n + (n > 1 ? ' ghosts' : ' ghost'), 1.8);
}

/* ---------- networking ---------- */
function send(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }
function connect() {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.hash = ''; url.search = '';
  const ws = new WebSocket(url.href);
  S.ws = ws;
  ws.onopen = () => send({ t: 'join', nm: S.name, seed: S.seed, col: S.color, tok: token });
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
      $('seedBtn').textContent = S.seed;
      try { history.replaceState(null, '', '#' + S.seed); } catch (e) { /* ignore */ }
      setNet('');
      break;
    }
    case 'level': loadLevel(m.lv | 0, ''); break;
    case 'join': S.roster.set(m.id, { nm: String(m.nm), col: String(m.col) }); break;
    case 'leave': S.roster.delete(m.id); S.ov.delete(m.id); break;
    case 'pts': S.pops.push({ x: +m.x || 0, y: +m.y || 0, txt: String(m.v | 0), t: 0 }); break;
    case 'error':
      S.wantGame = false;
      $('joinErr').textContent = String(m.msg || 'Could not join.'); $('joinErr').hidden = false;
      $('playBtn').disabled = false; $('playBtn').textContent = 'Enter the maze';
      if (S.ws) S.ws.close();
      break;
    case 's': {
      if ((m.lv | 0) !== S.L) return;
      for (const i of m.e || []) if (i >= 0 && i < S.lvl.W * S.lvl.H) M.setBit(S.srvBits, i);
      S.ph = m.ph | 0; S.fr = +m.fr || 0; S.ct = +m.ct || 0;
      if (m.fid !== S.fid) { S.fid = m.fid; }
      S.gTarget = (m.g || []).map((a, i) => ({ i, x: +a[0], y: +a[1], d: a[2] | 0, st: a[3] | 0, ep: a[4] | 0 }));
      const pl = [];
      for (const a of m.p || []) {
        const id = a[0], r = S.roster.get(id) || { nm: 'Player', col: '#ffcc33' };
        const p = { id, x: +a[1], y: +a[2], f: a[3] & 3, al: a[4] === 1, sc: a[5] | 0, li: a[6] | 0, over: a[7] === 1, nm: r.nm, col: /^#[0-9a-f]{6}$/i.test(r.col) ? r.col : '#ffcc33' };
        if (id === S.id) {
          S.sc = p.sc; S.li = p.li;
          if (p.over && !S.over) { S.over = true; $('overTxt').textContent = 'You scored ' + S.sc.toLocaleString() + ' and reached level ' + S.L + '.'; $('overOv').hidden = false; }
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
  const [x, y] = M.entPos(S.me);
  send({ t: 'p', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, f: S.me.face });
}, 50);

/* ---------- local player ---------- */
const eaten = i => M.getBit(S.srvBits, i) || M.getBit(S.myBits, i);
function eatAt(x, y) {
  const lv = S.lvl, i = y * lv.W + x;
  if (!lv.p[i] || eaten(i)) return;
  M.setBit(S.myBits, i); send({ t: 'eat', i });
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
    if (S.deadT <= 0 && S.li > 0) { S.alive = true; respawn(); send({ t: 'respawn' }); }
    return;
  }
  if (S.ph === 1) return;
  movePlayer(S.me, M.playerSpeed(S.L) * dt);
  if (S.inv > 0) S.inv -= dt;
  const [px, py] = M.entPos(S.me);
  for (const g of S.gv) {
    if (g.st !== 1 && g.st !== 2) continue;
    if (Math.hypot(g.x - px, g.y - py) > 0.62) continue;
    if (g.st === 2) {
      S.ge.push([g.i, g.ep]); if (S.ge.length > 8) S.ge.shift();
      g.st = 3; send({ t: 'ghost', i: g.i, ep: g.ep });
    } else if (S.inv <= 0) {
      S.alive = false; S.deadT = 1.4; send({ t: 'die' }); break;
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
      b.append(a, c); b.addEventListener('click', () => { $('seedIn').value = g.seed; join(); }); box.appendChild(b);
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
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  refreshLobby();
}

/* ---------- rendering ---------- */
const cv = $('cv'), ctx = cv.getContext('2d'), stage = $('stage');
let CW = 1, CH = 1, DPR = 1;
function resize() { const r = stage.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); CW = Math.max(1, r.width); CH = Math.max(1, r.height); cv.width = Math.round(CW * DPR); cv.height = Math.round(CH * DPR); S.mazeKey = ''; }
new ResizeObserver(resize).observe(stage); resize();

function buildMaze(lv, T, col) {
  const c = document.createElement('canvas'); c.width = lv.W * T; c.height = lv.H * T; const g = c.getContext('2d');
  const isW = (x, y) => x >= 0 && y >= 0 && x < lv.W && y < lv.H && lv.t[y * lv.W + x] === 1;
  g.fillStyle = 'rgba(255,154,213,0.06)';
  for (let x = lv.mid - 2; x <= lv.mid + 2; x++) g.fillRect(x * T, lv.cy * T, T, T);
  g.beginPath();
  for (let y = 0; y < lv.H; y++) for (let x = 0; x < lv.W; x++) {
    if (!isW(x, y)) continue; const cx = (x + .5) * T, cy = (y + .5) * T;
    g.moveTo(cx, cy); g.lineTo(cx + .01, cy);
    if (isW(x + 1, y)) { g.moveTo(cx, cy); g.lineTo(cx + T, cy); }
    if (isW(x, y + 1)) { g.moveTo(cx, cy); g.lineTo(cx, cy + T); }
  }
  g.lineCap = 'round'; g.lineJoin = 'round';
  const w = T * 0.62; g.strokeStyle = col; g.lineWidth = w; g.stroke();
  g.strokeStyle = INK2; g.lineWidth = Math.max(1, w - 2 * Math.max(1.5, T * 0.1)); g.stroke();
  g.fillStyle = '#ff9ad5'; g.fillRect(lv.mid * T, (lv.cy - 1) * T + T * .42, T, T * .16);
  return c;
}
function ensureMaze(T) {
  const lv = S.lvl, key = S.seed + '|' + lv.L + '|' + T; if (S.mazeKey === key) return;
  S.mazeKey = key; S.mazeCv = buildMaze(lv, T, 'hsl(' + lv.hue + ' 80% 62%)'); S.mazeFlash = buildMaze(lv, T, '#f4f6ff');
}
function drawPac(x, y, T, col, face, mouth) {
  const cx = (x + .5) * T, cy = (y + .5) * T, r = T * .44, a = [0, Math.PI / 2, Math.PI, -Math.PI / 2][face & 3], m = Math.min(.999, mouth) * Math.PI;
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a + m, a + 2 * Math.PI - m); ctx.closePath(); ctx.fill();
}
function drawGhost(x, y, T, col, st, d, flash) {
  const cx = (x + .5) * T, cy = (y + .5) * T, r = T * .44;
  if (st !== 3) {
    ctx.fillStyle = st === 2 ? (flash ? '#e8ecff' : '#2f45ff') : col;
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
function render(dt) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = INK; ctx.fillRect(0, 0, CW, CH);
  const lv = S.lvl; if (!lv) return;
  const fit = Math.min((CW - 16) / lv.W, (CH - 16) / lv.H);
  const T = Math.max(14, Math.min(34, Math.floor(fit)));
  ensureMaze(T);
  const mw = lv.W * T, mh = lv.H * T;
  const [mx, my] = S.inGame ? M.entPos(S.me) : [lv.mid, lv.cy];
  const tx = mw <= CW ? (CW - mw) / 2 : Math.min(8, Math.max(CW - mw - 8, CW / 2 - (mx + .5) * T));
  const ty = mh <= CH ? (CH - mh) / 2 : Math.min(8, Math.max(CH - mh - 8, CH / 2 - (my + .5) * T));
  if (S.camX === null || Math.abs(S.camX - tx) > CW) { S.camX = tx; S.camY = ty; }
  const kk = 1 - Math.exp(-dt * 10); S.camX += (tx - S.camX) * kk; S.camY += (ty - S.camY) * kk;
  const ox = Math.round(S.camX), oy = Math.round(S.camY);
  ctx.save(); ctx.translate(ox, oy);
  ctx.beginPath(); ctx.rect(0, 0, mw, mh); ctx.clip();
  const flash = S.inGame && S.ph === 1 && Math.floor(S.time * 6) % 2 === 0;
  ctx.drawImage(flash ? S.mazeFlash : S.mazeCv, 0, 0);
  const x0 = Math.max(0, Math.floor(-ox / T) - 1), x1 = Math.min(lv.W - 1, Math.ceil((CW - ox) / T) + 1);
  const y0 = Math.max(0, Math.floor(-oy / T) - 1), y1 = Math.min(lv.H - 1, Math.ceil((CH - oy) / T) + 1);
  const pulse = .75 + .25 * Math.sin(S.time * 7);
  ctx.fillStyle = '#ffdcae';
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * lv.W + x, k = lv.p[i]; if (!k) continue;
    if (S.inGame && eaten(i)) continue;
    ctx.beginPath(); ctx.arc((x + .5) * T, (y + .5) * T, k === 2 ? T * .3 * pulse : Math.max(1.5, T * .1), 0, Math.PI * 2); ctx.fill();
  }
  if (S.inGame) {
    const fl = S.fr > 0 && S.fr < 2 && Math.floor(S.time * 5) % 2 === 0;
    for (const g of S.gv) drawGhost(g.x, g.y, T, GCOL[g.i % GCOL.length], g.st, g.d, fl);
    ctx.font = '600 ' + Math.max(10, Math.round(T * .42)) + 'px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const kx = 1 - Math.exp(-dt * 16);
    for (const p of S.players) {
      if (!p.al || p.over) continue;
      let o = S.ov.get(p.id); if (!o || Math.hypot(o.x - p.x, o.y - p.y) > 3) { o = { x: p.x, y: p.y }; S.ov.set(p.id, o); }
      o.x += (p.x - o.x) * kx; o.y += (p.y - o.y) * kx;
      ctx.globalAlpha = .92; drawPac(o.x, o.y, T, p.col, p.f, .06 + .22 * Math.abs(Math.sin(S.time * 12 + p.id))); ctx.globalAlpha = 1;
      ctx.fillStyle = '#eef0ff'; ctx.fillText(p.nm, (o.x + .5) * T, (o.y + .5) * T - T * .5);
    }
    const [px, py] = M.entPos(S.me);
    if (!S.over) {
      if (!S.alive) { const prog = 1 - Math.max(0, S.deadT) / 1.4; if (prog < .95) drawPac(px, py, T, S.color, 3, .15 + .85 * prog); }
      else {
        const blink = S.inv > 0 && Math.floor(S.time * 10) % 2 === 0;
        if (!blink) drawPac(px, py, T, S.color, S.me.face, S.me.d >= 0 && S.ph !== 1 ? .06 + .24 * Math.abs(Math.sin(S.time * 14)) : .18);
        ctx.strokeStyle = S.color; ctx.globalAlpha = .35; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc((px + .5) * T, (py + .5) * T, T * .62, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = '#6fd3ff';
    S.pops = S.pops.filter(p => (p.t += dt) < 0.9);
    for (const p of S.pops) { ctx.globalAlpha = 1 - p.t / 0.9; ctx.fillText(p.txt, (p.x + .5) * T, (p.y + .5) * T - p.t * T); } ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/* ---------- HUD ---------- */
const bannerEl = $('banner');
function showBanner(t, s, dur) { $('bannerT').textContent = t; $('bannerS').textContent = s; bannerEl.hidden = false; S.bannerT = dur; }
const setTxt = (id, v) => { const e = $(id); v = String(v); if (e.textContent !== v) e.textContent = v; };
function setNet(msg) {
  const net = $('netState'); net.textContent = '';
  if (msg) { net.textContent = msg; return; }
  const b = document.createElement('b'); b.textContent = 'Live'; net.append(b, ' · send the invite link to bring friends into this maze.');
}
let lastLives = -1, boardAt = 0;
function hud(dt, now) {
  const lv = S.lvl; if (!lv) return;
  setTxt('hLevel', S.L || 1); setTxt('hSize', lv.W + '×' + lv.H); setTxt('hScore', S.sc.toLocaleString());
  if (lastLives !== S.li) { lastLives = S.li; const b = $('hLives'); b.textContent = ''; for (let i = 0; i < S.li; i++) { const s = document.createElement('span'); s.className = 'life'; b.appendChild(s); } }
  if (S.bannerT > 0) { S.bannerT -= dt; if (S.bannerT <= 0) bannerEl.hidden = true; }
  if (S.inGame && S.ph === 1 && bannerEl.hidden) { const nx = M.genLevel(S.seed, S.L + 1); showBanner('Level ' + S.L + ' clear', 'Next: ' + nx.W + ' × ' + nx.H + ' maze', 2.4); }
  if (now - boardAt < 300) return; boardAt = now;
  if (!S.inGame) { setTxt('pCount', '0'); return; }
  let left = 0; for (const i of lv.pList) if (!eaten(i)) left++;
  setTxt('pLeft', left); setTxt('gCount', M.ghostCount(S.L));
  const rows = [{ nm: S.name, col: S.color, sc: S.sc, al: S.alive && !S.over, me: true }];
  for (const p of S.players) rows.push({ nm: p.nm, col: p.col, sc: p.sc, al: p.al && !p.over, me: false });
  rows.sort((a, b) => b.sc - a.sc);
  setTxt('pCount', rows.length);
  const ol = $('board'); ol.textContent = '';
  for (const r of rows.slice(0, 60)) {
    const li = document.createElement('li'); if (!r.al) li.className = 'dead';
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = r.col;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.nm;
    if (r.me) { const sm = document.createElement('small'); sm.textContent = 'you'; nm.appendChild(sm); }
    const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = r.sc.toLocaleString();
    li.append(sw, nm, sc); ol.appendChild(li);
  }
  if (rows.length > 60) { const li = document.createElement('li'); li.textContent = '+' + (rows.length - 60) + ' more'; ol.appendChild(li); }
}

/* ---------- input ---------- */
const KEYS = { ArrowRight: 0, KeyD: 0, ArrowDown: 1, KeyS: 1, ArrowLeft: 2, KeyA: 2, ArrowUp: 3, KeyW: 3 };
addEventListener('keydown', e => { if (!S.inGame || e.target.tagName === 'INPUT') return; if (e.code in KEYS) { S.me.want = KEYS[e.code]; e.preventDefault(); } });
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
  const link = location.origin + location.pathname + '#' + s;
  const done = () => { b.textContent = 'Link copied'; setTimeout(() => { b.textContent = s; }, 1200); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link).then(done, () => prompt('Invite link', link));
  else prompt('Invite link', link);
});

/* ---------- loop ---------- */
function frame() {
  const now = performance.now(), dt = Math.min(.05, (now - S.lastT) / 1000); S.lastT = now; S.time += dt;
  if (S.inGame && S.lvl) { playerStep(dt); updateGhostView(dt); }
  render(dt); hud(dt, now);
  requestAnimationFrame(frame);
}

/* ---------- boot ---------- */
$('nameIn').value = (store.get('mm.name') || '').slice(0, 16);
const hashSeed = M.slug(decodeURIComponent(location.hash.slice(1)));
if (hashSeed) $('seedIn').value = hashSeed;
S.seed = hashSeed || M.randomSeed();
S.lvl = M.genLevel(S.seed, 1); S.L = 1;
requestAnimationFrame(frame);
})();
