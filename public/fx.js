/* Munch Maze visual effects: sparks, coins, rings, floating score text,
   screen shake, flashes, big tier banners, confetti and the slot-reel reveal.

   World-space effects use tile coordinates and are drawn inside the maze transform;
   screen-space effects are drawn on top in CSS pixels.
   Honours prefers-reduced-motion: no shake, softer flashes, fewer particles. */
(function () {
'use strict';
const RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const reduced = () => RM.matches;
const MAX_PARTS = 900;
const GOLD = '#ffcc33', GOLD_HI = '#fff3b0', GOLD_LO = '#c98a00';

const world = [];     // particles in tile space
const texts = [];     // floating score text in tile space
const screen = [];    // confetti in screen space
let shakeAmt = 0, shakeX = 0, shakeY = 0, rumble = 0, rumbleForced = false;
let flashA = 0, flashCol = '#ffffff';
let banner = null;    // { text, sub, color, t, dur }
let reel = null;      // slot-reel reveal state
let pslot = null;     // power-up slot

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.random() * a.length | 0];
function cap(n) { return reduced() ? Math.ceil(n / 3) : n; }
function room() { return world.length + screen.length < MAX_PARTS; }

/* ---------- world effects ---------- */
function sparks(x, y, color, n = 8, speed = 6, life = 0.45) {
  for (let i = 0; i < cap(n) && room(); i++) {
    const a = Math.random() * Math.PI * 2, s = speed * rnd(0.35, 1);
    world.push({ k: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: life * rnd(0.7, 1.2), size: rnd(0.05, 0.11), color, drag: 3.2 });
  }
}
function coins(x, y, n = 6, speed = 7) {
  for (let i = 0; i < cap(n) && room(); i++) {
    const a = rnd(-Math.PI * 0.9, -Math.PI * 0.1);
    world.push({ k: 'coin', x, y, vx: Math.cos(a) * speed * rnd(0.4, 1), vy: Math.sin(a) * speed * rnd(0.6, 1.1), g: 18, life: 0, max: rnd(0.8, 1.2), size: rnd(0.2, 0.28), spin: rnd(0, 6), spinV: rnd(8, 16), drag: 0.6 });
  }
}
function ring(x, y, color, radius = 2.5, life = 0.45) { if (room()) world.push({ k: 'ring', x, y, life: 0, max: life, r: radius, color }); }
function text(x, y, str, color = '#ffffff', size = 0.7) { texts.push({ x, y, str, color, size, life: 0, max: 1.1 }); }

/* ---------- screen effects ---------- */
function shake(a) { if (!reduced()) shakeAmt = Math.min(18, shakeAmt + a); }
function flash(color, a) { flashCol = color; flashA = Math.max(flashA, reduced() ? a * 0.35 : a); }
function bigText(textStr, sub, color = GOLD, dur = 1.5) { banner = { text: textStr, sub, color, t: 0, dur }; }
function confetti(n = 120, W = 800) {
  const cols = ['#ffcc33', '#ff4d5e', '#41e0f0', '#7ee081', '#ff9ad5', '#b48cff', '#ffffff'];
  for (let i = 0; i < cap(n) && room(); i++) {
    const coin = Math.random() < 0.35;
    screen.push({ k: coin ? 'coin' : 'conf', x: rnd(0, W), y: rnd(-260, -10), vx: rnd(-40, 40), vy: rnd(120, 260), g: 160, life: 0, max: rnd(2.2, 3.4),
      w: coin ? rnd(9, 13) : rnd(6, 11), h: rnd(3, 6), rot: rnd(0, 6), rv: rnd(-9, 9), color: pick(cols), spin: rnd(0, 6), spinV: rnd(6, 14) });
  }
}
/** Slot reels spin and land on `symbols` one by one. onStop(i) fires as each reel lands. */
function reels(symbols, { title = '', sub = '', dur = 2.4, onStop } = {}) {
  const POOL = '0123456789×★7$'.split('');
  reel = { symbols, title, sub, t: 0, dur, onStop, stopped: symbols.map(() => false),
    stopAt: symbols.map((_, i) => 2.0 + i * 0.35), /* spin ~2 s, then land one by one */ strips: symbols.map(() => Array.from({ length: 14 }, () => pick(POOL))) };
}

/* ---------- power-up icons (drawn, no images) ---------- */
function icon(ctx, id, x, y, s, t = 0) {
  ctx.save(); ctx.translate(x, y); const r = s / 2;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  switch (id) {
    case 'megaghost': {
      const ghost = (gx, gy, gr, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(gx, gy - gr * 0.1, gr, Math.PI, 0); ctx.lineTo(gx + gr, gy + gr * 0.85);
        for (let k = 0; k < 3; k++) { const x0 = gx + gr - k * (2 * gr / 3); ctx.lineTo(x0 - gr / 3, gy + gr * 0.6); ctx.lineTo(x0 - 2 * gr / 3, gy + gr * 0.85); } ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(gx - gr * 0.35, gy - gr * 0.2, gr * 0.22, 0, 7); ctx.arc(gx + gr * 0.35, gy - gr * 0.2, gr * 0.22, 0, 7); ctx.fill(); };
      ghost(r * 0.25, r * 0.05, r * 0.72, '#ff4d5e'); ghost(-r * 0.62, r * 0.45, r * 0.3, '#ff9ad5');
      break;
    }
    case 'nuke': {
      ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(0, 0, r * 0.95, 0, 7); ctx.fill();
      ctx.fillStyle = '#1a1a24';
      for (let k = 0; k < 3; k++) { const a = -Math.PI / 2 + k * Math.PI * 2 / 3; ctx.beginPath(); ctx.moveTo(Math.cos(a - 0.5) * r * 0.25, Math.sin(a - 0.5) * r * 0.25); ctx.arc(0, 0, r * 0.78, a - 0.5, a + 0.5); ctx.arc(0, 0, r * 0.25, a + 0.5, a - 0.5, true); ctx.closePath(); ctx.fill(); }
      ctx.beginPath(); ctx.arc(0, 0, r * 0.15, 0, 7); ctx.fill();
      break;
    }
    case 'reverse': {
      ctx.strokeStyle = '#c77dff'; ctx.lineWidth = s * 0.1;
      for (const sg of [-1, 1]) { ctx.beginPath(); ctx.moveTo(-r * 0.7 * sg, sg * r * 0.3); ctx.lineTo(r * 0.7 * sg, sg * r * 0.3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(r * 0.7 * sg - sg * r * 0.3, sg * r * 0.3 - r * 0.3); ctx.lineTo(r * 0.7 * sg, sg * r * 0.3); ctx.lineTo(r * 0.7 * sg - sg * r * 0.3, sg * r * 0.3 + r * 0.3); ctx.stroke(); }
      break;
    }
    case 'laser': {
      ctx.strokeStyle = 'rgba(255,60,80,0.45)'; ctx.lineWidth = s * 0.22; ctx.beginPath(); ctx.moveTo(-r * 0.4, r * 0.4); ctx.lineTo(r, -r); ctx.stroke();
      ctx.strokeStyle = '#ffe0e6'; ctx.lineWidth = s * 0.06; ctx.beginPath(); ctx.moveTo(-r * 0.4, r * 0.4); ctx.lineTo(r, -r); ctx.stroke();
      ctx.fillStyle = '#8fa8c8'; ctx.beginPath(); ctx.arc(-r * 0.55, r * 0.55, r * 0.35, 0, 7); ctx.fill();
      ctx.fillStyle = '#ff3d5e'; ctx.beginPath(); ctx.arc(-r * 0.45, r * 0.45, r * 0.12, 0, 7); ctx.fill();
      break;
    }
    case 'megapellet': {
      ctx.save(); ctx.rotate(t * 1.5); ctx.fillStyle = 'rgba(255,220,120,0.6)';
      for (let k = 0; k < 8; k++) { ctx.rotate(Math.PI / 4); ctx.beginPath(); ctx.moveTo(0, -r * 0.08); ctx.lineTo(r, 0); ctx.lineTo(0, r * 0.08); ctx.fill(); }
      ctx.restore();
      const g = ctx.createRadialGradient(-r * 0.15, -r * 0.15, 0, 0, 0, r * 0.6); g.addColorStop(0, '#fff'); g.addColorStop(0.5, '#ffdcae'); g.addColorStop(1, '#ffb347');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, 7); ctx.fill();
      break;
    }
    case 'bomb': {
      ctx.fillStyle = '#2a2d45'; ctx.beginPath(); ctx.arc(-r * 0.1, r * 0.15, r * 0.65, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.05, r * 0.18, 0, 7); ctx.fill();
      ctx.fillStyle = '#5a5f80'; ctx.fillRect(r * 0.2, -r * 0.6, r * 0.28, r * 0.25);
      ctx.strokeStyle = '#c9a36b'; ctx.lineWidth = s * 0.05; ctx.beginPath(); ctx.moveTo(r * 0.35, -r * 0.6); ctx.quadraticCurveTo(r * 0.55, -r * 0.95, r * 0.8, -r * 0.8); ctx.stroke();
      const sp = 0.6 + 0.4 * Math.sin(t * 20); ctx.fillStyle = '#ffd23f';
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + t * 4; ctx.beginPath(); ctx.arc(r * 0.82 + Math.cos(a) * r * 0.15 * sp, -r * 0.82 + Math.sin(a) * r * 0.15 * sp, r * 0.05, 0, 7); ctx.fill(); }
      break;
    }
    case 'quake': {
      ctx.strokeStyle = '#ff9a3c'; ctx.lineWidth = s * 0.08; ctx.beginPath();
      const pts = [-1, -0.1, -0.7, 0.2, -0.45, -0.6, -0.2, 0.7, 0.05, -0.85, 0.3, 0.5, 0.55, -0.3, 0.8, 0.1, 1, 0];
      for (let k = 0; k < pts.length; k += 2) { const px = pts[k] * r, py = pts[k + 1] * r * 0.9; k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke();
      break;
    }
    case 'unplugged': {
      ctx.fillStyle = '#b8c0cc'; ctx.beginPath(); ctx.ellipse(0, r * 0.1, r * 0.85, r * 0.5, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#2a2d45'; ctx.fillRect(-r * 0.6, 0, r * 0.3, r * 0.1); ctx.fillRect(-r * 0.5, -r * 0.1, r * 0.1, r * 0.3);
      ctx.beginPath(); ctx.arc(r * 0.45, r * 0.05, r * 0.08, 0, 7); ctx.arc(r * 0.3, r * 0.2, r * 0.08, 0, 7); ctx.fill();
      ctx.strokeStyle = '#ff4d5e'; ctx.lineWidth = s * 0.1; ctx.beginPath(); ctx.moveTo(-r * 0.6, -r * 0.6); ctx.lineTo(r * 0.6, r * 0.6); ctx.moveTo(r * 0.6, -r * 0.6); ctx.lineTo(-r * 0.6, r * 0.6); ctx.stroke();
      break;
    }
    case 'autopilot': {
      ctx.strokeStyle = '#41e0f0'; ctx.lineWidth = s * 0.09; ctx.beginPath(); ctx.arc(0, 0, r * 0.75, 0, 7); ctx.stroke();
      ctx.save(); ctx.rotate(Math.sin(t * 2) * 0.5);
      ctx.beginPath(); for (let k = 0; k < 3; k++) { const a = Math.PI / 2 + k * Math.PI * 2 / 3; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72); } ctx.stroke();
      ctx.fillStyle = '#41e0f0'; ctx.beginPath(); ctx.arc(0, 0, r * 0.18, 0, 7); ctx.fill(); ctx.restore();
      break;
    }
    case 'phone': {
      ctx.rotate(-0.5 + Math.sin(t * 30) * 0.08);
      ctx.fillStyle = '#ffcc33'; ctx.strokeStyle = '#ffcc33'; ctx.lineWidth = s * 0.16;
      ctx.beginPath(); ctx.arc(0, r * 0.35, r * 0.65, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-r * 0.6, -r * 0.05, r * 0.2, r * 0.13, -0.6, 0, 7); ctx.ellipse(r * 0.6, -r * 0.05, r * 0.2, r * 0.13, 0.6, 0, 7); ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/* ---------- power-up slot ---------- */
/** items: list of { id, name, good, desc }; final: index that wins. */
function powerSlot({ items, final, by = '', title = 'LOOT CRATE', subtitle = '', spin = 1.6, hold = 2.0, onLand }) {
  pslot = { items, final, by, title, subtitle, spin, hold, onLand, t: 0, landed: false, rows: 3 * items.length + final };
}
/** Break text into lines that fit maxW with the current ctx.font. */
function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/), lines = []; let line = '';
  for (const wd of words) {
    const tryL = line ? line + ' ' + wd : wd;
    if (ctx.measureText(tryL).width <= maxW || !line) line = tryL; else { lines.push(line); line = wd; }
  }
  if (line) lines.push(line);
  return lines;
}
/** Largest font size (up to max) at which text fits maxW. */
function fitFont(ctx, text, max, maxW, fmt) {
  let s = max; ctx.font = fmt(s);
  while (s > 10 && ctx.measureText(text).width > maxW) { s--; ctx.font = fmt(s); }
  return s;
}
const DESC_FONT = s => '500 ' + s + 'px "IBM Plex Mono", ui-monospace, monospace';
function drawPowerSlot(ctx, W, H) {
  const p = pslot, n = p.items.length, it = p.items[p.final];
  const w = Math.min(W - 32, 460), rowH = Math.min(64, H * 0.11);
  // the description wraps inside the box, and the box grows to hold it
  const descSize = w < 340 ? 12 : 13; ctx.font = DESC_FONT(descSize);
  const descLines = wrapLines(ctx, it.desc || '', w - 48).slice(0, 4), lineH = descSize + 6;
  const h = 72 + rowH * 1.6 + 38 + descLines.length * lineH + 22, x0 = (W - w) / 2, y0 = Math.max(16, (H - h) / 2);
  const appear = Math.min(1, p.t / 0.15), fade = p.t > p.spin + p.hold - 0.25 ? Math.max(0, (p.spin + p.hold - p.t) / 0.25) : 1;
  ctx.save(); ctx.globalAlpha = appear * fade;
  ctx.fillStyle = 'rgba(5,6,16,0.55)'; ctx.fillRect(0, 0, W, H);
  const col = !p.landed ? '#ffcc33' : it.good ? '#7ee081' : '#ff4d5e';
  const grd = ctx.createLinearGradient(0, y0, 0, y0 + h); grd.addColorStop(0, '#2a1d5e'); grd.addColorStop(1, '#13163a');
  ctx.fillStyle = grd; ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.shadowColor = col; ctx.shadowBlur = 22;
  roundRect(ctx, x0, y0, w, h, 16); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
  const bulbs = Math.round((w + h) * 2 / 22), phase = Math.floor(p.t * (p.landed ? 4 : 12));
  for (let i = 0; i < bulbs; i++) { const [bx, by] = perimeterPoint(x0, y0, w, h, i / bulbs), on = (i + phase) % 3 === 0;
    ctx.fillStyle = on ? '#fff3b0' : '#5a4510'; ctx.beginPath(); ctx.arc(bx, by, 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  glowText(ctx, p.title, W / 2, y0 + 30, Math.min(30, w / 12), '#ffcc33', 14);
  fitFont(ctx, p.subtitle || (p.by ? p.by + ' opened a crate' : 'A crate was opened'), 13, w - 48, s => '600 ' + s + 'px "IBM Plex Mono", ui-monospace, monospace'); ctx.fillStyle = '#c8cbe8';
  ctx.fillText(p.subtitle || (p.by ? p.by + ' opened a crate' : 'A crate was opened'), W / 2, y0 + 56);
  // the reel window
  const rx = x0 + 22, ry = y0 + 72, rw = w - 44, rh = rowH * 1.6;
  const wg = ctx.createLinearGradient(0, ry, 0, ry + rh); wg.addColorStop(0, '#c8cbe8'); wg.addColorStop(0.5, '#ffffff'); wg.addColorStop(1, '#c8cbe8');
  ctx.fillStyle = wg; roundRect(ctx, rx, ry, rw, rh, 10); ctx.fill();
  ctx.save(); roundRect(ctx, rx, ry, rw, rh, 10); ctx.clip();
  const k = Math.min(1, p.t / p.spin), ease = 1 - Math.pow(1 - k, 3);
  const pos = ease * p.rows;   // rows scrolled
  for (let j = -2; j <= 2; j++) {
    const row = Math.floor(pos) + j, off = (row - pos) * rowH, idx = ((row % n) + n) % n, item = p.items[idx];
    const cy = ry + rh / 2 + off;
    icon(ctx, item.id, rx + 44, cy, rowH * 0.62, p.t);
    fitFont(ctx, item.name.toUpperCase(), Math.round(Math.min(26, rw / 14)), rw - 100, s => '900 ' + s + 'px Orbitron, Impact, "Arial Black", sans-serif');
    ctx.fillStyle = p.landed && idx === p.final ? (item.good ? '#1f8a3a' : '#c2142f') : '#2a2f6a';
    ctx.textAlign = 'left'; ctx.fillText(item.name.toUpperCase(), rx + 84, cy + 1);
  }
  ctx.textAlign = 'center';
  const sg = ctx.createLinearGradient(0, ry, 0, ry + rh); sg.addColorStop(0, 'rgba(10,12,28,0.55)'); sg.addColorStop(0.3, 'rgba(10,12,28,0)'); sg.addColorStop(0.7, 'rgba(10,12,28,0)'); sg.addColorStop(1, 'rgba(10,12,28,0.55)');
  ctx.fillStyle = sg; ctx.fillRect(rx, ry, rw, rh);
  ctx.restore();
  if (p.landed) {
    glowText(ctx, it.good ? 'NICE!' : 'UH OH!', W / 2, ry + rh + 24, 20, col, 10);
    ctx.font = DESC_FONT(descSize); ctx.fillStyle = '#eef0ff';
    descLines.forEach((ln, i) => ctx.fillText(ln, W / 2, ry + rh + 46 + i * lineH));
  }
  ctx.restore();
}

/* ---------- update ---------- */
function update(dt) {
  for (let i = world.length - 1; i >= 0; i--) {
    const p = world[i]; p.life += dt;
    if (p.life >= p.max) { world.splice(i, 1); continue; }
    if (p.k === 'ring') continue;
    const d = Math.exp(-(p.drag || 0) * dt); p.vx *= d; p.vy *= d;
    if (p.g) p.vy += p.g * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.spinV) p.spin += p.spinV * dt;
  }
  for (let i = texts.length - 1; i >= 0; i--) { const t = texts[i]; t.life += dt; t.y -= dt * 1.1; if (t.life >= t.max) texts.splice(i, 1); }
  for (let i = screen.length - 1; i >= 0; i--) {
    const p = screen[i]; p.life += dt;
    if (p.life >= p.max) { screen.splice(i, 1); continue; }
    p.vy += p.g * dt * 0.25; p.x += (p.vx + Math.sin(p.life * 3 + p.rot) * 30) * dt; p.y += p.vy * dt; p.rot += p.rv * dt; p.spin += p.spinV * dt;
  }
  shakeAmt = Math.max(0, shakeAmt - dt * 40);
  // Reduced motion turns off decorative shake, but a gameplay rumble (the earthquake) still
  // has to be felt, so it plays at a gentler strength instead of not at all.
  const amp = shakeAmt + (reduced() ? (rumbleForced ? rumble * 0.45 : 0) : rumble);
  shakeX = (Math.random() * 2 - 1) * amp; shakeY = (Math.random() * 2 - 1) * amp;
  flashA = Math.max(0, flashA - dt * 2.2);
  if (banner) { banner.t += dt; if (banner.t > banner.dur) banner = null; }
  if (pslot) {
    pslot.t += dt;
    if (!pslot.landed && pslot.t >= pslot.spin) { pslot.landed = true; if (pslot.onLand) pslot.onLand(); }
    if (pslot.t > pslot.spin + pslot.hold) pslot = null;
  }
  if (reel) {
    reel.t += dt;
    reel.stopAt.forEach((at, i) => { if (!reel.stopped[i] && reel.t >= at) { reel.stopped[i] = true; if (reel.onStop) reel.onStop(i); } });
    if (reel.t > reel.dur) reel = null;
  }
}

/* ---------- drawing ---------- */
function drawCoin(ctx, x, y, r, spin) {
  const w = Math.max(0.12, Math.abs(Math.cos(spin))) * r;
  ctx.fillStyle = GOLD_LO; ctx.beginPath(); ctx.ellipse(x + r * 0.08, y + r * 0.08, w, r, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = GOLD; ctx.beginPath(); ctx.ellipse(x, y, w, r, 0, 0, Math.PI * 2); ctx.fill();
  if (w > r * 0.45) { ctx.fillStyle = GOLD_HI; ctx.beginPath(); ctx.ellipse(x - w * 0.25, y - r * 0.3, w * 0.25, r * 0.22, 0, 0, Math.PI * 2); ctx.fill(); }
}
function drawWorld(ctx, T) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of world) {
    const k = 1 - p.life / p.max;
    if (p.k === 'spark') {
      ctx.globalAlpha = k; ctx.fillStyle = p.color;
      const r = Math.max(1, p.size * T * (0.6 + k * 0.6));
      ctx.beginPath(); ctx.arc((p.x + 0.5) * T, (p.y + 0.5) * T, r, 0, Math.PI * 2); ctx.fill();
    } else if (p.k === 'ring') {
      const e = 1 - Math.pow(k, 3);
      ctx.globalAlpha = k * 0.9; ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(1.5, T * 0.18 * k);
      ctx.beginPath(); ctx.arc((p.x + 0.5) * T, (p.y + 0.5) * T, e * p.r * T, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const p of world) if (p.k === 'coin') { ctx.globalAlpha = Math.min(1, (1 - p.life / p.max) * 3); drawCoin(ctx, (p.x + 0.5) * T, (p.y + 0.5) * T, p.size * T, p.spin); }
  // floating score text with a pop-in bounce
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const t of texts) {
    const k = t.life / t.max, pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.7 : 1.3 - Math.min(0.3, (k - 0.15) * 1.2);
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.font = '900 ' + Math.round(t.size * T * pop) + 'px Orbitron, Impact, "Arial Black", sans-serif';
    ctx.lineWidth = Math.max(2, T * 0.12); ctx.strokeStyle = '#0a0c1c'; ctx.strokeText(t.str, (t.x + 0.5) * T, (t.y + 0.5) * T);
    ctx.fillStyle = t.color; ctx.fillText(t.str, (t.x + 0.5) * T, (t.y + 0.5) * T);
  }
  ctx.restore();
}
function drawScreen(ctx, W, H) {
  ctx.save();
  if (flashA > 0.01) { ctx.globalAlpha = Math.min(0.5, flashA); ctx.fillStyle = flashCol; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  for (const p of screen) {
    const fade = Math.min(1, (p.max - p.life) * 2);
    ctx.globalAlpha = fade;
    if (p.k === 'coin') drawCoin(ctx, p.x, p.y, p.w, p.spin);
    else { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.spin)), p.w, p.h * Math.abs(Math.cos(p.spin)) + 0.5); ctx.restore(); }
  }
  ctx.globalAlpha = 1;
  if (banner) drawBanner(ctx, W, H);
  if (reel) drawReels(ctx, W, H);
  if (pslot) drawPowerSlot(ctx, W, H);
  ctx.restore();
}
function glowText(ctx, str, x, y, size, color, blur) {
  ctx.font = '900 ' + Math.round(size) + 'px Orbitron, Impact, "Arial Black", sans-serif';
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size * 0.14); ctx.strokeStyle = '#0a0c1c'; ctx.strokeText(str, x, y);
  ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.fillStyle = color; ctx.fillText(str, x, y);
  ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.save(); ctx.beginPath(); ctx.rect(x - 2000, y - size, 4000, size * 0.42); ctx.clip(); ctx.fillText(str, x, y); ctx.restore();
}
function drawBanner(ctx, W, H) {
  const b = banner, k = b.t / b.dur;
  const pop = b.t < 0.18 ? 0.3 + (b.t / 0.18) * 0.9 : b.t < 0.3 ? 1.2 - ((b.t - 0.18) / 0.12) * 0.2 : 1;
  const a = k > 0.8 ? (1 - k) / 0.2 : 1;
  const size = Math.min(W / 12, 46) * pop;
  ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save(); ctx.translate(W / 2, Math.max(size * 0.9, H * 0.12)); ctx.rotate(Math.sin(b.t * 9) * 0.025 * (1 - k));
  // starburst behind the text
  ctx.save(); ctx.rotate(b.t * 0.8); ctx.globalAlpha = a * 0.22; ctx.fillStyle = b.color;
  for (let i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(size * 3.2, -size * 0.35); ctx.lineTo(size * 3.2, size * 0.35); ctx.fill(); }
  ctx.restore();
  ctx.globalAlpha = a;
  glowText(ctx, b.text, 0, 0, size, b.color, size * 0.6);
  if (b.sub) { ctx.font = '600 ' + Math.round(size * 0.3) + 'px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = '#eef0ff'; ctx.fillText(b.sub, 0, size * 0.8); }
  ctx.restore(); ctx.globalAlpha = 1;
}
function drawReels(ctx, W, H) {
  const r = reel, n = r.symbols.length;
  const cell = Math.min(84, W / (n + 2.4)), gap = cell * 0.16, boxW = n * cell + (n - 1) * gap + cell * 0.5, boxH = cell * 1.5;
  const x0 = (W - boxW) / 2, y0 = H * 0.42 - boxH / 2;
  const appear = Math.min(1, r.t / 0.2), fade = r.t > r.dur - 0.3 ? (r.dur - r.t) / 0.3 : 1;
  ctx.globalAlpha = appear * fade; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (r.title) glowText(ctx, r.title, W / 2, y0 - cell * 0.75, Math.min(W / 14, 40), GOLD, 24);
  // cabinet
  const grd = ctx.createLinearGradient(0, y0, 0, y0 + boxH); grd.addColorStop(0, '#2a1d5e'); grd.addColorStop(1, '#13163a');
  ctx.fillStyle = grd; ctx.strokeStyle = GOLD; ctx.lineWidth = 3; ctx.shadowColor = GOLD; ctx.shadowBlur = 18;
  roundRect(ctx, x0, y0, boxW, boxH, 14); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
  // cabinet bulbs
  const bulbs = Math.round((boxW + boxH) * 2 / 22), phase = Math.floor(r.t * 10);
  for (let i = 0; i < bulbs; i++) {
    const [bx, by] = perimeterPoint(x0, y0, boxW, boxH, i / bulbs), on = (i + phase) % 3 === 0;
    ctx.fillStyle = on ? '#fff3b0' : '#7a5a10'; ctx.shadowColor = GOLD; ctx.shadowBlur = on ? 10 : 0;
    ctx.beginPath(); ctx.arc(bx, by, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;
  for (let i = 0; i < n; i++) {
    const cx = x0 + cell * 0.25 + i * (cell + gap), cy = y0 + (boxH - cell * 1.15) / 2, h = cell * 1.15;
    const wg = ctx.createLinearGradient(0, cy, 0, cy + h); wg.addColorStop(0, '#c8cbe8'); wg.addColorStop(0.5, '#ffffff'); wg.addColorStop(1, '#c8cbe8');
    ctx.fillStyle = wg; roundRect(ctx, cx, cy, cell, h, 8); ctx.fill();
    ctx.save(); roundRect(ctx, cx, cy, cell, h, 8); ctx.clip();
    ctx.font = '900 ' + Math.round(cell * 0.62) + 'px Orbitron, Impact, "Arial Black", sans-serif';
    if (!r.stopped[i]) {
      const off = (r.t * 22 + i * 3.7) % r.strips[i].length;
      for (let j = -1; j < 3; j++) {
        const idx = Math.floor(off + j) % r.strips[i].length, yy = cy + h / 2 + (j - (off % 1)) * cell * 0.8;
        ctx.globalAlpha = appear * fade * 0.85; ctx.fillStyle = '#3a3f7a'; ctx.fillText(r.strips[i][idx], cx + cell / 2, yy);
      }
      ctx.globalAlpha = appear * fade;
    } else {
      const since = r.t - r.stopAt[i], bounce = since < 0.25 ? Math.sin(since / 0.25 * Math.PI) * cell * 0.12 * (1 - since / 0.25) : 0;
      ctx.fillStyle = '#d6142f'; ctx.fillText(r.symbols[i], cx + cell / 2, cy + h / 2 + bounce);
    }
    // glass shading
    const sg = ctx.createLinearGradient(0, cy, 0, cy + h); sg.addColorStop(0, 'rgba(10,12,28,0.55)'); sg.addColorStop(0.3, 'rgba(10,12,28,0)'); sg.addColorStop(0.7, 'rgba(10,12,28,0)'); sg.addColorStop(1, 'rgba(10,12,28,0.55)');
    ctx.fillStyle = sg; ctx.fillRect(cx, cy, cell, h);
    ctx.restore();
  }
  if (r.sub) { ctx.font = '600 ' + Math.round(Math.min(16, W / 40)) + 'px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = '#eef0ff'; ctx.fillText(r.sub, W / 2, y0 + boxH + cell * 0.45); }
  ctx.globalAlpha = 1;
}
function perimeterPoint(x, y, w, h, t) {
  const P = 2 * (w + h); let d = t * P;
  if (d < w) return [x + d, y]; d -= w;
  if (d < h) return [x + w, y + d]; d -= h;
  if (d < w) return [x + w - d, y + h]; d -= w;
  return [x, y + h - d];
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function setRumble(a, force = false) { rumble = Math.max(0, a); rumbleForced = !!force && rumble > 0; }
function clear() { rumble = 0; pslot = null; world.length = 0; texts.length = 0; screen.length = 0; banner = null; reel = null; shakeAmt = 0; flashA = 0; }

window.MazeFX = {
  icon, powerSlot, get slotActive() { return !!pslot; },
  sparks, coins, ring, text, shake, setRumble, flash, bigText, confetti, reels, update, drawWorld, drawScreen, clear,
  get shakeX() { return shakeX; }, get shakeY() { return shakeY; }, get reelActive() { return !!reel; }, reduced
};
})();
