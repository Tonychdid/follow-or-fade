// The odds engine. Nansen data -> probability that FOLLOWING a Smart Money trade wins -> betting odds.
// Starts from a sensible prior and self-calibrates on this week's resolved Smart Money trades.

export const FEATURES = ['walletEdge', 'smFlow', 'crowdFlow', 'funding', 'size'];
const PRIOR = { bias: 0, walletEdge: 2.0, smFlow: 0.8, crowdFlow: -0.3, funding: -0.25, size: 0.05 };
// No house edge: this is a learning game with play money, so the payout is the fair odds (1 / probability).
const HOUSE_EDGE = 0;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
// NaN-safe: one bad upstream field must never turn into NaN odds and then a NaN bankroll.
const clamp = (x, a, b) => (Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : Math.max(a, Math.min(b, 0)));

let model = { ...PRIOR, n: 0, baseRate: null, updatedAt: null };
// Recalibration: one logit shift, fitted on hands already dealt and scored. See recalibrate() below.
let recal = { offset: 0, n: 0, raw: 0, fittedAt: null };
export const getModel = () => ({ ...model, recal });
export const getRecal = () => recal;

/** Turn raw Nansen responses into model features. dir = +1 for a Long, -1 for a Short. */
export function features({ side, valueUsd, wallet, sm, crowd }) {
  const dir = side === 'Long' ? 1 : -1;
  const closed = wallet?.closed_trade_count || 0;
  const shrink = closed / (closed + 20); // few trades -> trust the win rate less
  const wr = wallet?.win_rate ?? 0.5;
  const flow = (c) => (c && c.volume ? clamp((c.buy_sell_pressure || 0) / c.volume, -1, 1) * 5 : 0);
  const smNet = (c) => (c && c.smart_money_volume ? clamp(((c.smart_money_buy_volume || 0) - (c.smart_money_sell_volume || 0)) / c.smart_money_volume, -1, 1) * 2 : flow(c));
  return {
    walletEdge: clamp((wr - 0.5) * shrink, -0.3, 0.3),
    smFlow: clamp(smNet(sm) * dir, -1, 1),        // did Smart Money flow agree with this trade?
    crowdFlow: clamp(flow(crowd) * dir, -1, 1),  // did everyone else agree? (crowded trades fade)
    funding: clamp((crowd?.funding ?? sm?.funding ?? 0) * dir * 1e4, -3, 3), // + = this side pays funding
    size: clamp(Math.log10((valueUsd || 1e5) / 1e5), -1, 2),
  };
}

/** The fitted model alone, before recalibration. Recorded next to every dealt price. */
export function baseProbability(f) {
  let z = model.bias;
  for (const k of FEATURES) z += (model[k] || 0) * (f[k] || 0);
  return clamp(sigmoid(z), 0.15, 0.85);
}

/** The price the table quotes: the fitted model plus the recalibration shift. */
export function probability(f) {
  let z = model.bias + recal.offset;
  for (const k of FEATURES) z += (model[k] || 0) * (f[k] || 0);
  return clamp(sigmoid(z), 0.15, 0.85);
}

/**
 * Why the table needs a recalibration step.
 *
 * Cross-validated on the training pool, the model is well calibrated: it says 74%, those hands win
 * 73%. The hands the table actually DEALS won more than that: 79% against a quoted 69% on the first
 * 309 scored hands. At fair odds that gap is free money for anyone who follows every hand, and the
 * house bot doing exactly that was up 12% a hand. The dealt set is drawn from the most recent week,
 * while the training pool reaches back two, so the level drifts even when the ranking does not.
 *
 * So the level is fitted where it is used: one logit shift, chosen so that the probabilities quoted
 * on hands already dealt and scored match how often those hands won. It is fitted on the base-model
 * probability recorded with each hand (so a shift never feeds on itself), never on held-out hands,
 * shrunk toward zero while the sample is small, and bounded. On a time split of the journal (fit on
 * the older half, score the newer half) it moved Always Follow from +14% a hand to about zero and
 * cut the Brier score below the base-rate reference.
 */
export function recalibrate(rows, { prior = 60, bound = 1 } = {}) {
  const r = rows.filter((x) => Number.isFinite(x.p) && x.p > 0 && x.p < 1 && typeof x.won === 'boolean');
  if (r.length < 30) { recal = { offset: 0, n: r.length, raw: 0, fittedAt: new Date().toISOString() }; return recal; }
  let b = 0;
  for (let it = 0; it < 60; it++) {
    let g = 0, h = 0;
    for (const x of r) { const q = sigmoid(logit(x.p) + b); g += q - (x.won ? 1 : 0); h += q * (1 - q); }
    if (h <= 0) break;
    const step = g / h; b -= step;
    if (Math.abs(step) < 1e-7) break;
  }
  const shrunk = (b * r.length) / (r.length + prior);
  recal = { offset: +clamp(shrunk, -bound, bound).toFixed(4), n: r.length, raw: +b.toFixed(4), fittedAt: new Date().toISOString() };
  return recal;
}

/**
 * How far each Nansen-fed feature moved THIS hand's price, in percentage points of win probability:
 * the price with the feature, minus the price with that one feature set to neutral. The pieces do not
 * add up exactly to the total (the curve is not a straight line), which is why each is shown on its own.
 */
export function contributions(f) {
  const base = probability(f);
  return FEATURES.map((k) => ({ feature: k, weight: +(model[k] || 0).toFixed(3), value: +(f?.[k] || 0).toFixed(3),
    pp: +((base - probability({ ...f, [k]: 0 })) * 100).toFixed(1) }));
}

// Truncate rather than round: rounding up makes the two implied probabilities sum to under 1,
// which would quietly pay players more than fair odds on roughly half of all cards.
const price = (p) => Math.max(1.01, Math.floor(((1 - HOUSE_EDGE) / p) * 100) / 100);
export function odds(p) {
  p = Number.isFinite(p) ? clamp(p, 0.01, 0.99) : 0.5;
  return { follow: price(p), fade: price(1 - p) };
}

// How long the whales in the training pool actually hold, in minutes. The model predicts the sign of
// their return AT THEIR EXIT, so it only fully applies to a bet that also runs to their exit.
let refHoldMin = 360;
export const getHorizonRef = () => refHoldMin;
export function setHorizonRef(minutes) { if (Number.isFinite(minutes) && minutes >= 15) refHoldMin = clamp(minutes, 60, 2880); }
/**
 * A 15-minute price bet is not the same wager as riding the whale to their exit: over a short window the
 * whale's edge has barely had time to show up, so the read has to shrink toward a coin flip.
 * Signal grows roughly with sqrt(time), so the log-odds are scaled by sqrt(horizon / typical hold).
 */
export function horizonP(p, minutes) {
  if (!Number.isFinite(p)) return 0.5;
  if (minutes === 'ride' || minutes === null || minutes === undefined) return clamp(p, 0.15, 0.85);
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 0.5;
  const shrink = clamp(Math.sqrt(m / refHoldMin), 0, 1);
  return clamp(sigmoid(logit(clamp(p, 0.01, 0.99)) * shrink), 0.15, 0.85);
}
/** Odds for one product: the ride bet gets the full read, the timed tables get the shrunk one. */
export const oddsFor = (p, minutes) => odds(horizonP(p, minutes));

// ------------------------------------------------------------------ late entry (Live Floor only)
// On the Live Floor you enter at today's price, not the whale's. `late` = how far the whale's trade has already moved in its
// favour, in %, capped at ±5. Its weight starts at 0 (no assumption) and is learned from settled live bets, pulled toward 0.
let lateModel = { w: 0, n: 0, updatedAt: null };
export const getLateModel = () => lateModel;
export const lateFeature = (moveSinceEntry) => clamp((moveSinceEntry || 0) * 100, -5, 5);
// Where Smart Money's money sits on this coin right now (long dollars vs short dollars), from the whale's side.
// Live Floor only, because "right now" is not point-in-time data and must never touch the replay odds.
const PRIOR_POS = 0.3;
let posModel = { w: PRIOR_POS, n: 0, updatedAt: null };
export const getPosModel = () => posModel;
export function posFeature(positioning, side) {
  if (!positioning) return 0;
  const l = Math.abs(positioning.longsUsd || 0), s = Math.abs(positioning.shortsUsd || 0);
  if (l + s <= 0) return 0;
  return clamp(((l - s) / (l + s)) * (side === 'Long' ? 1 : -1), -1, 1); // + = the money agrees with this trade
}
// Both live-only signals are applied in ONE logit step with ONE clamp: adjusting twice in a row
// clamps the intermediate probability and quietly distorts the second adjustment.
export const liveAdjust = (p, late, pos) =>
  clamp(sigmoid(logit(clamp(p, 0.01, 0.99)) + lateModel.w * (late || 0) + posModel.w * (pos || 0)), 0.15, 0.85);

/** Fit both live weights together on settled live bets. rows: { late, pos, pBase, followWon }. */
export function calibrateLive(rows) {
  rows = rows.filter((r) => Number.isFinite(r.pBase) && typeof r.followWon === 'boolean')
    .map((r) => ({ late: Number.isFinite(r.late) ? r.late : 0, pos: Number.isFinite(r.pos) ? r.pos : 0, z: logit(clamp(r.pBase, 0.01, 0.99)), y: r.followWon ? 1 : 0 }));
  if (rows.length < 30) { lateModel = { ...lateModel, n: rows.length }; posModel = { ...posModel, n: rows.length }; return { lateModel, posModel }; }
  let wl = lateModel.w, wp = posModel.w; const lambda = 20 / rows.length;
  for (let it = 0; it < 300; it++) {
    let gl = 0, gp = 0;
    for (const r of rows) { const e = sigmoid(r.z + wl * r.late + wp * r.pos) - r.y; gl += e * r.late; gp += e * r.pos; }
    wl -= 0.05 * (gl / rows.length + lambda * wl);            // late is pulled toward 0: no prior belief
    wp -= 0.05 * (gp / rows.length + lambda * (wp - PRIOR_POS)); // positioning is pulled toward its prior
  }
  const at = new Date().toISOString();
  lateModel = { w: clamp(wl, -0.6, 0.6), n: rows.length, updatedAt: at };
  posModel = { w: clamp(wp, -1, 1), n: rows.length, updatedAt: at };
  return { lateModel, posModel };
}

/** Plain-words tell about the money already positioned on this coin. */
export function posReason(positioning, coin, side) {
  if (!positioning) return null;
  const f = posFeature(positioning, side);
  if (Math.abs(f) < 0.05) return null;
  const m = (x) => '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x);
  const { longs, shorts, longsUsd, shortsUsd } = positioning;
  const netLong = longsUsd > shortsUsd;
  return { good: f > 0, w: 0.5 + Math.abs(f),
    text: `Smart Money on ${coin} is net ${netLong ? 'long' : 'short'} right now (${longs} longs ${m(longsUsd)} vs ${shorts} shorts ${m(shortsUsd)}): ${f > 0 ? 'the money agrees with this trade' : 'the money is on the other side'}` };
}

/** Plain-words tell about the entry you'd get versus the whale's. */
/**
 * How late you are to this trade.
 *
 * `moveSinceEntry` is the whale's PROFIT, already flipped for the side: on a short, a price rise is a
 * negative number. Saying "the whale is -0.63% from their entry" therefore reads backwards on a short,
 * where the price is 0.63% ABOVE where they sold. So spell both out: which way the price actually went,
 * and what that means for the whale and for you.
 */
export function lateReason(moveSinceEntry, side) {
  const m = (moveSinceEntry || 0) * 100;      // + = the whale is in profit
  const short = side === 'Short';
  const raw = short ? -m : m;                 // + = the price went up
  const dir = raw >= 0 ? 'above' : 'below';
  const verb = short ? 'shorting' : 'buying';
  if (Math.abs(m) < 0.3) {
    return { good: true, w: 0.2,
      text: `The price is still within ${Math.abs(raw).toFixed(2)}% of where the whale opened: you'd get almost exactly their entry` };
  }
  return m > 0
    ? { good: false, w: Math.min(1.5, m / 2),
        text: `The price is ${Math.abs(raw).toFixed(2)}% ${dir} the whale's entry, so this ${side.toLowerCase()} is already ${m.toFixed(2)}% up: ${verb} now means joining late, with less of the move left` }
    : { good: true, w: Math.min(1.5, -m / 2),
        text: `The price is ${Math.abs(raw).toFixed(2)}% ${dir} the whale's entry, so this ${side.toLowerCase()} is ${Math.abs(m).toFixed(2)}% underwater: ${verb} now gets you a better entry than the whale got` };
}

/** Human-readable reasons, strongest first. */
export function reasons(f, ctx) {
  const out = [];
  const pct = (x) => `${Math.round(x * 100)}%`;
  if (ctx.wallet?.closed_trade_count) {
    out.push({ w: Math.abs(f.walletEdge) * 2, good: f.walletEdge >= 0,
      text: `This wallet won ${pct(ctx.wallet.win_rate)} of ${ctx.wallet.closed_trade_count} closed trades in the 30 days before` });
  }
  if (ctx.sm?.smart_money_volume || ctx.sm?.volume) out.push({ w: Math.abs(f.smFlow), good: f.smFlow >= 0,
    text: f.smFlow >= 0 ? `Smart Money flow on ${ctx.coin} agreed with this trade in the prior 24h` : `Smart Money flow on ${ctx.coin} was against this trade in the prior 24h` });
  if (ctx.crowd?.volume) out.push({ w: Math.abs(f.crowdFlow) * 0.6, good: f.crowdFlow < 0,
    text: f.crowdFlow >= 0 ? `The crowd was already piling in the same direction` : `The crowd was on the other side` });
  if (Math.abs(f.funding) > 0.2) out.push({ w: Math.abs(f.funding) * 0.3, good: f.funding < 0,
    text: f.funding > 0 ? `This side was paying funding` : `This side was getting paid funding` });
  if (ctx.positioning && !ctx.hidePositioningReason) {
    const { longsUsd, shortsUsd, longs, shorts } = ctx.positioning;
    const netLong = longsUsd > shortsUsd;
    const agrees = (ctx.side === 'Long') === netLong;
    const m = (x) => '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x);
    out.push({ w: 0.5, good: agrees, text: `Smart Money is net ${netLong ? 'long' : 'short'} ${ctx.coin} right now: ${longs} longs (${m(longsUsd)}) vs ${shorts} shorts (${m(shortsUsd)})` });
  }
  return out.sort((a, b) => b.w - a.w).slice(0, 3).map(({ good, text }) => ({ good, text }));
}

/**
 * The fit itself, as a pure function: rows in, weights out, nothing touched.
 *
 * Split out from calibrate() so the same arithmetic that prices a live hand can be re-run on a
 * subset of the data without disturbing the model the game is using. That is what makes honest
 * cross-validation possible - see lib/proof.js. Scoring the training set with the model fitted on
 * that same training set flatters itself, and a reliability curve built that way is worthless.
 */
export function fit(rows) {
  const base = rows.filter((r) => r.win).length / rows.length;
  const w = { ...PRIOR, bias: logit(clamp(base, 0.2, 0.8)) };
  const prior = { ...w };
  const lambda = 8 / rows.length, lr = 0.3;
  for (let it = 0; it < 400; it++) {
    const g = { bias: 0 }; FEATURES.forEach((k) => (g[k] = 0));
    for (const r of rows) {
      let z = w.bias; FEATURES.forEach((k) => (z += w[k] * r.f[k]));
      const err = sigmoid(z) - (r.win ? 1 : 0);
      g.bias += err; FEATURES.forEach((k) => (g[k] += err * r.f[k]));
    }
    w.bias -= lr * (g.bias / rows.length + lambda * (w.bias - prior.bias));
    FEATURES.forEach((k) => (w[k] -= lr * (g[k] / rows.length + lambda * (w[k] - prior[k]))));
  }
  return { ...w, baseRate: base };
}

/** The probability a given set of weights assigns, for weights that are not the live model. */
export function predictWith(w, f) {
  let z = w.bias;
  for (const k of FEATURES) z += (w[k] || 0) * (f?.[k] || 0);
  return clamp(sigmoid(z), 0.15, 0.85);
}

/** Fit logistic regression on resolved samples, with an L2 pull toward the prior (small samples stay sane). */
export function calibrate(samples) {
  const rows = samples.filter((s) => s.f && typeof s.win === 'boolean');
  if (rows.length < 15) return model;
  const w = fit(rows);
  model = { ...w, n: rows.length, updatedAt: new Date().toISOString() };
  return model;
}
