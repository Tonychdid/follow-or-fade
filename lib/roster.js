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
 * for wallets the scanner happened to look up the same day, so budget close to the full 267 a day: it
 * runs daily (Sep 24 decision; ROSTER_DAYS=7 goes back to weekly). Set ROSTER_DAYS=0 to switch it off. It also refuses
 * to start, and stops mid-run, when the daily cap is hit: a roster is never worth an alert.
 */
import * as nansen from './nansen.js';
import * as game from './game.js';
import * as excluded from './excluded.js';
import { assess } from './alerts.js';
import * as tclass from './traderclass.js';
import * as healthLib from './health.js';
import { load, save, appendJsonl, readJsonl } from './store.js';

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
// 0 disables the whole thing. Anything else is clamped to at least a day, because re-assessing a
// 30-day track record more often than daily spends credits to watch noise.
export const ROSTER_DAYS = () => {
  const raw = process.env.ROSTER_DAYS;
  const n = raw === undefined || raw === '' ? 1 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, n);
};
const LOOKBACK_H = () => Math.max(24, Number(process.env.ROSTER_LOOKBACK_HOURS || 168));
// Matches the printer floor, not the whale floor: a trader whose positions sit at $20k has to appear in
// the candidate list at all before they can be classified as one.
const MIN_USD = () => Math.max(0, Number(process.env.ROSTER_MIN_USD || 15000));
// The whale board's own top performers are let into the alert pool even when they miss a rule -
// that is the point of having a leaderboard. Ranked the way the board ranks (30-day return on
// closes), but only among wallets with a real sample behind the number: a +300% on two closed
// trades is a coin toss with a good story, and it must not be able to fire alerts at subscribers.
const LB_TOP = () => Math.max(0, Number(process.env.LEADERBOARD_ALERT_TOP ?? 50));
const LB_MIN_CLOSED = () => Math.max(0, Number(process.env.LEADERBOARD_MIN_CLOSED ?? 20));
// Read each wallet's Hyperliquid account during the sweep (free, a few light calls per wallet).
const ROSTER_HEALTH = () => process.env.ROSTER_HEALTH !== '0';

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
      const w = byWallet.get(t.trader_address) || { address: t.trader_address, trader: nansen.whaleName(t.trader_address_label, t.trader_address), coins: new Map(), trades: 0, volumeUsd: 0 };
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
    const recs = new Map();   // address -> the record each verdict was made on, for the second pass below
    for (const w of byWallet.values()) {
      if (nansen.isCapped()) break; // stop mid-run rather than starve the scanner
      const topCoin = [...w.coins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const [s30, s7] = await Promise.all([
        nansen.walletSummary(w.address, iso(now - 30 * DAY), iso(now)).catch(() => null),
        nansen.walletSummary(w.address, iso(now - 7 * DAY), iso(now)).catch(() => null),
      ]);
      if (!s30) continue; // a failed lookup is not a verdict; leave them out of this run entirely
      const rec = { d30: game.recordOf(s30), d7: game.recordOf(s7) };
      // The account behind the record (Hyperliquid, free): the health gate and the HOLDS LOSERS tag
      // apply to the pool exactly as they do to an alert. A read that fails leaves health unknown.
      const health = ROSTER_HEALTH() ? await healthLib.read(w.address).catch(() => null) : null;
      const holds = health ? await tclass.checkHoldsLosers(w.address, rec.d30, health).catch(() => null) : null;
      rec.health = health;
      rec.trust = game.trustGrade(rec.d30, rec.d7, topCoin, w.address, { health, ...(holds ? { holdsLosers: holds } : {}) });
      // Hand the real pace back to the classifier: it counts round trips and cannot derive this.
      tclass.notePace(w.address, rec.trust.tradesPerDay, rec.trust.grade, rec.trust.score);
      const v = assess(rec, topCoin);
      recs.set(w.address, rec);
      whales.push({
        address: w.address, trader: w.trader, topCoin, trades: w.trades, volumeUsd: Math.round(w.volumeUsd),
        qualifies: v.kind, reason: v.reason,
        grade: rec.trust.grade, score: rec.trust.score, scalper: !!rec.trust.scalper, tradesPerDay: rec.trust.tradesPerDay,
        specialist: !!rec.trust.specialist, early: !!rec.trust.early, printer: !!rec.trust.printer,
        earlyStats: rec.trust.earlyStats, printerStats: rec.trust.printerStats,
        holdsLosers: !!rec.trust.holdsLosers, holdsLosersWhy: rec.trust.holdsLosersWhy || null,
        gradeV2: rec.trust.gradeV2 ?? null, scoreV2: rec.trust.scoreV2 ?? null,
        health: health ? { status: health.status, upnlPct: health.upnlPct, ret30: health.ret30, ret7: health.ret7, notionalX: health.notionalX, at: health.at } : null,
        d30: { pnl: rec.d30.pnl, roi: rec.d30.roi, winRate: rec.d30.winRate, closed: rec.d30.closed, coins: rec.d30.coins, fees: rec.d30.fees },
        d7: rec.d7 && rec.d7.closed != null ? { pnl: rec.d7.pnl, roi: rec.d7.roi, winRate: rec.d7.winRate, closed: rec.d7.closed, coins: rec.d7.coins } : null,
      });
    }
    // Top performers, recomputed on every sweep, so the list adds and drops with the daily
    // assessment instead of being a one-off snapshot that goes stale.
    const eligible = whales.filter((w) => w.d30 && w.d30.roi != null && (w.d30.closed || 0) >= LB_MIN_CLOSED());
    const top = [...eligible].sort((a, b) => b.d30.roi - a.d30.roi).slice(0, LB_TOP());
    const topSet = new Set(top.map((w) => w.address));
    // Second pass. The first verdict was made before the ranking existed, so a wallet the board
    // rescues still read as "does not qualify" - and the board would have shown it a LEADERBOARD tag
    // and no IN THE POOL badge while it was busy firing alerts. `qualifies` has to mean "this whale
    // can reach you", not "this whale cleared the rules", or the badge is a lie. The tag still says
    // which door they came through.
    let rescued = 0;
    for (const w of whales) {
      w.leaderboard = topSet.has(w.address);
      if (!w.leaderboard || w.qualifies) continue;
      const v = assess(recs.get(w.address), w.topCoin, { onBoard: true });
      if (v.kind) { w.qualifies = v.kind; w.reason = v.reason; rescued++; }
      else w.reason = v.reason;   // on the board and still turned away: say why, it is the interesting case
    }
    // Written as its own file rather than read out of roster.json by the alert scanner: roster.js
    // already imports assess() from alerts.js, and importing back the other way would make boot
    // order load-bearing. A flat list of addresses has no such problem.
    save('alertboost', [...topSet]);
    console.log(`  Whale roster: leaderboard top ${top.length} (min ${LB_MIN_CLOSED()} closes) \u2014 ${rescued} of them are in on the board alone`);

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
      leaderboardTop: top.map((w) => w.address), leaderboardMinClosed: LB_MIN_CLOSED(),
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

/**
 * The public whale board: the last sweep, ranked, carrying only the fields a whale card already
 * shows. This costs NOTHING - every number here was paid for by the daily assessment and is sitting
 * in roster.json. Opt-outs are re-checked here rather than trusted from write time, because someone
 * can ask to be removed between two sweeps.
 *
 * Ranked on 30-day return on closed trades, and `closed` travels beside it on purpose: a big return
 * on three trades is not the same as the same return on three hundred, and the table says so.
 */
export function publicBoard() {
  const rows = (state.whales || [])
    .filter((w) => w.address && !excluded.isExcluded(w.address))
    .map((w) => {
      // The snapshot is re-assessed daily; the market-maker guard applies on read so a wallet graded
      // before the guard existed is not shown as A+ until the next run.
      const mm = (w.d30?.winRate ?? 0) >= 0.95 && (w.d30?.closed ?? 0) >= 200;
      const fast = !mm && !!w.scalper && (w.d30?.winRate ?? 0) >= 0.88 && (w.d30?.closed ?? 0) >= 200;
      const cap = mm || fast;
      // HOLDS LOSERS needs account data: the sweep's own reading, or a fresher one an alert just took.
      // Without either the tag is simply not shown; unknown is never "holds losers".
      const live = healthLib.peek(w.address);
      const hl8 = live ? tclass.holdsLosersOf(w.d30, live) : null;
      const holds = !cap && (hl8 ? hl8.holdsLosers || (!!w.holdsLosers && !!w.health) : !!w.holdsLosers && !!w.health);
      const bCap = holds && (w.score ?? 0) > 74;
      return {
      address: w.address, trader: nansen.whaleName(w.trader, w.address), topCoin: w.topCoin,
      grade: cap ? 'C' : bCap ? 'B' : w.grade, score: cap ? Math.min(w.score ?? 55, 55) : bCap ? 74 : w.score, marketMaker: mm, tooFast: fast,
      holdsLosers: holds, holdsLosersWhy: holds ? (hl8?.why || w.holdsLosersWhy || null) : null,
      gradeV2: w.gradeV2 ?? null, scoreV2: w.scoreV2 ?? null, health: w.health?.status ?? null,
      inPool: !!w.qualifies && !cap, via: cap ? null : w.qualifies || null,
      specialist: !!w.specialist, early: !!w.early, printer: !!w.printer, scalper: !!w.scalper,
      leaderboard: !!w.leaderboard,
      earlyStats: w.earlyStats || null, printerStats: w.printerStats || null, tradesPerDay: w.tradesPerDay ?? null,
      d30: w.d30 || null, d7: w.d7 || null,
    }; })
    .sort((a, b) => (b.d30?.roi ?? -Infinity) - (a.d30?.roi ?? -Infinity));
  return {
    at: state.at || null, finishedAt: state.finishedAt || null, runs: state.runs || 0,
    lookbackHours: state.lookbackHours ?? null, everyDays: ROSTER_DAYS(),
    demo: nansen.isDemo(), due: isDue(),
    leaderboardTop: LB_TOP(), leaderboardMinClosed: LB_MIN_CLOSED(),
    counts: { seen: rows.length, inPool: rows.filter((r) => r.inPool).length },
    whales: rows,
  };
}

let timer = null;
/** Check once an hour whether a re-assessment is due. Cheap: isDue() is a date comparison. */
export function schedule() {
  clearInterval(timer);
  if (ROSTER_DAYS() <= 0) return;
  timer = setInterval(() => { if (isDue()) assessPool().catch(() => {}); }, 3600e3);
  if (timer.unref) timer.unref();
}
