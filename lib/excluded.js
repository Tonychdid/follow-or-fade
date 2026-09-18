import { load, save, isLocked } from './store.js';

// Traders who asked not to appear in the game.
//
// The site publishes wallet addresses, third-party labels and derived statistics about traders on a
// public blockchain. Where the trader is a natural person, the EDPB now treats a wallet address as
// personal data (Guidelines 02/2025 on blockchain, final July 2026), and the only lawful basis
// realistically available for publishing it is legitimate interests, Art. 6(1)(f).
//
// That basis carries an unconditional right to object under Art. 21. This module is how we honour it:
// an excluded address never reaches the Training Table, the Live Floor, an alert, or the deck again,
// on any refresh of the data. It is a permanent exclusion list, not a one-off takedown, because
// otherwise the address would simply reappear the next time the feed is read.
//
// It also works as an opt-out mechanism in the balancing test itself: the EDPB's legitimate-interests
// guidelines treat an easy, unconditional opt-out as a factor that weighs in the controller's favour.
const list = load('excluded', []); // [{ address, at, note }]
const set = new Set(list.map((x) => String(x.address || '').toLowerCase()));

const norm = (a) => String(a || '').trim().toLowerCase();

/** Is this address excluded? Called on every path that could display a trader. */
export const isExcluded = (address) => set.has(norm(address));

/** Filter any collection of Nansen trades or built items down to traders who have not objected. */
export const allow = (rows, pick = (r) => r.trader_address ?? r.address) =>
  (rows || []).filter((r) => !isExcluded(pick(r)));

const MAX = Number(process.env.MAX_EXCLUDED || 5000);
export function exclude(address, note = '') {
  const a = norm(address);
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw Object.assign(new Error('That is not a wallet address'), { status: 400 });
  if (set.size >= MAX && !set.has(a)) throw Object.assign(new Error('Exclusion list is full'), { status: 503 });
  if (set.has(a)) return { ok: true, already: true, count: set.size };
  if (isLocked('excluded')) throw Object.assign(new Error('Cannot record that right now: the exclusion file is damaged. Fix it before accepting objections.'), { status: 503 });
  set.add(a);
  list.push({ address: a, at: Date.now(), note: String(note || '').slice(0, 200) });
  save('excluded', list);
  console.log(`  Trader excluded on request: ${a.slice(0, 10)}…`);
  return { ok: true, already: false, count: set.size };
}

export function unexclude(address) {
  const a = norm(address);
  const i = list.findIndex((x) => norm(x.address) === a);
  if (i < 0) return { ok: true, removed: false };
  list.splice(i, 1); set.delete(a); save('excluded', list);
  return { ok: true, removed: true };
}

export const count = () => set.size;
