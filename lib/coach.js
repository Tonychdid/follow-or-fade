// The coach: turns every hand into a lesson and a player's history into a "Whale Reading" skill report.
import * as oddsEngine from './odds.js';

// Human names for the Nansen signals the odds engine uses. "follow"/"fade" = which side the signal favored.
const SIGNALS = {
  walletEdge: { thr: 0.04, follow: "the whale's strong track record", fade: "the whale's weak track record" },
  smFlow: { thr: 0.2, follow: 'Smart Money flow agreeing with the trade', fade: 'Smart Money flow going against the trade' },
  crowdFlow: { thr: 0.2, follow: 'the crowd sitting on the other side', fade: 'the crowd already piling in (a crowded trade)' },
  funding: { thr: 0.3, follow: 'the trade getting paid funding', fade: 'the trade paying funding' },
};
const pct = (x) => Math.round(x * 100) + '%';
const lc = (t) => t.charAt(0).toLowerCase() + t.slice(1);

/** Which side a signal favored for this trade, using the live model weights. */
function favors(k, f) {
  const w = oddsEngine.getModel()[k] || 0;
  const s = w * (f[k] || 0);
  if (Math.abs(f[k] || 0) < SIGNALS[k].thr || s === 0) return null;
  return s > 0 ? 'follow' : 'fade';
}

/** How often a signal pointing a given way was right, across this week's resolved Smart Money trades. */
function track(k, side, samples) {
  let n = 0, right = 0;
  for (const s of samples) {
    if (!s.f) continue;
    const fav = favors(k, s.f);
    if (fav !== side) continue;
    n++; if ((fav === 'follow') === s.win) right++;
  }
  return n >= 8 ? { n, rate: right / n } : null;
}

/** Post-hand lesson: the signal that called it (the tell) and the one that misled (the trap). */
export function lesson({ f, pFollow, choice, followWon, push, samples }) {
  if (!f || push) return push ? { headline: 'Too close to call: the whale moved less than 0.2%, so no signal won this one.' } : null;
  const winner = followWon ? 'follow' : 'fade';
  const scored = Object.keys(SIGNALS).map((k) => ({ k, side: favors(k, f), strength: Math.abs((oddsEngine.getModel()[k] || 0) * (f[k] || 0)) }))
    .filter((x) => x.side).sort((a, b) => b.strength - a.strength);
  const tell = scored.find((x) => x.side === winner);
  const trap = scored.find((x) => x.side !== winner);
  const modelSide = pFollow >= 0.5 ? 'follow' : 'fade';
  const out = {
    winner,
    headline: winner === 'follow' ? 'Following the whale was right.' : 'Fading the whale was right.',
    model: modelSide === winner ? `The odds favored ${modelSide} (${pct(Math.max(pFollow, 1 - pFollow))}), and they were right.` : `The odds favored ${modelSide} (${pct(Math.max(pFollow, 1 - pFollow))}), but the market went the other way. Upsets happen.`,
    you: choice === winner ? (choice === modelSide ? 'You read it the same way as the data.' : 'You went against the odds and won. That is an edge worth tracking.') : (choice === modelSide ? 'You went with the data and lost. Good decision, bad luck: keep doing it.' : 'You went against the data and lost. Check the tell before your next hand.'),
  };
  if (tell) {
    const t = track(tell.k, tell.side, samples);
    out.tell = { text: `The tell: ${SIGNALS[tell.k][tell.side]} pointed to ${tell.side}.`,
      stat: !t ? null : t.rate >= 0.55 ? `A reliable tell: right ${pct(t.rate)} of ${t.n} times this week.`
        : t.rate > 0.45 ? `Careful: this week it was a coin flip (right ${pct(t.rate)} of ${t.n} times), so don't lean on it alone.`
        : `Rare hit: this week it was right only ${pct(t.rate)} of ${t.n} times.` };
  }
  if (trap) {
    const t = track(trap.k, trap.side, samples);
    out.trap = { text: `The trap: ${SIGNALS[trap.k][trap.side]} pointed to ${trap.side}, and was wrong this time.`,
      stat: !t ? null : t.rate >= 0.55 ? `Normally a good signal (right ${pct(t.rate)} of ${t.n} times this week). Even good tells miss sometimes.`
        : `A weak signal anyway: right only ${pct(t.rate)} of ${t.n} times this week.` };
  }
  if (!tell && !trap) out.tell = { text: 'No strong signal this time. Price action decided it.', stat: null };
  return out;
}

/** Snapshot stored on each bet so the skill report can analyze decisions later. */
export function snapshot(f, pFollow, choice, grade) {
  return { sig: f ? { walletEdge: f.walletEdge, smFlow: f.smFlow, crowdFlow: f.crowdFlow, funding: f.funding } : null,
    pChosen: choice === 'follow' ? pFollow : 1 - pFollow, modelSide: pFollow >= 0.5 ? 'follow' : 'fade', grade: grade || null };
}

const LEVELS = [
  { name: 'Rookie', need: 'Play 10 hands to get your first reading' },
  { name: 'Learning the tells', need: 'Beat the odds over 20+ hands' },
  { name: 'Sharp reader', need: '30+ hands, 55%+ wins and a +5% edge over the odds' },
  { name: 'Ready for real trades', need: '' },
];

/** Skill report from a player's decision history. */
export function report(p) {
  // Only decisions long enough to reflect how whales actually trade count toward skill:
  // training hands (judged on the whale's exit), 4-hour bets and Ride the Whale. 15-minute bets are just for fun.
  const counts = (h) => !h.live || h.minutes === 'ride' || Number(h.minutes) >= 240;
  const hands = p.history.filter((h) => h.delta !== 0 && h.sig !== undefined && counts(h));
  const funHands = p.history.filter((h) => h.live && !counts(h)).length;
  const decided = hands.filter((h) => h.pChosen != null);
  const n = decided.length;
  const wins = decided.filter((h) => h.delta > 0).length;
  const winRate = n ? wins / n : 0;
  const expected = n ? decided.reduce((a, h) => a + h.pChosen, 0) / n : 0;
  const edge = winRate - expected;                          // how much better than the odds implied
  const pnl = decided.reduce((a, h) => a + h.delta, 0);

  const patterns = [
    ['Following A/B-grade whales', (h) => h.choice === 'follow' && /^(A\+?|B)$/.test(h.grade || '')],
    ['Following C-to-F whales', (h) => h.choice === 'follow' && /^(C|D|F)$/.test(h.grade || '')],
    ['Fading A/B-grade whales', (h) => h.choice === 'fade' && /^(A\+?|B)$/.test(h.grade || '')],
    ['Fading C-to-F whales', (h) => h.choice === 'fade' && /^(C|D|F)$/.test(h.grade || '')],
    ['Fading crowded trades', (h) => h.choice === 'fade' && (h.sig?.crowdFlow || 0) > 0.2],
    ['Following crowded trades', (h) => h.choice === 'follow' && (h.sig?.crowdFlow || 0) > 0.2],
    ['Siding with Smart Money flow', (h) => h.sig && Math.abs(h.sig.smFlow) > 0.2 && ((h.sig.smFlow > 0) === (h.choice === 'follow'))],
    ['Betting against Smart Money flow', (h) => h.sig && Math.abs(h.sig.smFlow) > 0.2 && ((h.sig.smFlow > 0) !== (h.choice === 'follow'))],
    ['Taking the favorite (odds under x2)', (h) => h.choice === h.modelSide],
    ['Taking the underdog (odds over x2)', (h) => h.choice !== h.modelSide],
  ].map(([label, test]) => {
    const hs = decided.filter(test);
    const w = hs.filter((h) => h.delta > 0).length;
    return { label, n: hs.length, winRate: hs.length ? w / hs.length : null, pnl: hs.reduce((a, h) => a + h.delta, 0) };
  });
  const rated = patterns.filter((x) => x.n >= 3);
  const strengths = rated.filter((x) => x.winRate >= 0.6).sort((a, b) => b.winRate - a.winRate || b.n - a.n).slice(0, 3);
  const leaks = rated.filter((x) => x.winRate <= 0.45).sort((a, b) => a.winRate - b.winRate || b.n - a.n).slice(0, 3);

  let level = 0;
  if (n >= 10) level = 1;
  if (n >= 20 && edge > 0) level = 2;
  if (n >= 30 && winRate >= 0.55 && edge >= 0.05 && pnl > 0) level = 3;
  const progress = level === 3 ? 1 : level === 0 ? n / 10 : level === 1 ? Math.min(1, n / 20) * (edge > 0 ? 1 : 0.6) : Math.min(1, n / 30) * Math.min(1, Math.max(0, edge) / 0.05);

  const advice = [];
  if (leaks[0]) advice.push(`Stop ${lc(leaks[0].label)}: you win only ${pct(leaks[0].winRate)} of those.`);
  if (strengths[0]) advice.push(`Lean into ${lc(strengths[0].label)}: you win ${pct(strengths[0].winRate)} of those.`);
  if (n >= 10 && edge < 0) advice.push('You are picking worse than the odds suggest. Read the tell after each hand before dealing the next.');

  return { hands: n, funHands, wins, winRate, expected, edge, pnl, patterns, strengths, leaks, advice,
    level: { index: level, name: LEVELS[level].name, next: LEVELS[level].need, progress: Math.max(0, Math.min(1, progress)) } };
}
