/**
 * Grade v2, in SHADOW. Computed next to the live grade on every alert, reject-log row and whale-board
 * row, and never used by any gate. The Sep 24 panel (chair G2) found the live grade does not track
 * account performance (rank correlation with the account's month return about 0) and asked for a
 * grade that shrinks hard on small samples and caps on risk. Switching it live would restart the
 * forward sample, so it runs beside v1 until the pre-registered test (Oct 22: IC >= 0.05 and A+ > B
 * in 3 of 4 weeks) says otherwise.
 *
 * Formula (G2 chair, "Proposed v2 grade formula"):
 *   Score = 50
 *         + 15 * tanh(ROI30 * s / 0.06)                 Nansen anchor
 *         + 20 * tanh(s_d * Calmar30 / 2)               account return per drawdown
 *         +  7 * clip(ln(dPF) * s_d / ln 3, -1, 1)       daily profit factor
 *         +  3 * clip((WR_rt - 0.5) / 0.2, -1, 1)        round-trip win rate
 *         +  5 * tanh(acctRet7 * s_d / 0.10)             7D, account-based
 * then the lowest cap wins, and NR (unrated) overrides everything.
 *
 * Substitutions, where the data at hand is not what the chair specified:
 *   N_rt   round trips come from traderclass (30D of Hyperliquid fills, not the 45-60D the chair
 *          asked for). When a wallet is not classified yet, the chair's stop-gap is used:
 *          s = closed / (closed + 300) on Nansen's closing-fill count.
 *   s_d    active days come from the portfolio 'month' PnL history (days on which PnL moved). When
 *          the account could not be read, s_d falls back to s.
 *   WR_rt  round-trip wins from traderclass; without it, Nansen's fill win rate shrunk toward 50%
 *          by s, since fill win rates run 6-19 points above position win rates.
 *   dPF    from the daily PnL changes in the 'month' history (all products, not perp only).
 *   Account terms (Calmar, dPF, 7D) are 0 when the account could not be read; `partial` says so.
 *   7D veto uses the account 7D/30D returns; without them, Nansen's 7D and 30D realized PnL.
 *   Concentration cap uses the best COIN's 30D PnL as a stand-in for the best round trip.
 *   The A+ band's "top 12% of the board" percentile rule needs the whole board and is not applied.
 */
const tanh = Math.tanh;
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fin = (x) => x != null && Number.isFinite(+x);

export function bandOf(score) {
  return score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 62 ? 'B' : score >= 48 ? 'C' : score >= 35 ? 'D' : 'F';
}

/**
 * @param {object} p
 *   d30, d7      Nansen records (game.recordOf)
 *   cls          traderclass entry or null
 *   health       health.js reading or null
 *   holdsLosers  bool
 *   marketMaker  bool (v1 guard)
 *   specialist   truthy when the v1 specialist rule holds on this coin
 * @returns {{ scoreV2: number|null, gradeV2: string, v2: object }}
 */
export function gradeV2({ d30, d7, cls = null, health = null, holdsLosers = false, marketMaker = false, specialist = null } = {}) {
  if (!d30 || !d30.closed) return { scoreV2: null, gradeV2: '?', v2: { reason: 'no track record' } };
  const subs = [];
  const nRt = fin(cls?.closed) ? +cls.closed : null;
  const s = nRt != null ? nRt / (nRt + 20) : (subs.push('s:fills/300'), d30.closed / (d30.closed + 300));
  const h = health || null;   // an 'unknown' reading can still carry the half that was read
  const days = fin(h?.activeDays30) ? +h.activeDays30 : null;
  const sd = days != null ? days / (days + 10) : (subs.push('s_d:s'), s);

  const roi30 = +d30.roi || 0;
  const ret30 = fin(h?.ret30) ? +h.ret30 : null;
  const mdd30 = fin(h?.mdd30) ? +h.mdd30 : null;
  const ret7 = fin(h?.ret7) ? +h.ret7 : null;
  const daily = Array.isArray(h?.dailyPnl30) ? h.dailyPnl30.filter(fin).map(Number) : [];
  let wr;
  if (nRt != null && fin(cls?.winRate)) wr = (Math.round(cls.winRate * nRt) + 10) / (nRt + 20);
  else { subs.push('wr:nansen-shrunk'); wr = 0.5 + ((d30.winRate ?? 0.5) - 0.5) * s; }

  const tRoi = 15 * tanh((roi30 * s) / 0.06);
  const calmar = ret30 != null ? ret30 / Math.max(mdd30 ?? 0, 0.05) : null;
  const tCalmar = calmar != null ? 20 * tanh((sd * calmar) / 2) : 0;
  const pos = daily.filter((x) => x > 0).reduce((a, x) => a + x, 0);
  const neg = -daily.filter((x) => x < 0).reduce((a, x) => a + x, 0);
  const dPF = daily.length ? (neg > 0 ? pos / neg : pos > 0 ? Infinity : 1) : null;
  const lpf = dPF == null ? 0 : dPF === Infinity ? 1 : (Math.log(Math.max(dPF, 1e-9)) / Math.log(3)) * sd;   // no losing day: full marks
  const tPF = 7 * clip(lpf, -1, 1);
  const tWr = 3 * clip((wr - 0.5) / 0.2, -1, 1);
  const t7 = ret7 != null ? 5 * tanh((ret7 * sd) / 0.1) : 0;
  let score = 50 + tRoi + tCalmar + tPF + tWr + t7;
  const partial = ret30 == null || ret7 == null || dPF == null;

  // Caps: the lowest wins.
  const caps = [];
  const cap = (v, why) => { caps.push([v, why]); };
  if (mdd30 != null) { if (mdd30 >= 0.4) cap(61, 'MDD30>=40%'); else if (mdd30 >= 0.3) cap(74, 'MDD30>=30%'); else if (mdd30 >= 0.15) cap(84, 'MDD30>=15%'); }
  if (daily.length >= 5 && h?.medAv30 > 0) {
    const r = daily.map((x) => x / h.medAv30);
    const m = r.reduce((a, x) => a + x, 0) / r.length;
    const vol = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(365);
    if (vol > 1.5) cap(74, 'annVol30>150%');
  }
  if (fin(h?.upnlPct)) { if (h.upnlPct <= -0.3) cap(35, 'open loss<=-30%'); else if (h.upnlPct <= -0.15) cap(74, 'open loss<=-15%'); }
  if (holdsLosers) cap(74, 'holds losers');
  if (ret30 != null && ret30 < 0) cap(74, 'account 30D<0');
  if (ret30 != null && ret7 != null) { if (ret7 < 0 && ret30 > 0 && -ret7 > 0.5 * ret30) cap(74, '7D veto'); }
  else if (d7 && d7.closed && d7.pnl < 0 && d30.pnl > 0 && -d7.pnl > 0.5 * d30.pnl) { subs.push('7d:nansen'); cap(74, '7D veto'); }
  if (d30.best && d30.pnl > 0 && d30.best.pnl > d30.pnl) cap(74, 'concentration');
  if (fin(h?.ageDays)) { if (h.ageDays < 30) cap(61, 'age<30d'); else if (h.ageDays < 90) cap(74, 'age<90d'); else if (h.ageDays < 180) cap(84, 'age<180d'); }
  if (!specialist) {
    if ((d30.coins || 0) <= 2) cap(70, 'coins<=2');
    if (d7 && d7.closed && (d7.coins || 0) <= 1) cap(74, '7D coins<=1');
  }
  let capBy = null;
  for (const [v, why] of caps) if (score > v) { score = v; capBy = why; }
  score = Math.round(clip(score, 0, 100));

  // Unrated overrides everything: a market maker, or too thin a sample to grade at all.
  const nr = marketMaker ? 'market maker' : nRt != null && nRt < 8 ? 'under 8 round trips' : days != null && days < 7 ? 'under 7 active days' : null;
  return {
    scoreV2: score, gradeV2: nr ? 'NR' : bandOf(score),
    v2: { cap: capBy, nr, partial, subs, terms: { roi: +tRoi.toFixed(2), calmar: +tCalmar.toFixed(2), dpf: +tPF.toFixed(2), wr: +tWr.toFixed(2), d7: +t7.toFixed(2) } },
  };
}
