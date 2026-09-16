// The odds engine. Nansen data -> probability that FOLLOWING a Smart Money trade wins -> betting odds.
// Starts from a sensible prior and self-calibrates on this week's resolved Smart Money trades.

export const FEATURES = ['walletEdge', 'smFlow', 'crowdFlow', 'funding', 'size'];
const PRIOR = { bias: 0, walletEdge: 2.0, smFlow: 0.8, crowdFlow: -0.3, funding: -0.25, size: 0.05 };
const HOUSE_EDGE = 0.03;
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
  if (ctx.positioning) {
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
