/**
 * The proof desk.
 *
 * This product makes two claims a judge, a player or a sceptic is entitled to check:
 *
 *   1. The odds are honest — when the model says 60%, that side wins about 60% of the time.
 *   2. Reading the Nansen tells beats blindly copying Smart Money.
 *
 * Neither claim is worth anything asserted. So both are measured here, from data nobody gets to
 * tune after the fact, and the raw record is downloadable so every number on the page can be
 * recomputed by someone who does not trust it.
 *
 * The distinction this file exists to protect is in-sample versus out-of-sample. Scoring the
 * training set with the model that was fitted on that training set produces a beautiful curve and
 * means nothing. So there are exactly two kinds of evidence here and they are never mixed:
 *
 *   FORWARD   Every price the table actually quoted, written down before the outcome was known.
 *             Unfakeable by construction, and the only thing that can settle the argument.
 *             It starts at zero the day this ships and grows with every hand dealt.
 *
 *   K-FOLD    The 30-day training pool, cross-validated: fit on nine tenths, predict the tenth,
 *             rotate. Genuinely out-of-sample, available immediately, and reproducible because the
 *             folds are assigned by position rather than at random.
 *
 * An in-sample curve is deliberately not offered, at any size, under any label.
 */
import { readJsonl, appendJsonl, jsonlStats, load } from './store.js';
import * as oddsEngine from './odds.js';

const JOURNAL = 'predictions';
// A hand is a push when the whale's move was too small to call either way; it has no winner, so it
// is recorded (the count matters) and then excluded from every accuracy figure.
const scored = (rows) => rows.filter((r) => !r.push && typeof r.won === 'boolean' && Number.isFinite(r.p));

/**
 * Did this wallet clear the house rules?
 *
 * Read straight off the weekly roster snapshot already in memory rather than re-deriving it, so
 * asking the question costs nothing and cannot disagree with what the whale board is showing.
 *
 * Three answers, not two, and the difference matters. `true` passed. `false` was assessed and did
 * not. `null` means the roster has never looked at this wallet, which is not the same as failing
 * and is never quietly folded into either bucket.
 */
export function qualifies(address) {
  const a = String(address || '').toLowerCase();
  if (!a) return null;
  const whales = load('roster', { whales: [] })?.whales || [];
  if (!whales.length) return null;
  const w = whales.find((x) => String(x.address || '').toLowerCase() === a);
  return w ? !!w.qualifies : null;
}

/**
 * Write down one prediction, at the moment it is made and before the outcome is known to the player.
 * The wallet is recorded because the whole point of the comparison is which wallets these were, and
 * every address here is already public on the whale board. Failures are swallowed — an audit trail
 * must never be the reason a hand fails.
 */
export function record({ key, coin, side, address, pFollow, followWon, push }) {
  if (!key || !Number.isFinite(pFollow)) return false;
  return appendJsonl(JOURNAL, {
    at: new Date().toISOString(),
    coin: String(coin || '').slice(0, 24), side: side === 'Short' ? 'S' : 'L',
    addr: String(address || '').toLowerCase().slice(0, 44) || null,
    pool: qualifies(address),
    p: +pFollow.toFixed(4), won: !!followWon, push: !!push,
  });
}

export const journal = (limit = 0) => readJsonl(JOURNAL, limit);
export const journalStats = () => jsonlStats(JOURNAL);

/**
 * A reliability table: predictions grouped by what they claimed, against what actually happened.
 * This is the whole argument in one object — if `predicted` and `actual` track each other down the
 * column, the odds are fair; if they diverge, they are not, and the number says by how much.
 */
export function reliability(rows, edges = [0.15, 0.35, 0.45, 0.55, 0.65, 0.85]) {
  const r = scored(rows);
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    // Last bucket takes its upper edge, so a prediction at the clamp ceiling is not dropped.
    const inB = r.filter((x) => x.p >= lo && (i === edges.length - 2 ? x.p <= hi : x.p < hi));
    out.push({
      lo, hi, n: inB.length,
      predicted: inB.length ? inB.reduce((a, x) => a + x.p, 0) / inB.length : null,
      actual: inB.length ? inB.filter((x) => x.won).length / inB.length : null,
      // Binomial standard error on the observed rate: the honest width of "about".
      se: inB.length ? Math.sqrt(0.25 / inB.length) : null,
    });
  }
  return out;
}

/**
 * Brier score: mean squared error of the probabilities. Lower is better, 0 is perfect.
 *
 * Reported next to the score a model gets for ignoring every feature and always predicting the base
 * rate. That reference is the point: a Brier of 0.21 sounds bad and is excellent if always-guessing
 * scores 0.25, and sounds fine and is worthless if always-guessing scores 0.20.
 */
export function brier(rows) {
  const r = scored(rows);
  if (!r.length) return null;
  const base = r.filter((x) => x.won).length / r.length;
  return {
    n: r.length,
    score: r.reduce((a, x) => a + (x.p - (x.won ? 1 : 0)) ** 2, 0) / r.length,
    baseRate: base,
    reference: r.reduce((a, x) => a + (base - (x.won ? 1 : 0)) ** 2, 0) / r.length,
  };
}

/**
 * What blindly following, and blindly fading, actually returned — recomputed from the journal
 * rather than read off a counter, so the number on the page and the file you can download cannot
 * drift apart. Both strategies are deterministic given a recorded (p, won), which is exactly why
 * they are the right falsification test: nobody can tune them.
 *
 * `edge` is the honest headline. At fair odds it is zero. It is reported with its own standard
 * error because a run of 150 hands is a small sample and a page that hid that would be doing the
 * thing this page exists to stop.
 */
export function strategies(rows) {
  const r = scored(rows);
  const price = (p) => Math.max(1.01, Math.floor((1 / p) * 100) / 100);
  const run = (pick) => {
    // Per-hand profit per 1 unit staked: the payout less the stake, or the stake lost.
    const rets = r.map((x) => {
      const win = pick === 'follow' ? x.won : !x.won;
      const pr = price(pick === 'follow' ? x.p : 1 - x.p);
      return win ? pr - 1 : -1;
    });
    const n = rets.length;
    if (!n) return { n: 0, roi: null, se: null, winRate: null };
    const mean = rets.reduce((a, x) => a + x, 0) / n;
    const varr = n > 1 ? rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0;
    return {
      n, roi: mean, se: Math.sqrt(varr / n),
      winRate: rets.filter((x) => x > 0).length / n,
    };
  };
  return { follow: run('follow'), fade: run('fade') };
}

/**
 * K-fold cross-validation over the training pool.
 *
 * Folds are assigned by position after sorting by timestamp, not at random, so anyone re-running
 * this on the same data gets the same answer. Each sample is predicted exactly once, by a model
 * that never saw it.
 */
export function crossValidate(samples, k = 10) {
  const rows = samples.filter((s) => s.f && typeof s.win === 'boolean')
    .slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  if (rows.length < 50) return { rows: [], folds: 0, n: rows.length, tooSmall: true };
  const out = [];
  for (let i = 0; i < k; i++) {
    const test = rows.filter((_, j) => j % k === i);
    const train = rows.filter((_, j) => j % k !== i);
    if (train.length < 15 || !test.length) continue;
    const w = oddsEngine.fit(train);
    for (const s of test) out.push({ p: oddsEngine.predictWith(w, s.f), won: s.win, push: false,
      addr: s.address || null, pool: qualifies(s.address) });
  }
  return { rows: out, folds: k, n: rows.length, tooSmall: false };
}

/**
 * The comparison this whole desk exists for.
 *
 * Two populations, priced by the same model and settled the same way, so the only thing that differs
 * between them is which wallets were allowed in:
 *
 *   ALL       every Smart Money whale Nansen surfaced in the perp feed.
 *   FILTERED  only the ones that clear the house rules - grade, win rate, sample size, coins traded,
 *             profitable over both windows, plus the specialist / early / printer / board routes.
 *
 * If FILTERED does not beat ALL, the filters are decoration and this product should say so. That is
 * the entire claim, and it is the number the study is being recorded to answer.
 *
 * `unknown` is reported rather than hidden: a wallet the weekly roster has not assessed sits in ALL
 * and in neither of the other two, and pretending otherwise would flatter whichever side it landed on.
 */
export function populations(rows) {
  const r = scored(rows);
  const pass = r.filter((x) => x.pool === true);
  const fail = r.filter((x) => x.pool === false);
  const unknown = r.filter((x) => x.pool == null);
  const cut = (set) => ({
    n: set.length,
    wallets: new Set(set.map((x) => x.addr).filter(Boolean)).size || null,
    follow: strategies(set).follow,
    winRate: set.length ? set.filter((x) => x.won).length / set.length : null,
  });
  const all = cut(r), filtered = cut(pass);
  // The difference, and whether a difference that size could just be the sample talking. Two
  // independent means, so the standard errors add in quadrature.
  const se = all.follow.se != null && filtered.follow.se != null
    ? Math.sqrt(all.follow.se ** 2 + filtered.follow.se ** 2) : null;
  const diff = all.follow.roi != null && filtered.follow.roi != null
    ? filtered.follow.roi - all.follow.roi : null;
  return {
    all, filtered, rejected: cut(fail),
    unknown: unknown.length, assessed: r.length - unknown.length,
    difference: diff, differenceSe: se,
    significant: diff != null && se != null && se > 0 ? Math.abs(diff) > 1.96 * se : false,
  };
}

/** Everything the proof page and /api/proof serve. `samples` is the resolved training pool. */
export function report(samples = [], botRows = []) {
  const fwd = journal();
  const cv = crossValidate(samples);
  const first = fwd.length ? fwd[0].at : null;
  return {
    generatedAt: new Date().toISOString(),
    forward: {
      n: fwd.length, scored: scored(fwd).length, since: first,
      pushes: fwd.filter((x) => x.push).length,
      reliability: reliability(fwd), brier: brier(fwd), strategies: strategies(fwd),
      populations: populations(fwd), file: journalStats(JOURNAL),
    },
    crossValidated: {
      n: cv.n, folds: cv.folds, tooSmall: cv.tooSmall,
      reliability: reliability(cv.rows), brier: brier(cv.rows), strategies: strategies(cv.rows),
      populations: populations(cv.rows),
    },
    bots: botRows.map((b) => ({ id: b.id, name: b.name, bets: b.bets, net: b.net, winRate: b.winRate,
      stake: b.stake, roi: b.bets ? b.net / (b.bets * b.stake) : null })),
    model: oddsEngine.getModel(),
  };
}
