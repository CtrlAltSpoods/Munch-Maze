/* Munch Maze player characters, drawn with canvas paths (no images).
   Every character chomps: a jaw opens and closes towards the way it's heading.

   MazeModels.draw(g, mdl, cx, cy, r, paint, face, chew, t)
     mdl    index into MazeCore.MODELS
     paint  '#rrggbb', or 'p:<id>' for an animated premium colour
     face   0 right, 1 down, 2 left, 3 up (left is mirrored so nobody ends up upside down)
     chew   0..1, how far the jaw is open
     t      time in seconds, for idle animation
   MazeModels.colorAt(paint, t) gives the plain colour to use for glows, trails and rings. */
(function () {
'use strict';
const INK = '#0a0c1c', MOUTH = '#4a0f1c', TONGUE = '#ff6b8b';

/* ---------- colour helpers ---------- */
function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgb2hex(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function mix(hex, k) {   // k>0 towards white, k<0 towards black
  const [r, g, b] = hex2rgb(hex), f = v => k < 0 ? v * (1 + k) : v + (255 - v) * k;
  return rgb2hex(f(r), f(g), f(b));
}
function hsl2hex(h, s, l) {
  s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgb2hex(f(0) * 255, f(8) * 255, f(4) * 255);
}
/* Premium colours, quantised a little so cached glow sprites stay few. */
function colorAt(paint, t) {
  if (typeof paint !== 'string' || !paint.startsWith('p:')) return paint || '#ffcc33';
  const q = v => Math.round(v / 10) * 10;
  switch (paint.slice(2)) {
    case 'rainbow': return hsl2hex(q((t * 90) % 360), 95, 62);
    case 'gold': { const s = 0.5 + 0.5 * Math.sin(t * 3); return hsl2hex(44, 95, q(52 + s * 20)); }
    case 'plasma': { const s = 0.5 + 0.5 * Math.sin(t * 2.4); return hsl2hex(q(185 + s * 135), 100, 62); }
    case 'galaxy': { const s = 0.5 + 0.5 * Math.sin(t * 1.3); return hsl2hex(q(250 + s * 40), 80, q(50 + s * 10)); }
    case 'prism': return hsl2hex(q((t * 220) % 360), 70, 82);
    default: return '#ffcc33';
  }
}
/* Extra shimmer drawn over premium characters. */
function premiumOverlay(g, id, r, t) {
  g.save();
  if (id === 'gold' || id === 'prism' || id === 'galaxy') {
    const n = id === 'galaxy' ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const a = i * 2.4 + t * (id === 'galaxy' ? 0.6 : 1.4), d = r * (0.25 + 0.5 * ((i * 0.37 + t * 0.3) % 1));
      const tw = 0.5 + 0.5 * Math.sin(t * 7 + i * 2);
      g.fillStyle = id === 'gold' ? `rgba(255,250,210,${tw})` : `rgba(255,255,255,${tw * 0.9})`;
      const x = Math.cos(a) * d - r * 0.15, y = Math.sin(a) * d * 0.8, s = r * (id === 'galaxy' ? 0.06 : 0.1) * (0.6 + tw);
      g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.3, y); g.lineTo(x, y + s); g.lineTo(x - s * 0.3, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - s, y); g.lineTo(x, y + s * 0.3); g.lineTo(x + s, y); g.lineTo(x, y - s * 0.3); g.closePath(); g.fill();
    }
  }
  if (id === 'plasma') {
    g.strokeStyle = `rgba(255,255,255,${0.35 + 0.25 * Math.sin(t * 9)})`; g.lineWidth = Math.max(1, r * 0.05);
    g.beginPath(); for (let k = 0; k <= 8; k++) { const x = -r * 0.7 + k * r * 0.12, y = Math.sin(k * 1.7 + t * 14) * r * 0.25; k ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  }
  if (id === 'rainbow' || id === 'prism') {
    g.beginPath(); g.arc(0, 0, r * 0.95, 0, Math.PI * 2); g.clip();   // keep the shine on the character
    g.globalAlpha = 0.35; g.fillStyle = '#ffffff';
    const sx = ((t * 0.8) % 1.6 - 0.8) * r * 2;
    g.beginPath(); g.moveTo(sx - r * 0.15, -r); g.lineTo(sx + r * 0.05, -r); g.lineTo(sx - r * 0.25, r); g.lineTo(sx - r * 0.45, r); g.closePath(); g.fill();
  }
  g.restore();
}

/* ---------- shared drawing pieces (all characters face right) ---------- */
const jawAngle = chew => (0.05 + Math.max(0, Math.min(1, chew)) * 0.27) * Math.PI;
function shaded(g, r, c, ox = -0.35, oy = -0.45) {
  const gr = g.createRadialGradient(r * ox, r * oy, r * 0.08, 0, 0, r * 1.05);
  gr.addColorStop(0, mix(c, 0.6)); gr.addColorStop(0.4, c); gr.addColorStop(1, mix(c, -0.35));
  return gr;
}
/** Inside of the mouth, visible through the open jaw. */
function mouthInside(g, r, m, tongue = true) {
  g.fillStyle = MOUTH; g.beginPath(); g.moveTo(-r * 0.05, 0); g.arc(0, 0, r * 0.84, -m * 0.95, m * 0.95); g.closePath(); g.fill();
  if (tongue && m > 0.3) { g.fillStyle = TONGUE; g.beginPath(); g.ellipse(r * 0.38, r * 0.06, r * 0.26, Math.min(r * 0.12, Math.tan(m) * r * 0.3), 0, 0, Math.PI * 2); g.fill(); }
}
/** Body with the jaw cut out. */
function jawBody(g, r, m, fill) { g.fillStyle = fill; g.beginPath(); g.moveTo(r * 0.05, 0); g.arc(0, 0, r, m, Math.PI * 2 - m); g.closePath(); g.fill(); }
/** Teeth along both jaw edges. */
function teeth(g, r, m, { n = 3, from = 0.45, to = 0.92, size = 0.13, color = '#ffffff', top = true, bottom = true } = {}) {
  g.fillStyle = color;
  for (const s of [-1, 1]) {
    if ((s < 0 && !top) || (s > 0 && !bottom)) continue;
    for (let k = 0; k < n; k++) {
      const d = r * (from + (to - from) * (n === 1 ? 0.5 : k / (n - 1))), a = s * (m + 0.02);
      const x = Math.cos(a) * d, y = Math.sin(a) * d, w = r * size * 0.45;
      g.beginPath(); g.moveTo(x - w, y); g.lineTo(x + w, y); g.lineTo(x + Math.sin(a) * 0, y - s * r * size); g.closePath(); g.fill();
    }
  }
}
function eye(g, x, y, er, { iris = '#ffffff', pupil = INK, brow = false, angle = 0 } = {}) {
  g.fillStyle = iris; g.beginPath(); g.arc(x, y, er, 0, Math.PI * 2); g.fill();
  g.fillStyle = pupil; g.beginPath(); g.arc(x + er * 0.25, y, er * 0.55, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(x - er * 0.15, y - er * 0.35, er * 0.22, 0, Math.PI * 2); g.fill();
  if (brow) { g.strokeStyle = INK; g.lineWidth = er * 0.45; g.lineCap = 'round'; g.beginPath(); g.moveTo(x - er * 1.1, y - er * 1.2 - angle); g.lineTo(x + er * 1.1, y - er * 0.9 + angle); g.stroke(); }
}

/* ---------- the ten characters ---------- */
function chomper(g, r, c, chew) {
  const m = jawAngle(chew);
  jawBody(g, r, m, shaded(g, r, c));
  g.fillStyle = INK; g.beginPath(); g.arc(r * 0.18, -r * 0.5, r * 0.11, 0, Math.PI * 2); g.fill();
}
function shark(g, r, c, chew, t) {
  const m = jawAngle(chew) * 0.8, sway = Math.sin(t * 9) * 0.12;
  g.fillStyle = mix(c, -0.2);
  g.beginPath(); g.moveTo(-r * 0.7, 0); g.lineTo(-r * 1.15, -r * (0.5 + sway)); g.lineTo(-r * 1.0, 0); g.lineTo(-r * 1.15, r * (0.5 - sway)); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(-r * 0.15, -r * 0.6); g.lineTo(-r * 0.45, -r * 1.02); g.lineTo(-r * 0.5, -r * 0.55); g.closePath(); g.fill();   // dorsal fin
  g.save(); g.scale(1, 0.78);
  mouthInside(g, r, m, false); jawBody(g, r, m, shaded(g, r, c));
  g.strokeStyle = mix(c, 0.55); g.lineWidth = r * 0.08; g.beginPath(); g.arc(0, 0, r * 0.82, Math.PI * 0.6, Math.PI * 0.95); g.stroke();
  teeth(g, r, m, { n: 4, from: 0.35, to: 0.92, size: 0.17 });
  g.restore();
  for (let k = 0; k < 3; k++) { g.strokeStyle = mix(c, -0.4); g.lineWidth = Math.max(1, r * 0.04); g.beginPath(); g.moveTo(-r * (0.05 + k * 0.12), -r * 0.12); g.lineTo(-r * (0.1 + k * 0.12), r * 0.15); g.stroke(); }
  eye(g, r * 0.28, -r * 0.34, r * 0.1, { brow: true, angle: r * 0.05 });
}
function bear(g, r, c, chew, t) {
  const m = jawAngle(chew) * 0.9;
  // ears
  for (const [x, y] of [[-r * 0.42, -r * 0.82], [r * 0.08, -r * 0.92]]) {
    g.fillStyle = mix(c, -0.12); g.beginPath(); g.arc(x, y, r * 0.24, 0, Math.PI * 2); g.fill();
    g.fillStyle = mix(c, -0.35); g.beginPath(); g.arc(x, y, r * 0.12, 0, Math.PI * 2); g.fill();
  }
  mouthInside(g, r, m); jawBody(g, r, m, shaded(g, r, c, -0.4, -0.4));
  // muzzle on both jaws
  g.fillStyle = mix(c, 0.35);
  for (const s of [-1, 1]) { const a = s * (m + 0.35); g.beginPath(); g.ellipse(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, r * 0.3, r * 0.2, a, 0, Math.PI * 2); g.fill(); }
  teeth(g, r, m, { n: 2, from: 0.62, to: 0.88, size: 0.12 });
  // nose at the tip of the upper jaw
  const na = -(m + 0.12); g.fillStyle = '#1a1a24'; g.beginPath(); g.ellipse(Math.cos(na) * r * 0.9, Math.sin(na) * r * 0.9, r * 0.13, r * 0.09, na, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.arc(Math.cos(na) * r * 0.86, Math.sin(na) * r * 0.9 - r * 0.03, r * 0.03, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK; g.beginPath(); g.arc(r * 0.18, -r * 0.48, r * 0.09, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.arc(r * 0.15, -r * 0.51, r * 0.03, 0, Math.PI * 2); g.fill();
}
function piranha(g, r, c, chew, t) {
  const m = jawAngle(chew), sway = Math.sin(t * 11) * 0.15;
  g.fillStyle = mix(c, -0.25);
  g.beginPath(); g.moveTo(-r * 0.75, 0); g.lineTo(-r * 1.2, -r * (0.55 + sway)); g.lineTo(-r * 1.05, 0); g.lineTo(-r * 1.2, r * (0.55 - sway)); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(-r * 0.4, -r * 0.8); g.lineTo(-r * 0.1, -r * 1.08); g.lineTo(r * 0.1, -r * 0.85); g.closePath(); g.fill();
  mouthInside(g, r, m, false);
  // two-tone body: darker back, bright belly
  g.save(); g.beginPath(); g.moveTo(r * 0.05, 0); g.arc(0, 0, r, m, Math.PI * 2 - m); g.closePath(); g.clip();
  g.fillStyle = shaded(g, r, c); g.fillRect(-r, -r, r * 2, r * 2);
  const belly = g.createLinearGradient(0, 0, 0, r); belly.addColorStop(0, 'rgba(255,200,120,0)'); belly.addColorStop(0.4, 'rgba(255,170,90,0.55)'); belly.addColorStop(1, 'rgba(255,120,60,0.75)');
  g.fillStyle = belly; g.fillRect(-r, 0, r * 2, r);
  g.strokeStyle = mix(c, -0.3); g.globalAlpha = 0.35; g.lineWidth = Math.max(1, r * 0.04);
  for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(-r * (0.15 + k * 0.22), 0, r * 0.35, -1, 1); g.stroke(); }
  g.restore();
  // underbite: big teeth on the lower jaw, small on the top
  teeth(g, r, m, { n: 4, from: 0.38, to: 0.94, size: 0.2, top: false });
  teeth(g, r, m, { n: 3, from: 0.5, to: 0.9, size: 0.1, bottom: false });
  eye(g, r * 0.28, -r * 0.4, r * 0.15, { iris: '#ffe066', brow: true, angle: r * 0.07 });
}
function croc(g, r, c, chew, t) {
  const m = jawAngle(chew) * 0.75;
  g.save(); g.scale(1.22, 0.72);
  mouthInside(g, r, m);
  jawBody(g, r, m, shaded(g, r, c));
  // ridges along the back
  g.fillStyle = mix(c, -0.3);
  for (let k = 0; k < 5; k++) { const a = -Math.PI + 0.45 + k * 0.42; if (a > -m - 0.35) break; const x = Math.cos(a) * r, y = Math.sin(a) * r;
    g.beginPath(); g.moveTo(x - r * 0.1, y + r * 0.02); g.lineTo(x, y - r * 0.2); g.lineTo(x + r * 0.1, y + r * 0.02); g.closePath(); g.fill(); }
  teeth(g, r, m, { n: 5, from: 0.3, to: 0.95, size: 0.16 });
  // nostrils
  const na = -(m + 0.1); g.fillStyle = INK; g.beginPath(); g.arc(Math.cos(na) * r * 0.88, Math.sin(na) * r * 0.88, r * 0.05, 0, Math.PI * 2); g.fill();
  g.restore();
  // raised eye with a slit pupil
  g.fillStyle = mix(c, -0.1); g.beginPath(); g.arc(r * 0.05, -r * 0.62, r * 0.2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffe066'; g.beginPath(); g.arc(r * 0.08, -r * 0.62, r * 0.13, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK; g.beginPath(); g.ellipse(r * 0.1, -r * 0.62, r * 0.035, r * 0.11, 0, 0, Math.PI * 2); g.fill();
}
function wolf(g, r, c, chew, t) {
  const m = jawAngle(chew);
  // pointed ears (one twitches now and then)
  const tw = (t % 3) < 0.15 ? 0.12 : 0;
  for (const [x, lean] of [[-r * 0.45, -0.25], [r * 0.02, -0.05 + tw]]) {
    g.save(); g.translate(x, -r * 0.7); g.rotate(lean);
    g.fillStyle = mix(c, -0.2); g.beginPath(); g.moveTo(-r * 0.22, r * 0.1); g.lineTo(0, -r * 0.48); g.lineTo(r * 0.22, r * 0.1); g.closePath(); g.fill();
    g.fillStyle = '#ffb3c8'; g.beginPath(); g.moveTo(-r * 0.1, r * 0.05); g.lineTo(0, -r * 0.28); g.lineTo(r * 0.1, r * 0.05); g.closePath(); g.fill();
    g.restore();
  }
  mouthInside(g, r, m); jawBody(g, r, m, shaded(g, r, c));
  // pale muzzle and cheek fur
  g.fillStyle = mix(c, 0.45); g.beginPath(); g.moveTo(r * 0.05, 0); g.arc(0, 0, r, m, m + 0.9); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(-r * 0.55, r * 0.2); g.lineTo(-r * 0.85, r * 0.45); g.lineTo(-r * 0.6, r * 0.42); g.lineTo(-r * 0.75, r * 0.65); g.lineTo(-r * 0.4, r * 0.5); g.closePath(); g.fill();
  teeth(g, r, m, { n: 2, from: 0.55, to: 0.9, size: 0.2 });
  const na = -(m + 0.1); g.fillStyle = '#1a1a24'; g.beginPath(); g.ellipse(Math.cos(na) * r * 0.92, Math.sin(na) * r * 0.92, r * 0.11, r * 0.08, na, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffcc33'; g.beginPath(); g.ellipse(r * 0.2, -r * 0.45, r * 0.12, r * 0.08, -0.25, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK; g.beginPath(); g.ellipse(r * 0.22, -r * 0.45, r * 0.04, r * 0.07, 0, 0, Math.PI * 2); g.fill();
}
function dino(g, r, c, chew, t) {
  const m = jawAngle(chew);
  // back plates
  g.fillStyle = mix(c, -0.3);
  for (let k = 0; k < 4; k++) { const a = -Math.PI + 0.55 + k * 0.42, x = Math.cos(a) * r, y = Math.sin(a) * r;
    g.beginPath(); g.moveTo(x + Math.cos(a + 1.5) * r * 0.14, y + Math.sin(a + 1.5) * r * 0.14); g.lineTo(x + Math.cos(a) * r * 0.32, y + Math.sin(a) * r * 0.32); g.lineTo(x + Math.cos(a - 1.5) * r * 0.14, y + Math.sin(a - 1.5) * r * 0.14); g.closePath(); g.fill(); }
  mouthInside(g, r, m); jawBody(g, r, m, shaded(g, r, c));
  // spots
  g.fillStyle = mix(c, -0.22); for (const [x, y, s] of [[-0.45, -0.2, 0.12], [-0.25, 0.35, 0.09], [-0.6, 0.25, 0.08]]) { g.beginPath(); g.arc(x * r, y * r, s * r, 0, Math.PI * 2); g.fill(); }
  teeth(g, r, m, { n: 4, from: 0.35, to: 0.92, size: 0.15 });
  const na = -(m + 0.12); g.fillStyle = INK; g.beginPath(); g.arc(Math.cos(na) * r * 0.85, Math.sin(na) * r * 0.85, r * 0.04, 0, Math.PI * 2); g.fill();
  eye(g, r * 0.2, -r * 0.5, r * 0.13, { brow: true, angle: r * 0.06 });
}
function whale(g, r, c, chew, t) {
  const m = jawAngle(chew) * 0.85;
  // water spout
  const sp = (t * 1.5) % 1;
  g.fillStyle = 'rgba(160,220,255,0.75)';
  for (let k = 0; k < 4; k++) { const p = (sp + k * 0.25) % 1, x = -r * 0.2 + (k % 2 ? 1 : -1) * p * r * 0.35, y = -r * 1.0 - p * r * 0.5;
    g.globalAlpha = 1 - p; g.beginPath(); g.arc(x, y, r * 0.09 * (1 - p * 0.5), 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1;
  // tail
  g.fillStyle = mix(c, -0.25); g.beginPath(); g.moveTo(-r * 0.8, 0); g.quadraticCurveTo(-r * 1.15, -r * 0.1, -r * 1.25, -r * 0.45); g.quadraticCurveTo(-r * 1.05, -r * 0.05, -r * 1.25, r * 0.4); g.quadraticCurveTo(-r * 1.1, r * 0.1, -r * 0.8, 0); g.fill();
  mouthInside(g, r, m);
  g.save(); g.scale(1.08, 0.92); jawBody(g, r, m, shaded(g, r, c)); g.restore();
  // pale throat grooves
  g.save(); g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r * 0.98, m, Math.PI * 0.85); g.closePath(); g.clip();
  g.fillStyle = mix(c, 0.5); g.fillRect(-r, 0, r * 2, r);
  g.strokeStyle = mix(c, 0.15); g.lineWidth = Math.max(1, r * 0.035);
  for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(-r * 0.6, r * 0.15 * k); g.lineTo(r * 0.8, r * 0.12 * k + r * 0.05); g.stroke(); }
  g.restore();
  g.fillStyle = mix(c, -0.3); g.beginPath(); g.ellipse(-r * 0.2, r * 0.55, r * 0.28, r * 0.1, 0.5, 0, Math.PI * 2); g.fill();   // flipper
  eye(g, r * 0.15, -r * 0.18, r * 0.09);
}
function dragon(g, r, c, chew, t) {
  const m = jawAngle(chew);
  // horns sweeping back
  g.fillStyle = '#f2e6c8';
  for (const [x, y, s] of [[-r * 0.15, -r * 0.82, 1], [-r * 0.45, -r * 0.7, 0.8]]) { g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x - r * 0.35 * s, y - r * 0.25 * s, x - r * 0.65 * s, y - r * 0.1 * s); g.quadraticCurveTo(x - r * 0.3 * s, y + r * 0.02, x + r * 0.15, y + r * 0.12); g.closePath(); g.fill(); }
  // flame when the jaw is wide open
  if (chew > 0.75) {
    const f = (chew - 0.75) / 0.25, fl = r * (0.6 + 0.4 * Math.sin(t * 40)) * f;
    const fg = g.createLinearGradient(r * 0.6, 0, r + fl, 0); fg.addColorStop(0, '#fff3b0'); fg.addColorStop(0.5, '#ff9a1a'); fg.addColorStop(1, 'rgba(255,60,20,0)');
    g.fillStyle = fg; g.beginPath(); g.moveTo(r * 0.5, -r * 0.08); g.quadraticCurveTo(r + fl * 0.6, -r * 0.35, r + fl, 0); g.quadraticCurveTo(r + fl * 0.6, r * 0.35, r * 0.5, r * 0.08); g.closePath(); g.fill();
  }
  mouthInside(g, r, m, false); jawBody(g, r, m, shaded(g, r, c));
  // scales and a belly band
  g.save(); g.beginPath(); g.moveTo(r * 0.05, 0); g.arc(0, 0, r, m, Math.PI * 2 - m); g.closePath(); g.clip();
  g.strokeStyle = mix(c, -0.3); g.globalAlpha = 0.45; g.lineWidth = Math.max(1, r * 0.04);
  for (let row = 0; row < 3; row++) for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(-r * 0.75 + k * r * 0.26 + (row % 2) * r * 0.13, -r * 0.45 + row * r * 0.22, r * 0.12, 0, Math.PI); g.stroke(); }
  g.globalAlpha = 1; g.fillStyle = '#ffd98a'; g.beginPath(); g.moveTo(r * 0.05, 0); g.arc(0, 0, r, m, m + 0.8); g.closePath(); g.fill();
  g.restore();
  teeth(g, r, m, { n: 3, from: 0.45, to: 0.92, size: 0.15 });
  const na = -(m + 0.1); g.fillStyle = INK; g.beginPath(); g.arc(Math.cos(na) * r * 0.86, Math.sin(na) * r * 0.86, r * 0.05, 0, Math.PI * 2); g.fill();
  eye(g, r * 0.2, -r * 0.48, r * 0.13, { iris: '#ffe066', brow: true, angle: r * 0.07 });
}
function gem(g, r, c, chew, t) {
  const m = jawAngle(chew), N = 10, pts = [];
  for (let k = 0; k <= N; k++) { const a = m + (Math.PI * 2 - 2 * m) * k / N; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  g.beginPath(); g.moveTo(0, 0); for (const [x, y] of pts) g.lineTo(x, y); g.closePath();
  g.fillStyle = shaded(g, r, c); g.fill();
  g.strokeStyle = mix(c, 0.55); g.lineWidth = Math.max(1, r * 0.04); g.globalAlpha = 0.7; g.beginPath();
  for (let k = 0; k < pts.length; k++) { const [x, y] = pts[k]; g.moveTo(x * 0.55, y * 0.55); g.lineTo(x, y); if (k) { const [px, py] = pts[k - 1]; g.moveTo(px * 0.55, py * 0.55); g.lineTo(x * 0.55, y * 0.55); } }
  g.stroke(); g.globalAlpha = 1;
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.moveTo(-r * 0.5, -r * 0.45); g.lineTo(-r * 0.1, -r * 0.7); g.lineTo(-r * 0.05, -r * 0.35); g.closePath(); g.fill();
  const tw = 0.5 + 0.5 * Math.sin(t * 5);
  g.save(); g.translate(-r * 0.35, -r * 0.4); g.rotate(t); g.fillStyle = `rgba(255,255,255,${0.5 + tw * 0.5})`;
  for (let k = 0; k < 4; k++) { g.rotate(Math.PI / 2); g.beginPath(); g.moveTo(0, -r * 0.03); g.lineTo(r * (0.12 + tw * 0.1), 0); g.lineTo(0, r * 0.03); g.fill(); }
  g.restore();
  g.fillStyle = INK; g.beginPath(); g.arc(r * 0.15, -r * 0.5, r * 0.1, 0, Math.PI * 2); g.fill();
}

const DRAW = { chomper, shark, bear, piranha, croc, wolf, dino, whale, dragon, gem };
/* Easter egg: a little yellow duck, seen from the side, waddling along. Faces left when
   heading left; tips its head up or down for vertical moves. chew opens the beak. */
function drawDuck(g, cx, cy, r, face = 0, chew = 0.5, t = 0) {
  const step = t * 11, bob = Math.abs(Math.sin(step)) * r * 0.07, sway = Math.sin(step) * 0.07;
  g.save(); g.translate(cx, cy - bob);
  if (face === 2) g.scale(-1, 1);
  g.rotate(face === 3 ? -0.28 : face === 1 ? 0.28 : sway);
  g.lineJoin = 'round'; g.lineCap = 'round';
  // feet, stepping in turn
  for (const k of [0, 1]) {
    const ph = step + k * Math.PI, fx = Math.sin(ph) * r * 0.22 - r * 0.05 + k * r * 0.12, lift = Math.max(0, Math.cos(ph)) * r * 0.1;
    g.fillStyle = '#ff9a1f'; g.strokeStyle = '#c26a00'; g.lineWidth = Math.max(1, r * 0.05);
    g.beginPath(); g.moveTo(fx - r * 0.05, r * 0.5 - lift); g.lineTo(fx - r * 0.05, r * 0.66 - lift); g.stroke();
    g.beginPath(); g.moveTo(fx - r * 0.12, r * 0.7 - lift); g.lineTo(fx + r * 0.2, r * 0.68 - lift); g.lineTo(fx + r * 0.02, r * 0.6 - lift); g.closePath(); g.fill();
  }
  // body
  const body = g.createRadialGradient(-r * 0.15, -r * 0.05, r * 0.1, -r * 0.05, r * 0.15, r * 0.75);
  body.addColorStop(0, '#fff6a8'); body.addColorStop(0.6, '#ffdb2e'); body.addColorStop(1, '#f2b800');
  g.fillStyle = body; g.strokeStyle = '#b98500'; g.lineWidth = Math.max(1, r * 0.06);
  g.beginPath(); g.ellipse(-r * 0.08, r * 0.16, r * 0.62, r * 0.42, 0, 0, Math.PI * 2);
  g.moveTo(-r * 0.62, r * 0.02); g.lineTo(-r * 0.86, -r * 0.2); g.lineTo(-r * 0.6, r * 0.18);   // tail tuft
  g.fill(); g.stroke();
  // wing, flapping a little with each step
  g.save(); g.translate(-r * 0.12, r * 0.1); g.rotate(-0.15 + Math.sin(step * 2) * 0.12);
  g.fillStyle = '#ffcf1a'; g.beginPath(); g.ellipse(0, 0, r * 0.32, r * 0.2, -0.2, 0, Math.PI * 2); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(185,133,0,0.6)'; g.lineWidth = Math.max(1, r * 0.035);
  g.beginPath(); g.moveTo(-r * 0.2, r * 0.02); g.quadraticCurveTo(0, r * 0.1, r * 0.18, -r * 0.02); g.stroke();
  g.restore();
  // head
  const hx = r * 0.36, hy = -r * 0.34;
  const head = g.createRadialGradient(hx - r * 0.1, hy - r * 0.12, r * 0.05, hx, hy, r * 0.36);
  head.addColorStop(0, '#fff6a8'); head.addColorStop(1, '#ffd21f');
  g.fillStyle = head; g.strokeStyle = '#b98500'; g.lineWidth = Math.max(1, r * 0.06);
  g.beginPath(); g.arc(hx, hy, r * 0.33, 0, Math.PI * 2); g.fill(); g.stroke();
  // beak: top and bottom halves, opening as it eats
  const open = Math.max(0, Math.min(1, chew)) * r * 0.16;
  g.fillStyle = '#ff9a1f'; g.strokeStyle = '#c26a00'; g.lineWidth = Math.max(1, r * 0.04);
  g.beginPath(); g.moveTo(hx + r * 0.24, hy - r * 0.02); g.quadraticCurveTo(hx + r * 0.62, hy - r * 0.04 - open * 0.3, hx + r * 0.66, hy + r * 0.04 - open * 0.5); g.lineTo(hx + r * 0.26, hy + r * 0.08); g.closePath(); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(hx + r * 0.26, hy + r * 0.1); g.lineTo(hx + r * 0.6, hy + r * 0.1 + open); g.quadraticCurveTo(hx + r * 0.4, hy + r * 0.2 + open, hx + r * 0.22, hy + r * 0.14); g.closePath(); g.fill(); g.stroke();
  // eye and cheek
  g.fillStyle = '#1a1206'; g.beginPath(); g.arc(hx + r * 0.1, hy - r * 0.1, r * 0.07, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(hx + r * 0.12, hy - r * 0.13, r * 0.025, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,120,120,0.45)'; g.beginPath(); g.ellipse(hx + r * 0.02, hy + r * 0.08, r * 0.08, r * 0.05, 0, 0, Math.PI * 2); g.fill();
  g.restore();
}
function draw(g, mdl, cx, cy, r, paint, face = 0, chew = 0.5, t = 0) {
  if (mdl === 'duck') return drawDuck(g, cx, cy, r, face, chew, t);
  const list = (window.MazeCore && MazeCore.MODELS) || [];
  const fn = DRAW[(list[mdl] || list[0] || { id: 'chomper' }).id] || chomper;
  const premium = typeof paint === 'string' && paint.startsWith('p:') ? paint.slice(2) : '';
  const col = colorAt(paint, t);
  face &= 3;
  g.save(); g.translate(cx, cy);
  if (face === 2) g.scale(-1, 1);
  else if (face === 1) g.rotate(Math.PI / 2);
  else if (face === 3) g.rotate(-Math.PI / 2);
  fn(g, r, col, chew, t);
  if (premium) premiumOverlay(g, premium, r, t);
  g.restore();
}
/** CSS background for a swatch of this paint (animated premiums use a gradient). */
function swatchCss(paint) {
  switch (typeof paint === 'string' && paint.startsWith('p:') ? paint.slice(2) : '') {
    case 'rainbow': return 'conic-gradient(#ff4d5e, #ffcc33, #7ee081, #41e0f0, #6f7bff, #ff5fd2, #ff4d5e)';
    case 'gold': return 'radial-gradient(circle at 35% 30%, #fff6c8, #ffcc33 45%, #b8860b)';
    case 'plasma': return 'linear-gradient(135deg, #ff4dd8, #41e0f0)';
    case 'galaxy': return 'radial-gradient(circle at 30% 30%, #b9a3ff 0 6%, transparent 7%), radial-gradient(circle at 65% 60%, #ffffff 0 4%, transparent 5%), linear-gradient(135deg, #2a1366, #6a3cff 60%, #1b0f45)';
    case 'prism': return 'linear-gradient(135deg, #ffd1f0, #c8f6ff, #fff6c8, #d8c8ff)';
    default: return paint;
  }
}
window.MazeModels = { draw, colorAt, swatchCss };
})();
