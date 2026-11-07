/* Munch Maze background: flying through space.
   A perspective starfield streams out from the centre (warp streaks that stretch
   with speed), and every few minutes a planet drifts past.

   MazeSpace.draw(ctx, dt, W, H, { warp, hue, reduced })
     warp: target speed (0.05 idle … 0.6 hyperspace); eased so changes feel smooth. */
(function () {
'use strict';
let stars = [], W = 0, H = 0, speed = 0.08, t = 0;
let planet = null, nextPlanetAt = 60 + Math.random() * 90;   // first one after 1–2.5 minutes

const rnd = (a, b) => a + Math.random() * (b - a);
function spawn(s, fresh) {
  s.x = rnd(-1, 1); s.y = rnd(-1, 1);
  s.z = fresh ? rnd(0.05, 1) : rnd(0.85, 1);
  s.tint = Math.random() < 0.18 ? (Math.random() < 0.5 ? '#a9c8ff' : '#ffd9a8') : '#ffffff';
}
function resize(w, h) {
  W = w; H = h;
  const n = Math.round(Math.min(420, Math.max(120, w * h / 2400)));
  stars = Array.from({ length: n }, () => { const s = {}; spawn(s, true); return s; });
}

/* ---------- planets (drawn once to an offscreen sprite) ---------- */
const TYPES = [
  { name: 'gas', base: ['#f3d9a4', '#c98c4a', '#6b3d1f'], bands: true, ring: true, atmo: '#ffd59a' },
  { name: 'ice', base: ['#e6f6ff', '#7cc4e8', '#1d4f7a'], bands: true, ring: false, atmo: '#9fe2ff' },
  { name: 'rock', base: ['#f0b38a', '#b4573a', '#3e1a14'], craters: true, ring: false, atmo: '#ff9a6e' },
  { name: 'ocean', base: ['#9fe7d2', '#2f8fb0', '#0d2c4d'], land: true, ring: false, atmo: '#8fe3ff' },
  { name: 'violet', base: ['#e9c8ff', '#9b5fd6', '#2e1150'], bands: true, ring: true, atmo: '#d7a8ff' }
];
function makePlanetSprite(type) {
  const R = 220, ringOut = type.ring ? R * 2.15 : R * 1.25, size = Math.ceil(ringOut * 2 + 20);
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), m = size / 2, tilt = rnd(-0.45, -0.15);
  const ringPath = (front) => {
    g.save(); g.translate(m, m); g.rotate(tilt);
    g.beginPath();
    g.ellipse(0, 0, ringOut, ringOut * 0.28, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
    g.ellipse(0, 0, R * 1.35, R * 1.35 * 0.28, 0, front ? Math.PI : Math.PI * 2, front ? 0 : Math.PI, true);
    g.closePath();
    const rg = g.createRadialGradient(0, 0, R * 1.3, 0, 0, ringOut);
    rg.addColorStop(0, 'rgba(255,240,210,0.15)'); rg.addColorStop(0.35, 'rgba(240,215,170,0.55)');
    rg.addColorStop(0.55, 'rgba(200,170,130,0.25)'); rg.addColorStop(0.75, 'rgba(250,230,190,0.5)'); rg.addColorStop(1, 'rgba(250,230,190,0.05)');
    g.fillStyle = rg; g.fill(); g.restore();
  };
  // atmosphere halo
  const halo = g.createRadialGradient(m, m, R * 0.95, m, m, R * 1.22);
  halo.addColorStop(0, type.atmo + 'aa'); halo.addColorStop(1, type.atmo + '00');
  g.fillStyle = halo; g.beginPath(); g.arc(m, m, R * 1.22, 0, Math.PI * 2); g.fill();
  if (type.ring) ringPath(false);
  // sphere
  g.save(); g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.clip();
  const body = g.createRadialGradient(m - R * 0.4, m - R * 0.45, R * 0.1, m, m, R);
  body.addColorStop(0, type.base[0]); body.addColorStop(0.55, type.base[1]); body.addColorStop(1, type.base[2]);
  g.fillStyle = body; g.fillRect(m - R, m - R, R * 2, R * 2);
  if (type.bands) {
    for (let i = 0; i < 16; i++) {
      const y = m - R + (i + rnd(0, 0.6)) * (R * 2 / 16), h = rnd(R * 0.04, R * 0.12);
      g.globalAlpha = rnd(0.08, 0.28); g.fillStyle = Math.random() < 0.5 ? type.base[2] : type.base[0];
      g.beginPath(); g.moveTo(m - R, y);
      for (let x = -R; x <= R; x += 12) g.lineTo(m + x, y + Math.sin(x / 40 + i) * h * 0.4);
      g.lineTo(m + R, y + h); g.lineTo(m - R, y + h); g.closePath(); g.fill();
    }
    if (Math.random() < 0.6) { g.globalAlpha = 0.35; g.fillStyle = type.base[2]; g.beginPath(); g.ellipse(m + R * rnd(-0.3, 0.3), m + R * rnd(0.1, 0.4), R * 0.16, R * 0.08, 0, 0, Math.PI * 2); g.fill(); }
  }
  if (type.craters) for (let i = 0; i < 26; i++) {
    const a = rnd(0, Math.PI * 2), d = Math.sqrt(Math.random()) * R * 0.9, r = rnd(R * 0.03, R * 0.12);
    g.globalAlpha = rnd(0.15, 0.35); g.fillStyle = type.base[2]; g.beginPath(); g.arc(m + Math.cos(a) * d, m + Math.sin(a) * d, r, 0, Math.PI * 2); g.fill();
    g.globalAlpha *= 0.6; g.fillStyle = type.base[0]; g.beginPath(); g.arc(m + Math.cos(a) * d - r * 0.25, m + Math.sin(a) * d - r * 0.25, r * 0.6, 0, Math.PI * 2); g.fill();
  }
  if (type.land) for (let i = 0; i < 9; i++) {
    const cx = m + rnd(-R, R) * 0.8, cy = m + rnd(-R, R) * 0.8;
    g.globalAlpha = 0.55; g.fillStyle = Math.random() < 0.7 ? '#4f9a5a' : '#c9b27a';
    g.beginPath(); for (let k = 0; k < 9; k++) { const a = k / 9 * Math.PI * 2, rr = R * rnd(0.08, 0.22); g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8); } g.closePath(); g.fill();
    g.globalAlpha = 0.35; g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(cx + R * 0.15, cy - R * 0.1, R * rnd(0.1, 0.25), R * 0.03, rnd(-0.3, 0.3), 0, Math.PI * 2); g.fill();
  }
  // night side
  g.globalAlpha = 1;
  const shadow = g.createRadialGradient(m - R * 0.55, m - R * 0.55, R * 0.6, m - R * 0.2, m - R * 0.2, R * 1.9);
  shadow.addColorStop(0, 'rgba(0,0,8,0)'); shadow.addColorStop(0.55, 'rgba(0,0,8,0.25)'); shadow.addColorStop(1, 'rgba(0,0,8,0.92)');
  g.fillStyle = shadow; g.fillRect(m - R, m - R, R * 2, R * 2);
  g.restore();
  if (type.ring) ringPath(true);
  return c;
}
function newPlanet() {
  const type = TYPES[Math.random() * TYPES.length | 0];
  const ang = rnd(0, Math.PI * 2);
  return { sprite: makePlanetSprite(type), dx: Math.cos(ang), dy: Math.sin(ang) * 0.7, z: 1, dur: rnd(18, 26), age: 0, spin: rnd(-0.03, 0.03), rot: rnd(-0.3, 0.3) };
}

/* ---------- per frame ---------- */
function draw(ctx, dt, w, h, opts = {}) {
  if (w !== W || h !== H) resize(w, h);
  t += dt;
  const reduced = !!opts.reduced;
  const target = reduced ? 0.015 : (opts.warp || 0.08);
  speed += (target - speed) * Math.min(1, dt * 1.8);
  const cx = W / 2, cy = H / 2, S = Math.max(W, H) * 0.5;

  // planet (behind the stars)
  if (!planet && t > nextPlanetAt && !reduced) planet = newPlanet();
  if (planet) {
    const p = planet; p.age += dt;
    // approach: z falls from 1 towards 0 over its life; the closer it is, the bigger and further out
    p.z = Math.max(0.02, 1 - p.age / p.dur);
    const k = 1 / (p.z + 0.08);
    const px = cx + p.dx * S * 0.12 * k, py = cy + p.dy * S * 0.12 * k;
    const size = S * 0.035 * k;
    const sw = p.sprite.width * size / 220;
    const fadeIn = Math.min(1, p.age / 3);
    if (px + sw < -50 || px - sw > W + 50 || py + sw < -50 || py - sw > H + 50 || p.z <= 0.02) {
      planet = null; nextPlanetAt = t + rnd(120, 300);   // then every 2–5 minutes
    } else {
      ctx.save(); ctx.globalAlpha = fadeIn * 0.92; ctx.translate(px, py); ctx.rotate(p.rot + p.age * p.spin);
      ctx.drawImage(p.sprite, -sw / 2, -sw / 2, sw, sw); ctx.restore();
    }
  }

  // warp starfield
  const tail = Math.min(0.5, speed * 0.1 + speed * speed * 0.14);   // streaks stretch as warp builds
  ctx.save(); ctx.lineCap = 'round';
  for (const s of stars) {
    s.z -= speed * dt;
    if (s.z <= 0.02) { spawn(s, false); continue; }
    const sx = cx + (s.x / s.z) * S, sy = cy + (s.y / s.z) * S;
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) { spawn(s, false); continue; }
    const near = 1 - s.z, a = Math.min(1, 0.08 + near * near * 1.1);
    const tz = Math.min(1, s.z + tail), tx = cx + (s.x / tz) * S, ty = cy + (s.y / tz) * S;
    ctx.globalAlpha = a; ctx.strokeStyle = s.tint; ctx.lineWidth = 0.6 + near * 2.2;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(sx + 0.01, sy); ctx.stroke();
  }
  ctx.restore();
}

window.MazeSpace = { draw, resize, get speed() { return speed; }, /* for testing */ forcePlanet() { planet = newPlanet(); } };
})();
