/* Munch Maze audio: an original electro track and arcade sound effects,
   synthesised live with the Web Audio API (no audio files).

   MazeAudio.unlock()            call from a click/keypress (browsers require it)
   MazeAudio.startMusic(level)   start or retune the track for a level
   MazeAudio.stopMusic()
   MazeAudio.setFright(bool)     filter sweep while ghosts are blue
   MazeAudio.setMusicVolume(0..1), setSfxVolume(0..1)
   MazeAudio.sfx(name)           eat | power | ghost | die | clear | life | start | over | respawn | join
*/
(function () {
'use strict';
const AC = window.AudioContext || window.webkitAudioContext;
let ctx = null, master, musicBus, musicFilter, sfxBus, noiseBuf, delaySend, tracks;
let musicVol = 0.1, sfxVol = 0.4;

// Slider position -> gain. A gentle curve so the low end of the slider stays usable.
const curve = v => Math.pow(Math.max(0, Math.min(1, v)), 1.3);
// The full mix peaks around 1.4 before this trim, so 100% music stays clean.
const MUSIC_TRIM = 0.6;

function build() {
  ctx = new AC();
  master = ctx.createDynamicsCompressor();
  master.threshold.value = -10; master.knee.value = 6; master.ratio.value = 4;
  master.attack.value = 0.003; master.release.value = 0.2;
  master.connect(ctx.destination);

  musicFilter = ctx.createBiquadFilter(); musicFilter.type = 'lowpass'; musicFilter.frequency.value = 18000; musicFilter.Q.value = 0.7;
  musicBus = ctx.createGain(); musicBus.gain.value = curve(musicVol) * MUSIC_TRIM;
  musicFilter.connect(musicBus); musicBus.connect(master);

  sfxBus = ctx.createGain(); sfxBus.gain.value = curve(sfxVol); sfxBus.connect(master);

  // Each track plays into its own channel with its own dotted-eighth echo, so switching
  // tracks can silence everything the outgoing one still has queued, sustained or echoing.
  const track = () => {
    const bus = ctx.createGain(); bus.connect(musicFilter);
    const d = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3200; fb.gain.value = 0.38; wet.gain.value = 0.35;
    const send = ctx.createGain(); send.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(bus);
    send._delay = d;
    return { bus, send };
  };
  tracks = { normal: track(), boss: track() };
  tracks.boss.bus.gain.value = 0;
  delaySend = tracks.normal.send;

  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  loadSample('highfive', 'sounds/high-five.mp3');
}

function unlock() {
  if (!AC) return false;
  if (!ctx) { try { build(); } catch (e) { ctx = null; return false; } }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return true;
}
const ready = () => ctx && ctx.state !== 'closed';
const hz = m => 440 * Math.pow(2, (m - 69) / 12);

/* ---------- building blocks ---------- */
function env(g, t, a, peak, dec, sus = 0.0001, hold = 0) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  if (hold) g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(Math.max(sus, 0.0001), t + a + hold + dec);
}
function tone(dest, { type = 'square', f, f2, t, dur, vol = 0.2, a = 0.004, detune = 0, filter }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); o.detune.value = detune;
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  env(g, t, a, vol, dur);
  let out = o;
  if (filter) { const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.setValueAtTime(filter[0], t); if (filter[1]) fl.frequency.exponentialRampToValueAtTime(filter[1], t + dur); fl.Q.value = filter[2] || 1; o.connect(fl); out = fl; }
  out.connect(g); g.connect(dest);
  o.start(t); o.stop(t + a + dur + 0.05);
  return o;
}
function noise(dest, { t, dur, vol, type = 'highpass', freq = 7000, q = 0.8 }) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
  env(g, t, 0.001, vol, dur);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}

/* ---------- the track ----------
   Neon synthwave, ~112 BPM in A minor over an 8-bar progression with sevenths:
   Am7 - Fmaj7 - Cmaj7 - G6 - Dm7 - Am7 - Fmaj7 - E7.
   A 32-bar arrangement builds up: drums, round off-beat bass and a warm pumping pad,
   then a soft plucked arp with echo, then a sung-style lead melody. No square waves,
   gentle hats, so it sits under the game instead of buzzing over it.
   Each level shifts the key and nudges the tempo up a little. */
const PROG = [[57, 60, 64, 67], [53, 57, 60, 64], [52, 55, 59, 60], [55, 59, 62, 64],
              [53, 57, 60, 62], [55, 57, 60, 64], [53, 57, 60, 64], [52, 56, 59, 62]];   // chord tones (MIDI)
const BASS = [45, 41, 48, 43, 50, 45, 41, 40];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3];   // 8th-note pattern, index into the chord (an octave up)
// lead melody, one entry per bar: [step, MIDI note, length in 16ths]
const MELODY = [
  [[0, 76, 6], [6, 74, 2], [8, 72, 4], [12, 69, 4]],
  [[0, 72, 4], [4, 69, 2], [6, 72, 2], [8, 76, 8]],
  [[0, 79, 6], [6, 76, 2], [8, 74, 4], [12, 72, 4]],
  [[0, 74, 8], [8, 71, 4]],
  [[0, 69, 4], [4, 72, 2], [6, 74, 2], [8, 77, 6], [14, 76, 2]],
  [[0, 76, 4], [4, 74, 2], [6, 72, 2], [8, 69, 8]],
  [[0, 72, 4], [4, 74, 4], [8, 76, 4], [12, 79, 4]],
  [[0, 71, 6], [6, 74, 2], [8, 71, 4], [12, 68, 4]]
];
const KEYS = [0, 3, -2, 5, 2, -4, 7];
let music = { mode: 'normal', baseBpm: 112, on: false, step: 0, next: 0, bpm: 112, trans: 0, pendingTrans: 0, timer: 0, bar: 0, pad: null, kicks: [] };

function stepDur() { return 60 / music.bpm / 4; }
function kick(t, vol, track = true) {
  if (track) { music.kicks.push(t); if (music.kicks.length > 8) music.kicks.shift(); }
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
  env(g, t, 0.002, vol, 0.32); o.connect(g); g.connect(tracks[music.mode].bus); o.start(t); o.stop(t + 0.4);
  if (music.pad) { const pg = music.pad.gain, sd = stepDur(); pg.cancelScheduledValues(t); pg.setValueAtTime(0.012, t); pg.linearRampToValueAtTime(music.mode === 'boss' ? 0.045 : 0.05, t + sd * 3); }
}

/* ---------- boss fight ----------
   While ghosts are blue: about 20% faster, E phrygian with a tritone turn
   (E - F - E - Bb), driving distorted 16th bass, syncopated power-chord stabs,
   a diminished arp, a two-tone alarm lead and snare rolls. */
const BOSS_ROOTS = [40, 41, 40, 46];
const BOSS_BASS = [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 1, 12, 0];
const BOSS_STABS = [0, 3, 6, 10, 13];
const DIM = [0, 3, 6, 9];
let bossDist = null;
function distCurve(k) { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)); } return c; }
function ensureBossChain() {
  if (bossDist) return;
  bossDist = ctx.createWaveShaper(); bossDist.curve = distCurve(18); bossDist.oversample = '2x';
  const trim = ctx.createGain(); trim.gain.value = 0.55; bossDist.connect(trim); trim.connect(tracks.boss.bus);
}
function schedBoss(s, t) {
  const bar = music.bar, root = BOSS_ROOTS[bar % 4] + music.trans, sd = stepDur();
  // drums: four on the floor plus pushes, claps, 16th hats, a roll into every 4th bar
  if (s % 4 === 0) kick(t, 1.0);
  else if (s === 14 || (s === 7 && bar % 2)) kick(t, 0.7, false);
  if (s === 4 || s === 12) { noise(tracks.boss.bus, { t, dur: 0.14, vol: 0.34, type: 'bandpass', freq: 1700, q: 0.9 }); noise(tracks.boss.bus, { t: t + 0.01, dur: 0.08, vol: 0.2, type: 'bandpass', freq: 3200, q: 1.2 }); }
  if (bar % 4 === 3 && s >= 12) { noise(tracks.boss.bus, { t, dur: 0.05, vol: 0.2 + (s - 12) * 0.05, type: 'bandpass', freq: 1900, q: 1 }); noise(tracks.boss.bus, { t: t + sd / 2, dur: 0.05, vol: 0.2 + (s - 12) * 0.05, type: 'bandpass', freq: 1900, q: 1 }); }
  noise(tracks.boss.bus, { t, dur: s % 4 === 2 ? 0.08 : 0.02, vol: s % 4 === 2 ? 0.13 : 0.06, freq: 9000 });
  // distorted bass on every 16th
  tone(bossDist, { type: 'sawtooth', f: hz(root + BOSS_BASS[s]), t, dur: sd * 0.85, vol: 0.16, filter: [1600, 220, 7] });
  // power-chord stabs
  if (BOSS_STABS.includes(s)) for (const iv of [24, 31, 36]) tone(bossDist, { type: 'square', f: hz(root + iv), t, dur: sd * 0.7, vol: 0.035, detune: iv === 31 ? 7 : -7, filter: [4200, 900, 2] });
  // diminished arp up high, through the echo
  if (bar % 2 === 1 || s >= 8) { const n = root + 48 + DIM[s % 4] + (s >= 8 ? 12 : 0); tone(tracks.boss.bus, { type: 'square', f: hz(n), t, dur: sd * 0.6, vol: 0.03, filter: [6000, 2000, 1] }); tone(tracks.boss.send, { type: 'square', f: hz(n), t, dur: sd * 0.5, vol: 0.02 }); }
  // alarm lead: two notes a semitone apart, wailing, every other bar
  if (bar % 2 === 0 && (s === 0 || s === 8)) {
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(hz(root + (s === 0 ? 36 : 37)), t);
    lfo.frequency.value = 6.5; lg.gain.value = 9; lfo.connect(lg); lg.connect(o.frequency);
    f.type = 'lowpass'; f.frequency.value = 3200; f.Q.value = 3;
    env(g, t, 0.03, 0.045, sd * 7.5, 0.0001, sd * 2);
    o.connect(f); f.connect(g); g.connect(tracks.boss.bus); g.connect(tracks.boss.send);
    o.start(t); lfo.start(t); o.stop(t + sd * 8.5); lfo.stop(t + sd * 8.5);
  }
}
/** The slam when the boss music cuts in. */
function bossImpact(t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.7);
  env(g, t, 0.003, 0.9, 0.8); o.connect(g); g.connect(tracks.boss.bus); o.start(t); o.stop(t + 0.9);
  noise(tracks.boss.bus, { t, dur: 0.45, vol: 0.35, type: 'lowpass', freq: 1200, q: 0.7 });
  tone(bossDist, { type: 'sawtooth', f: hz(52 + music.trans), f2: hz(40 + music.trans), t, dur: 0.5, vol: 0.12, filter: [2500, 300, 3] });
}

/** Soft lead voice: triangle with a quiet sine an octave up, gentle attack, a little vibrato. */
function lead(dest, n, t, dur, vol) {
  const g = ctx.createGain(), f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(1800, t + dur); f.Q.value = 0.5;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
  g.gain.setTargetAtTime(vol * 0.6, t + 0.05, 0.25); g.gain.setTargetAtTime(0.0001, t + dur * 0.92, 0.08);
  const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5.2; vg.gain.value = 0; vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(7, t + Math.min(dur, 0.6));
  vib.connect(vg);
  for (const [type, mul, lvl] of [['triangle', 1, 1], ['sine', 2, 0.25]]) {
    const o = ctx.createOscillator(), og = ctx.createGain(); o.type = type; o.frequency.value = hz(n) * mul; og.gain.value = lvl;
    vg.connect(o.detune); o.connect(og); og.connect(f); o.start(t); o.stop(t + dur + 0.6);
  }
  vib.start(t); vib.stop(t + dur + 0.6);
  f.connect(g); g.connect(dest);
}
function schedStep(s, t) {
  const bar = music.bar, ci = bar % 8, chord = PROG[ci].map(n => n + music.trans), sd = stepDur();
  const part = Math.floor(bar / 8) % 4;   // 0 groove, 1 + arp, 2 + melody, 3 melody + arp
  const bus = tracks.normal.bus, send = tracks.normal.send;
  if (s % 4 === 0) kick(t, 0.8);
  // snare: soft noise burst with a little body on 2 and 4
  if (s === 4 || s === 12) {
    noise(bus, { t, dur: 0.22, vol: 0.13, type: 'bandpass', freq: 1900, q: 0.7 });
    tone(bus, { type: 'triangle', f: 210, f2: 150, t, dur: 0.09, vol: 0.09 });
    noise(send, { t, dur: 0.15, vol: 0.05, type: 'bandpass', freq: 2500, q: 0.8 });
  }
  // hats: closed on the off-beat 8ths, a faint shaker on the rest
  if (s % 4 === 2) noise(bus, { t, dur: 0.05, vol: 0.05, freq: 9500 });
  else if (s % 2 === 1) noise(bus, { t, dur: 0.02, vol: 0.016, freq: 11000 });
  // bass: round off-beat 8ths, root then octave (synthwave gallop)
  if (s % 2 === 0) {
    const n = BASS[ci] + music.trans + (s % 4 === 2 ? 12 : 0);
    tone(bus, { type: 'sawtooth', f: hz(n), t, dur: sd * 1.7, vol: 0.085, filter: [700, 220, 1.5] });
    tone(bus, { type: 'sine', f: hz(n), t, dur: sd * 1.7, vol: 0.12 });
  }
  // plucked arp with echo
  if ((part === 1 || part === 3) && s % 2 === 0) {
    const n = chord[ARP[s / 2]] + 12;
    tone(bus, { type: 'sawtooth', f: hz(n), t, dur: 0.26, vol: 0.068, filter: [3200, 460, 2] });
    tone(send, { type: 'triangle', f: hz(n), t, dur: 0.2, vol: 0.045 });
  }
  // the melody
  if (part >= 2) for (const [st, n, len] of MELODY[ci]) if (st === s) {
    lead(bus, n + music.trans, t, len * sd, 0.06);
    lead(send, n + music.trans, t, len * sd * 0.8, 0.028);
  }
}
function stopPad(t) {
  if (!music.pad) return;
  for (const o of music.pad.oscs) { try { o.stop(t); } catch (e) { /* ignore */ } }
  const node = music.pad.node; setTimeout(() => { try { node.disconnect(); } catch (e) { /* ignore */ } }, 300);
  music.pad = null;
}
function setPad(t) {
  if (music.pad && music.pad.mode !== music.mode) stopPad(t);
  if (!music.pad) {
    const g = ctx.createGain(); g.gain.value = 0.05;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 0.6;
    f.connect(g); g.connect(tracks[music.mode].bus);
    music.pad = { gain: g.gain, node: g, filter: f, oscs: [], mode: music.mode };
  }
  const chord = music.mode === 'boss' ? [0, 7, 12].map(iv => BOSS_ROOTS[music.bar % 4] + 12 + iv + music.trans) : PROG[music.bar % 8].map(n => n + music.trans);
  const old = music.pad.oscs; music.pad.oscs = [];
  for (const n of chord) for (const dt of [-8, 8]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(n); o.detune.value = dt;
    o.connect(music.pad.filter); o.start(t); music.pad.oscs.push(o);
  }
  for (const o of old) { try { o.stop(t); } catch (e) { /* ignore */ } }
}

function scheduler() {
  if (!music.on || !ready()) return;
  const ahead = ctx.currentTime + 0.12;
  while (music.next < ahead) {
    if (music.step === 0) { music.trans = music.pendingTrans; setPad(music.next); }
    if (music.mode === 'boss') schedBoss(music.step, music.next); else schedStep(music.step, music.next);
    music.next += stepDur();
    music.step = (music.step + 1) % 16;
    if (music.step === 0) music.bar++;
  }
}
function startMusic(level = 1) {
  custom.level = level;
  if (custom.url) { if (ready()) playCustom(); return; }
  if (!unlock()) return;
  clearTimeout(fadeTimer);
  if (!music.on) { const g = musicBus.gain; g.cancelScheduledValues(ctx.currentTime); g.setValueAtTime(curve(musicVol) * MUSIC_TRIM, ctx.currentTime); }
  music.baseBpm = 112 + Math.min(14, (level - 1) * 1.5);
  music.bpm = music.mode === 'boss' ? bossBpm() : music.baseBpm;
  music.pendingTrans = KEYS[(level - 1) % KEYS.length];
  setDelays();
  if (music.on) return;   // retune at the next bar
  music.on = true; music.step = 0; music.bar = 0; music.trans = music.pendingTrans;
  music.next = ctx.currentTime + 0.06;
  musicFilter.frequency.cancelScheduledValues(ctx.currentTime);
  musicFilter.frequency.setValueAtTime(18000, ctx.currentTime);
  clearInterval(music.timer); music.timer = setInterval(scheduler, 25); scheduler();
}
/** 1 on the kick, decaying to 0 before the next beat. Falls back to a 128 BPM clock when the music is off. */
function beat() {
  const beatLen = 60 / music.bpm;
  if (music.on && ready()) {
    const now = ctx.currentTime; let last = -1;
    for (const k of music.kicks) if (k <= now) last = k;
    if (last >= 0) return Math.pow(Math.max(0, 1 - (now - last) / beatLen), 2.2);
  }
  const p = (performance.now() / 1000 / beatLen) % 1; return Math.pow(1 - p, 2.2) * 0.6;
}
let fadeTimer = 0;
/** Fade the music out over `dur` seconds, then stop it (it restarts with the next level). */
function fadeOutMusic(dur = DROP_TIME) {
  if (custom.url) return;   // the custom song carries on into the next level
  if (!ready() || !music.on) return;
  const t = ctx.currentTime, g = musicBus.gain;
  g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0.0001, t + dur);
  clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { stopMusic(); }, dur * 1000 + 50);
}
/* A custom song (the Peanut easter egg) replaces all background music while it's set.
   It loops through the music channel (so the music slider works) and carries on across
   levels and blue-ghost phases. If the file can't be loaded, the normal music plays. */
const custom = { url: null, buf: null, src: null, gain: null, offset: 0, startedAt: 0, want: false, level: 1, failed: null };
function setCustomTrack(url) {
  if (url === custom.url) return;
  stopCustom(); custom.url = url || null; custom.buf = null;
  if (!url || !ctx) return;
  loadCustom();
}
function loadCustom() {
  const url = custom.url; if (!url || custom.buf || custom.loading === url || custom.failed === url) return;
  custom.loading = url;
  fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(b => new Promise((res, rej) => ctx.decodeAudioData(b, res, rej)))
    .then(buf => { if (custom.url !== url) return; custom.buf = buf; custom.loading = null; if (custom.want) playCustom(); })
    .catch(() => {   // no song on this server: fall back to the normal music
      custom.loading = null; custom.failed = url;
      if (custom.url === url) { custom.url = null; if (custom.want) { custom.want = false; startMusic(custom.level); } }
    });
}
function playCustom() {
  custom.want = true;
  if (!ready() || custom.src) return;
  if (!custom.buf) { loadCustom(); return; }
  const s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = custom.buf; s.loop = true; g.gain.value = 0.0001; g.gain.setTargetAtTime(1.3, ctx.currentTime, 0.3);
  s.connect(g); g.connect(musicFilter);
  const off = custom.offset % custom.buf.duration;
  s.start(ctx.currentTime, off); custom.startedAt = ctx.currentTime - off;
  custom.src = s; custom.gain = g;
  musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setValueAtTime(curve(musicVol) * MUSIC_TRIM, ctx.currentTime);
  musicFilter.frequency.cancelScheduledValues(ctx.currentTime); musicFilter.frequency.setValueAtTime(18000, ctx.currentTime);
}
function stopCustom() {
  custom.want = false;
  if (!custom.src) return;
  if (custom.buf) custom.offset = (ctx.currentTime - custom.startedAt) % custom.buf.duration;   // pick up where it left off
  const s = custom.src, g = custom.gain; custom.src = null; custom.gain = null;
  try { g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08); s.stop(ctx.currentTime + 0.4); } catch (e) { /* ignore */ }
}
function stopMusic() {
  stopCustom();
  clearTimeout(fadeTimer);
  music.on = false; clearInterval(music.timer); music.kicks = []; music.mode = 'normal'; frightOn = false;
  if (tracks) { const t = ctx.currentTime; tracks.boss.bus.gain.cancelScheduledValues(t); tracks.boss.bus.gain.setValueAtTime(0, t); tracks.normal.bus.gain.cancelScheduledValues(t); tracks.normal.bus.gain.setValueAtTime(1, t); }
  if (music.pad && ctx) { const t = ctx.currentTime; music.pad.oscs.forEach(o => { try { o.stop(t + 0.05); } catch (e) { /* ignore */ } }); music.pad.node.disconnect(); music.pad = null; }
}
let frightOn = false;
/** Dotted-eighth echo for each track at its own tempo. */
function setDelays() {
  if (!tracks) return;
  tracks.normal.send._delay.delayTime.setTargetAtTime(60 / music.baseBpm / 4 * 3, ctx.currentTime, 0.02);
  tracks.boss.send._delay.delayTime.setTargetAtTime(60 / bossBpm() / 4 * 3, ctx.currentTime, 0.02);
}
const bossBpm = () => Math.min(176, Math.round(music.baseBpm * 1.2 + 20));   // boss stays fast (~154 at level 1)
/** Ghosts turned blue: cut to the boss track on the very next 16th; back again when they recover. */
function setFright(on) {
  if (custom.url) { frightOn = on; return; }   // the custom song plays straight through
  if (!ready() || on === frightOn) return; frightOn = on;
  ensureBossChain();
  music.mode = on ? 'boss' : 'normal';
  music.bpm = on ? bossBpm() : music.baseBpm;
  setDelays();
  const now = ctx.currentTime, out = tracks[on ? 'normal' : 'boss'].bus.gain, inn = tracks[on ? 'boss' : 'normal'].bus.gain;
  // silence the outgoing track at once (its queued notes, pad and echoes go with it)
  out.cancelScheduledValues(now); out.setValueAtTime(out.value, now); out.linearRampToValueAtTime(0, now + 0.025);
  inn.cancelScheduledValues(now); inn.setValueAtTime(1, now);
  if (!music.on) return;
  stopPad(now + 0.03);
  music.next = now + 0.03;   // drop the old track's lookahead; the new one starts on this step
  if (on) bossImpact(music.next);
  setPad(music.next);
}

/* ---------- sound effects ---------- */
let wakaFlip = false, lastWaka = 0, lastOther = 0;
const DROP_TIME = 2.6, PU_SPIN_S = 1.6;
function kickTo(dest, t, vol) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
  env(g, t, 0.002, vol, 0.45); o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.5);
}
function panned(pan) {
  if (!pan || !ctx.createStereoPanner) return sfxBus;
  const p = ctx.createStereoPanner(); p.pan.value = Math.max(-0.85, Math.min(0.85, pan)); p.connect(sfxBus);
  setTimeout(() => { try { p.disconnect(); } catch (e) { /* ignore */ } }, 1500);
  return p;
}
// Streak pitch: every pellet in a streak raises the streak sounds a little, with no ceiling.
// (7/60 of a semitone per pellet: a fifth by 60, an octave by about 100, two octaves by about 200.)
const STREAK_STEP = 7 / 60;
const streakSemis = n => Math.max(0, n | 0) * STREAK_STEP;
const FX = {
  eat(t, streak = 0) {
    if (t - lastWaka < 0.06) return; lastWaka = t; wakaFlip = !wakaFlip;
    // pitch climbs with the streak and keeps climbing
    const up = Math.pow(2, streakSemis(streak) / 12);
    tone(sfxBus, { type: 'triangle', f: (wakaFlip ? 300 : 620) * up, f2: (wakaFlip ? 620 : 300) * up, t, dur: 0.075, vol: 0.32 });
    if (streak >= 25 && streak % 5 === 0) tone(sfxBus, { type: 'sine', f: hz(88 + streakSemis(streak - 25)), t: t + 0.02, dur: 0.12, vol: 0.08 });
  },
  /* Other players munching: a soft, higher "pip" instead of the waka, panned to
     where they are and fading with distance. */
  eatOther(t, o = {}) {
    if (t - lastOther < 0.05) return; lastOther = t;
    const out = panned(o.pan), near = Math.max(0.3, Math.min(1, o.near == null ? 1 : o.near));
    const f = 1050 + Math.random() * 260;
    tone(out, { type: 'sine', f, f2: f * 1.45, t, dur: 0.045, vol: 0.075 * near });
    tone(out, { type: 'triangle', f: f * 2, t, dur: 0.025, vol: 0.02 * near });
  },
  /* Someone else grabbed a big pellet: the same power-up, panned towards them. */
  powerOther(t, o = {}) {
    const out = panned(o.pan);
    tone(out, { type: 'sawtooth', f: 160, f2: 1300, t, dur: 0.38, vol: 0.2, filter: [800, 5000, 6] });
    tone(out, { type: 'square', f: 80, f2: 650, t: t + 0.02, dur: 0.36, vol: 0.1 });
  },
  /* ---- level clear ---- */
  // A big bass drop: impact, then a sub-bass dive with a filtered whoosh. DROP_TIME long.
  drop(t) {
    const D = DROP_TIME;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(26, t + D);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.95, t + 0.02); g.gain.setValueAtTime(0.95, t + D * 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + D);
    o.connect(g); g.connect(sfxBus); o.start(t); o.stop(t + D + 0.05);
    const ws = ctx.createWaveShaper(); ws.curve = distCurve(30);
    const o2 = ctx.createOscillator(), g2 = ctx.createGain(), lp = ctx.createBiquadFilter();
    o2.type = 'sawtooth'; o2.frequency.setValueAtTime(75, t); o2.frequency.exponentialRampToValueAtTime(22, t + D);
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(90, t + D);
    g2.gain.setValueAtTime(0.0001, t); g2.gain.exponentialRampToValueAtTime(0.22, t + 0.03); g2.gain.exponentialRampToValueAtTime(0.0001, t + D);
    o2.connect(ws); ws.connect(lp); lp.connect(g2); g2.connect(sfxBus); o2.start(t); o2.stop(t + D + 0.05);
    kickTo(sfxBus, t, 1.0);
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), gn = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true; f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(7000, t); f.frequency.exponentialRampToValueAtTime(70, t + D);
    gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(0.3, t + 0.05); gn.gain.exponentialRampToValueAtTime(0.0001, t + D);
    s.connect(f); f.connect(gn); gn.connect(sfxBus); s.start(t); s.stop(t + D + 0.05);
  },
  // Bright level-up fanfare over the drop.
  levelup(t) {
    [60, 64, 67, 72, 76, 79, 84].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m + 12), t: t + i * 0.07, dur: 0.12, vol: 0.12 }));
    [72, 76, 79, 84].forEach(m => tone(sfxBus, { type: 'sawtooth', f: hz(m + 12), t: t + 0.5, dur: 1.4, vol: 0.05, detune: 7, filter: [5000, 1500, 1] }));
    [96, 100, 103, 108].forEach((m, i) => tone(sfxBus, { type: 'sine', f: hz(m), t: t + 0.55 + i * 0.09, dur: 0.6, vol: 0.06 }));
  },
  /* ---- power-ups ---- */
  crate(t) {   // a loot crate appears
    [88, 92, 95, 100].forEach((m, i) => tone(sfxBus, { type: 'sine', f: hz(m), t: t + i * 0.06, dur: 0.35, vol: 0.08 }));
    noise(sfxBus, { t, dur: 0.4, vol: 0.06, freq: 9000 });
  },
  puOpen(t) {   // crate cracked open, the slot spins with slowing ticks
    noise(sfxBus, { t, dur: 0.12, vol: 0.3, type: 'bandpass', freq: 1200, q: 1.5 });
    tone(sfxBus, { type: 'square', f: hz(83), t, dur: 0.07, vol: 0.12 }); tone(sfxBus, { type: 'square', f: hz(88), t: t + 0.07, dur: 0.3, vol: 0.12 });
    let tt = t + 0.12, gap = 0.045;
    while (tt < t + PU_SPIN_S - 0.05) { tone(sfxBus, { type: 'square', f: 1400, t: tt, dur: 0.012, vol: 0.05 }); tt += gap; gap *= 1.07; }
  },
  puLand(t, good) {   // result revealed
    FX.reel(t);
    if (good) [72, 76, 79, 84, 88].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m), t: t + 0.05 + i * 0.07, dur: 0.16, vol: 0.13 }));
    else [62, 61, 60, 59].forEach((m, i) => tone(sfxBus, { type: 'sawtooth', f: hz(m), f2: hz(m - (i === 3 ? 2 : 0)), t: t + 0.08 + i * 0.26, dur: i === 3 ? 0.7 : 0.22, vol: 0.13, filter: [1400, 500, 3] }));
  },
  megaghost(t) {   // monstrous growl
    const o = ctx.createOscillator(), g = ctx.createGain(), lf = ctx.createOscillator(), lg = ctx.createGain(), ws = ctx.createWaveShaper();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(45, t + 1.2);
    lf.frequency.value = 23; lg.gain.value = 18; lf.connect(lg); lg.connect(o.frequency); ws.curve = distCurve(25);
    env(g, t, 0.05, 0.3, 1.2); o.connect(ws); ws.connect(g); g.connect(sfxBus); o.start(t); lf.start(t); o.stop(t + 1.3); lf.stop(t + 1.3);
  },
  jetFlyby(t) {   // fighter screams across left to right
    const dur = 3.4, pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null, out = ctx.createGain();
    out.gain.value = 1; if (pan) { pan.pan.setValueAtTime(-0.9, t); pan.pan.linearRampToValueAtTime(0.9, t + dur); out.connect(pan); pan.connect(sfxBus); } else out.connect(sfxBus);
    // roar: noise swelling to the pass at 1.6 s, then trailing off
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true; f.type = 'bandpass'; f.Q.value = 0.7;
    f.frequency.setValueAtTime(500, t); f.frequency.exponentialRampToValueAtTime(2600, t + 1.6); f.frequency.exponentialRampToValueAtTime(380, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 1.55); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(out); s.start(t); s.stop(t + dur + 0.1);
    // turbine whine with doppler drop at the pass
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(1100, t); o.frequency.setValueAtTime(1100, t + 1.45); o.frequency.exponentialRampToValueAtTime(520, t + 1.9);
    og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.05, t + 1.5); og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 2400;
    o.connect(of); of.connect(og); og.connect(out); o.start(t); o.stop(t + dur + 0.1);
    // low rumble you feel
    tone(out, { type: 'sawtooth', f: 48, f2: 40, t: t + 0.6, dur: 2.2, vol: 0.18, a: 0.6, filter: [160, 120, 1] });
    setTimeout(() => { try { out.disconnect(); if (pan) pan.disconnect(); } catch (e) { /* ignore */ } }, (dur + 1) * 1000);
  },
  bombRelease(t) { noise(sfxBus, { t, dur: 0.12, vol: 0.25, type: 'lowpass', freq: 1800 }); tone(sfxBus, { type: 'square', f: 140, f2: 70, t, dur: 0.1, vol: 0.12 }); },
  bombWhistle(t) {   // falling whistle, 1.2 s
    tone(sfxBus, { type: 'sine', f: 2100, f2: 520, t, dur: 1.2, vol: 0.09, a: 0.08 });
    tone(sfxBus, { type: 'triangle', f: 1050, f2: 260, t, dur: 1.2, vol: 0.04, a: 0.08 });
  },
  nukeBlast(t) {
    kickTo(sfxBus, t, 1.0); kickTo(sfxBus, t + 0.09, 0.8);
    const o = ctx.createOscillator(), g = ctx.createGain(), ws = ctx.createWaveShaper(); ws.curve = distCurve(6);
    o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(16, t + 4.2);
    env(g, t, 0.005, 1.0, 4.2); o.connect(ws); ws.connect(g); g.connect(sfxBus); o.start(t); o.stop(t + 4.3);
    // the roar: wideband crack that closes down into a long rumble
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), gn = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true; f.type = 'lowpass'; f.frequency.setValueAtTime(9000, t); f.frequency.exponentialRampToValueAtTime(70, t + 4.5);
    env(gn, t, 0.003, 0.9, 4.5); s.connect(f); f.connect(gn); gn.connect(sfxBus); s.start(t); s.stop(t + 4.6);
    // debris crackle
    for (let i = 0; i < 26; i++) noise(sfxBus, { t: t + 0.3 + Math.random() * 2.6, dur: 0.03 + Math.random() * 0.08, vol: 0.06 + Math.random() * 0.12, type: 'bandpass', freq: 600 + Math.random() * 3000, q: 2 });
  },
  reverse(t) {   // tape rewind wobble
    const o = ctx.createOscillator(), g = ctx.createGain(), lf = ctx.createOscillator(), lg = ctx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.5); o.frequency.exponentialRampToValueAtTime(700, t + 0.9);
    lf.frequency.value = 30; lg.gain.value = 120; lf.connect(lg); lg.connect(o.frequency);
    env(g, t, 0.01, 0.1, 0.9); o.connect(g); g.connect(sfxBus); o.start(t); lf.start(t); o.stop(t + 1); lf.stop(t + 1);
  },
  laser(t) {   // charge up, then zap
    tone(sfxBus, { type: 'sine', f: 200, f2: 2400, t, dur: 0.45, vol: 0.12 });
    tone(sfxBus, { type: 'sawtooth', f: 2400, f2: 300, t: t + 0.45, dur: 0.3, vol: 0.14, filter: [6000, 1500, 4] });
    noise(sfxBus, { t: t + 0.45, dur: 0.25, vol: 0.12, freq: 5000 });
  },
  megapellet(t) { FX.power(t); FX.power(t + 0.18); [72, 76, 79, 84].forEach(m => tone(sfxBus, { type: 'sawtooth', f: hz(m), t: t + 0.4, dur: 0.8, vol: 0.05, filter: [4000, 1500, 1] })); },
  bomb(t) {
    tone(sfxBus, { type: 'sine', f: 1200, f2: 300, t, dur: 0.35, vol: 0.08 });   // whistle
    kickTo(sfxBus, t + 0.35, 1.0);
    noise(sfxBus, { t: t + 0.35, dur: 0.8, vol: 0.5, type: 'lowpass', freq: 1400, q: 0.7 });
  },
  quake(t) {   // seven seconds of rumble
    const D = 7, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), lf = ctx.createOscillator(), lg = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true; f.type = 'lowpass'; f.frequency.value = 110; f.Q.value = 2;
    lf.frequency.value = 5; lg.gain.value = 0.25; lf.connect(lg); lg.connect(g.gain);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7, t + 0.4); g.gain.setValueAtTime(0.7, t + D - 1); g.gain.exponentialRampToValueAtTime(0.0001, t + D);
    s.connect(f); f.connect(g); g.connect(sfxBus); s.start(t); lf.start(t); s.stop(t + D + 0.05); lf.stop(t + D + 0.05);
    kickTo(sfxBus, t, 0.9);
  },
  unplugged(t) {   // power-down and static
    tone(sfxBus, { type: 'sine', f: 900, f2: 40, t, dur: 0.9, vol: 0.2 });
    noise(sfxBus, { t: t + 0.1, dur: 1.2, vol: 0.12, type: 'bandpass', freq: 3000, q: 0.5 });
  },
  replugged(t) { [72, 79].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m), t: t + i * 0.08, dur: 0.1, vol: 0.1 })); },
  autopilot(t) { [84, 84, 91, 96].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m), t: t + i * 0.11, dur: 0.08, vol: 0.1, filter: [3500, 3500, 1] })); },
  autopilotOff(t) { [91, 84].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m), t: t + i * 0.11, dur: 0.08, vol: 0.09 })); },
  hacker(t) {   // glitchy data stutter, a modem chirp, then a two-note "access granted"
    for (let k = 0; k < 16; k++) {
      const tt = t + k * 0.032 + Math.random() * 0.01, f = 300 + Math.random() * 2200;
      tone(sfxBus, { type: Math.random() < 0.5 ? 'square' : 'sawtooth', f, f2: f * (0.5 + Math.random()), t: tt, dur: 0.025, vol: 0.05, filter: [4000, 1500, 2] });
      if (k % 4 === 0) noise(sfxBus, { t: tt, dur: 0.02, vol: 0.08, type: 'bandpass', freq: 3000 + Math.random() * 3000, q: 4 });
    }
    const m = t + 0.55, o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(1100, m); o.frequency.linearRampToValueAtTime(2300, m + 0.3);
    lfo.frequency.value = 55; lg.gain.value = 260; lfo.connect(lg); lg.connect(o.frequency);
    env(g, m, 0.01, 0.06, 0.3); o.connect(g); g.connect(sfxBus); o.start(m); o.stop(m + 0.35); lfo.start(m); lfo.stop(m + 0.35);
    tone(sfxBus, { type: 'triangle', f: 880, t: m + 0.42, dur: 0.12, vol: 0.1 });
    tone(sfxBus, { type: 'triangle', f: 1320, t: m + 0.56, dur: 0.22, vol: 0.1 });
  },
  magnet(t) { tone(sfxBus, { type: 'sawtooth', f: 90, f2: 180, t, dur: 0.5, vol: 0.08, filter: [600, 1400, 4] }); tone(sfxBus, { type: 'sine', f: 880, f2: 1320, t: t + 0.1, dur: 0.3, vol: 0.06 }); },
  swap(t) { tone(sfxBus, { type: 'triangle', f: 400, f2: 1200, t, dur: 0.18, vol: 0.12 }); tone(sfxBus, { type: 'triangle', f: 1200, f2: 400, t: t + 0.16, dur: 0.18, vol: 0.12 }); noise(sfxBus, { t: t + 0.15, dur: 0.12, vol: 0.12, type: 'bandpass', freq: 3000, q: 2 }); },
  freeze(t) { for (let k = 0; k < 6; k++) tone(sfxBus, { type: 'sine', f: 1800 + k * 260, t: t + k * 0.04, dur: 0.4, vol: 0.045 }); noise(sfxBus, { t, dur: 0.5, vol: 0.08, type: 'highpass', freq: 6000 }); },
  shrink(t) { tone(sfxBus, { type: 'square', f: 900, f2: 1800, t, dur: 0.35, vol: 0.05, filter: [3000, 3000, 1] }); },
  fog(t) { noise(sfxBus, { t, dur: 1.2, vol: 0.16, type: 'lowpass', freq: 500 }); tone(sfxBus, { type: 'sine', f: 110, f2: 70, t, dur: 1, vol: 0.12 }); },
  emote(t) { tone(sfxBus, { type: 'sine', f: 660, f2: 990, t, dur: 0.08, vol: 0.06 }); },
  beep(t, n = 0) { const f = 900 + Math.min(1200, (n | 0) * 12); tone(sfxBus, { type: 'square', f, t, dur: 0.04, vol: 0.035, filter: [3000, 3000, 1] }); tone(sfxBus, { type: 'square', f: f * 1.5, t: t + 0.045, dur: 0.03, vol: 0.025, filter: [3000, 3000, 1] }); },
  clap(t) {   // a crisp hand clap: a few tight bursts, then a short tail
    for (const [d, v] of [[0, 0.5], [0.011, 0.38], [0.022, 0.3]]) noise(sfxBus, { t: t + d, dur: 0.03, vol: v, type: 'bandpass', freq: 1400, q: 1.1 });
    noise(sfxBus, { t: t + 0.03, dur: 0.16, vol: 0.22, type: 'bandpass', freq: 1100, q: 0.8 });
    noise(sfxBus, { t, dur: 0.05, vol: 0.12, type: 'highpass', freq: 5000 });
  },
  phone(t) {   // old phone ring, twice
    for (let r = 0; r < 2; r++) for (let k = 0; k < 10; k++) {
      const tt = t + r * 0.65 + k * 0.04;
      tone(sfxBus, { type: 'sine', f: 440, t: tt, dur: 0.035, vol: 0.09 }); tone(sfxBus, { type: 'sine', f: 480, t: tt, dur: 0.035, vol: 0.09 });
    }
  },
  coin(t) {
    tone(sfxBus, { type: 'square', f: hz(83), t, dur: 0.07, vol: 0.12 });
    tone(sfxBus, { type: 'square', f: hz(88), t: t + 0.07, dur: 0.25, vol: 0.12 });
  },
  streak(t, streak = 10) {
    const base = 72 + streakSemis(streak), notes = streak >= 50 ? 5 : streak >= 25 ? 4 : 3;
    [0, 4, 7, 12, 16].slice(0, notes).forEach((iv, i) => tone(sfxBus, { type: 'square', f: hz(base + iv), t: t + i * 0.055, dur: 0.09, vol: 0.13 }));
    tone(sfxBus, { type: 'sine', f: hz(base + 24), t: t + 0.25, dur: 0.35, vol: 0.08 });
  },
  jackpot(t, streak) {
    // bell chord, then a cascade of coin dings; streak jackpots rise with the streak
    const up = streak ? streakSemis(streak - 100) : 0;
    [84, 88, 91, 96].forEach(m => tone(sfxBus, { type: 'sine', f: hz(m + up), t, dur: 0.9, vol: 0.09, a: 0.002 }));
    [84, 88, 91, 96].forEach(m => tone(sfxBus, { type: 'triangle', f: hz(m + 12 + up), t, dur: 0.4, vol: 0.05 }));
    for (let i = 0; i < 14; i++) {
      const tt = t + 0.12 + i * 0.055 + Math.random() * 0.02, m = 88 + up + [0, 3, 7, 10, 12][i % 5];
      tone(sfxBus, { type: 'square', f: hz(m), t: tt, dur: 0.05, vol: 0.06 });
    }
  },
  reel(t) {
    noise(sfxBus, { t, dur: 0.06, vol: 0.25, type: 'bandpass', freq: 900, q: 2 });
    tone(sfxBus, { type: 'square', f: 180, f2: 90, t, dur: 0.08, vol: 0.18 });
  },
  power(t) {
    tone(sfxBus, { type: 'sawtooth', f: 160, f2: 1300, t, dur: 0.38, vol: 0.22, filter: [800, 5000, 6] });
    tone(sfxBus, { type: 'square', f: 80, f2: 650, t: t + 0.02, dur: 0.36, vol: 0.12 });
  },
  ghost(t) {
    [880, 1175, 1568, 2093].forEach((f, i) => tone(sfxBus, { type: 'square', f, t: t + i * 0.045, dur: 0.06, vol: 0.16 }));
    tone(sfxBus, { type: 'sine', f: 300, f2: 1800, t, dur: 0.22, vol: 0.18 });
  },
  die(t) {
    const o = tone(sfxBus, { type: 'triangle', f: 820, f2: 70, t, dur: 1.0, vol: 0.35, a: 0.01 });
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 11; lg.gain.value = 40;
    lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + 1.05);
    noise(sfxBus, { t: t + 0.85, dur: 0.25, vol: 0.18, type: 'lowpass', freq: 900 });
  },
  clear(t) {
    [72, 76, 79, 84, 88].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m), t: t + i * 0.09, dur: 0.12, vol: 0.16 }));
    [72, 76, 79].forEach(m => tone(sfxBus, { type: 'sawtooth', f: hz(m + 12), t: t + 0.48, dur: 0.6, vol: 0.07, detune: 7, filter: [4000, 1200, 1] }));
  },
  life(t) { [84, 91].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m), t: t + i * 0.1, dur: 0.14, vol: 0.16 })); },
  start(t) { [64, 67, 71, 76].forEach((m, i) => tone(sfxBus, { type: 'square', f: hz(m), t: t + i * 0.08, dur: 0.1, vol: 0.15 })); },
  over(t) { [67, 63, 60, 55].forEach((m, i) => tone(sfxBus, { type: 'triangle', f: hz(m), t: t + i * 0.22, dur: 0.3, vol: 0.3 })); },
  respawn(t) { tone(sfxBus, { type: 'sine', f: 400, f2: 1200, t, dur: 0.18, vol: 0.22 }); },
  join(t) { [79, 84].forEach((m, i) => tone(sfxBus, { type: 'sine', f: hz(m), t: t + i * 0.07, dur: 0.18, vol: 0.12 })); }
};
/* Recorded clips (public/sounds/*.mp3), decoded once and played through the effects channel.
   A missing or undecodable file just stays silent. */
const samples = {};
function loadSample(name, url) {
  if (!ctx || samples[name]) return;
  samples[name] = 'loading';
  fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status)))
    .then(b => new Promise((res, rej) => ctx.decodeAudioData(b, res, rej)))
    .then(buf => { samples[name] = buf; }).catch(() => { samples[name] = null; });
}
function playSample(name, vol = 1) {
  if (!ready()) return;
  const buf = samples[name]; if (!buf || buf === 'loading') return;
  const s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = buf; g.gain.value = vol; s.connect(g); g.connect(sfxBus); s.start();
}
/* A short robotic voice line (the browser's built-in speech), at the effects volume. */
function say(text, { pitch = 0.5, rate = 1.05 } = {}) {
  try {
    if (!('speechSynthesis' in window) || sfxVol <= 0.001) return;
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = pitch; u.rate = rate; u.volume = Math.min(1, curve(sfxVol) * 2.2);
    const v = speechSynthesis.getVoices().find(x => /^en/i.test(x.lang)); if (v) u.voice = v;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch (e) { /* speech is a nice extra, never required */ }
}
/* Nuke alarm: a rising electronic "whoop" every second, warbling, until stopped. */
let alarm = null;
function alarmWhoop(t, out) {
  const g = ctx.createGain(), bp = ctx.createBiquadFilter(), ws = ctx.createWaveShaper();
  bp.type = 'bandpass'; bp.Q.value = 0.8; bp.frequency.setValueAtTime(700, t); bp.frequency.exponentialRampToValueAtTime(2400, t + 0.85);
  ws.curve = distCurve(5);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.14, t + 0.05); g.gain.setValueAtTime(0.14, t + 0.78); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.93);
  for (const [det, type] of [[-16, 'sawtooth'], [0, 'square'], [15, 'sawtooth']]) {
    const o = ctx.createOscillator(); o.type = type; o.detune.value = det;
    o.frequency.setValueAtTime(280, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.88);
    o.connect(ws); o.start(t); o.stop(t + 0.97);
  }
  const lfo = ctx.createOscillator(), lg = ctx.createGain();   // fast warble
  lfo.frequency.value = 17; lg.gain.value = 0.045; lfo.connect(lg); lg.connect(g.gain); lfo.start(t); lfo.stop(t + 0.97);
  ws.connect(bp); bp.connect(g); g.connect(out);
}
function nukeAlarm(on) {
  if (!ready()) return;
  if (on && !alarm) {
    const out = ctx.createGain(); out.gain.value = 1; out.connect(sfxBus);
    alarm = { out, next: ctx.currentTime + 0.05 };
    const pump = () => { if (!alarm) return; while (alarm.next < ctx.currentTime + 0.35) { alarmWhoop(alarm.next, alarm.out); alarm.next += 1.0; } };
    pump(); alarm.timer = setInterval(pump, 100);
  } else if (!on && alarm) {
    const a = alarm; alarm = null; clearInterval(a.timer);
    a.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    setTimeout(() => { try { a.out.disconnect(); } catch (e) { /* ignore */ } }, 1500);
  }
}
function sfx(name, arg) {
  if (!ready() || ctx.state !== 'running' || sfxVol <= 0 || !FX[name]) return;
  try { FX[name](ctx.currentTime + 0.005, arg); } catch (e) { /* ignore */ }
}

function setMusicVolume(v) { musicVol = v; if (musicBus) musicBus.gain.setTargetAtTime(curve(v) * MUSIC_TRIM, ctx.currentTime, 0.03); }
function setSfxVolume(v) { sfxVol = v; if (sfxBus) sfxBus.gain.setTargetAtTime(curve(v), ctx.currentTime, 0.03); }

// Pause the track while the tab is hidden; resume where it left off.
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) ctx.suspend().catch(() => {});
  else ctx.resume().then(() => { if (music.on) music.next = Math.max(music.next, ctx.currentTime + 0.05); }).catch(() => {});
});

window.MazeAudio = { setCustomTrack, get customPlaying() { return !!custom.src; }, loadSample, playSample, say, nukeAlarm, get alarmOn() { return !!alarm; }, fadeOutMusic, DROP_TIME, get playing() { return music.on; }, get mode() { return music.mode; }, /* for tests */ levels() { return tracks ? { normal: +tracks.normal.bus.gain.value.toFixed(3), boss: +tracks.boss.bus.gain.value.toFixed(3) } : null; }, get bpm() { return music.bpm; }, unlock, startMusic, stopMusic, setFright, setMusicVolume, setSfxVolume, sfx, beat, get supported() { return !!AC; } };
})();
