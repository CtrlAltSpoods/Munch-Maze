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
   128 BPM four-on-the-floor in A minor: Am - F - C - G.
   Kick, clap, hats, pumping saw bass, sidechained pad and a delayed square arp.
   Each level shifts the key and nudges the tempo up a little. */
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // chord tones (MIDI)
const BASS = [45, 41, 48, 43];
const ARP_A = [0, 1, 2, 1, 0, 2, 3, 2, 0, 1, 2, 3, 2, 1, 0, 2];   // index into chord + octave
const ARP_B = [3, 2, 0, 2, 1, 2, 3, 0, 3, 2, 1, 2, 0, 1, 2, 3];
const BASS_STEPS = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 2]; // 0 rest, 1 root, 2 octave
const KEYS = [0, 3, -2, 5, 2, -4, 7];
let music = { mode: 'normal', baseBpm: 128, on: false, step: 0, next: 0, bpm: 128, trans: 0, pendingTrans: 0, timer: 0, bar: 0, pad: null, kicks: [] };

function stepDur() { return 60 / music.bpm / 4; }
function kick(t, vol, track = true) {
  if (track) { music.kicks.push(t); if (music.kicks.length > 8) music.kicks.shift(); }
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
  env(g, t, 0.002, vol, 0.32); o.connect(g); g.connect(tracks[music.mode].bus); o.start(t); o.stop(t + 0.4);
  if (music.pad) { const pg = music.pad.gain, sd = stepDur(); pg.cancelScheduledValues(t); pg.setValueAtTime(0.012, t); pg.linearRampToValueAtTime(music.mode === 'boss' ? 0.045 : 0.07, t + sd * 3); }
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

function schedStep(s, t) {
  const bar = music.bar, chord = PROG[bar % 4].map(n => n + music.trans), sd = stepDur();
  const sec = Math.floor(bar / 8) % 2;       // alternate arp patterns every 8 bars
  if (s % 4 === 0) kick(t, 0.95);
  // clap on 2 and 4
  if (s === 4 || s === 12) { noise(tracks.normal.bus, { t, dur: 0.16, vol: 0.32, type: 'bandpass', freq: 1500, q: 0.9 }); noise(tracks.normal.bus, { t: t + 0.012, dur: 0.1, vol: 0.18, type: 'bandpass', freq: 2400, q: 1.2 }); }
  // hats: closed 16ths, open on the off-beat
  noise(tracks.normal.bus, { t, dur: s % 4 === 2 ? 0.09 : 0.025, vol: s % 4 === 2 ? 0.12 : 0.045, freq: 8000 });
  // bass
  const bs = BASS_STEPS[s];
  if (bs) tone(tracks.normal.bus, { type: 'sawtooth', f: hz(BASS[bar % 4] + music.trans + (bs === 2 ? 12 : 0)), t, dur: sd * 0.9, vol: 0.2, filter: [900, 160, 4] });
  // arp (from bar 2 on, so the loop opens with drums and bass)
  if (bar % 16 !== 0) {
    const idx = (sec ? ARP_B : ARP_A)[s];
    const n = idx === 3 ? chord[0] + 12 : chord[idx];
    tone(tracks.normal.bus, { type: 'square', f: hz(n + 12), t, dur: sd * 0.75, vol: 0.055, filter: [3800, 1200, 2] });
    tone(tracks.normal.send, { type: 'square', f: hz(n + 12), t, dur: sd * 0.6, vol: 0.04 });
  }
  // a short lead hook every other bar, on the off-beats
  if (bar % 2 === 1 && (s === 6 || s === 10 || s === 14)) {
    const n = chord[s === 14 ? 2 : s === 10 ? 1 : 0] + 24;
    tone(tracks.normal.bus, { type: 'sawtooth', f: hz(n), t, dur: sd * 1.6, vol: 0.05, detune: 6, filter: [5200, 1800, 1] });
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
  const chord = music.mode === 'boss' ? [0, 7, 12].map(iv => BOSS_ROOTS[music.bar % 4] + 12 + iv + music.trans) : PROG[music.bar % 4].map(n => n + music.trans);
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
  if (!unlock()) return;
  music.baseBpm = 128 + Math.min(12, (level - 1) * 1.5);
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
function stopMusic() {
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
const bossBpm = () => Math.min(176, Math.round(music.baseBpm * 1.2));
/** Ghosts turned blue: cut to the boss track on the very next 16th; back again when they recover. */
function setFright(on) {
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

window.MazeAudio = { get mode() { return music.mode; }, /* for tests */ levels() { return tracks ? { normal: +tracks.normal.bus.gain.value.toFixed(3), boss: +tracks.boss.bus.gain.value.toFixed(3) } : null; }, get bpm() { return music.bpm; }, unlock, startMusic, stopMusic, setFright, setMusicVolume, setSfxVolume, sfx, beat, get supported() { return !!AC; } };
})();
