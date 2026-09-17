import * as store from './store.js';
// Free beta + paid-plan waitlist. No payments yet: we only collect interest.
const PLANS = ['free', 'basic', 'premium'];
const list = store.load('waitlist', []);

export function beta() {
  return { status: 'free-beta' }; // free during the beta, paid plans coming soon (no end date is promised)
}

export function join({ email, plan, player }) {
  const e = String(email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw Object.assign(new Error('That email looks off. Try again?'), { status: 400 });
  const p = PLANS.includes(plan) ? plan : 'premium';
  const existing = list.find((x) => x.email === e);
  if (existing) { existing.plan = p; existing.updated = Date.now(); }
  else {
    if (list.length >= 50000) throw Object.assign(new Error('Waitlist is full for now.'), { status: 503 });
    list.push({ email: e, plan: p, player: String(player || '').slice(0, 40), at: Date.now() });
  }
  store.save('waitlist', list);
  return { ok: true, already: !!existing, ...beta() };
}

export function csv() {
  // quote cells and neutralise spreadsheet formulas (=, +, -, @ at the start)
  const q = (s) => { let v = String(s ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
  return 'email,plan,joined_utc,player\n' + list.map((x) => [q(x.email), q(x.plan), q(new Date(x.at).toISOString()), q(x.player)].join(',')).join('\n') + '\n';
}
