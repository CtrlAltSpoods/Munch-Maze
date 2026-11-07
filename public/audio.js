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
let ctx = null, master, musicBus, musicFilter, sfxBus, noiseBuf, delaySend;
let musicVol = 0.2, sfxVol = 0.4;

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

  // Dotted-eighth echo for the arp.
  const d = ctx.createDelay(1); const fb = ctx.createGain(); const wet = ctx.createGain(); const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass'; tone.frequency.value = 3200; fb.gain.value = 0.38; wet.gain.value = 0.35;
  delaySend = ctx.createGain(); delaySend.connect(d); d.connect(tone); tone.connect(fb); fb.connect(d); tone.connect(wet); wet.connect(musicFilter);
  delaySend._delay = d;

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
let music = { on: false, step: 0, next: 0, bpm: 128, trans: 0, pendingTrans: 0, timer: 0, bar: 0, pad: null, kicks: [] };

function stepDur() { return 60 / music.bpm / 4; }
function schedStep(s, t) {
  const bar = music.bar, chord = PROG[bar % 4].map(n => n + music.trans), sd = stepDur();
  const sec = Math.floor(bar / 8) % 2;       // alternate arp patterns every 8 bars
  // kick
  if (s % 4 === 0) {
    music.kicks.push(t); if (music.kicks.length > 8) music.kicks.shift();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    env(g, t, 0.002, 0.95, 0.32); o.connect(g); g.connect(musicFilter); o.start(t); o.stop(t + 0.4);
    if (music.pad) { const pg = music.pad.gain; pg.cancelScheduledValues(t); pg.setValueAtTime(0.012, t); pg.linearRampToValueAtTime(0.07, t + sd * 3); }
  }
  // clap on 2 and 4
  if (s === 4 || s === 12) { noise(musicFilter, { t, dur: 0.16, vol: 0.32, type: 'bandpass', freq: 1500, q: 0.9 }); noise(musicFilter, { t: t + 0.012, dur: 0.1, vol: 0.18, type: 'bandpass', freq: 2400, q: 1.2 }); }
  // hats: closed 16ths, open on the off-beat
  noise(musicFilter, { t, dur: s % 4 === 2 ? 0.09 : 0.025, vol: s % 4 === 2 ? 0.12 : 0.045, freq: 8000 });
  // bass
  const bs = BASS_STEPS[s];
  if (bs) tone(musicFilter, { type: 'sawtooth', f: hz(BASS[bar % 4] + music.trans + (bs === 2 ? 12 : 0)), t, dur: sd * 0.9, vol: 0.2, filter: [900, 160, 4] });
  // arp (from bar 2 on, so the loop opens with drums and bass)
  if (bar % 16 !== 0) {
    const idx = (sec ? ARP_B : ARP_A)[s];
    const n = idx === 3 ? chord[0] + 12 : chord[idx];
    tone(musicFilter, { type: 'square', f: hz(n + 12), t, dur: sd * 0.75, vol: 0.055, filter: [3800, 1200, 2] });
    tone(delaySend, { type: 'square', f: hz(n + 12), t, dur: sd * 0.6, vol: 0.04 });
  }
  // a short lead hook every other bar, on the off-beats
  if (bar % 2 === 1 && (s === 6 || s === 10 || s === 14)) {
    const n = chord[s === 14 ? 2 : s === 10 ? 1 : 0] + 24;
    tone(musicFilter, { type: 'sawtooth', f: hz(n), t, dur: sd * 1.6, vol: 0.05, detune: 6, filter: [5200, 1800, 1] });
  }
}
function setPad(t) {
  if (!music.pad) {
    const g = ctx.createGain(); g.gain.value = 0.05;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 0.6;
    f.connect(g); g.connect(musicFilter);
    music.pad = { gain: g.gain, node: g, filter: f, oscs: [] };
  }
  const chord = PROG[music.bar % 4].map(n => n + music.trans);
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
    schedStep(music.step, music.next);
    music.next += stepDur();
    music.step = (music.step + 1) % 16;
    if (music.step === 0) music.bar++;
  }
}
function startMusic(level = 1) {
  if (!unlock()) return;
  music.bpm = 128 + Math.min(12, (level - 1) * 1.5);
  music.pendingTrans = KEYS[(level - 1) % KEYS.length];
  delaySend._delay.delayTime.value = stepDur() * 3;
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
  music.on = false; clearInterval(music.timer); music.kicks = [];
  if (music.pad && ctx) { const t = ctx.currentTime; music.pad.oscs.forEach(o => { try { o.stop(t + 0.05); } catch (e) { /* ignore */ } }); music.pad.node.disconnect(); music.pad = null; }
}
let frightOn = false;
function setFright(on) {
  if (!ready() || on === frightOn) return; frightOn = on;
  const t = ctx.currentTime, f = musicFilter.frequency;
  f.cancelScheduledValues(t); f.setValueAtTime(f.value, t);
  f.exponentialRampToValueAtTime(on ? 700 : 18000, t + (on ? 0.25 : 0.6));
}

/* ---------- sound effects ---------- */
let wakaFlip = false, lastWaka = 0;
const FX = {
  eat(t, streak = 0) {
    if (t - lastWaka < 0.06) return; lastWaka = t; wakaFlip = !wakaFlip;
    // pitch climbs with the streak, up to a fifth higher
    const up = Math.pow(2, Math.min(streak, 60) / 60 * 7 / 12);
    tone(sfxBus, { type: 'triangle', f: (wakaFlip ? 300 : 620) * up, f2: (wakaFlip ? 620 : 300) * up, t, dur: 0.075, vol: 0.32 });
    if (streak >= 25 && streak % 5 === 0) tone(sfxBus, { type: 'sine', f: hz(88 + Math.min(12, Math.floor(streak / 25))), t: t + 0.02, dur: 0.12, vol: 0.08 });
  },
  coin(t) {
    tone(sfxBus, { type: 'square', f: hz(83), t, dur: 0.07, vol: 0.12 });
    tone(sfxBus, { type: 'square', f: hz(88), t: t + 0.07, dur: 0.25, vol: 0.12 });
  },
  streak(t, tier = 1) {
    const base = 72 + tier * 2;
    [0, 4, 7, 12, 16].slice(0, 3 + Math.min(2, tier)).forEach((iv, i) => tone(sfxBus, { type: 'square', f: hz(base + iv), t: t + i * 0.055, dur: 0.09, vol: 0.13 }));
    tone(sfxBus, { type: 'sine', f: hz(base + 24), t: t + 0.25, dur: 0.35, vol: 0.08 });
  },
  jackpot(t) {
    // bell chord, then a cascade of coin dings
    [84, 88, 91, 96].forEach(m => tone(sfxBus, { type: 'sine', f: hz(m), t, dur: 0.9, vol: 0.09, a: 0.002 }));
    [84, 88, 91, 96].forEach(m => tone(sfxBus, { type: 'triangle', f: hz(m + 12), t, dur: 0.4, vol: 0.05 }));
    for (let i = 0; i < 14; i++) {
      const tt = t + 0.12 + i * 0.055 + Math.random() * 0.02, m = 88 + [0, 3, 7, 10, 12][i % 5];
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

window.MazeAudio = { unlock, startMusic, stopMusic, setFright, setMusicVolume, setSfxVolume, sfx, beat, get supported() { return !!AC; } };
})();
