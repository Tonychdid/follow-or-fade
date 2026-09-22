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
 *   DEALT     Every price the table actually quoted, logged when the hand was dealt. These are
 *             replays of trades that have already closed, so this is a record of what the table
 *             said, not a forecast made before the future. The model may have trained on some of
 *             those trades, so on its own it is a consistency check, not a clean test.
 *
 *   HELD OUT  The clean subset of DEALT: trades in a fixed 1-in-5 holdout, chosen by a hash of the
 *             trade itself, that the odds model is never allowed to train on. Priced by a model
 *             that never saw them. It starts empty the day it ships and grows with every hand.
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
 * Write down one prediction, at the moment the hand is dealt. The player does not know the outcome;
 * the server may, because a replay hand is a trade that has already closed. `ho` marks the held-out
 * trades the odds model never trains on, which is what makes that subset a clean test.
 * The wallet is recorded because the whole point of the comparison is which wallets these were, and
 * every address here is already public on the whale board. Failures are swallowed — an audit trail
 * must never be the reason a hand fails.
 */
/**
 * The permanent holdout. One trade in HOLDOUT_EVERY, picked by a hash of its own key, is never used
 * to fit the odds model (see calibrate() in game.js). A price quoted on one of these came from a
 * model that had never seen that trade, which is the only way a replay can be an honest test.
 * Deterministic on purpose: anyone re-running it on the published keys gets the same split.
 */
export const HOLDOUT_EVERY = 5;
export function isHoldout(key) {
  let h = 2166136261;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % HOLDOUT_EVERY) === 0;
}

export function record({ key, coin, side, address, pFollow, followWon, push }) {
  if (!key || !Number.isFinite(pFollow)) return false;
  return appendJsonl(JOURNAL, {
    at: new Date().toISOString(),
    coin: String(coin || '').slice(0, 24), side: side === 'Short' ? 'S' : 'L',
    addr: String(address || '').toLowerCase().slice(0, 44) || null,
    pool: qualifies(address),
    p: +pFollow.toFixed(4), won: !!followWon, push: !!push,
    ho: isHoldout(key),
  });
}

export const journal = (limit = 0) => readJsonl(JOURNAL, limit);
export const journalStats = () => jsonlStats(JOURNAL);

/**
 * Below this many wallets a cluster-robust error is unreliable - it is biased DOWNWARD, and a
 * too-small error bar is the one mistake this page must never make.
 */
const MIN_CLUSTERS = 20;

/** Normal tail, Abramowitz & Stegun 7.1.26 - accurate to ~1.5e-7, ample for a printed p-value. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
const pTwoSided = (z) => 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));

/**
 * The mean of something, and how much to trust it.
 *
 * Two standard errors are computed because the hands are not independent draws. 173 filtered hands
 * come from 64 wallets - about 2.7 hands each - and two hands from the same whale carry much of the
 * same information. Treating them as 173 independent observations quietly shrinks the error bar and
 * manufactures significance out of repetition.
 *
 *   seIid      textbook, pretends every hand is its own wallet.
 *   seCluster  cluster-robust, groups every hand by the wallet that made it.
 *
 * The reported `se` is the LARGER of the two, always. Where hands from one wallet really do move
 * together - the realistic case - the clustered figure is bigger and wins on its merits. Where it
 * comes out smaller, that is an artifact of too few clusters or an unnaturally balanced split rather
 * than genuine extra precision, and taking the max refuses the free lunch. The rule costs nothing
 * when it is not needed and cannot flatter the result when it is.
 */
export function meanStats(values, keys) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, se: null, seIid: null, seCluster: null, clusters: 0 };
  const mean = values.reduce((a, x) => a + x, 0) / n;
  const seIid = n > 1
    ? Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) / n)
    : null;
  // Sum the deviations WITHIN each wallet first, then square: that is what lets a wallet whose
  // hands all moved the same way count once rather than many times.
  const g = new Map();
  for (let i = 0; i < n; i++) {
    const k = keys?.[i] || `#${i}`; // a hand with no wallet on it is its own cluster
    g.set(k, (g.get(k) || 0) + (values[i] - mean));
  }
  const clusters = g.size;
  let seCluster = null;
  if (clusters > 1) {
    let ss = 0;
    for (const v of g.values()) ss += v * v;
    seCluster = Math.sqrt((clusters / (clusters - 1)) * ss) / n;
  }
  const se = seIid != null && seCluster != null ? Math.max(seIid, seCluster) : (seIid ?? seCluster);
  return { n, mean, se, seIid, seCluster, clusters, clustersLow: clusters < MIN_CLUSTERS };
}

/** A difference between two groups that share no wallets, with the verdict spelled out. */
const verdict = (diff, se) => ({
  diff, se,
  z: se > 0 ? diff / se : null,
  p: se > 0 ? pTwoSided(diff / se) : null,
  lo: se > 0 ? diff - 1.96 * se : null,
  hi: se > 0 ? diff + 1.96 * se : null,
  significant: se > 0 ? Math.abs(diff) > 1.96 * se : false,
});

const contrastVs = (A, B) => {
  if (!A.n || !B.n || A.se == null || B.se == null) return null;
  return verdict(A.mean - B.mean, Math.sqrt(A.se ** 2 + B.se ** 2));
};

/**
 * Filtered against ALL - and ALL contains filtered, so the two are not independent samples and
 * adding their errors in quadrature is simply the wrong sum. Rewritten as a weighted contrast over
 * the three groups that genuinely share nothing:
 *
 *   m_F - m_all  =  ( (N - nF)*m_F - nR*m_R - nU*m_U ) / N
 *
 * which is exact, and whose variance is the weighted sum of three independent variances.
 */
const contrastVsAll = (F, R, U) => {
  const N = F.n + R.n + U.n;
  if (!N || !F.n || F.mean == null || F.se == null) return null;
  const parts = [F, R, U];
  const c = [(N - F.n) / N, -R.n / N, -U.n / N];
  let v = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].n) continue;
    if (parts[i].se == null) return null;
    v += c[i] ** 2 * parts[i].se ** 2;
  }
  const mAll = (F.n * F.mean + R.n * (R.mean || 0) + U.n * (U.mean || 0)) / N;
  return verdict(F.mean - mAll, Math.sqrt(v));
};

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
export const price = (p) => Math.max(1.01, Math.floor((1 / p) * 100) / 100);

export function strategies(rows) {
  const r = scored(rows);
  const keys = r.map((x) => x.addr || null);
  const run = (pick) => {
    // Per-hand profit per 1 unit staked: the payout less the stake, or the stake lost.
    const rets = r.map((x) => {
      const win = pick === 'follow' ? x.won : !x.won;
      const pr = price(pick === 'follow' ? x.p : 1 - x.p);
      return win ? pr - 1 : -1;
    });
    if (!rets.length) return { n: 0, roi: null, se: null, winRate: null, clusters: 0 };
    const st = meanStats(rets, keys);
    return {
      n: st.n, roi: st.mean, se: st.se, seIid: st.seIid, seCluster: st.seCluster,
      clusters: st.clusters, clustersLow: st.clustersLow,
      winRate: rets.filter((x) => x > 0).length / rets.length,
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

  // Two measurements per population, because they answer different questions and can disagree.
  const keysOf = (set) => set.map((x) => x.addr || null);
  const retOf = (x) => (x.won ? price(x.p) - 1 : -1);
  const stat = (set) => ({
    ret: meanStats(set.map(retOf), keysOf(set)),
    win: meanStats(set.map((x) => (x.won ? 1 : 0)), keysOf(set)),
  });
  const sAll = stat(r), sF = stat(pass), sR = stat(fail), sU = stat(unknown);

  const cut = (set, st) => ({
    n: set.length,
    wallets: new Set(set.map((x) => x.addr).filter(Boolean)).size || null,
    follow: strategies(set).follow,
    winRate: st.win.mean,
    winRateSe: st.win.se,
    clusters: st.ret.clusters,
  });

  /**
   * Two claims, tested separately, because only one of them is hard.
   *
   * WIN RATE is the plain question: does backing this population pay off more often.
   * RETURN is the real test, because the odds already price in how good a wallet is - a whale with
   * a strong record is quoted at a shorter price, so merely picking better whales should NOT move
   * the return. A return gap that survives the pricing means the house rules are seeing something
   * the odds are not, and that is the only version of the claim worth making.
   *
   * Each is run against two comparisons: the raw population the player would copy blindly, and the
   * wallets the filters actively threw out. The second is the cleaner statistic - the groups share
   * no wallets - while the first is the question a player actually asks.
   */
  const tests = {
    winRate: { vsAll: contrastVsAll(sF.win, sR.win, sU.win), vsRejected: contrastVs(sF.win, sR.win) },
    return: { vsAll: contrastVsAll(sF.ret, sR.ret, sU.ret), vsRejected: contrastVs(sF.ret, sR.ret) },
  };

  // Four tests are run on the same hands, so a 5% bar on each is really a much looser bar on "any
  // of them". Holm's step-down adjustment keeps the family-wide error at 5%: sort by p, scale the
  // smallest by 4, the next by 3, and so on, never letting an adjusted p fall below the one before.
  // `significant` is judged on the adjusted p; the raw one is kept for anyone who wants it.
  const family = [tests.winRate.vsAll, tests.winRate.vsRejected, tests.return.vsAll, tests.return.vsRejected]
    .filter((t) => t && t.p != null).sort((a, b) => a.p - b.p);
  let prev = 0;
  family.forEach((t, i) => {
    const adj = Math.max(prev, Math.min(1, (family.length - i) * t.p));
    prev = adj;
    t.pRaw = t.p; t.pAdj = adj; t.significant = adj < 0.05;
  });

  return {
    all: cut(r, sAll), filtered: cut(pass, sF), rejected: cut(fail, sR),
    unknown: unknown.length, assessed: r.length - unknown.length,
    tests,
    // Kept under their old names so nothing that already reads this object breaks. Both are now
    // cluster-robust and use the exact overlapping-sample contrast rather than quadrature.
    difference: tests.return.vsAll?.diff ?? null,
    differenceSe: tests.return.vsAll?.se ?? null,
    significant: !!tests.return.vsAll?.significant,
  };
}

/**
 * The cross-validated half of the report, memoised.
 *
 * Ten gradient-descent fits over the whole training pool is real CPU - about 1.4s at a thousand
 * samples and 3.3s at twenty-five hundred - and this server is single-threaded, so computing it per
 * request would stall the table for everyone every time a judge refreshed the page. The inputs only
 * change when the hourly calibration runs, so it is computed once and reused, and `warm()` lets the
 * background job pay that cost off the request path instead of making a visitor wait for it.
 */
let cvCache = null;
const CV_TTL = 10 * 60e3;
export function crossValidatedReport(samples = []) {
  const key = samples.length;
  if (cvCache && cvCache.key === key && Date.now() - cvCache.at < CV_TTL) return cvCache.value;
  const cv = crossValidate(samples);
  const value = {
    n: cv.n, folds: cv.folds, tooSmall: cv.tooSmall,
    computedAt: new Date().toISOString(),
    reliability: reliability(cv.rows), brier: brier(cv.rows), strategies: strategies(cv.rows),
    populations: populations(cv.rows),
  };
  cvCache = { key, at: Date.now(), value };
  return value;
}
/** Recompute the expensive half now, so the next visitor is served from memory. */
export const warm = (samples = []) => { cvCache = null; return crossValidatedReport(samples); };

/** Everything the proof page and /api/proof serve. `samples` is the resolved training pool. */
export function report(samples = [], botRows = []) {
  const fwd = journal();
  const first = fwd.length ? fwd[0].at : null;
  return {
    generatedAt: new Date().toISOString(),
    forward: {
      n: fwd.length, scored: scored(fwd).length, since: first,
      pushes: fwd.filter((x) => x.push).length,
      reliability: reliability(fwd), brier: brier(fwd), strategies: strategies(fwd),
      populations: populations(fwd), file: journalStats(JOURNAL),
      clean: (() => {
        const c = fwd.filter((x) => x.ho === true);
        return { n: c.length, scored: scored(c).length, since: c.length ? c[0].at : null, every: HOLDOUT_EVERY,
          reliability: reliability(c), brier: brier(c), strategies: strategies(c), populations: populations(c) };
      })(),
    },
    crossValidated: crossValidatedReport(samples),
    bots: botRows.map((b) => ({ id: b.id, name: b.name, bets: b.bets, net: b.net, winRate: b.winRate,
      stake: b.stake, roi: b.bets ? b.net / (b.bets * b.stake) : null })),
    model: oddsEngine.getModel(),
  };
}
