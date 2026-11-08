/* Munch Maze logo: a neon shark chomping a stream of pellets, beside a flickering
   neon wordmark. Fills every element with data-logo; data-logo="mark" draws the
   shark only. Pure SVG + CSS animation (style.css: .logo). */
(function () {
'use strict';
let n = 0;
function mark() {
  const id = 'lg' + (++n);   // unique ids: the logo appears more than once
  return `
<svg class="logo-mark" viewBox="0 0 270 120" aria-hidden="true" focusable="false">
  <defs>
    <filter id="${id}g" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#00f0ff" stop-opacity=".30"/>
      <stop offset="1" stop-color="#7a2bff" stop-opacity=".10"/>
    </linearGradient>
    <clipPath id="${id}c"><rect x="176" y="0" width="94" height="120"/></clipPath>
  </defs>
  <!-- pellets streaming into the mouth -->
  <g clip-path="url(#${id}c)" filter="url(#${id}g)">
    <g class="lg-pellets">
      ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => `<circle cx="${186 + k * 26}" cy="66" r="${k % 5 === 3 ? 9 : 5.5}"${k % 5 === 3 ? ' class="lg-power"' : ''}/>`).join('')}
    </g>
  </g>
  <g class="lg-shark" filter="url(#${id}g)">
    <!-- tail, fins -->
    <path class="lg-fill" d="M34 60 L8 30 L18 61 L6 92 Z"/>
    <path class="lg-fill" d="M92 38 L106 8 L124 36 Z"/>
    <path class="lg-fill" d="M104 76 L88 102 L126 78 Z"/>
    <!-- body and upper jaw -->
    <path class="lg-fill" d="M30 62 C52 44 84 34 118 34 C150 34 176 44 192 58 L194 62 L150 64 C120 76 74 76 30 64 Z"/>
    <!-- gills, eye -->
    <path class="lg-line" d="M136 48 q-4 7 0 14 M144 46 q-4 8 0 16 M152 46 q-4 8 0 15"/>
    <circle class="lg-eye" cx="168" cy="47" r="4"/>
    <!-- upper teeth -->
    <path class="lg-teeth" d="M160 63 l3 6 l3 -6 l3 6 l3 -6 l3 6 l3 -6 l3 6 l3 -6 l3 5 l3 -5"/>
    <!-- lower jaw: swings open and snaps shut on each pellet -->
    <g class="lg-jaw">
      <path class="lg-fill" d="M146 66 L190 66 C184 76 168 82 150 80 C140 79 132 76 128 72 Z"/>
      <path class="lg-teeth" d="M162 66 l3 -6 l3 6 l3 -6 l3 6 l3 -6 l3 6 l3 -6 l3 6"/>
    </g>
  </g>
</svg>`;
}
function word() {
  return '<span class="logo-word"><b class="w1" data-text="MUNCH">MUNCH</b><b class="w2" data-text="MAZE">MAZE</b></span>';
}
function fill() {
  for (const el of document.querySelectorAll('[data-logo]')) {
    if (el.dataset.done) continue;
    el.dataset.done = '1';
    el.classList.add('logo');
    el.innerHTML = mark() + (el.dataset.logo === 'mark' ? '' : word());
    if (!el.getAttribute('aria-label')) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', 'Munch Maze'); }
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
window.MazeLogo = { fill };
})();
