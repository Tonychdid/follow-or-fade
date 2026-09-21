/**
 * The whale roster: who currently clears the bar, who just walked in, and who dropped out.
 *
 * Nothing in this file changes which whales the game uses — the feed was already a rolling 7-day
 * window, so a whale who stops trading falls out on their own and a new one is picked up the moment
 * they appear. What was missing was the RECORD of it. Without a snapshot there is no way to answer
 * "who was in the pool last week", no way to see a good trader quietly degrade, and no way to tell
 * whether a rule change helped or just churned the list. This writes that snapshot on a schedule and
 * diffs it against the one before.
 *
 * Cost, measured on a live run: 131 wallets, 267 credits, 61 seconds. The 24h wallet cache only helps
 * for wallets the scanner happened to look up the same day, so budget close to the full 267 — about
 * 38 credits a day when it runs weekly. Set ROSTER_DAYS=0 to switch it off entirely. It also refuses
 * to start, and stops mid-run, when the daily cap is hit: a roster is never worth an alert.
 */
import * as nansen from './nansen.js';
import * as game from './game.js';
import * as excluded from './excluded.js';
import { assess } from './alerts.js';
import * as tclass from './traderclass.js';
import { load, save, appendJsonl, readJsonl } from './store.js';

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
// 0 disables the whole thing. Anything else is clamped to at least a day, because re-assessing a
// 30-day track record more often than daily spends credits to watch noise.
export const ROSTER_DAYS = () => {
  const raw = process.env.ROSTER_DAYS;
  const n = raw === undefined || raw === '' ? 7 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, n);
};
const LOOKBACK_H = () => Math.max(24, Number(process.env.ROSTER_LOOKBACK_HOURS || 168));
// Matches the printer floor, not the whale floor: a trader whose positions sit at $20k has to appear in
// the candidate list at all before they can be classified as one.
const MIN_USD = () => Math.max(0, Number(process.env.ROSTER_MIN_USD || 15000));

let state = load('roster', { at: null, whales: [], runs: 0 });
let running = false;

export const lastRoster = () => state;
export const rosterHistory = (limit = 20) => readJsonl('rosterjournal', limit);
export const isDue = () => ROSTER_DAYS() > 0 && (!state.at || Date.now() - Date.parse(state.at) >= ROSTER_DAYS() * DAY);

/**
 * Re-assess every wallet that opened a qualifying-size position in the lookback window.
 * `force` runs it even when it is not due yet (the admin button).
 */
export async function assessPool({ force = false } = {}) {
  if (running) return { skipped: 'already running' };
  if (ROSTER_DAYS() === 0 && !force) return { skipped: 'disabled (ROSTER_DAYS=0)' };
  if (!force && !isDue()) return { skipped: 'not due', nextDue: new Date(Date.parse(state.at) + ROSTER_DAYS() * DAY).toISOString() };
  if (nansen.isDemo()) return { skipped: 'demo mode' };
  if (nansen.isCapped()) return { skipped: 'daily Nansen credit cap reached' };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const trades = await nansen.smartMoneyOpens({ lookbackHours: LOOKBACK_H(), minValueUsd: MIN_USD() });
    // One entry per wallet, carrying the coin they traded most in the window — the specialist rule is
    // coin-specific, so assessing against a random one of their coins would reject real specialists.
    const byWallet = new Map();
    for (const t of trades) {
      if (!t.trader_address || excluded.isExcluded(t.trader_address)) continue;
      const w = byWallet.get(t.trader_address) || { address: t.trader_address, trader: t.trader_address_label || 'Smart Money whale', coins: new Map(), trades: 0, volumeUsd: 0 };
      w.coins.set(t.token_symbol, (w.coins.get(t.token_symbol) || 0) + 1);
      w.trades++; w.volumeUsd += +t.value_usd || 0;
      byWallet.set(t.trader_address, w);
    }
    // Re-score the early-finder and printer classes first, so the assessment below already sees them.
    // This reads Hyperliquid only — no Nansen credits — but it is the slow part of the run: one fills
    // call per wallet, serialised by the rate limiter.
    const cls = await tclass.classifyAll([...byWallet.keys()], {
      onProgress: (i, n) => console.log(`  Whale roster: classified ${i}/${n}`),
    }).catch((e) => { console.error('[roster] classify', e.message); return null; });
    if (cls) console.log(`  Whale roster: ${cls.early} early finders, ${cls.printer} printers among ${cls.scored} scored`);

    const now = Date.now();
    const whales = [];
    for (const w of byWallet.values()) {
      if (nansen.isCapped()) break; // stop mid-run rather than starve the scanner
      const topCoin = [...w.coins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const [s30, s7] = await Promise.all([
        nansen.walletSummary(w.address, iso(now - 30 * DAY), iso(now)).catch(() => null),
        nansen.walletSummary(w.address, iso(now - 7 * DAY), iso(now)).catch(() => null),
      ]);
      if (!s30) continue; // a failed lookup is not a verdict; leave them out of this run entirely
      const rec = { d30: game.recordOf(s30), d7: game.recordOf(s7) };
      rec.trust = game.trustGrade(rec.d30, rec.d7, topCoin, w.address);
      // Hand the real pace back to the classifier: it counts round trips and cannot derive this.
      tclass.notePace(w.address, rec.trust.tradesPerDay, rec.trust.grade, rec.trust.score);
      const v = assess(rec, topCoin);
      whales.push({
        address: w.address, trader: w.trader, topCoin, trades: w.trades, volumeUsd: Math.round(w.volumeUsd),
        qualifies: v.kind, reason: v.reason,
        grade: rec.trust.grade, score: rec.trust.score, scalper: !!rec.trust.scalper, tradesPerDay: rec.trust.tradesPerDay,
        specialist: !!rec.trust.specialist, early: !!rec.trust.early, printer: !!rec.trust.printer,
        earlyStats: rec.trust.earlyStats, printerStats: rec.trust.printerStats,
        d30: { pnl: rec.d30.pnl, roi: rec.d30.roi, winRate: rec.d30.winRate, closed: rec.d30.closed, coins: rec.d30.coins, fees: rec.d30.fees },
        d7: rec.d7 && rec.d7.closed != null ? { pnl: rec.d7.pnl, roi: rec.d7.roi, winRate: rec.d7.winRate, closed: rec.d7.closed, coins: rec.d7.coins } : null,
      });
    }
    const prev = state.whales || [];
    const prevIn = new Set(prev.filter((x) => x.qualifies).map((x) => x.address));
    const nowIn = new Set(whales.filter((x) => x.qualifies).map((x) => x.address));
    const entered = whales.filter((x) => x.qualifies && !prevIn.has(x.address))
      .map((x) => ({ address: x.address, trader: x.trader, grade: x.grade, scalper: x.scalper }));
    // "Left" means left the QUALIFYING set — either they failed a rule, or they stopped trading
    // altogether and never came back in the window. Both matter, and they are not the same thing.
    const left = prev.filter((x) => x.qualifies && !nowIn.has(x.address)).map((x) => {
      const still = whales.find((y) => y.address === x.address);
      return { address: x.address, trader: x.trader, grade: x.grade, why: still ? still.reason : 'no qualifying-size trades in the window' };
    });
    const summary = {
      at: startedAt, finishedAt: new Date().toISOString(), runs: (state.runs || 0) + 1,
      walletsSeen: whales.length, qualifying: nowIn.size,
      scalpers: whales.filter((x) => x.qualifies && x.scalper).length,
      early: whales.filter((x) => x.early).length, printer: whales.filter((x) => x.printer).length,
      // the ones the other rules would have turned away: what these two paths actually add
      earlyOnly: whales.filter((x) => x.qualifies === 'early').length,
      printerOnly: whales.filter((x) => x.qualifies === 'printer').length,
      entered, left,
      lookbackHours: LOOKBACK_H(), minUsd: MIN_USD(), everyDays: ROSTER_DAYS(),
    };
    tclass.flushPace();
    state = { ...summary, whales };
    save('roster', state);
    appendJsonl('rosterjournal', summary);   // the diff is the history; the full list lives in roster.json
    console.log(`  Whale roster: ${summary.qualifying}/${summary.walletsSeen} qualify (${summary.scalpers} scalpers, ${summary.early} early, ${summary.printer} printer) · +${entered.length} in, -${left.length} out`);
    if (summary.earlyOnly || summary.printerOnly) console.log(`    ${summary.earlyOnly} got in ONLY as early finders, ${summary.printerOnly} only as printers`);
    for (const l of left.slice(0, 5)) console.log(`    out: ${l.trader} (${l.address.slice(0, 10)}…) — ${l.why}`);
    return summary;
  } catch (e) {
    console.error('[roster]', e.message);
    return { error: e.message };
  } finally { running = false; }
}

let timer = null;
/** Check once an hour whether a re-assessment is due. Cheap: isDue() is a date comparison. */
export function schedule() {
  clearInterval(timer);
  if (ROSTER_DAYS() <= 0) return;
  timer = setInterval(() => { if (isDue()) assessPool().catch(() => {}); }, 3600e3);
  if (timer.unref) timer.unref();
}
