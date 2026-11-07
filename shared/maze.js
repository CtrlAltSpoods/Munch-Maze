/* Munch Maze shared core: seeded level generation and rules.
   Loaded by the Node server (require) and the browser (<script src="maze.js">),
   so both sides always build the exact same maze from a seed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MazeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // right, down, left, up

  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
    return function () { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
  }
  function mulberry32(a) {
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /** Seeds are normalised so "Hello World" and "hello-world" are the same maze. */
  function slug(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '').slice(0, 40);
  }
  const WA = ['amber', 'brisk', 'cobalt', 'dusty', 'ember', 'frosty', 'glowy', 'hazel', 'ivory', 'jade', 'kelp', 'lunar', 'mossy', 'neon', 'opal', 'plum', 'quartz', 'rusty', 'sable', 'tidal', 'umber', 'velvet', 'windy', 'zesty'];
  const WB = ['otter', 'comet', 'pickle', 'falcon', 'marble', 'lantern', 'badger', 'cactus', 'harbor', 'meadow', 'nebula', 'pepper', 'quokka', 'rocket', 'sprout', 'tundra', 'walrus', 'yonder'];
  function randomSeed() {
    return WA[Math.random() * WA.length | 0] + '-' + WB[Math.random() * WB.length | 0] + '-' + (10 + Math.random() * 90 | 0);
  }

  /* Player characters, in unlock order: character N needs level N cleared (the first is free).
     Each has five colours (colour N also needs level N cleared), plus five premium
     animated colours shared by every character, unlocked every 10 levels cleared. */
  const MODELS = [
    { id: 'chomper', name: 'Chomper',    colors: ['#ffcc33', '#7cf0a0', '#6fd3ff', '#ff8fd1', '#f2f2f2'] },
    { id: 'shark',   name: 'Shark',      colors: ['#8fb0d8', '#e6edf5', '#e0a35a', '#41e0f0', '#ff6b8b'] },
    { id: 'bear',    name: 'Polar Bear', colors: ['#f4f8ff', '#efe3c8', '#c9d6e8', '#ffd6e8', '#d6f0ff'] },
    { id: 'piranha', name: 'Piranha',    colors: ['#ff5a4a', '#ff9f1c', '#6fa8ff', '#a77bff', '#c0c8d8'] },
    { id: 'croc',    name: 'Croc',       colors: ['#5fbf4a', '#9aa83a', '#3fae8f', '#d8c27a', '#7a8cff'] },
    { id: 'wolf',    name: 'Wolf',       colors: ['#b8c0cc', '#8a7562', '#ece6dc', '#6a7488', '#c88f55'] },
    { id: 'dino',    name: 'Dino',       colors: ['#7ee081', '#ff8a3d', '#5fb4ff', '#c77dff', '#e0c070'] },
    { id: 'whale',   name: 'Whale',      colors: ['#4d8bff', '#6fd3ff', '#8fa8c8', '#5fd4b0', '#ff9ad5'] },
    { id: 'dragon',  name: 'Dragon',     colors: ['#ff4d4d', '#3ddc84', '#4d7cff', '#b06bff', '#ffcc33'] },
    { id: 'gem',     name: 'Gem',        colors: ['#ff4d6d', '#3ddc84', '#4d7cff', '#b06bff', '#ffc24d'] }
  ];
  const PREMIUM = [
    { id: 'rainbow', name: 'Rainbow',   at: 10, base: '#ff5fd2' },
    { id: 'gold',    name: 'Gold Rush', at: 20, base: '#ffcc33' },
    { id: 'plasma',  name: 'Plasma',    at: 30, base: '#41e0f0' },
    { id: 'galaxy',  name: 'Galaxy',    at: 40, base: '#8a5cff' },
    { id: 'prism',   name: 'Prism',     at: 50, base: '#f4f6ff' }
  ];
  const COLOURS_PER_MODEL = 5 + PREMIUM.length;
  /** Levels that must be cleared to use character i / colour k (0-based). */
  const modelUnlock = i => (i | 0) <= 0 ? 0 : (i | 0) + 1;
  const colourUnlock = k => (k | 0) <= 0 ? 0 : (k | 0) < 5 ? (k | 0) + 1 : PREMIUM[(k | 0) - 5].at;
  /** Validated choice. col is a plain hex for lists and glows; paint is what the character is drawn with. */
  const pickModel = (mdl, ci) => {
    const i = (mdl | 0) >= 0 && (mdl | 0) < MODELS.length ? mdl | 0 : 0;
    const k = (ci | 0) >= 0 && (ci | 0) < COLOURS_PER_MODEL ? ci | 0 : 0;
    const m = MODELS[i], prem = k >= 5 ? PREMIUM[k - 5] : null;
    return { mdl: i, ci: k, col: prem ? prem.base : m.colors[k], paint: prem ? 'p:' + prem.id : m.colors[k] };
  };

  /* Power-ups from loot crates (level 3 onwards). dur in seconds (0 = instant).
     weight sets how often each comes up; the nuke is rare. */
  const POWERUPS = [
    { id: 'megaghost',  name: 'Mega Ghost',       good: false, dur: 15, weight: 10, desc: 'The ghosts grow to twice their size' },
    { id: 'nuke',       name: 'Nuke',             good: true,  dur: 0,  weight: 3,  desc: 'Survive until the nuke arrives. Then the whole maze goes. Level passed!' },
    { id: 'reverse',    name: 'Reverse Controls', good: false, dur: 6, weight: 10, desc: 'Controls reversed for everyone for 6 s' },
    { id: 'laser',      name: 'Laser Beamz',      good: true,  dur: 10, weight: 10, desc: 'Everyone fires a laser for 10 s: it eats pellets and zaps ghosts' },
    { id: 'megapellet', name: 'Mega Pellet',      good: true,  dur: 10, weight: 10, desc: 'Every ghost turns blue for 10 s' },
    { id: 'bomb',       name: 'Just A Lil Bomb',  good: true,  dur: 0,  weight: 10, desc: 'Every ghost is blown back to the box' },
    { id: 'quake',      name: 'EARTHQUAKE',       good: false, dur: 7,  weight: 10, desc: 'The whole maze shakes for 7 s' },
    { id: 'unplugged',  name: 'Controller Died',  good: false, dur: 3,  weight: 10, desc: 'Nobody can move for 3 s' },
    { id: 'autopilot',  name: 'Autopilot',        good: true,  dur: 10, weight: 10, desc: 'Your browser plays for you for 10 s' },
    { id: 'phone',      name: 'Phone A Ghost',    good: false, dur: 20, weight: 10, desc: 'An extra ghost joins for 20 s' }
  ];
  const POWERUP_FROM_LEVEL = 3;
  const PU_SPIN = 1.6, PU_HOLD = 2.0;   // slot spins, then shows the result this long before play resumes
  const NUKE_WARN = 10;    // seconds everyone has to survive after the slot lands
  const NUKE_TIME = 7.0;   // the jet, the drop and the blast (everything paused)
  function rollPowerup(rnd = Math.random) {
    const total = POWERUPS.reduce((n, p) => n + p.weight, 0);
    let r = rnd() * total;
    for (let i = 0; i < POWERUPS.length; i++) { r -= POWERUPS[i].weight; if (r < 0) return i; }
    return POWERUPS.length - 1;
  }

  // Level rules
  const levelSize = L => [Math.min(15 + 4 * (L - 1), 63), Math.min(11 + 4 * (L - 1), 51)];
  const ghostCount = L => Math.min(1 + Math.floor(L / 2), 6);
  // Everything that moves gets 10% faster with each completed level (compounding).
  const speedMult = L => Math.pow(1.1, Math.max(0, L - 1));
  const playerSpeed = L => 5.2 * speedMult(L);
  const ghostSpeed = L => 3.6 * speedMult(L);          // chasing / scattering
  const frightGhostSpeed = L => 2.4 * speedMult(L);    // blue
  const eyesSpeed = L => 9 * speedMult(L);             // eaten, heading home
  const frightDuration = L => Math.max(2.5, 7 - 0.45 * (L - 1));

  /* Tiles: 0 path, 1 wall, 2 ghost door, 3 ghost-house floor.
     Pellets: 0 none, 1 dot, 2 power pellet. */
  const cache = new Map();
  function genLevel(seed, L) {
    const key = seed + '|' + L;
    if (cache.has(key)) return cache.get(key);
    const rnd = mulberry32(xmur3(key)());
    const [W, H] = levelSize(L);
    const t = new Uint8Array(W * H).fill(1);
    const mid = (W - 1) / 2, cy = (H - 1) / 2, I = (x, y) => y * W + x;

    // 1. Perfect maze on the left half (cells on odd coordinates).
    const st = [[1, 1]]; t[I(1, 1)] = 0;
    while (st.length) {
      const [x, y] = st[st.length - 1], o = [];
      for (const [dx, dy] of DIRS) {
        const nx = x + 2 * dx, ny = y + 2 * dy;
        if (nx >= 1 && nx <= mid && ny >= 1 && ny <= H - 2 && t[I(nx, ny)] === 1) o.push([dx, dy]);
      }
      if (!o.length) { st.pop(); continue; }
      const [dx, dy] = o[rnd() * o.length | 0];
      t[I(x + dx, y + dy)] = 0; t[I(x + 2 * dx, y + 2 * dy)] = 0; st.push([x + 2 * dx, y + 2 * dy]);
    }
    // 2. Mirror into the right half.
    for (let y = 0; y < H; y++) for (let x = 0; x < mid; x++) t[I(W - 1 - x, y)] = t[I(x, y)];
    const set = (x, y, v) => { t[I(x, y)] = v; t[I(W - 1 - x, y)] = v; };
    // 3. Ghost house, ringed by a corridor.
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = mid - 4; x <= mid + 4; x++) t[I(x, y)] = 0;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = mid - 3; x <= mid + 3; x++) t[I(x, y)] = 1;
    for (let x = mid - 2; x <= mid + 2; x++) t[I(x, cy)] = 3;
    t[I(mid, cy - 1)] = 2;
    const inHouse = (x, y) => x >= mid - 3 && x <= mid + 3 && y >= cy - 1 && y <= cy + 1;
    const open = (x, y) => x >= 0 && x < W && y >= 0 && y < H && t[I(x, y)] === 0;
    const deg = (x, y) => { let n = 0; for (const [dx, dy] of DIRS) if (open(x + dx, y + dy)) n++; return n; };
    // 4. Extra loops, more in bigger mazes.
    const extra = Math.floor(W * H / 70);
    for (let k = 0, tries = 0; k < extra && tries < extra * 30; tries++) {
      const x = 1 + (rnd() * mid | 0), y = 1 + (rnd() * (H - 2) | 0);
      if (x > mid || ((x + y) & 1) === 0 || t[I(x, y)] !== 1 || inHouse(x, y)) continue;
      const ok = (x & 1) ? (open(x, y - 1) && open(x, y + 1)) : (open(x - 1, y) && open(x + 1, y));
      if (!ok) continue; set(x, y, 0); k++;
    }
    // 5. Braid: remove every dead end.
    for (let y = 1; y < H - 1; y += 2) for (let x = 1; x <= mid; x += 2) {
      if (!open(x, y) || deg(x, y) > 1) continue;
      const c = [];
      for (const [dx, dy] of DIRS) {
        const wx = x + dx, wy = y + dy, nx = x + 2 * dx, ny = y + 2 * dy;
        if (nx < 1 || nx > W - 2 || ny < 1 || ny > H - 2) continue;
        if (t[I(wx, wy)] !== 1 || inHouse(wx, wy) || !open(nx, ny)) continue;
        c.push([wx, wy, deg(nx, ny)]);
      }
      if (!c.length) continue;
      const de = c.filter(q => q[2] <= 1), pool = de.length ? de : c, p = pool[rnd() * pool.length | 0];
      set(p[0], p[1], 0);
    }
    // 6. Wrap-around tunnel from level 2.
    if (L >= 2) { t[I(0, cy)] = 0; t[I(W - 1, cy)] = 0; }
    // 7. Keep only tiles reachable from the spawn point.
    const sx = mid, sy = cy + 2, seen = new Uint8Array(W * H), q = [I(sx, sy)]; seen[q[0]] = 1;
    while (q.length) {
      const i = q.pop(), x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = (x + dx + W) % W, ny = y + dy; if (ny < 0 || ny >= H) continue;
        const j = I(nx, ny); if (!seen[j] && t[j] === 0) { seen[j] = 1; q.push(j); }
      }
    }
    for (let i = 0; i < W * H; i++) if (t[i] === 0 && !seen[i]) t[i] = 1;
    // 8. Pellets.
    const p = new Uint8Array(W * H), pList = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = I(x, y); if (t[i] !== 0 || x === 0 || x === W - 1 || (x === sx && y === sy)) continue; p[i] = 1;
    }
    const pw = [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]]; if (L >= 3) pw.push([mid, 1], [mid, H - 2]);
    for (const [x, y] of pw) if (t[I(x, y)] === 0) p[I(x, y)] = 2;
    for (let i = 0; i < W * H; i++) if (p[i]) pList.push(i);
    const lv = { L, W, H, t, p, pList, mid, cy, sx, sy, hue: (228 + (L - 1) * 47) % 360, bytes: Math.ceil(W * H / 8) };
    if (cache.size > 64) cache.clear();
    cache.set(key, lv); return lv;
  }

  const wrapX = (lv, x) => (x + lv.W) % lv.W;
  function canGo(lv, x, y, d) {
    if (d < 0) return false;
    const nx = wrapX(lv, x + DIRS[d][0]), ny = y + DIRS[d][1];
    if (ny < 0 || ny >= lv.H) return false;
    return lv.t[ny * lv.W + nx] === 0;
  }
  const entPos = e => e.d >= 0 ? [e.tx + DIRS[e.d][0] * e.t, e.ty + DIRS[e.d][1] * e.t] : [e.tx, e.ty];

  // Bitsets (pellets eaten) and base64.
  const getBit = (u, i) => (u[i >> 3] >> (i & 7)) & 1;
  const setBit = (u, i) => { u[i >> 3] |= 1 << (i & 7); };
  function toB64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    let s = ''; for (let i = 0; i < u8.length; i += 0x2000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x2000));
    return btoa(s);
  }
  function fromB64(str, len) {
    const o = new Uint8Array(len);
    try {
      if (typeof Buffer !== 'undefined') { const b = Buffer.from(str, 'base64'); o.set(b.subarray(0, len)); }
      else { const s = atob(str); for (let i = 0; i < Math.min(len, s.length); i++) o[i] = s.charCodeAt(i); }
    } catch (e) { /* empty set */ }
    return o;
  }

  return { DIRS, POWERUPS, POWERUP_FROM_LEVEL, PU_SPIN, PU_HOLD, NUKE_WARN, NUKE_TIME, rollPowerup, MODELS, PREMIUM, COLOURS_PER_MODEL, modelUnlock, colourUnlock, pickModel, slug, randomSeed, levelSize, ghostCount, speedMult, playerSpeed, ghostSpeed, frightGhostSpeed, eyesSpeed, frightDuration,
    genLevel, wrapX, canGo, entPos, getBit, setBit, toB64, fromB64 };
});
