// Visual effects: gold coin rain, confetti, sparkle bursts. One full-screen canvas, pointer-events off.
const cv = document.getElementById('fx');
const g = cv.getContext('2d');
let parts = [], raf = null, dpr = 1;
const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function resize() { dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; }
resize(); addEventListener('resize', resize);

function loop() {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 60);
  for (const p of parts) {
    p.vy += p.grav; p.vx *= p.drag; p.vy *= p.drag; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 1;
    const a = Math.min(1, p.life / 25);
    g.save(); g.globalAlpha = a; g.translate(p.x, p.y); g.rotate(p.rot);
    if (p.kind === 'coin') {
      const w = p.r * Math.abs(Math.cos(p.rot * 1.7)) + 1.5;
      const grd = g.createLinearGradient(-w, -p.r, w, p.r); grd.addColorStop(0, '#fff3c4'); grd.addColorStop(0.5, '#d4af37'); grd.addColorStop(1, '#7a5c12');
      g.fillStyle = grd; g.beginPath(); g.ellipse(0, 0, w, p.r, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(90,64,10,.8)'; g.lineWidth = 1; g.stroke();
    } else if (p.kind === 'spark') {
      g.fillStyle = p.color; g.beginPath();
      for (let i = 0; i < 4; i++) { g.rotate(Math.PI / 2); g.lineTo(0, -p.r); g.lineTo(p.r * 0.25, -p.r * 0.25); }
      g.fill();
    } else {
      g.fillStyle = p.color; g.fillRect(-p.r, -p.r * 0.45, p.r * 2, p.r * 0.9);
    }
    g.restore();
  }
  if (parts.length) raf = requestAnimationFrame(loop); else { raf = null; g.clearRect(0, 0, innerWidth, innerHeight); }
}
const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

export function coinRain(n = 70) {
  if (reduce) return;
  for (let i = 0; i < n; i++) parts.push({ kind: 'coin', x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * 0.6, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3,
    grav: 0.12, drag: 0.995, r: 7 + Math.random() * 7, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, life: 260 });
  kick();
}
export function burst(x, y, n = 60, palette = ['#f5d77a', '#d4af37', '#22c07e', '#fff3c4', '#e0445a']) {
  if (reduce) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 9;
    parts.push({ kind: Math.random() < 0.35 ? 'spark' : 'confetti', color: palette[i % palette.length], x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 4,
      grav: 0.22, drag: 0.975, r: 3 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.5, life: 110 + Math.random() * 60 });
  }
  kick();
}
export function sparkleAt(el, n = 24) {
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, n, ['#f5d77a', '#fff3c4', '#d4af37']);
}
/** Count a number up/down inside an element. */
export function countTo(el, from, to, fmt, ms = 900) {
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
