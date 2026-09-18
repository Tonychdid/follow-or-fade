// The odds engine. Nansen data -> probability that FOLLOWING a Smart Money trade wins -> betting odds.
// Starts from a sensible prior and self-calibrates on this week's resolved Smart Money trades.

export const FEATURES = ['walletEdge', 'smFlow', 'crowdFlow', 'funding', 'size'];
const PRIOR = { bias: 0, walletEdge: 2.0, smFlow: 0.8, crowdFlow: -0.3, funding: -0.25, size: 0.05 };
// No house edge: this is a learning game with play money, so the payout is the fair odds (1 / probability).
const HOUSE_EDGE = 0;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

let model = { ...PRIOR, n: 0, baseRate: null, updatedAt: null };
export const getModel = () => model;

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

export function probability(f) {
  let z = model.bias;
  for (const k of FEATURES) z += (model[k] || 0) * (f[k] || 0);
  return clamp(sigmoid(z), 0.15, 0.85);
}

export function odds(p) {
  return { follow: +((1 - HOUSE_EDGE) / p).toFixed(2), fade: +((1 - HOUSE_EDGE) / (1 - p)).toFixed(2) };
}

// ------------------------------------------------------------------ late entry (Live Floor only)
// On the Live Floor you enter at today's price, not the whale's. `late` = how far the whale's trade has already moved in its
// favour, in %, capped at ±5. Its weight starts at 0 (no assumption) and is learned from settled live bets, pulled toward 0.
let lateModel = { w: 0, n: 0, updatedAt: null };
export const getLateModel = () => lateModel;
export const lateFeature = (moveSinceEntry) => clamp((moveSinceEntry || 0) * 100, -5, 5);
export function lateAdjust(p, late) {
  return clamp(sigmoid(logit(clamp(p, 0.01, 0.99)) + lateModel.w * late), 0.15, 0.85);
}
/** rows: { late, pBase, followWon } from settled live bets. */
export function calibrateLate(rows) {
  rows = rows.filter((r) => Number.isFinite(r.late) && Number.isFinite(r.pBase) && typeof r.followWon === 'boolean');
  if (rows.length < 30) { lateModel = { ...lateModel, n: rows.length }; return lateModel; }
  let w = 0; const lambda = 20 / rows.length;
  for (let it = 0; it < 300; it++) {
    let g = 0;
    for (const r of rows) g += (sigmoid(logit(clamp(r.pBase, 0.01, 0.99)) + w * r.late) - (r.followWon ? 1 : 0)) * r.late;
    w -= 0.05 * (g / rows.length + lambda * w);
  }
  lateModel = { w: clamp(w, -0.6, 0.6), n: rows.length, updatedAt: new Date().toISOString() };
  return lateModel;
}
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
export const posAdjust = (p, pos) => clamp(sigmoid(logit(clamp(p, 0.01, 0.99)) + posModel.w * pos), 0.15, 0.85);
/** rows: { pos, pBase, followWon } from settled live bets. Pulled toward the prior, not toward zero. */
export function calibratePos(rows) {
  rows = rows.filter((r) => Number.isFinite(r.pos) && Number.isFinite(r.pBase) && typeof r.followWon === 'boolean');
  if (rows.length < 30) { posModel = { ...posModel, n: rows.length }; return posModel; }
  let w = posModel.w; const lambda = 20 / rows.length;
  for (let it = 0; it < 300; it++) {
    let g = 0;
    for (const r of rows) g += (sigmoid(logit(clamp(r.pBase, 0.01, 0.99)) + w * r.pos) - (r.followWon ? 1 : 0)) * r.pos;
    w -= 0.05 * (g / rows.length + lambda * (w - PRIOR_POS));
  }
  posModel = { w: clamp(w, -1, 1), n: rows.length, updatedAt: new Date().toISOString() };
  return posModel;
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
    text: `Smart Money money on ${coin} is net ${netLong ? 'long' : 'short'} right now (${longs} longs ${m(longsUsd)} vs ${shorts} shorts ${m(shortsUsd)}): ${f > 0 ? 'the money agrees with this trade' : 'the money is on the other side'}` };
}

/** Plain-words tell about the entry you'd get versus the whale's. */
export function lateReason(moveSinceEntry, side) {
  const m = (moveSinceEntry || 0) * 100;
  if (Math.abs(m) < 0.3) return { good: true, w: 0.2, text: `The whale opened close to today's price (${m >= 0 ? '+' : ''}${m.toFixed(2)}%): you'd enter almost where they did` };
  const learned = '';
  return m > 0
    ? { good: false, w: Math.min(1.5, m / 2), text: `The whale is already +${m.toFixed(2)}% from their entry: following now means joining late, with less room left${learned}` }
    : { good: true, w: Math.min(1.5, -m / 2), text: `The whale is ${m.toFixed(2)}% from their entry: following now gets you a better price than the whale${learned}` };
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

/** Fit logistic regression on resolved samples, with an L2 pull toward the prior (small samples stay sane). */
export function calibrate(samples) {
  const rows = samples.filter((s) => s.f && typeof s.win === 'boolean');
  if (rows.length < 15) return model;
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
  model = { ...w, n: rows.length, baseRate: base, updatedAt: new Date().toISOString() };
  return model;
}
