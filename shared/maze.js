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
    { id: 'shark',   name: 'Shark',      colors: ['#41e0f0', '#8fb0d8', '#e6edf5', '#ff6b8b', '#e0a35a'] },
    { id: 'chomper', name: 'Chomper',    colors: ['#ffcc33', '#7cf0a0', '#6fd3ff', '#ff8fd1', '#f2f2f2'] },
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
    { id: 'phone',      name: 'Phone A Ghost',    good: false, dur: 20, weight: 10, desc: 'An extra ghost joins for 20 s' },
    { id: 'hacker',     name: 'Hacker',           good: true,  dur: 10, weight: 9,  desc: 'Ghosts are hacked for 10 s: they eat pellets as they roam' },
    { id: 'magnet',     name: 'Magnet',           good: true,  dur: 10, weight: 9,  desc: 'Pellets near you fly into your mouth for 10 s' },
    { id: 'swap',       name: 'Ghost Swap',       good: true,  dur: 0,  weight: 7,  desc: 'You swap places with the nearest ghost' },
    { id: 'freeze',     name: 'Freeze',           good: true,  dur: 6,  weight: 9,  desc: 'Ghosts are frozen in ice for 6 s (and harmless)' },
    { id: 'shrink',     name: 'Shrink',           good: true,  dur: 8,  weight: 8,  desc: 'Everyone shrinks for 8 s: too small for ghosts or fireballs to catch' },
    { id: 'fog',        name: 'Fog of War',       good: false, dur: 10, weight: 8,  desc: 'Thick fog for 10 s: you only see a little way around you' }
  ];
  const POWERUP_FROM_LEVEL = 3;
  const VOTE_TIME = 8;   // seconds everyone gets to vote on opening a crate
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
  // Speed: everything gets 5% faster per completed level up to level 10, then players gain
  // 1% a level. From level 10 ghosts also close the gap on players by 0.5% a level
  // (so they speed up ~1.5% a level) until they are exactly as fast as players.
  const SPEED_STEP = 0.05, LATE_FROM = 10, LATE_STEP = 0.01, GHOST_CATCHUP = 0.005;
  const PLAYER_BASE = 5.2, GHOST_BASE = 3.6;
  const lateLevels = L => Math.max(0, Math.max(1, L) - LATE_FROM);
  const speedMult = L => Math.pow(1 + SPEED_STEP, Math.min(Math.max(1, L), LATE_FROM) - 1) * Math.pow(1 + LATE_STEP, lateLevels(L));
  /** Ghost speed as a multiple of its level-1 speed, capped so ghosts never outrun players. */
  const ghostMult = L => Math.min(speedMult(L) * Math.pow(1 + GHOST_CATCHUP, lateLevels(L)), speedMult(L) * PLAYER_BASE / GHOST_BASE);
  /** The speed increase going from level L to L + 1, e.g. 0.05 or 0.01. */
  const speedStep = L => speedMult(L + 1) / speedMult(L) - 1;
  const playerSpeed = L => PLAYER_BASE * speedMult(L);
  const ghostSpeed = L => GHOST_BASE * ghostMult(L);         // chasing / scattering
  const frightGhostSpeed = L => 2.4 * ghostMult(L);          // blue
  const eyesSpeed = L => 9 * ghostMult(L);                   // eaten, heading home
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

  // Bonus fruit: appears in the middle of the maze at 30% and 70% of pellets eaten, for a few seconds.
  const FRUITS = [
    { id: 'cherry', name: 'Cherries', pts: 100 }, { id: 'strawberry', name: 'Strawberry', pts: 300 },
    { id: 'orange', name: 'Orange', pts: 500 }, { id: 'apple', name: 'Apple', pts: 700 },
    { id: 'melon', name: 'Melon', pts: 1000 }, { id: 'grapes', name: 'Grapes', pts: 2000 },
    { id: 'pear', name: 'Pear', pts: 3000 }, { id: 'starfruit', name: 'Star fruit', pts: 5000 }
  ];
  const fruitFor = L => Math.min(FRUITS.length - 1, Math.floor((Math.max(1, L) - 1) / 2));
  const FRUIT_TIME = 9.5;
  // Every 10th level is a boss level: one giant ghost with 3 hits and a few minions.
  const isBossLevel = L => L > 0 && L % 10 === 0;
  const BOSS_HP = 3;
  // Achievements, earned by players logged in with Discord (shown on their profile card).
  const ACHIEVEMENTS = [
    { id: 'first',     name: 'First Clear',  desc: 'Clear a level' },
    { id: 'level10',   name: 'Ten Down',     desc: 'Clear level 10' },
    { id: 'level25',   name: 'Deep Diver',   desc: 'Clear level 25' },
    { id: 'streak100', name: 'Unstoppable',  desc: 'Hit a 100 pellet streak' },
    { id: 'quad',      name: 'Clean Sweep',  desc: 'Eat 4 ghosts from one big pellet' },
    { id: 'nuke',      name: 'Survivor',     desc: 'Survive a Nuke countdown' },
    { id: 'teamwork',  name: 'Teamwork',     desc: 'High five another player' },
    { id: 'revive',    name: 'Lifesaver',    desc: 'Revive a teammate' },
    { id: 'boss',      name: 'Boss Slayer',  desc: 'Help defeat a boss ghost' },
    { id: 'fruit',     name: 'Fruit Picker', desc: 'Grab a bonus fruit' },
    { id: 'daily',     name: 'Daily Driver', desc: 'Set a score on the daily maze' },
    { id: 'versus',    name: 'Champion',     desc: 'Win a versus level' },
    { id: 'chal',      name: 'Challenger',   desc: 'Complete a daily challenge' },
    { id: 'chalw',     name: 'Week Warrior', desc: 'Complete a weekly challenge' },
    { id: 'plevel10',  name: 'Rising Star',  desc: 'Reach player level 10' },
    { id: 'plevel25',  name: 'Veteran',      desc: 'Reach player level 25' }
  ];
  /* ---------- player levels (Discord accounts) ----------
     XP comes from playing; reaching level n takes 50·n·(n-1) XP in total (level 2 at 100,
     level 10 at 4,500, level 50 at 122,500). Achievements and challenges pay big chunks. */
  const XP = { pellet: 1, ghost: 25, boss: 100, fruit: 50, crate: 20, highfive: 10, revive: 60, clear: L => 100 + 10 * L, ach: 250, daily: 150, weekly: 500 };
  const MAX_PLEVEL = 100;
  const xpFor = n => 50 * n * (n - 1);   // total XP needed to reach player level n
  function playerLevel(xp) { let n = 1; while (n < MAX_PLEVEL && xp >= xpFor(n + 1)) n++; return n; }
  /* Cosmetics unlocked by player level: a trail behind you and how you go when you're caught. */
  const TRAILS = [
    { id: 'glow',      name: 'Glow',         at: 1 },
    { id: 'sparks',    name: 'Sparks',       at: 2 },
    { id: 'ribbon',    name: 'Neon ribbon',  at: 5 },
    { id: 'rainbow',   name: 'Rainbow wake', at: 10 },
    { id: 'bubbles',   name: 'Bubbles',      at: 15 },
    { id: 'pixels',    name: 'Pixel stream', at: 20 },
    { id: 'comet',     name: 'Comet',        at: 30 },
    { id: 'stardust',  name: 'Stardust',     at: 40 },
    { id: 'lightning', name: 'Lightning',    at: 50 }
  ];
  const DEATHFX = [
    { id: 'pop',       name: 'Pop',            at: 1 },
    { id: 'shatter',   name: 'Pixel shatter',  at: 3 },
    { id: 'confetti',  name: 'Confetti',       at: 8 },
    { id: 'blackhole', name: 'Black hole',     at: 12 },
    { id: 'firework',  name: 'Firework',       at: 18 },
    { id: 'glitch',    name: 'Glitch',         at: 25 },
    { id: 'ghostly',   name: 'Ghostly rise',   at: 35 }
  ];
  /** Index of a cosmetic the player may use at this level (0 if locked or unknown). */
  const pickCosmetic = (list, i, plevel) => ((i | 0) > 0 && (i | 0) < list.length && list[i | 0].at <= (plevel | 0) ? i | 0 : 0);
  /* Daily and weekly challenges: three of each, the same for everyone, picked from the period's key.
     sum: add up over the period; max: best single value. d / w: the goal for a daily / weekly (0 = not used). */
  const CHALLENGES = [
    { id: 'pellets',  stat: 'pellets',  kind: 'sum', d: 1500, w: 10000, text: n => 'Eat ' + n.toLocaleString('en') + ' pellets' },
    { id: 'ghosts',   stat: 'ghosts',   kind: 'sum', d: 15,   w: 100,   text: n => 'Eat ' + n + ' ghosts' },
    { id: 'clears',   stat: 'clears',   kind: 'sum', d: 5,    w: 30,    text: n => 'Clear ' + n + ' levels' },
    { id: 'deep',     stat: 'deep',     kind: 'max', d: 6,    w: 12,    text: n => 'Clear level ' + n + ' or higher' },
    { id: 'fruit',    stat: 'fruit',    kind: 'sum', d: 3,    w: 15,    text: n => 'Grab ' + n + ' bonus fruits' },
    { id: 'crates',   stat: 'crates',   kind: 'sum', d: 3,    w: 20,    text: n => 'Find ' + n + ' loot crates' },
    { id: 'highfive', stat: 'highfive', kind: 'sum', d: 5,    w: 25,    text: n => 'High five other players ' + n + ' times' },
    { id: 'streak',   stat: 'streak',   kind: 'max', d: 60,   w: 150,   text: n => 'Hit a ×' + n + ' pellet streak' },
    { id: 'revive',   stat: 'revive',   kind: 'sum', d: 0,    w: 8,     text: n => 'Revive teammates ' + n + ' times' },
    { id: 'boss',     stat: 'boss',     kind: 'sum', d: 0,    w: 6,     text: n => 'Land ' + n + ' hits on boss ghosts' },
    { id: 'versus',   stat: 'versus',   kind: 'sum', d: 0,    w: 10,    text: n => 'Win ' + n + ' versus levels' },
    { id: 'dailyrun', stat: 'dailyrun', kind: 'sum', d: 1,    w: 4,     text: n => n === 1 ? 'Set a score on the daily maze' : 'Set a score on the daily maze on ' + n + ' days' }
  ];
  /** The challenges for a period key ('day:2026-11-08' or 'week:2026-W45'): [{ id, stat, kind, goal, text }]. */
  function challengesFor(period, n = 3) {
    const weekly = String(period).startsWith('week:'), rnd = mulberry32(xmur3('chal|' + period)());
    const pool = CHALLENGES.filter(c => (weekly ? c.w : c.d) > 0).slice(), out = [];
    while (out.length < n && pool.length) {
      const c = pool.splice(rnd() * pool.length | 0, 1)[0], goal = weekly ? c.w : c.d;
      out.push({ id: c.id, stat: c.stat, kind: c.kind, goal, text: c.text(goal) });
    }
    return out;
  }

  /* ---------- maze themes: a new look every 10 levels (then round again) ---------- */
  const THEMES = [
    { id: 'neon',  name: 'Neon City',     sub: 'Where it all starts',             hue: L => (228 + (L - 1) * 47) % 360, sat: 85, pellet: '#ffdcae', floor: 'rgba(6,7,20,0.86)',   fx: 'none' },
    { id: 'ice',   name: 'Ice Caverns',   sub: 'Mind the cold',                   hue: L => 186 + (L % 10) * 2,         sat: 90, pellet: '#d8f6ff', floor: 'rgba(5,16,30,0.88)',  fx: 'snow' },
    { id: 'lava',  name: 'Lava Core',     sub: 'It’s getting hot in here',        hue: L => 8 + (L % 10) * 2,           sat: 95, pellet: '#ffd27a', floor: 'rgba(26,6,4,0.88)',   fx: 'embers' },
    { id: 'deep',  name: 'Deep Sea',      sub: 'Something big lives down here',   hue: L => 162 + (L % 10) * 2,         sat: 80, pellet: '#a5ffe3', floor: 'rgba(3,18,24,0.88)',  fx: 'bubbles' },
    { id: 'space', name: 'Space Station', sub: 'No one can hear you munch',       hue: L => 268 + (L % 10) * 3,         sat: 70, pellet: '#ffffff', floor: 'rgba(4,4,12,0.9)',    fx: 'stars' }
  ];
  const themeFor = L => THEMES[Math.floor((Math.max(1, L) - 1) / 10) % THEMES.length];
  /* ---------- challenge modifiers: the host picks them in the lobby; each adds to the score ---------- */
  const MODS = [
    { bit: 1, id: 'onelife', name: 'One life',       bonus: 0.5,  desc: 'One life each, and no extra lives between levels' },
    { bit: 2, id: 'fast',    name: 'Fast ghosts',    bonus: 0.25, desc: 'Ghosts move 25% faster' },
    { bit: 4, id: 'nobig',   name: 'No big pellets', bonus: 0.25, desc: 'Big pellets are just pellets: no turning the tables' },
    { bit: 8, id: 'fog',     name: 'Fog',            bonus: 0.25, desc: 'Thick fog all game: you only see a little way around you' }
  ];
  const MODS_ALL = MODS.reduce((n, m) => n | m.bit, 0);
  const FAST_GHOSTS = 1.25;
  /** Score multiplier for a set of modifiers, e.g. 1.75. */
  const modMult = mods => 1 + MODS.reduce((s, m) => s + ((mods & m.bit) ? m.bonus : 0), 0);
  /* ---------- co-op roles (the host turns them on) ---------- */
  const ROLES = [
    { id: 'none',  name: 'No role', desc: 'Just you' },
    { id: 'scout', name: 'Scout',   desc: '10% faster, and sees further in fog' },
    { id: 'tank',  name: 'Tank',    desc: 'Shrugs off one ghost hit each level' },
    { id: 'medic', name: 'Medic',   desc: 'Revives fallen teammates from much further away' }
  ];
  const SCOUT_SPEED = 1.1, MEDIC_REACH = 3.2;

  return { THEMES, themeFor, MODS, MODS_ALL, FAST_GHOSTS, modMult, ROLES, SCOUT_SPEED, MEDIC_REACH, XP, MAX_PLEVEL, xpFor, playerLevel, TRAILS, DEATHFX, pickCosmetic, CHALLENGES, challengesFor, FRUITS, fruitFor, FRUIT_TIME, isBossLevel, BOSS_HP, ACHIEVEMENTS, DIRS, POWERUPS, POWERUP_FROM_LEVEL, VOTE_TIME, SPEED_STEP, PU_SPIN, PU_HOLD, NUKE_WARN, NUKE_TIME, rollPowerup, MODELS, PREMIUM, COLOURS_PER_MODEL, modelUnlock, colourUnlock, pickModel, slug, randomSeed, levelSize, ghostCount, speedMult, ghostMult, speedStep, playerSpeed, ghostSpeed, frightGhostSpeed, eyesSpeed, frightDuration,
    genLevel, wrapX, canGo, entPos, getBit, setBit, toB64, fromB64 };
});
