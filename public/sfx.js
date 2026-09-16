// Casino sound effects, synthesized live with Web Audio (no audio files, no licensing).
let ctx = null, master = null;
let muted = (() => { try { return localStorage.getItem('fof_muted') === '1'; } catch { return false; } })();

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C(); master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export const isMuted = () => muted;
export function setMuted(m) { muted = m; try { localStorage.setItem('fof_muted', m ? '1' : '0'); } catch {} }

function tone(freq, t0, dur, { type = 'sine', gain = 0.3, attack = 0.005, slide = 0 } = {}) {
  const c = ac(); if (!c || muted) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, c.currentTime + t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), c.currentTime + t0 + dur);
  g.gain.setValueAtTime(0, c.currentTime + t0);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
  o.connect(g).connect(master); o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur + 0.05);
}
function noise(t0, dur, { gain = 0.25, freq = 3000, q = 1, type = 'bandpass' } = {}) {
  const c = ac(); if (!c || muted) return;
  const len = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = buf; f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = gain;
  s.connect(f).connect(g).connect(master); s.start(c.currentTime + t0);
}

export const sfx = {
  /** clay chip clack */
  chip() { noise(0, 0.05, { freq: 4200, q: 3, gain: 0.5 }); tone(2400, 0, 0.06, { type: 'triangle', gain: 0.12 }); noise(0.05, 0.04, { freq: 3600, q: 4, gain: 0.35 }); },
  /** card swish onto felt */
  deal() { noise(0, 0.18, { freq: 1800, q: 0.6, gain: 0.35 }); noise(0.12, 0.06, { freq: 900, q: 1, gain: 0.25, type: 'lowpass' }); },
  /** button press on a big bet */
  bet() { tone(180, 0, 0.18, { type: 'sine', gain: 0.35, slide: 0.6 }); noise(0, 0.08, { freq: 5000, q: 2, gain: 0.3 }); },
  /** roulette-style ticking roll, ~duration seconds, slowing down */
  roll(duration = 1.3) { let t = 0, gap = 0.035; while (t < duration) { noise(t, 0.02, { freq: 5200, q: 6, gain: 0.3 }); t += gap; gap *= 1.07; } },
  /** win jingle + coin shimmer */
  win(big = false) {
    const notes = big ? [523, 659, 784, 1047, 1319, 1568] : [659, 784, 1047, 1319];
    notes.forEach((n, i) => { tone(n, i * 0.08, 0.35, { type: 'triangle', gain: 0.22 }); tone(n * 2, i * 0.08, 0.2, { type: 'sine', gain: 0.05 }); });
    const n = big ? 26 : 12;
    for (let i = 0; i < n; i++) tone(2200 + Math.random() * 2600, 0.25 + i * 0.045, 0.12, { type: 'sine', gain: 0.07 });
    if (big) [1047, 1319, 1568].forEach((f) => tone(f, 0.55, 1.1, { type: 'sawtooth', gain: 0.04 }));
  },
  /** sad trombone-ish slide */
  lose() { [392, 370, 349].forEach((f, i) => tone(f, i * 0.22, 0.24, { type: 'sawtooth', gain: 0.09 })); tone(330, 0.66, 0.7, { type: 'sawtooth', gain: 0.09, slide: 0.85 }); noise(0, 0.3, { freq: 200, type: 'lowpass', gain: 0.35 }); },
  /** bell for a settled live bet */
  ding() { tone(1568, 0, 0.9, { type: 'sine', gain: 0.18 }); tone(2093, 0.02, 0.7, { type: 'sine', gain: 0.08 }); },
  /** soft tick */
  tick() { noise(0, 0.015, { freq: 6000, q: 8, gain: 0.18 }); },
  /** cash register ka-ching */
  cashout() { noise(0, 0.06, { freq: 2500, q: 2, gain: 0.4 }); tone(1318, 0.06, 0.5, { type: 'triangle', gain: 0.25 }); tone(1760, 0.14, 0.7, { type: 'triangle', gain: 0.22 }); noise(0.12, 0.25, { freq: 7000, q: 1, gain: 0.08 }); },
  /** quick whoosh getting out the door */
  escape() { tone(300, 0, 0.35, { type: 'sine', gain: 0.18, slide: 3 }); noise(0, 0.3, { freq: 1200, q: 0.7, gain: 0.25 }); },
  push() { tone(440, 0, 0.25, { type: 'triangle', gain: 0.15 }); tone(440, 0.2, 0.25, { type: 'triangle', gain: 0.15 }); },
};
// unlock audio on first interaction (browser autoplay rules)
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => ac(), { once: true }));
