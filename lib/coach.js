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
    out.tell = { text: `The tell: ${SIGNALS[tell.k][tell.side]} favored ${tell.side === 'follow' ? 'following' : 'fading'}.`,
      stat: !t ? null : t.rate >= 0.55 ? `A reliable tell: right ${pct(t.rate)} of ${t.n} times this week.`
        : t.rate > 0.45 ? `Careful: this week it was a coin flip (right ${pct(t.rate)} of ${t.n} times), so don't lean on it alone.`
        : `Rare hit: this week it was right only ${pct(t.rate)} of ${t.n} times.` };
  }
  if (trap) {
    const t = track(trap.k, trap.side, samples);
    out.trap = { text: `The trap: ${SIGNALS[trap.k][trap.side]} favored ${trap.side === 'follow' ? 'following' : 'fading'}, and was wrong this time.`,
      stat: !t ? null : t.rate >= 0.55 ? `Normally a good signal (right ${pct(t.rate)} of ${t.n} times this week). Even good tells miss sometimes.`
        : `A weak signal anyway: right only ${pct(t.rate)} of ${t.n} times this week.` };
  }
  if (!tell && !trap) out.tell = { text: 'No strong signal this time. Price action decided it.', stat: null };
  return out;
}

/** Snapshot stored on each bet so the skill report can analyze decisions later. */
export function snapshot(f, pFollow, choice, grade, trust) {
  return { sig: f ? { walletEdge: f.walletEdge, smFlow: f.smFlow, crowdFlow: f.crowdFlow, funding: f.funding } : null,
    pChosen: choice === 'follow' ? pFollow : 1 - pFollow, modelSide: pFollow >= 0.5 ? 'follow' : 'fade', grade: grade || null,
    // The whale's tags, stored per hand so the profile can answer "which kinds of whale do you read
    // well?" later. Recorded at the moment of the decision: a whale can gain or lose a tag next week,
    // and the question is what was on the card when the player called it.
    tags: trust ? [trust.specialist && 'specialist', trust.early && 'early', trust.printer && 'printer', trust.scalper && 'scalper'].filter(Boolean) : [] };
}

// Every level is earned by reading better than the odds, never by playing more hands:
// a volume ladder would reward clicking, which is the opposite of what this teaches.
const LEVELS = [
  { name: 'Rookie', need: 'Play 10 hands to get your first reading' },
  { name: 'Apprentice', need: 'Beat the odds over 20+ hands' },
  { name: 'Whale Reader', need: '30+ hands, 55%+ wins and a +5% edge over the odds' },
  { name: 'Smart Money Hunter', need: 'Hold that +5% edge over 60+ hands' },
  { name: 'Market Operator', need: '' },
];

/**
 * A 0–100 skill score. 50 means "exactly as good as the odds said you'd be" — the scores measure
 * edge, not win rate, so an easy hand you were expected to win doesn't inflate them. Small samples
 * are pulled back toward 50 so three lucky hands don't read as mastery.
 */
function score(hs) {
  const n = hs.length;
  if (!n) return { score: null, n: 0, winRate: null };
  const wins = hs.filter((h) => h.delta > 0).length;
  const winRate = wins / n;
  const expected = hs.reduce((a, h) => a + h.pChosen, 0) / n;
  const shrink = n / (n + 8);
  const v = 50 + (winRate - expected) * 100 * shrink;
  return { score: Math.max(0, Math.min(100, Math.round(v))), n, winRate, expected };
}

// Each score is a slice of the same decision history. Nothing here is invented: every filter below
// reads a field the bet actually stored. (There is deliberately no "Risk Management" score —
// the game measures nothing that would honestly support one.)
const SKILLS = [
  { key: 'smartMoney', icon: '🧠', label: 'Smart Money Detection', blurb: 'Hands where Nansen Smart Money flow gave you a clear signal to read',
    test: (h) => h.sig && Math.abs(h.sig.smFlow) > 0.2 },
  { key: 'follow', icon: '🐋', label: 'Follow Accuracy', blurb: 'Every hand you decided to ride with the whale',
    test: (h) => h.choice === 'follow' },
  { key: 'fade', icon: '🧨', label: 'Fade Accuracy', blurb: 'Every hand you decided to bet against the whale',
    test: (h) => h.choice === 'fade' },
  { key: 'crowd', icon: '👀', label: 'Crowd Reading', blurb: 'Hands where the crowd was heavily on one side',
    test: (h) => h.sig && Math.abs(h.sig.crowdFlow) > 0.2 },
  { key: 'timing', icon: '🎯', label: 'Entry Timing', blurb: 'Live hands where the whale had already moved, for or against you, before you joined',
    test: (h) => h.live && h.late != null && Math.abs(h.late) > 1 },
  { key: 'short', icon: '⚡', label: 'Short-Term Trades', blurb: 'Four-hour bets on the Live Floor',
    test: (h) => h.live && Number(h.minutes) === 240 },
  { key: 'long', icon: '📈', label: 'Long-Term Trades', blurb: "Ride the Whale bets and training hands, both judged on the whale's real exit",
    test: (h) => !h.live || h.minutes === 'ride' },
];

/**
 * How the player scores against each KIND of whale.
 *
 * The patterns above already split by grade, which answers "do you trust good records too much". The
 * tags answer a different question the grade cannot: reading a whale who gets in before moves is not
 * the same skill as reading one who never holds. A player can be reliably good at one and reliably
 * wrong about another, and until this existed there was no way for them to find that out.
 *
 * Reported only once there is enough of a sample to mean anything, and the sample size is shown
 * beside every line so a 3-hand streak is never mistaken for a finding.
 */
const TAG_GROUPS = [
  { key: 'early', label: 'EARLY whales', blurb: 'In before the move, and hold for it', test: (h) => (h.tags || []).includes('early') },
  { key: 'printer', label: 'PRINTER whales', blurb: 'Small positions, outsized returns', test: (h) => (h.tags || []).includes('printer') },
  { key: 'scalper', label: 'SCALPER whales', blurb: 'Do not hold: in and out fast', test: (h) => (h.tags || []).includes('scalper') },
  { key: 'specialist', label: 'SPECIALIST whales', blurb: 'Few coins, expert in this one', test: (h) => (h.tags || []).includes('specialist') },
  { key: 'combo', label: 'Whales wearing two tags', blurb: 'The rarest cards on the table', test: (h) => (h.tags || []).length >= 2 },
  { key: 'untagged', label: 'Whales with no tag', blurb: 'Judged on grade and the tells alone', test: (h) => !(h.tags || []).length },
  { key: 'elite', label: 'A-grade whales', blurb: 'The records that look hardest to bet against', test: (h) => /^A\+?$/.test(h.grade || '') },
  { key: 'weak', label: 'C-to-F whales', blurb: 'Records that argue against following', test: (h) => /^(C|D|F)$/.test(h.grade || '') },
];
export function tagBreakdown(decided, minHands = 4) {
  return TAG_GROUPS.map((g) => {
    const hs = decided.filter(g.test);
    if (hs.length < minHands) return { ...g, n: hs.length, enough: false, winRate: null, edge: null, pnl: 0 };
    const wins = hs.filter((h) => h.delta > 0).length;
    const winRate = wins / hs.length;
    const expected = hs.reduce((a, h) => a + h.pChosen, 0) / hs.length;
    return { key: g.key, label: g.label, blurb: g.blurb, n: hs.length, enough: true,
      winRate, edge: winRate - expected, pnl: Math.round(hs.reduce((a, h) => a + h.delta, 0)) };
  });
}

/** Skill report from a player's decision history. */
export function report(p) {
  // Only decisions long enough to reflect how whales actually trade count toward skill:
  // training hands (judged on the whale's exit), 4-hour bets and Ride the Whale. 15-minute bets are just for fun.
  // Everything on the floor now runs to a real exit, so everything counts. The 15-minute exclusion is
  // kept only for hands played before the timed lanes were removed.
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

  // The trader profile: the same decisions, sliced into named skills and scored against the odds.
  const MIN_SCORED = 4;
  const scores = SKILLS.map((sk) => {
    const hs = decided.filter(sk.test);
    return { key: sk.key, icon: sk.icon, label: sk.label, blurb: sk.blurb, ...score(hs), ready: hs.length >= MIN_SCORED };
  });
  const ranked = scores.filter((x) => x.ready).sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const nextUp = scores.filter((x) => !x.ready).sort((a, b) => b.n - a.n)[0] || null;
  const overall = ranked.length ? Math.round(ranked.reduce((a, x) => a + x.score, 0) / ranked.length) : null;

  let level = 0;
  if (n >= 10) level = 1;
  if (n >= 20 && edge > 0) level = 2;
  if (n >= 30 && winRate >= 0.55 && edge >= 0.05 && pnl > 0) level = 3;
  if (n >= 60 && winRate >= 0.55 && edge >= 0.05 && pnl > 0) level = 4;
  const progress = level === 4 ? 1
    : level === 0 ? n / 10
    : level === 1 ? Math.min(1, n / 20) * (edge > 0 ? 1 : 0.6)
    : level === 2 ? Math.min(1, n / 30) * Math.min(1, Math.max(0, edge) / 0.05)
    : Math.min(1, n / 60) * Math.min(1, Math.max(0, edge) / 0.05);

  const advice = [];
  if (leaks[0]) advice.push(`Stop ${lc(leaks[0].label)}: you win only ${pct(leaks[0].winRate)} of those.`);
  if (strengths[0]) advice.push(`Lean into ${lc(strengths[0].label)}: you win ${pct(strengths[0].winRate)} of those.`);
  if (n >= 10 && edge < 0) advice.push('You are picking worse than the odds suggest. Read the tell after each hand before dealing the next.');

  // What to practise next: shore up the weakest scored skill, or finish opening an unscored one.
  let training = null;
  if (worst && worst.score < 50) training = `Work on ${worst.label}: ${MIN_SCORED * 2} more of those hands, reading the tell before each call.`;
  else if (nextUp) training = `${MIN_SCORED - nextUp.n} more ${nextUp.label} hand${MIN_SCORED - nextUp.n === 1 ? '' : 's'} to unlock that score.`;
  else if (best) training = `Your strongest read is ${best.label}. Take it to the Live Floor and see if it holds on real prices.`;

  const byTag = tagBreakdown(decided);
  const tagRated = byTag.filter((x) => x.enough);
  const tagBest = tagRated.slice().sort((a, b) => b.edge - a.edge)[0] || null;
  const tagWorst = tagRated.slice().sort((a, b) => a.edge - b.edge)[0] || null;
  // Only worth saying when the two ends actually differ: with one rated group, "best" and "worst"
  // are the same line and the sentence would be noise dressed up as insight.
  if (tagWorst && tagBest && tagWorst.key !== tagBest.key && tagWorst.edge < -0.03)
    advice.push(`You read ${tagBest.label} well (${pct(tagBest.winRate)} over ${tagBest.n}) but ${tagWorst.label} are costing you (${pct(tagWorst.winRate)} over ${tagWorst.n}).`);

  return { hands: n, funHands, wins, winRate, expected, edge, pnl, patterns, strengths, leaks, advice,
    byTag, tagBest, tagWorst,
    profile: { overall, scores, best, worst, training, minScored: MIN_SCORED },
    level: { index: level, name: LEVELS[level].name, next: LEVELS[level].need, progress: Math.max(0, Math.min(1, progress)), top: LEVELS.length - 1 } };
}
