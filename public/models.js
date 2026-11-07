/* Munch Maze player characters, drawn with canvas paths (no images).

   MazeModels.draw(g, mdl, cx, cy, r, color, face, chew, t)
     mdl   index into MazeCore.MODELS
     face  0 right, 1 down, 2 left, 3 up
     chew  0..1 mouth/animation amount (bigger = wider open)
     t     time in seconds, for idle animation

   "Turning" characters rotate to face their direction (left is mirrored so they
   never end up upside down). "Upright" ones stay upright and look where they go. */
(function () {
'use strict';
const INK = '#0a0c1c';
const LOOK = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function mix(hex, k) {   // k>0 lighten towards white, k<0 darken
  const n = parseInt(hex.slice(1), 16), f = v => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`;
}
function shaded(g, r, col, ox = -0.35, oy = -0.4) {
  const gr = g.createRadialGradient(r * ox, r * oy, r * 0.08, 0, 0, r * 1.05);
  gr.addColorStop(0, mix(col, 0.65)); gr.addColorStop(0.35, col); gr.addColorStop(1, mix(col, -0.32));
  return gr;
}
function eye(g, x, y, er, look, pr = 0.5) {
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, er, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK; g.beginPath(); g.arc(x + look[0] * er * 0.35, y + look[1] * er * 0.35, er * pr, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(x - er * 0.25, y - er * 0.3, er * 0.18, 0, Math.PI * 2); g.fill();
}

/* ---------- turning characters (drawn facing right) ---------- */
function chomper(g, r, c, chew) {
  const m = (0.05 + chew * 0.27) * Math.PI;
  g.fillStyle = shaded(g, r, c); g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, m, Math.PI * 2 - m); g.closePath(); g.fill();
  g.fillStyle = INK; g.beginPath(); g.arc(r * 0.18, -r * 0.5, r * 0.11, 0, Math.PI * 2); g.fill();
}
function shark(g, r, c, chew, t) {
  const sway = Math.sin(t * 9) * 0.12;
  // tail
  g.fillStyle = mix(c, -0.2); g.beginPath(); g.moveTo(-r * 0.7, 0); g.lineTo(-r * 1.15, -r * (0.5 + sway)); g.lineTo(-r * 1.0, 0); g.lineTo(-r * 1.15, r * (0.5 - sway)); g.closePath(); g.fill();
  // side fins
  g.beginPath(); g.moveTo(-r * 0.1, -r * 0.35); g.lineTo(-r * 0.55, -r * 0.85); g.lineTo(-r * 0.35, -r * 0.3); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(-r * 0.1, r * 0.35); g.lineTo(-r * 0.55, r * 0.85); g.lineTo(-r * 0.35, r * 0.3); g.closePath(); g.fill();
  // body with a jaw that opens
  const m = (0.04 + chew * 0.2) * Math.PI;
  g.save(); g.scale(1, 0.72);
  g.fillStyle = shaded(g, r, c); g.beginPath(); g.moveTo(r * 0.15, 0);
  g.arc(0, 0, r, m, Math.PI * 2 - m); g.closePath(); g.fill();
  // belly line
  g.strokeStyle = mix(c, 0.55); g.lineWidth = r * 0.08; g.beginPath(); g.arc(0, 0, r * 0.82, Math.PI * 0.6, Math.PI * 0.95); g.stroke();
  // teeth along the jaw
  g.fillStyle = '#ffffff';
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
    const a = s * (m + 0.04), d = r * (0.42 + k * 0.17), x = Math.cos(a) * d, y = Math.sin(a) * d;
    g.beginPath(); g.moveTo(x - r * 0.06, y); g.lineTo(x + r * 0.06, y); g.lineTo(x, y - s * r * 0.15); g.closePath(); g.fill();
  }
  g.restore();
  g.fillStyle = INK; g.beginPath(); g.arc(r * 0.3, -r * 0.36, r * 0.09, 0, Math.PI * 2); g.fill();
}
function rocket(g, r, c, chew, t) {
  // flame
  const fl = r * (0.45 + 0.25 * Math.abs(Math.sin(t * 30)) + chew * 0.25);
  const fg = g.createLinearGradient(-r * 0.7 - fl, 0, -r * 0.65, 0); fg.addColorStop(0, 'rgba(255,90,40,0)'); fg.addColorStop(0.5, '#ff7a1a'); fg.addColorStop(1, '#fff3b0');
  g.fillStyle = fg; g.beginPath(); g.moveTo(-r * 0.62, -r * 0.24); g.quadraticCurveTo(-r * 0.7 - fl, 0, -r * 0.62, r * 0.24); g.closePath(); g.fill();
  // fins
  g.fillStyle = mix(c, -0.3);
  g.beginPath(); g.moveTo(-r * 0.2, -r * 0.32); g.lineTo(-r * 0.7, -r * 0.72); g.lineTo(-r * 0.66, -r * 0.25); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(-r * 0.2, r * 0.32); g.lineTo(-r * 0.7, r * 0.72); g.lineTo(-r * 0.66, r * 0.25); g.closePath(); g.fill();
  // body
  const bg = g.createLinearGradient(0, -r * 0.42, 0, r * 0.42); bg.addColorStop(0, mix(c, 0.5)); bg.addColorStop(0.45, c); bg.addColorStop(1, mix(c, -0.35));
  g.fillStyle = bg; g.beginPath(); g.moveTo(-r * 0.66, -r * 0.36); g.lineTo(r * 0.35, -r * 0.4); g.quadraticCurveTo(r * 1.05, -r * 0.2, r * 1.0, 0);
  g.quadraticCurveTo(r * 1.05, r * 0.2, r * 0.35, r * 0.4); g.lineTo(-r * 0.66, r * 0.36); g.closePath(); g.fill();
  // nose band and window
  g.fillStyle = mix(c, -0.25); g.fillRect(r * 0.48, -r * 0.33, r * 0.08, r * 0.66);
  g.fillStyle = '#cfe9ff'; g.strokeStyle = mix(c, -0.45); g.lineWidth = r * 0.07;
  g.beginPath(); g.arc(r * 0.05, 0, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.arc(-r * 0.01, -r * 0.06, r * 0.06, 0, Math.PI * 2); g.fill();
}
function gem(g, r, c, chew, t) {
  const m = (0.05 + chew * 0.25) * Math.PI, N = 10;
  const pts = [];
  for (let k = 0; k <= N; k++) { const a = m + (Math.PI * 2 - 2 * m) * k / N; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  g.beginPath(); g.moveTo(0, 0); for (const [x, y] of pts) g.lineTo(x, y); g.closePath();
  g.fillStyle = shaded(g, r, c); g.fill();
  // facets
  g.strokeStyle = mix(c, 0.55); g.lineWidth = Math.max(1, r * 0.04); g.globalAlpha = 0.7;
  g.beginPath();
  for (let k = 0; k < pts.length; k++) { const [x, y] = pts[k]; g.moveTo(x * 0.55, y * 0.55); g.lineTo(x, y); if (k) { const [px, py] = pts[k - 1]; g.moveTo(px * 0.55, py * 0.55); g.lineTo(x * 0.55, y * 0.55); } }
  g.stroke(); g.globalAlpha = 1;
  // table highlight + sparkle
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.moveTo(-r * 0.5, -r * 0.45); g.lineTo(-r * 0.1, -r * 0.7); g.lineTo(-r * 0.05, -r * 0.35); g.closePath(); g.fill();
  const tw = 0.5 + 0.5 * Math.sin(t * 5);
  g.save(); g.translate(-r * 0.35, -r * 0.4); g.rotate(t); g.fillStyle = `rgba(255,255,255,${0.5 + tw * 0.5})`;
  for (let k = 0; k < 4; k++) { g.rotate(Math.PI / 2); g.beginPath(); g.moveTo(0, -r * 0.03); g.lineTo(r * (0.12 + tw * 0.1), 0); g.lineTo(0, r * 0.03); g.fill(); }
  g.restore();
  g.fillStyle = INK; g.beginPath(); g.arc(r * 0.15, -r * 0.5, r * 0.1, 0, Math.PI * 2); g.fill();
}

/* ---------- upright characters (look towards their direction) ---------- */
function saucer(g, r, c, chew, t, look) {
  // beam
  g.fillStyle = `rgba(160,255,200,${0.12 + chew * 0.25})`;
  g.beginPath(); g.moveTo(-r * 0.3, r * 0.25); g.lineTo(r * 0.3, r * 0.25); g.lineTo(r * 0.55, r * 1.0); g.lineTo(-r * 0.55, r * 1.0); g.closePath(); g.fill();
  // dome with a little pilot
  const dg = g.createRadialGradient(-r * 0.15, -r * 0.45, r * 0.05, 0, -r * 0.2, r * 0.55);
  dg.addColorStop(0, 'rgba(230,250,255,0.95)'); dg.addColorStop(1, 'rgba(120,200,255,0.55)');
  g.fillStyle = '#7cf06a'; g.beginPath(); g.arc(0, -r * 0.18, r * 0.24, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK; for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * r * 0.09 + look[0] * r * 0.04, -r * 0.2 + look[1] * r * 0.03, r * 0.05, r * 0.08, 0, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = dg; g.beginPath(); g.arc(0, -r * 0.1, r * 0.48, Math.PI, 0); g.closePath(); g.fill();
  // disc
  const sg = g.createLinearGradient(0, -r * 0.2, 0, r * 0.35); sg.addColorStop(0, mix(c, 0.6)); sg.addColorStop(0.5, c); sg.addColorStop(1, mix(c, -0.45));
  g.fillStyle = sg; g.beginPath(); g.ellipse(0, r * 0.08, r * 1.0, r * 0.32, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = mix(c, -0.25); g.beginPath(); g.ellipse(0, r * 0.2, r * 0.55, r * 0.12, 0, 0, Math.PI * 2); g.fill();
  // chasing rim lights
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + t * 3, x = Math.cos(a) * r * 0.78, y = r * 0.08 + Math.sin(a) * r * 0.22;
    if (Math.sin(a) < -0.2) continue;   // back side hidden
    g.fillStyle = k % 2 ? '#ffe066' : '#ff6bd6'; g.beginPath(); g.arc(x, y, r * 0.07, 0, Math.PI * 2); g.fill();
  }
}
function robot(g, r, c, chew, t, look) {
  // antenna
  g.strokeStyle = mix(c, -0.4); g.lineWidth = r * 0.07; g.beginPath(); g.moveTo(0, -r * 0.7); g.lineTo(0, -r * 0.95); g.stroke();
  g.fillStyle = Math.sin(t * 6) > 0 ? '#ff4d5e' : '#7a1f2a'; g.beginPath(); g.arc(0, -r * 1.0, r * 0.1, 0, Math.PI * 2); g.fill();
  // ears
  g.fillStyle = mix(c, -0.35); g.fillRect(-r * 0.98, -r * 0.2, r * 0.18, r * 0.4); g.fillRect(r * 0.8, -r * 0.2, r * 0.18, r * 0.4);
  // head (top part) and jaw that drops when chewing
  const jaw = r * 0.22 * chew;
  const hg = g.createLinearGradient(0, -r * 0.75, 0, r * 0.4); hg.addColorStop(0, mix(c, 0.45)); hg.addColorStop(1, mix(c, -0.2));
  g.fillStyle = hg; rr(g, -r * 0.8, -r * 0.75, r * 1.6, r * 1.05, r * 0.25); g.fill();
  g.fillStyle = mix(c, -0.3); rr(g, -r * 0.7, r * 0.3 + jaw * 0.3, r * 1.4, r * 0.42, r * 0.15); g.fill();
  g.fillStyle = INK; g.fillRect(-r * 0.6, r * 0.3, r * 1.2, jaw * 0.6 + 1);
  // teeth grill
  g.fillStyle = mix(c, 0.5); for (let k = 0; k < 5; k++) g.fillRect(-r * 0.55 + k * r * 0.24, r * 0.38 + jaw * 0.3, r * 0.14, r * 0.18);
  // visor with a scanning eye
  g.fillStyle = '#111432'; rr(g, -r * 0.62, -r * 0.48, r * 1.24, r * 0.4, r * 0.18); g.fill();
  const ex = look[0] * r * 0.3 + Math.sin(t * 2) * r * 0.08 * (look[0] === 0 ? 1 : 0);
  const eg = g.createRadialGradient(ex, -r * 0.28 + look[1] * r * 0.05, 0, ex, -r * 0.28, r * 0.25);
  eg.addColorStop(0, '#ffffff'); eg.addColorStop(0.3, '#41e0f0'); eg.addColorStop(1, 'rgba(65,224,240,0)');
  g.fillStyle = eg; g.beginPath(); g.ellipse(ex, -r * 0.28 + look[1] * r * 0.05, r * 0.26, r * 0.13, 0, 0, Math.PI * 2); g.fill();
}
function slime(g, r, c, chew, t, look) {
  const sq = 0.12 * chew, N = 18;
  g.beginPath();
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * Math.PI * 2, wob = 1 + 0.06 * Math.sin(a * 3 + t * 7);
    const x = Math.cos(a) * r * wob * (1 + sq), y = Math.sin(a) * r * wob * (1 - sq) * (Math.sin(a) > 0 ? 0.82 : 1) + r * 0.08;
    k ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath(); g.fillStyle = shaded(g, r, c); g.globalAlpha = 0.92; g.fill(); g.globalAlpha = 1;
  g.fillStyle = 'rgba(255,255,255,0.45)'; g.beginPath(); g.ellipse(-r * 0.4, -r * 0.45, r * 0.18, r * 0.1, -0.6, 0, Math.PI * 2); g.fill();
  eye(g, -r * 0.3, -r * 0.1, r * 0.2, look); eye(g, r * 0.3, -r * 0.1, r * 0.2, look);
  g.fillStyle = INK; g.beginPath(); g.ellipse(0, r * 0.32, r * (0.12 + chew * 0.08), r * (0.05 + chew * 0.12), 0, 0, Math.PI * 2); g.fill();
}
function cat(g, r, c, chew, t, look) {
  // ears
  for (const s of [-1, 1]) {
    g.fillStyle = mix(c, -0.15); g.beginPath(); g.moveTo(s * r * 0.85, -r * 0.2); g.lineTo(s * r * 0.75, -r * 1.05); g.lineTo(s * r * 0.2, -r * 0.7); g.closePath(); g.fill();
    g.fillStyle = '#ff9ad5'; g.beginPath(); g.moveTo(s * r * 0.7, -r * 0.35); g.lineTo(s * r * 0.68, -r * 0.85); g.lineTo(s * r * 0.35, -r * 0.62); g.closePath(); g.fill();
  }
  g.fillStyle = shaded(g, r, c); g.beginPath(); g.ellipse(0, 0, r * 0.95, r * 0.85, 0, 0, Math.PI * 2); g.fill();
  // eyes: almond with slit pupils, blink now and then
  const blink = (t % 4) < 0.12;
  for (const s of [-1, 1]) {
    const x = s * r * 0.36, y = -r * 0.15;
    if (blink) { g.strokeStyle = INK; g.lineWidth = r * 0.06; g.beginPath(); g.moveTo(x - r * 0.16, y); g.lineTo(x + r * 0.16, y); g.stroke(); continue; }
    g.fillStyle = '#c8ff6a'; g.beginPath(); g.ellipse(x, y, r * 0.18, r * 0.14, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = INK; g.beginPath(); g.ellipse(x + look[0] * r * 0.06, y + look[1] * r * 0.03, r * 0.05, r * 0.12, 0, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#ff7ab8'; g.beginPath(); g.moveTo(-r * 0.08, r * 0.1); g.lineTo(r * 0.08, r * 0.1); g.lineTo(0, r * 0.2); g.closePath(); g.fill();
  if (chew > 0.15) { g.fillStyle = INK; g.beginPath(); g.ellipse(0, r * 0.36, r * 0.14, r * 0.13 * chew, 0, 0, Math.PI * 2); g.fill(); }
  else { g.strokeStyle = INK; g.lineWidth = r * 0.05; g.beginPath(); g.arc(-r * 0.09, r * 0.22, r * 0.09, 0.2, Math.PI - 0.2); g.arc(r * 0.09, r * 0.22, r * 0.09, 0.2, Math.PI - 0.2); g.stroke(); }
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = Math.max(1, r * 0.03);
  for (const s of [-1, 1]) for (const k of [-1, 0, 1]) { g.beginPath(); g.moveTo(s * r * 0.3, r * 0.2 + k * r * 0.06); g.lineTo(s * r * 1.05, r * 0.15 + k * r * 0.16); g.stroke(); }
}
function bee(g, r, c, chew, t, look) {
  // wings flap
  const flap = 0.55 + 0.45 * Math.abs(Math.sin(t * 38));
  g.fillStyle = 'rgba(220,240,255,0.7)'; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = Math.max(1, r * 0.03);
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * r * 0.45, -r * 0.6, r * 0.42, r * 0.28 * flap, s * 0.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
  // stinger
  g.fillStyle = INK; g.beginPath(); g.moveTo(-r * 0.12, r * 0.75); g.lineTo(r * 0.12, r * 0.75); g.lineTo(0, r * 1.05); g.closePath(); g.fill();
  // body with stripes
  g.save(); g.beginPath(); g.ellipse(0, r * 0.05, r * 0.8, r * 0.78, 0, 0, Math.PI * 2); g.clip();
  g.fillStyle = shaded(g, r, c); g.fillRect(-r, -r, r * 2, r * 2);
  g.fillStyle = 'rgba(20,16,30,0.85)'; for (const y of [0.1, 0.5]) g.fillRect(-r, r * y, r * 2, r * 0.18);
  g.restore();
  // antennae
  g.strokeStyle = INK; g.lineWidth = r * 0.06;
  for (const s of [-1, 1]) { g.beginPath(); g.moveTo(s * r * 0.2, -r * 0.65); g.quadraticCurveTo(s * r * 0.3, -r * 1.05, s * r * 0.5, -r * 1.0); g.stroke(); g.fillStyle = INK; g.beginPath(); g.arc(s * r * 0.5, -r * 1.0, r * 0.08, 0, Math.PI * 2); g.fill(); }
  eye(g, -r * 0.28, -r * 0.25, r * 0.18, look, 0.6); eye(g, r * 0.28, -r * 0.25, r * 0.18, look, 0.6);
  if (chew > 0.2) { g.fillStyle = INK; g.beginPath(); g.ellipse(0, -r * 0.0, r * 0.1, r * 0.08 * chew, 0, 0, Math.PI * 2); g.fill(); }
}
function frog(g, r, c, chew, t, look) {
  // eye bumps
  for (const s of [-1, 1]) { g.fillStyle = shaded(g, r, c); g.beginPath(); g.arc(s * r * 0.45, -r * 0.55, r * 0.33, 0, Math.PI * 2); g.fill(); }
  // head
  g.fillStyle = shaded(g, r, c, -0.3, -0.2); g.beginPath(); g.ellipse(0, r * 0.05, r * 1.0, r * 0.72, 0, 0, Math.PI * 2); g.fill();
  eye(g, -r * 0.45, -r * 0.58, r * 0.22, look, 0.55); eye(g, r * 0.45, -r * 0.58, r * 0.22, look, 0.55);
  // cheeks
  g.fillStyle = 'rgba(255,120,150,0.45)'; for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * r * 0.62, r * 0.15, r * 0.14, r * 0.09, 0, 0, Math.PI * 2); g.fill(); }
  // wide mouth; tongue flicks out when chewing hard
  if (chew > 0.2) {
    g.fillStyle = '#3a0d1e'; g.beginPath(); g.ellipse(0, r * 0.3, r * 0.6, r * 0.25 * chew, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff6b8b'; g.beginPath(); g.ellipse(0, r * 0.36, r * 0.25, r * 0.12 * chew, 0, 0, Math.PI * 2); g.fill();
  } else { g.strokeStyle = mix(c, -0.55); g.lineWidth = r * 0.06; g.beginPath(); g.moveTo(-r * 0.6, r * 0.25); g.quadraticCurveTo(0, r * 0.45, r * 0.6, r * 0.25); g.stroke(); }
}
function rr(g, x, y, w, h, rad) {
  g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad); g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath();
}

const DRAW = {
  chomper: [chomper, true], shark: [shark, true], rocket: [rocket, true], gem: [gem, true],
  saucer: [saucer, false], robot: [robot, false], slime: [slime, false], cat: [cat, false], bee: [bee, false], frog: [frog, false]
};
function draw(g, mdl, cx, cy, r, color, face = 0, chew = 0.5, t = 0) {
  const list = (window.MazeCore && MazeCore.MODELS) || [];
  const id = (list[mdl] || list[0] || { id: 'chomper' }).id;
  const [fn, turns] = DRAW[id] || DRAW.chomper;
  face &= 3;
  g.save(); g.translate(cx, cy);
  if (turns) {
    if (face === 2) g.scale(-1, 1);
    else if (face === 1) g.rotate(Math.PI / 2);
    else if (face === 3) g.rotate(-Math.PI / 2);
    fn(g, r, color, chew, t);
  } else {
    // upright: tilt slightly into horizontal movement, mirror when heading left
    if (face === 2) g.scale(-1, 1);
    const look = face === 2 ? [1, 0] : LOOK[face];
    fn(g, r * 0.95, color, chew, t, look);
  }
  g.restore();
}
window.MazeModels = { draw };
})();
