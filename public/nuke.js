/* Munch Maze: the Nuke.
   1. drawWarning(): while everyone survives the countdown, a red alarm overlay.
   2. start(): the cinematic (game paused, 7 s on the server):
        0.0 s  a fighter jet streaks in from the left
        1.6 s  over the middle it drops the bomb
        2.8 s  the bomb hits the centre of the maze: white-out, fireball,
               shockwaves, mushroom cloud, and the maze itself is torn into
               chunks that fly out towards the camera.
   Everything is drawn in screen space on top of the game canvas. */
(function () {
'use strict';
const RELEASE = 1.6, DET = 2.8, END = 7.0;
const rnd = (a, b) => a + Math.random() * (b - a);
const ease3 = k => 1 - Math.pow(1 - k, 3);
let nk = null;   // the running cinematic

function start({ lv, mazeCv, onRelease, onDetonate }) {
  nk = { t: 0, lv, mazeCv, onRelease, onDetonate, released: false, det: false, trail: [], blocks: null, embers: [], puffs: [], view: null };
}
function clear() { nk = null; }

function update(dt) {
  if (!nk) return;
  nk.t += dt;
  if (!nk.released && nk.t >= RELEASE) { nk.released = true; if (nk.onRelease) nk.onRelease(); }
  if (!nk.det && nk.t >= DET) { nk.det = true; detonate(); if (nk.onDetonate) nk.onDetonate(); }
  if (nk.t > END + 0.5) nk = null;
}

/* ---------- the blast tears the maze into chunks ---------- */
function detonate() {
  const v = nk.view; if (!v) return;
  const { ox, oy, T, W, H } = v, lv = nk.lv, gx = ox + lv.W * T / 2, gy = oy + lv.H * T / 2;
  nk.gz = [gx, gy];
  const B = lv.W * lv.H > 1400 ? 3 : 2, diag = Math.hypot(W, H), near = Math.min(W, H) * 0.3, blocks = [];
  for (let by = -1; by < lv.H + 1; by += B) for (let bx = -1; bx < lv.W + 1; bx += B) {
    const cx = ox + (bx + B / 2) * T, cy = oy + (by + B / 2) * T, dx = cx - gx, dy = cy - gy, d = Math.hypot(dx, dy) || 1;
    const sp = (260 + 1300 * Math.exp(-d / near)) * rnd(0.7, 1.25), a = Math.atan2(dy, dx) + rnd(-0.25, 0.25);
    const inside = bx >= 0 && by >= 0 && bx < lv.W && by < lv.H;
    blocks.push({
      sx: (bx + 1) * T, sy: (by + 1) * T, s: B * T, x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      delay: d / (diag * 1.2), rot: 0, vr: rnd(-4, 4), sc: 1, vs: rnd(0.4, 1.4), life: rnd(2.4, 3.6), floor: inside
    });
  }
  nk.blocks = blocks;
  for (let i = 0; i < 260; i++) {
    const a = rnd(0, Math.PI * 2), sp = rnd(200, 1700);
    nk.embers.push({ x: gx, y: gy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: rnd(0.8, 2.6), r: rnd(1.2, 4), c: Math.random() < 0.5 ? '#ffd27a' : '#ff7a2a' });
  }
}

/* ---------- drawing ---------- */
function draw(ctx, W, H, view) {
  if (!nk) return;
  nk.view = { ...view, W, H };
  const t = nk.t, lv = nk.lv, gx = view.ox + lv.W * view.T / 2, gy = view.oy + lv.H * view.T / 2;
  const s = Math.max(140, Math.min(360, Math.min(W, H) * 0.3));   // jet length in px
  ctx.save();
  if (t < DET) {
    // the alarm overlay keeps going until the bomb lands
    drawWarning(ctx, W, H, 0, t, true);
    if (t >= RELEASE) drawTarget(ctx, gx, gy, t - RELEASE, view.T);
    if (t >= RELEASE) drawBomb(ctx, W, H, gx, gy, s, (t - RELEASE) / (DET - RELEASE));
  }
  if (t < 3.6) drawJet(ctx, W, H, s, t);
  if (nk.det) drawBlast(ctx, W, H, t - DET);
  ctx.restore();
}

function jetPos(W, H, t) { return [-0.35 * W + (1.7 * W) * (t / (RELEASE * 2)), H * 0.3 + Math.sin(t * 1.3) * H * 0.01]; }

function jetPath(ctx, L) {
  const P = (pts) => { ctx.moveTo(pts[0][0] * L, pts[0][1] * L); for (const [x, y] of pts.slice(1)) ctx.lineTo(x * L, y * L); ctx.closePath(); };
  ctx.beginPath();
  P([[0.5, 0], [0.33, 0.045], [0.1, 0.062], [-0.42, 0.062], [-0.5, 0.048], [-0.5, -0.048], [-0.42, -0.062], [0.1, -0.062], [0.33, -0.045]]);   // fuselage
  for (const m of [1, -1]) {
    P([[0.14, 0.055 * m], [-0.17, 0.43 * m], [-0.29, 0.43 * m], [-0.22, 0.055 * m]]);   // swept wing
    P([[-0.33, 0.055 * m], [-0.47, 0.21 * m], [-0.53, 0.21 * m], [-0.47, 0.055 * m]]);   // tailplane
    P([[0.12, 0.06 * m], [0.02, 0.11 * m], [-0.05, 0.11 * m], [0.02, 0.06 * m]]);       // leading-edge extension
  }
}
function drawJet(ctx, W, H, L, t) {
  const [x, y] = jetPos(W, H, t), bank = Math.sin(t * 1.7) * 0.08;
  // shadow far below on the maze
  ctx.save(); ctx.translate(x + L * 0.25, y + H * 0.33); ctx.scale(0.7, 0.7 * (1 - Math.abs(bank)));
  ctx.globalAlpha = 0.32; ctx.fillStyle = '#000'; if ('filter' in ctx) ctx.filter = 'blur(5px)';
  jetPath(ctx, L); ctx.fill(); ctx.restore();
  // contrails from the wingtips
  const tips = [[x - L * 0.25, y - L * 0.43], [x - L * 0.25, y + L * 0.43]];
  nk.trail.push({ t, tips });
  while (nk.trail.length && t - nk.trail[0].t > 1.3) nk.trail.shift();
  ctx.save(); ctx.lineCap = 'round';
  for (let side = 0; side < 2; side++) for (let i = 1; i < nk.trail.length; i++) {
    const a = nk.trail[i - 1], b = nk.trail[i], age = t - b.t, k = 1 - age / 1.3;
    ctx.strokeStyle = `rgba(235,240,255,${0.5 * k})`; ctx.lineWidth = 2 + (1 - k) * 9;
    ctx.beginPath(); ctx.moveTo(a.tips[side][0], a.tips[side][1]); ctx.lineTo(b.tips[side][0], b.tips[side][1]); ctx.stroke();
  }
  ctx.restore();
  ctx.save(); ctx.translate(x, y); ctx.scale(1, 1 - Math.abs(bank));
  // afterburners
  ctx.globalCompositeOperation = 'lighter';
  for (const m of [-1, 1]) {
    const fl = L * (0.16 + Math.random() * 0.06), ny = m * L * 0.024;
    const g = ctx.createLinearGradient(-L * 0.5, 0, -L * 0.5 - fl, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.25, 'rgba(120,180,255,0.9)'); g.addColorStop(0.6, 'rgba(255,140,40,0.6)'); g.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-L * 0.5, ny - L * 0.02); ctx.lineTo(-L * 0.5 - fl, ny); ctx.lineTo(-L * 0.5, ny + L * 0.02); ctx.closePath(); ctx.fill();
    const glow = ctx.createRadialGradient(-L * 0.52, ny, 0, -L * 0.52, ny, L * 0.09); glow.addColorStop(0, 'rgba(255,170,80,0.55)'); glow.addColorStop(1, 'rgba(255,90,0,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(-L * 0.52, ny, L * 0.09, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  // airframe
  const body = ctx.createLinearGradient(0, -L * 0.45, 0, L * 0.45);
  body.addColorStop(0, '#262b37'); body.addColorStop(0.45, '#6a7386'); body.addColorStop(0.55, '#5a6375'); body.addColorStop(1, '#1f242f');
  jetPath(ctx, L); ctx.fillStyle = body; ctx.fill();
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(10,12,20,0.9)'; ctx.stroke();
  // panel lines, spine, twin fins
  ctx.strokeStyle = 'rgba(20,24,34,0.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L * 0.3, 0); ctx.lineTo(-L * 0.46, 0); ctx.stroke();
  for (const m of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(-L * 0.05, m * L * 0.2); ctx.lineTo(-L * 0.22, m * L * 0.2); ctx.stroke();
    ctx.strokeStyle = '#151922'; ctx.lineWidth = L * 0.018; ctx.beginPath(); ctx.moveTo(-L * 0.3, m * L * 0.07); ctx.lineTo(-L * 0.47, m * L * 0.1); ctx.stroke();
    ctx.strokeStyle = 'rgba(20,24,34,0.6)'; ctx.lineWidth = 1;
  }
  // canopy
  const cg = ctx.createLinearGradient(L * 0.18, -L * 0.03, L * 0.34, L * 0.03);
  cg.addColorStop(0, '#0d2a4a'); cg.addColorStop(0.5, '#4fb4ff'); cg.addColorStop(1, '#0a1c33');
  ctx.fillStyle = cg; ctx.beginPath(); ctx.ellipse(L * 0.26, 0, L * 0.085, L * 0.03, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.ellipse(L * 0.28, -L * 0.01, L * 0.03, L * 0.008, -0.2, 0, Math.PI * 2); ctx.fill();
  // the bomb on its pylon until it drops
  if (t < RELEASE) { ctx.fillStyle = '#3d4a2c'; ctx.beginPath(); ctx.ellipse(-L * 0.08, 0, L * 0.11, L * 0.028, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#e8c23a'; ctx.fillRect(-L * 0.03, -L * 0.028, L * 0.012, L * 0.056); }
  // nav lights
  const blink = Math.floor(t * 3) % 2 === 0;
  ctx.globalCompositeOperation = 'lighter';
  for (const [m, c] of [[-1, '255,40,40'], [1, '40,255,90']]) {
    const lx = -L * 0.24, ly = m * L * 0.43, r = blink ? L * 0.05 : L * 0.025;
    const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, r); lg.addColorStop(0, `rgba(${c},1)`); lg.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(lx, ly, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawTarget(ctx, x, y, t, T) {
  const r = Math.max(T * 2.5, 40), spin = t * 2, pulse = 0.5 + 0.5 * Math.sin(t * 14);
  ctx.save(); ctx.translate(x, y); ctx.strokeStyle = `rgba(255,50,60,${0.55 + 0.4 * pulse})`; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(0, 0, r * (1.25 - Math.min(1, t) * 0.25), 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2); ctx.stroke();
  ctx.rotate(spin);
  for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(r * 0.6, 0); ctx.lineTo(r * 1.5, 0); ctx.stroke(); }
  ctx.restore();
}
function drawBomb(ctx, W, H, gx, gy, L, k) {
  k = Math.min(1, Math.max(0, k));
  const [rx, ry] = [W * 0.5, H * 0.3], f = k * k;   // accelerating fall
  const x = rx + (gx - rx) * f, y = ry + (gy - ry) * f, r = L * (0.11 - 0.07 * k);
  // its shadow closes in on ground zero as it falls
  ctx.save(); ctx.globalAlpha = 0.25 + 0.4 * k; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(gx + (1 - k) * L * 0.2, gy + (1 - k) * L * 0.3, r * (1.6 - k * 0.4), r * (1.1 - k * 0.3), 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.save(); ctx.translate(x, y); ctx.rotate(k * 5 + Math.sin(k * 30) * 0.08);
  ctx.fillStyle = '#2b331f';
  for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.fillRect(r * 0.4, -r * 0.12, r * 0.95, r * 0.24); }   // tail fins
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  g.addColorStop(0, '#7c8d55'); g.addColorStop(1, '#2a3320');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#e8c23a'; ctx.lineWidth = Math.max(1.5, r * 0.18); ctx.beginPath(); ctx.arc(0, 0, r * 0.68, 0, Math.PI * 2); ctx.stroke();
  // radiation trefoil
  ctx.fillStyle = '#111';
  for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r * 0.5, i * 2.094 - 0.5, i * 2.094 + 0.5); ctx.closePath(); ctx.fill(); }
  ctx.fillStyle = '#e8c23a'; ctx.beginPath(); ctx.arc(0, 0, r * 0.12, 0, Math.PI * 2); ctx.fill();
  if (Math.floor(k * 16) % 2 === 0) { ctx.fillStyle = '#ff2a2a'; ctx.beginPath(); ctx.arc(r * 0.8, 0, Math.max(2, r * 0.12), 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function drawBlast(ctx, W, H, t) {
  const gz = nk.gz || [W / 2, H / 2], [gx, gy] = gz, diag = Math.hypot(W, H), u = Math.min(W, H) / 40;
  // the maze, in pieces
  if (nk.blocks && nk.mazeCv) {
    const dt = Math.min(0.05, t - (nk.lastBt || 0)); nk.lastBt = t;
    for (const b of nk.blocks) {
      const age = t - b.delay;
      if (age < 0) {   // not hit yet: shudder in place
        drawBlock(ctx, b, b.x + rnd(-2, 2), b.y + rnd(-2, 2), 0, 1, 1, Math.max(0, 1 + age * 4) * 0.6);
        continue;
      }
      if (age > b.life) continue;
      const d = Math.exp(-0.5 * dt); b.vx *= d; b.vy *= d;
      b.x += b.vx * dt; b.y += b.vy * dt; b.rot += b.vr * dt; b.sc += b.vs * dt;
      const k = age / b.life;
      drawBlock(ctx, b, b.x, b.y, b.rot, b.sc, k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4, Math.max(0, 1 - age / 1.4));
    }
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  // fireball
  const fk = Math.min(1, t / 0.9), R = diag * 0.08 + diag * 0.5 * ease3(fk), fa = Math.max(0, 1 - Math.max(0, t - 0.9) / 2.6);
  if (fa > 0) {
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, R);
    g.addColorStop(0, `rgba(255,255,240,${fa})`); g.addColorStop(0.18, `rgba(255,236,150,${fa})`); g.addColorStop(0.42, `rgba(255,150,40,${fa * 0.85})`);
    g.addColorStop(0.75, `rgba(200,50,10,${fa * 0.45})`); g.addColorStop(1, 'rgba(80,10,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, R, 0, Math.PI * 2); ctx.fill();
  }
  // shockwaves
  for (const [delay, w] of [[0, 1], [0.18, 0.7], [0.45, 0.5]]) {
    const k = (t - delay) / 1.3; if (k < 0 || k > 1) continue;
    const rr = diag * 0.9 * ease3(k);
    ctx.strokeStyle = `rgba(255,245,215,${(1 - k) * 0.85 * w})`; ctx.lineWidth = u * 2.2 * (1 - k) * w + 1;
    ctx.beginPath(); ctx.arc(gx, gy, rr, 0, Math.PI * 2); ctx.stroke();
  }
  // embers
  const dt = Math.min(0.05, t - (nk.lastEt || 0)); nk.lastEt = t;
  for (const e of nk.embers) {
    e.life += dt; if (e.life > e.max) continue;
    const d = Math.exp(-1.4 * dt); e.vx *= d; e.vy = e.vy * d + 90 * dt; e.x += e.vx * dt; e.y += e.vy * dt;
    ctx.globalAlpha = 1 - e.life / e.max; ctx.fillStyle = e.c; ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.restore();
  // mushroom cloud rising out of the fireball
  if (t > 0.35) drawMushroom(ctx, gx, gy, u, t - 0.35, H);
  // white-out, then a hot orange cast that fades away
  const wo = t < 0.08 ? 1 : Math.max(0, 1 - (t - 0.08) / 0.75);
  if (wo > 0) { ctx.fillStyle = `rgba(255,${Math.round(255 - (1 - wo) * 90)},${Math.round(240 - (1 - wo) * 190)},${Math.pow(wo, 1.4)})`; ctx.fillRect(0, 0, W, H); }
  const cast = Math.max(0, 0.22 * (1 - Math.max(0, t - 1) / 3));
  if (cast > 0) { ctx.fillStyle = `rgba(255,110,30,${cast})`; ctx.fillRect(0, 0, W, H); }
}
function drawBlock(ctx, b, x, y, rot, sc, alpha, heat) {
  if (alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sc, sc);
  const h = b.s / 2;
  if (b.floor) { ctx.fillStyle = 'rgb(10,12,30)'; ctx.fillRect(-h, -h, b.s, b.s); }
  ctx.drawImage(nk.mazeCv, b.sx, b.sy, b.s, b.s, -h, -h, b.s, b.s);
  if (heat > 0) { ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = `rgba(255,120,30,${heat * 0.7})`; ctx.fillRect(-h, -h, b.s, b.s); }
  ctx.restore();
}
function drawMushroom(ctx, gx, gy, u, t, H) {
  const k = Math.min(1, t / 3), rise = Math.min(H * 0.42, u * 16) * (1 - Math.pow(1 - k, 2));
  const alpha = Math.min(1, t * 2) * Math.max(0, 1 - Math.max(0, t - 3.2) / 1.2);
  if (alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = alpha;
  const capY = gy - rise, capR = u * (3 + k * 4);
  // stem
  for (let i = 0; i < 10; i++) {
    const yy = gy - rise * (i / 10), w = u * (1.6 + (1 - i / 10) * 1.2 + Math.sin(i * 1.7 + t * 3) * 0.2);
    const g = ctx.createRadialGradient(gx - w * 0.3, yy - w * 0.3, 0, gx, yy, w);
    g.addColorStop(0, i < 3 ? '#ffd08a' : '#d9935e'); g.addColorStop(1, i < 3 ? 'rgba(220,90,30,0)' : 'rgba(110,60,45,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx + Math.sin(i * 2 + t) * u * 0.3, yy, w, 0, Math.PI * 2); ctx.fill();
  }
  // base ring of dust
  for (let i = 0; i < 26; i++) {
    const a = i / 26 * Math.PI * 2 + t * 0.3, rr = u * (3 + k * 8) * (0.85 + 0.15 * Math.sin(i * 5.3)), px = gx + Math.cos(a) * rr, py = gy + Math.sin(a) * rr * 0.35;
    const pr = u * (1.6 + k * 1.2), g = ctx.createRadialGradient(px, py, 0, px, py, pr);
    g.addColorStop(0, `rgba(170,110,80,${0.55 * (1 - k * 0.5)})`); g.addColorStop(1, 'rgba(120,70,50,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
  }
  // rolling cap, glowing underneath
  for (let ring = 0; ring < 2; ring++) for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2 + t * (ring ? -0.6 : 0.8), rr = capR * (ring ? 0.55 : 1);
    const px = gx + Math.cos(a) * rr, py = capY + Math.sin(a) * rr * 0.42 - (ring ? u * 1.2 : 0), pr = u * (2.1 + Math.sin(i * 3 + t * 4) * 0.3 + k * 0.8);
    const g = ctx.createRadialGradient(px, py - pr * 0.4, 0, px, py, pr);
    g.addColorStop(0, '#fff0c8'); g.addColorStop(0.45, '#f08a45'); g.addColorStop(1, 'rgba(90,40,30,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'lighter';
  const core = ctx.createRadialGradient(gx, capY + u, 0, gx, capY + u, capR);
  core.addColorStop(0, `rgba(255,220,140,${0.6 * (1 - k * 0.6)})`); core.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = core; ctx.beginPath(); ctx.arc(gx, capY + u, capR, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/* ---------- the countdown overlay ---------- */
function hazard(ctx, y, W, h, t) {
  ctx.save(); ctx.beginPath(); ctx.rect(0, y, W, h); ctx.clip();
  ctx.fillStyle = '#ffcc00'; ctx.fillRect(0, y, W, h); ctx.fillStyle = '#111';
  const step = h * 2, off = (t * 60) % step;
  for (let x = -step * 2 + off; x < W + step; x += step) { ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + h, y); ctx.lineTo(x + h * 2, y); ctx.lineTo(x + h, y + h); ctx.closePath(); ctx.fill(); }
  ctx.restore();
}
function drawWarning(ctx, W, H, left, time, incoming) {
  const ph = time % 1, pulse = ph < 0.85 ? ph / 0.85 : 1 - (ph - 0.85) / 0.15;   // brightens with each whoop
  ctx.save();
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
  v.addColorStop(0, 'rgba(255,0,30,0)'); v.addColorStop(1, `rgba(255,0,30,${0.18 + 0.32 * pulse})`);
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  const hh = Math.max(8, Math.round(H * 0.014));
  ctx.globalAlpha = 0.85; hazard(ctx, 0, W, hh, time); hazard(ctx, H - hh, W, hh, -time); ctx.globalAlpha = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const big = Math.min(W / 16, 34), small = Math.min(W / 30, 17), y = hh + 14 + small;
  ctx.font = '900 ' + Math.round(small) + 'px Orbitron, Impact, "Arial Black", sans-serif';
  ctx.lineWidth = 4; ctx.strokeStyle = '#0a0c1c';
  const head = incoming ? 'TACTICAL NUKE INCOMING' : 'TACTICAL NUKE INBOUND';
  ctx.strokeText(head, W / 2, y); ctx.shadowColor = '#ff2a3a'; ctx.shadowBlur = 12 * pulse; ctx.fillStyle = '#ff3d4d'; ctx.fillText(head, W / 2, y); ctx.shadowBlur = 0;
  const line2 = incoming ? 'BRACE FOR IMPACT' : 'SURVIVE ' + Math.max(0, left).toFixed(1) + 's';
  const urgent = !incoming && left < 3 && Math.floor(time * 6) % 2 === 0;
  ctx.font = '900 ' + Math.round(big) + 'px Orbitron, Impact, "Arial Black", sans-serif';
  ctx.strokeText(line2, W / 2, y + small * 0.7 + big * 0.75);
  ctx.fillStyle = urgent ? '#ff3d4d' : '#fff3b0'; ctx.fillText(line2, W / 2, y + small * 0.7 + big * 0.75);
  ctx.restore();
}

window.MazeNuke = {
  start, clear, update, draw, drawWarning,
  get active() { return !!nk; }, get mapGone() { return !!(nk && nk.det); }, get t() { return nk ? nk.t : 0; },
  RELEASE, DET, END
};
})();
