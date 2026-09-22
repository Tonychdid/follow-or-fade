// Whale Watch: scans Nansen Smart Money perp opens and alerts when a whale with a strong track record opens a position.
import crypto from 'node:crypto';
import * as nansen from './nansen.js';
import * as game from './game.js';
import * as agent from './agent.js';
import * as excluded from './excluded.js';
import * as hl from './hyperliquid.js';
import * as tclass from './traderclass.js';
import { load, save, appendJsonl } from './store.js';

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
const GRADE_RANK = { 'A+': 5, A: 4, B: 3, C: 2, D: 1, F: 0, '?': -1 };

const DEFAULTS = {
  enabled: true, minGrade: 'A', minWinRate: 0.55, minClosed: 20, minCoins7d: 3, minCoins30d: 5, allowSpecialists: true, minSizeUsd: 50000, requireProfit30d: true,
  // Quality rules that replace the old "no scalpers" blanket. Thresholds set from the live
  // distribution of 70 Smart Money whales (Sep 2026) — see the comment on qualifies().
  minRoi30d: 0.02, requireProfit7d: true, minPnlPerFee: 3, minPnlPerTrade: 10, requireCoinMajority: true,
  allowEarly: true, allowPrinter: true,
  intervalMin: 10, telegram: { token: '', chatId: '', botName: '' },
};
const cfg = load('alertcfg', DEFAULTS);
for (const [k, v] of Object.entries(DEFAULTS)) if (cfg[k] === undefined) cfg[k] = v;
// A saved config overrides DEFAULTS, so changing a default never reaches an existing deployment.
// The scan interval is the one default that costs real money, so it gets a hard floor instead:
// SCAN_MIN_MINUTES (default 10). Nansen's own feed lags more than the minutes this used to save.
const SCAN_FLOOR = Math.max(2, Number(process.env.SCAN_MIN_MINUTES) || 10);
// How old a trade may be and still earn its first alert. This used to be a hard-coded 45 minutes,
// written before stillOpen() existed, as a stand-in for "is this still actionable?". It is not the
// dedupe (`seen` is, and it persists), and it was silently dropping real signals: Nansen's feed lag
// regularly puts a qualifying trade past 45 minutes before the scanner ever sees it — the same
// failure that lost the SNDK alert. We now verify the position is still open directly, and measured
// 137 resolved trades: a player entering 4 HOURS after the whale's open earned MORE on average than
// one entering at the whale's exact price (3.16% vs 2.38%), with the median price still within 0.2%
// of the whale's entry. Lateness is priced into the odds by oddsEngine.lateFeature, not blocked.
const MAX_AGE_MS = Math.max(5, Number(process.env.ALERT_MAX_AGE_MIN) || 240) * 60e3;
const LOOKBACK_H = Math.max(1, Math.min(168, Number(process.env.ALERT_LOOKBACK_HOURS) || 6));
// Safety valve. A wider window means a scan can find several qualifying trades at once — most sharply
// on the first scan after widening it, when hours of trades are unseen. Nobody wants seven Telegram
// messages in one second. Newest first, the rest wait for the next scan (they stay unseen).
const MAX_PER_SCAN = Math.max(1, Number(process.env.ALERT_MAX_PER_SCAN) || 5);
if (!(cfg.intervalMin >= SCAN_FLOOR)) {
  console.log(`  Alert scan interval raised from ${cfg.intervalMin} to ${SCAN_FLOOR} min (SCAN_MIN_MINUTES)`);
  cfg.intervalMin = SCAN_FLOOR;
  save('alertcfg', cfg);
}
// The whale board's top performers, written by the weekly roster sweep. Read, never written, here.
const boosted = () => new Set(load('alertboost', []));
// A board top performer is forgiven ONE bad week, not an unravelling. The loss over the last 7 days
// may not exceed this share of the month's profit. Measured on the live board when this was written:
// of 19 top-50 wallets the house rules turn away, 18 had a profitable week and the 19th had lost 3%
// of its month - so this ceiling costs nothing today. It exists for the first wallet whose record is
// actually changing, which is exactly the case a 30-day ranking is slowest to notice.
const LB_MAX_DD = () => Math.max(0, Number(process.env.LEADERBOARD_MAX_7D_LOSS_PCT ?? 0.25));
const alerts = load('alerts', []);         // newest last
const seen = load('alertseen', {});        // tradeKey -> ts
const watches = load('alertwatch', []);    // alerted positions we keep following until the whale exits
for (let i = watches.length - 1; i >= 0; i--) if (watches[i].pending) watches.splice(i, 1);
// `busy` is an in-flight flag, not state. pushExitAlert saves the list from inside checkOne, so a watch
// that fired an alert went to disk with busy:true — and on the next boot checkOne returned immediately,
// every time, for ever. Those are exactly the watches players hold bets on. Clear it on load.
for (const w of watches) delete w.busy;
let lastScan = null, lastError = null, timer = null;

// ---------------------------------------------------------------- public Telegram subscribers
// Opening the alerts to everyone: anyone who sends /start to the bot gets the same alerts the
// operator gets, and /stop ends it. Off unless TELEGRAM_PUBLIC=1, so an existing private
// deployment stays private after an upgrade. Chat ids live in their own store and are never
// returned by publicConfig - a subscriber list is personal data, not configuration.
const TG_PUBLIC = process.env.TELEGRAM_PUBLIC === '1';
const TG_MAX_SUBS = Math.max(1, Number(process.env.TELEGRAM_MAX_SUBS) || 5000);
const subs = load('alertsubs', []);        // [{ id, at }]
const blocked = load('alertblocked', []);  // chat ids the operator removed: /start will not take them back
const isSub = (id) => subs.some((s) => s.id === String(id));
const isBlocked = (id) => blocked.includes(String(id));
const isOwner = (id) => !!cfg.telegram.chatId && String(id) === String(cfg.telegram.chatId);
function addSub(id) {
  id = String(id);
  if (isSub(id) || isBlocked(id) || subs.length >= TG_MAX_SUBS) return false;
  subs.push({ id, at: Date.now() });
  save('alertsubs', subs);
  return true;
}
function dropSub(id) {
  const i = subs.findIndex((s) => s.id === String(id));
  if (i < 0) return false;
  subs.splice(i, 1);
  save('alertsubs', subs);
  return true;
}
// Telegram allows roughly 30 messages a second across a bot, so send one at a time with a gap
// rather than firing the whole list at once. A chat that has blocked the bot or been deleted is
// removed on the spot: otherwise every future alert pays for the same dead chat again.
const DEAD_CHAT = /blocked|chat not found|deactivated|kicked|chat_id is empty|user is deactivated/i;
/**
 * Every whale message is built as Telegram HTML so the numbers can line up in a <pre> grid. That
 * buys a dashboard and costs a new way to fail: if one string slips through unescaped, Telegram
 * rejects the message outright and the alert is simply lost. So the formatting is never allowed to
 * be load-bearing - a parse error is caught, the tags are stripped, and the same message goes out
 * as plain text. Losing the alignment is a cosmetic problem; losing an exit alert on a position
 * somebody may be holding is not.
 */
const TG_PARSE_FAIL = /can't parse entities|unsupported start tag|can't find end|unmatched end tag|entity/i;
const stripHtml = (t) => String(t)
  .replace(/<\/?(?:b|strong|i|em|u|s|code|pre|tg-spoiler|blockquote)>/g, '')
  .replace(/<a\s+href="[^"]*">/g, '').replace(/<\/a>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
async function tgHtml(method, body, timeoutMs = 15e3) {
  try { return await tg(cfg.telegram.token, method, { ...body, parse_mode: 'HTML' }, timeoutMs); }
  catch (e) {
    if (!TG_PARSE_FAIL.test(e.message || '')) throw e;
    console.error(`  [telegram] ${method}: Telegram refused the formatting (${e.message}) — resending as plain text`);
    return tg(cfg.telegram.token, method, { ...body, text: stripHtml(body.text) }, timeoutMs);
  }
}
async function broadcast(payload) {
  if (!cfg.telegram.token || !subs.length) return;
  let sent = 0, dropped = 0;
  for (const s of [...subs]) {
    if (isOwner(s.id)) continue;   // the operator already had this message
    try { await tgHtml('sendMessage', { ...payload, chat_id: s.id }); sent++; }
    catch (e) { if (DEAD_CHAT.test(e.message || '')) { dropSub(s.id); dropped++; } }
    await new Promise((r) => setTimeout(r, 40));
  }
  if (sent || dropped) console.log(`  Telegram broadcast: ${sent} sent${dropped ? `, ${dropped} dead chat(s) removed` : ''} (${subs.length} subscribers)`);
}

export function publicConfig(canAdmin = true) {
  const { telegram, ...rest } = cfg;
  // the bot's @username only goes to the operator: visitors have no use for it and it invites noise
  const pairLink = telegram.botName && telegram.pairCode ? `https://t.me/${telegram.botName}?start=${telegram.pairCode}` : '';
  // When the alerts are open to everyone the bot's @username stops being operator-only: it is the
  // one thing a visitor needs. The pairing code stays admin-only - that still connects the operator.
  const open = TG_PUBLIC && !!telegram.token && !!telegram.botName;
  return { ...rest, telegram: { connected: !!(telegram.token && telegram.chatId), hasToken: !!telegram.token,
    public: open, botLink: open ? `https://t.me/${telegram.botName}` : '', subscribers: canAdmin ? subs.length : null,
    botName: canAdmin || open ? telegram.botName : '', pairCode: canAdmin ? telegram.pairCode || '' : '', pairLink: canAdmin ? pairLink : '' },
    lastScan: canAdmin ? lastScan : null, lastError: canAdmin ? lastError : null,
    estCreditsPerDay: Math.round((24 * 60) / cfg.intervalMin) * 5, canAdmin };
}

export function updateConfig(patch = {}) {
  if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
  if (Object.hasOwn(GRADE_RANK, patch.minGrade) && patch.minGrade !== '?') cfg.minGrade = patch.minGrade;
  if ([0, 0.5, 0.55, 0.6, 0.65, 0.7].includes(Number(patch.minWinRate))) cfg.minWinRate = Number(patch.minWinRate);
  if ([10000, 25000, 50000, 100000, 250000, 1000000].includes(Number(patch.minSizeUsd))) cfg.minSizeUsd = Number(patch.minSizeUsd);
  if ([2, 5, 10, 15, 30].includes(Number(patch.intervalMin))) cfg.intervalMin = Math.max(SCAN_FLOOR, Number(patch.intervalMin));
  if ([0, 2, 3, 4, 5, 8].includes(Number(patch.minCoins7d))) cfg.minCoins7d = Number(patch.minCoins7d);
  if ([0, 3, 4, 5, 8, 12].includes(Number(patch.minCoins30d))) cfg.minCoins30d = Number(patch.minCoins30d);
  if (typeof patch.allowSpecialists === 'boolean') cfg.allowSpecialists = patch.allowSpecialists;
  if (typeof patch.requireProfit30d === 'boolean') cfg.requireProfit30d = patch.requireProfit30d;
  // The quality rules that replaced the blanket "no scalpers". Same allow-list style as the rules
  // above: a patch is a request from the network, so only known keys with known values get through.
  if ([0, 10, 20, 50, 100].includes(Number(patch.minClosed))) cfg.minClosed = Number(patch.minClosed);
  if ([0, 0.01, 0.02, 0.03, 0.05, 0.1].includes(Number(patch.minRoi30d))) cfg.minRoi30d = Number(patch.minRoi30d);
  if (typeof patch.requireProfit7d === 'boolean') cfg.requireProfit7d = patch.requireProfit7d;
  if ([0, 1, 2, 3, 5, 10].includes(Number(patch.minPnlPerFee))) cfg.minPnlPerFee = Number(patch.minPnlPerFee);
  if ([0, 5, 10, 25, 50, 100].includes(Number(patch.minPnlPerTrade))) cfg.minPnlPerTrade = Number(patch.minPnlPerTrade);
  if (typeof patch.requireCoinMajority === 'boolean') cfg.requireCoinMajority = patch.requireCoinMajority;
  if (typeof patch.allowEarly === 'boolean') cfg.allowEarly = patch.allowEarly;
  if (typeof patch.allowPrinter === 'boolean') cfg.allowPrinter = patch.allowPrinter;
  save('alertcfg', cfg);
  schedule();
  return publicConfig();
}

export const listAlerts = (since = 0) =>
  alerts.filter((a) => a.t > since && !excluded.isExcluded(a.address)).slice(-50).reverse();

/**
 * Does this whale deserve an alert? Returns 'standard' | 'specialist', or null.
 *
 * Scalpers are welcome now — how long they hold says nothing about whether they are any good. What is
 * asked instead is that the WALLET is consistently profitable and not just churning. Measured across
 * 70 live Smart Money whales, these rules keep 51% of the cohort, three quarters of them scalpers:
 *   · ROI >= 2%      the cohort's median is 3.0% and its 25th percentile 1.5%, so this is "good, not lucky"
 *   · profitable over 7 DAYS as well as 30   one good month can be one good week; two windows is consistency
 *   · most of their top coins green          stops a single lucky coin carrying a losing book
 *   · PnL >= 3x fees paid, and >= $10 a trade
 *        The wash-trading guards. A wash trader racks up volume and nets roughly nothing after fees;
 *        a real one clears them many times over (cohort median 47x). Honest caveat: neither guard
 *        excluded anybody in the sample — no wash trading was present to catch. They are insurance.
 */
/**
 * The full verdict on a wallet: whether it qualifies, and when it does not, the FIRST rule it broke.
 *
 * The reason is not decoration. A roster that only says a whale dropped out is a roster nobody can
 * argue with; one that says "7D unprofitable" tells you whether the rules are working or whether
 * they just threw away a good trader on a bad week.
 */
export function assess(rec, coin, { onBoard = false } = {}) {
  const d30 = rec.d30, d7 = rec.d7, trust = rec.trust;
  const no = (reason) => ({ kind: null, reason });

  // ---- Integrity gates. These apply to EVERY path, early finders and printer included, because they
  // are not quality preferences — they are the tests that stop us pointing at a wash trader or at a
  // record too small to mean anything. Nothing buys an exemption from these.
  if (!d30 || d30.closed < cfg.minClosed) return no(`under ${cfg.minClosed} closed trades in 30D`);
  if (cfg.requireProfit30d && !(d30.pnl > 0)) return no('unprofitable over 30D');
  if (d30.fees > 0 && d30.pnl < d30.fees * (cfg.minPnlPerFee ?? 0)) return no(`profit only ${(d30.pnl / d30.fees).toFixed(1)}x fees (wash-trade guard)`);
  if (d30.closed > 0 && d30.pnl / d30.closed < (cfg.minPnlPerTrade ?? 0)) return no(`$${(d30.pnl / d30.closed).toFixed(2)} profit per trade (wash-trade guard)`);
  if (cfg.requireCoinMajority) {
    const top = Object.values(d30.perCoin || {});
    if (top.length && top.filter((c) => c.pnl > 0).length / top.length < 0.5) return no('fewer than half their coins were profitable');
  }

  // ---- The ordinary way in: good enough on the generic bars, or a proven specialist on this coin.
  const generic = () => {
    if ((d30.roi ?? 0) < (cfg.minRoi30d ?? 0)) return no(`30D return ${((d30.roi ?? 0) * 100).toFixed(2)}% is under ${((cfg.minRoi30d ?? 0) * 100).toFixed(2)}%`);
    if (cfg.requireProfit7d && !(d7 && d7.closed && d7.pnl > 0)) return no(d7 && d7.closed ? 'unprofitable over the last 7D' : 'no closed trades in the last 7D');
    const standard = GRADE_RANK[trust.grade] >= GRADE_RANK[cfg.minGrade]
      && (d30.winRate ?? 0) >= cfg.minWinRate
      // a high win rate on one or two coins is easy to inflate; require breadth
      && (d30.coins || 0) >= cfg.minCoins30d
      && ((rec.d7 && rec.d7.coins) || 0) >= cfg.minCoins7d;
    if (standard) return { kind: 'standard', reason: null };
    if (cfg.allowSpecialists && game.isSpecialist(d30, rec.d7, coin)) return { kind: 'specialist', reason: null };
    return no(GRADE_RANK[trust.grade] < GRADE_RANK[cfg.minGrade] ? `grade ${trust.grade} is below ${cfg.minGrade}`
      : (d30.winRate ?? 0) < cfg.minWinRate ? `win rate ${Math.round((d30.winRate ?? 0) * 100)}% is under ${Math.round(cfg.minWinRate * 100)}%`
      : (d30.coins || 0) < cfg.minCoins30d ? `only ${d30.coins || 0} coins in 30D, needs ${cfg.minCoins30d}`
      : `only ${(rec.d7 && rec.d7.coins) || 0} coins in 7D, needs ${cfg.minCoins7d}`);
  };
  const g = generic();
  if (g.kind) return g;   // they did not need the exemption, so the verdict records how they really got in

  // ---- Only now the two paths that exist BECAUSE those bars turn these traders away. Measured on
  // 143 wallets, the early finders rejected above fail on exactly the return and recent-week rules —
  // one with an 89% win rate over 6,531 trades, turned away for a 1.58% return; another for a single
  // losing week. `kind` here therefore means "in ONLY because of this path", which is what makes the
  // roster's count of what these two rules actually add an honest number.
  if (cfg.allowEarly !== false && trust.early) return { kind: 'early', reason: null };
  if (cfg.allowPrinter !== false && trust.printer) return { kind: 'printer', reason: null };
  // ---- And the whale board's own top performers. The rules are a filter, the board is a verdict -
  // but a verdict on thirty days, which is slow to notice a record coming apart. So the board route
  // waives every bar above EXCEPT a ceiling on the last week: lose more than LB_MAX_DD of the
  // month's profit in seven days and no ranking rescues you. A wallet that has simply not traded
  // this week has no loss to weigh and passes.
  if (onBoard) {
    const lost = d7 && d7.pnl < 0 ? -d7.pnl : 0;
    const budget = Math.max(0, d30.pnl) * LB_MAX_DD();
    if (lost <= budget) return { kind: 'leaderboard', reason: null };
    return no(`on the whale board, but last week cost ${Math.round((lost / d30.pnl) * 100)}% of the month's profit (ceiling ${Math.round(LB_MAX_DD() * 100)}%)`);
  }
  return g;
}
const qualifies = (rec, coin) => assess(rec, coin).kind;
export const alertConfig = () => cfg;

let scanning = false;
export async function scan({ force = false } = {}) {
  if (scanning) return []; // the interval can fire again while a slow scan is still walking its list
  if (!cfg.enabled && !force) return [];
  if (nansen.isCapped()) { lastError = 'Daily Nansen credit cap reached, scanner paused until midnight UTC'; return []; }
  lastScan = new Date().toISOString();
  scanning = true;
  try {
    // The size floor is asked of the FEED, which is why a small trader could never be alerted on no
    // matter what the rules said further down: their trades never arrived. Ask for everything from the
    // printer floor upward instead, then apply the whale floor per trade below. The feed costs the same
    // 5 credits at any floor — only the row count changes ($15k returned 438 opens in 7 days against
    // 321 at $50k) — so the widening is free until a trade is actually assessed.
    const floor = Math.min(cfg.minSizeUsd, tclass.PRINTER_MIN_USD());
    const trades = await nansen.smartMoneyOpens({ lookbackHours: LOOKBACK_H, pages: 1, perPage: 300, minValueUsd: floor });
    const lb = boosted();
    const unseen = trades.filter((t) => !seen[game.tradeKey(t)]);
    // First run on a fresh deployment: `seen` is empty, so every trade in the window looks new and the
    // whole window would go out as one burst. Adopt it silently instead and start alerting from here.
    if (!Object.keys(seen).length && unseen.length) {
      for (const t of unseen) seen[game.tradeKey(t)] = Date.now();
      save('alertseen', seen);
      console.log(`  Whale alerts: warm start, adopted ${unseen.length} existing trades without alerting`);
      return [];
    }
    const fresh = unseen
      .filter((t) => Date.now() - Date.parse(t.block_timestamp) < MAX_AGE_MS)
      // A trade under the whale floor is only worth looking at when the WALLET has already earned its
      // way in as an early finder or a printer. That check is a lookup in a map the roster wrote — no
      // Nansen call — so everything else is dropped here, before it can cost anything.
      .filter((t) => {
        if (+t.value_usd >= cfg.minSizeUsd) return true;
        if (lb.has(t.trader_address)) return true; // a board top performer is in on their record, not their size
        // isEarly(), not c.early: the size floor may only be waived for a pattern that is still current.
        const c = tclass.classOf(t.trader_address);
        return (cfg.allowEarly !== false && tclass.isEarly(t.trader_address)) || (cfg.allowPrinter !== false && !!c?.printer);
      })
      .sort((a, b) => Date.parse(b.block_timestamp) - Date.parse(a.block_timestamp))
      .slice(0, MAX_PER_SCAN);
    const created = [];
    const hour = game.ctxBucket(); // shared bucket: the same window as the live cards, so both hit one cache entry
    for (const t of fresh) {
      seen[game.tradeKey(t)] = Date.now();
      if (excluded.isExcluded(t.trader_address)) continue; // this trader asked not to appear
      if (!(Number(t.price_usd) > 0)) continue; // no usable entry price: every downstream line would read "undefined"

      // one alert per whale per coin every 2 hours
      if (alerts.some((a) => !a.kind && a.address === t.trader_address && a.coin === t.token_symbol && Date.now() - a.t < 2 * 3600e3)) continue;
      const [w30, w7] = await Promise.all([
        nansen.walletSummary(t.trader_address, iso(hour - 30 * DAY), iso(hour)).catch(() => null),
        nansen.walletSummary(t.trader_address, iso(hour - 7 * DAY), iso(hour)).catch(() => null),
      ]);
      const rec = { d30: game.recordOf(w30), d7: game.recordOf(w7) };
      rec.trust = game.trustGrade(rec.d30, rec.d7, t.token_symbol, t.trader_address);
      // A wallet the board ranks in its top performers is admitted even when a rule turns it away.
      // That is the whole point of ranking them: the rules are a filter, the board is a verdict.
      const onBoard = lb.has(t.trader_address);
      const kind = assess(rec, t.token_symbol, { onBoard }).kind;
      if (!kind) continue;
      const a = { id: crypto.randomUUID(), t: Date.now(), key: game.tradeKey(t), raw: t,
        // `tradeUsd` is the row Nansen handed us; `valueUsd` is what the whale actually holds, filled
        // in from Hyperliquid a few lines below. They are wildly different when a whale splits an
        // entry across many fills: one ZRO entry came through as a $25.4K row against a $142K buy,
        // and the alert told everyone $25.4K. The position is what a copier is sizing against, so
        // the position is what the headline carries.
        coin: t.token_symbol, side: t.side === 'Short' ? 'Short' : 'Long',
        tradeUsd: t.value_usd, valueUsd: t.value_usd, entryPrice: t.price_usd, openedAt: t.block_timestamp,
        trader: t.trader_address_label || 'Smart Money whale', address: t.trader_address, record: rec, specialist: rec.trust?.specialist || null,
        scalper: !!rec.trust?.scalper, tradesPerDay: rec.trust?.tradesPerDay ?? null,
        holdHours: rec.trust?.holdHours ?? null, shareUnder1h: rec.trust?.shareUnder1h ?? null,
        early: !!rec.trust?.early, printer: !!rec.trust?.printer, leaderboard: onBoard,
        // WHICH door they came through, not merely which tags they wear. The whole question the
        // study exists to answer is whether the early-finder and printer paths earn their place, and
        // that needs "would not have qualified otherwise" — a whale can carry the EARLY tag and still
        // have walked in on an ordinary A+ record.
        admittedVia: kind,
        holdHours: rec.trust?.holdHours ?? null, shareUnder1h: rec.trust?.shareUnder1h ?? null,
        earlyStats: rec.trust?.earlyStats || null, printerStats: rec.trust?.printerStats || null,
        belowWhaleFloor: +t.value_usd < cfg.minSizeUsd };
      alerts.push(a); created.push(a);
      // Nansen's feed lags, and an alert can fire hours after the trade. A fast whale can be out
      // before the signal lands. Never push a signal for a position the whale has already left: someone
      // may put real money behind it. Check first, and say so when we could not check.
      // This runs BEFORE pricing the card: pricing costs four Nansen calls, and a dead trade is not
      // worth paying for.
      const live = (!t._demo && !nansen.isDemo()) ? await stillOpen(a) : { open: true, checked: false };
      if (live.open === false) {
        for (const arr of [alerts, created]) { const i = arr.indexOf(a); if (i >= 0) arr.splice(i, 1); }
        console.log(`  Whale alert SKIPPED (whale already ${live.flipped ? 'flipped' : 'closed'}): ${a.side} ${a.coin} by ${a.trader}`);
        continue; // never shown anywhere: a dead trade is not a signal
      }
      // The position we just paid to look up IS the headline size. Nansen's feed hands back one trade
      // row at a time, so a whale that split an entry across 145 fills arrives looking like a fraction
      // of itself; sizing a copy against that row is sizing against the wrong number. The size bar is
      // re-judged here too, or a $142K entry reported as a $25.4K row gets stamped "under the $50K
      // bar" and the alert argues the opposite of the truth.
      if (Number.isFinite(live.valueUsd) && live.valueUsd > 0) {
        a.valueUsd = live.valueUsd;
        if (Number.isFinite(live.entryPx) && live.entryPx > 0) a.avgEntry = live.entryPx;
        a.belowWhaleFloor = a.valueUsd < cfg.minSizeUsd;
      }
      // price it now: the odds, the tells and current Smart Money positioning go into the alert itself
      const item = await game.buildLiveItem(t).catch(() => null);
      if (item) {
        a.read = { pFollow: item.pFollow, odds: item.odds, reasons: (item.reasons || []).slice(0, 3), positioning: item.positioning, moveSinceEntry: item.moveSinceEntry, mid: item.mid };
        a.base = { mid: item.mid, pFollow: item.pFollow, at: Date.now() }; // frozen: what the numbers were when the alert went out
      }
      a.unverifiedOnSend = live.checked === false || live.open == null;
      journal(a);   // after pricing, so priceAtAlert and pFollow are on the record
      sendTelegram(a).catch((e) => console.error('[telegram]', e.message));
      if (!t._demo && !nansen.isDemo()) watchAlert(a, live.sz).catch(() => {});
    }
    // housekeeping
    for (const [k, ts] of Object.entries(seen)) if (Date.now() - ts > 2 * DAY) delete seen[k];
    while (alerts.length > 200) alerts.shift();
    save('alerts', alerts); save('alertseen', seen);
    lastError = null;
    if (created.length) console.log(`  Whale alert: ${created.map((a) => `${a.record.trust.grade} ${a.side} ${a.coin}`).join(', ')}`);
    return created;
  } catch (e) {
    lastError = e.message;
    return [];
  } finally { scanning = false; }
}

// Alerted trades from the last 6 hours are pinned at the top of the Live Floor.
game.setAlertLookup((key) => alerts.find((a) => !a.kind && a.key === key) || null);
game.setExtraLive(() => alerts.filter((a) => Date.now() - Date.parse(a.openedAt) < 6 * 3600e3)
  .filter((a) => a.raw && !excluded.isExcluded(a.address)).slice(-4).map((a) => a.raw));

// ------------------------------------------------------------------ position updates (add / trim / exit)
// After a whale alert we keep reading that whale's Hyperliquid position:
//  - ADD when they grow the position by 50%+ since the last update (conviction),
//  - TRIM when they cut 25% / 50% / 75% from the peak,
//  - EXIT when they fully close, so nobody following the whale is left holding the bag.
/**
 * Is the whale still in the position the alert describes?
 * { open: true|false|null }  — null means we could not tell, which is NOT the same as closed.
 */
async function stillOpen(a) {
  const coin = await hl.resolveCoin(a.coin).catch(() => null);
  if (!coin) return { open: null, checked: false };
  // positionInfo costs exactly what positionSize costs (same Hyperliquid call) and carries the size
  // in dollars as well as the sign, which is the number the headline should have been using all along.
  const pos = await hl.positionInfo(a.address, coin).catch(() => null);
  if (pos == null || pos.szi == null) return { open: null, checked: false };
  const sz = pos.szi;
  const dir = a.side === 'Long' ? 1 : -1;
  if (Math.abs(sz) < 1e-12) return { open: false, checked: true, flipped: false, sz };
  if (Math.sign(sz) !== dir) return { open: false, checked: true, flipped: true, sz };
  return { open: true, checked: true, sz, valueUsd: pos.valueUsd, entryPx: pos.entryPx };
}

/**
 * The permanent record of what we told people, and what the whale did next.
 *
 * alerts.json keeps the last 200 and drops the rest, which is right for the UI and wrong for any
 * question asked in weeks rather than hours — "if we had copied every alert the moment it landed,
 * where would we be?". That question needs the entry you could actually have got, the whale's exit,
 * and enough about the whale to split scalpers from the rest and to settle two whales who disagree.
 * So every alert and every follow-up is also appended here, and nothing is ever trimmed.
 *
 * Addresses are already public on-chain and already shown in the product, so nothing new is exposed.
 * A trader who opts out stops producing alerts, so they stop producing journal lines too.
 */
function journal(a, extra = {}) {
  const r = a.record || {}, d30 = r.d30 || {}, d7 = r.d7 || {};
  const slim = (d) => (d && d.closed != null ? { pnl: d.pnl, roi: d.roi, winRate: d.winRate, closed: d.closed, coins: d.coins, fees: d.fees } : null);
  appendJsonl('alertjournal', {
    v: 2,                       // v1 rows predate admittedVia, holdHours and the tag detail below
    kind: a.kind || 'open',
    at: new Date(a.t || Date.now()).toISOString(),
    id: a.id, parentId: a.parentId || null, test: !!a.test,
    // who
    address: a.address, trader: a.trader,
    grade: r.trust?.grade ?? null, score: r.trust?.score ?? null,
    // Read from the alert first, the record second: the scan copies these onto the alert, other
    // paths (a test alert) do not, and a journal row missing the scalper flag is a row the study
    // has to throw away.
    scalper: a.scalper ?? !!r.trust?.scalper,
    // tradesPerDay is Nansen's closed_trade_count/30 — a FILL count, not a pace, and wrong by an
    // order of magnitude as a measure of how fast a whale trades. Kept for continuity with v1 rows;
    // holdHours is the figure the study should actually use for "does this whale hold".
    tradesPerDay: a.tradesPerDay ?? r.trust?.tradesPerDay ?? null,
    holdHours: a.holdHours ?? r.trust?.holdHours ?? null,
    shareUnder1h: a.shareUnder1h ?? r.trust?.shareUnder1h ?? null,
    specialist: !!a.specialist, specialistShare: a.specialist?.share ?? null,
    early: !!a.early, printer: !!a.printer, belowWhaleFloor: !!a.belowWhaleFloor,
    admittedVia: a.admittedVia ?? null,
    // Enough of each tag's evidence to split the results by strength later: an EARLY whale admitted
    // on one converted call and an exceptional record is a different animal from one with nine, and
    // averaging them together would hide whichever of the two actually works.
    earlyVia: a.earlyStats?.via ?? null,
    earlyFinds: a.earlyStats ? `${a.earlyStats.goodFinds}/${a.earlyStats.finds}` : null,
    earlyCapture: a.earlyStats?.capture ?? null,
    printerSize: a.printerStats?.medNotional ?? null,
    printerWinRate: a.printerStats?.winRate ?? null,
    printerMedRet: a.printerStats?.medRet ?? null,
    d30: slim(d30), d7: slim(d7),
    // what
    coin: a.coin, side: a.side, valueUsd: a.valueUsd, entryPrice: a.entryPrice, openedAt: a.openedAt,
    // the price a follower could actually have entered at, which is the mark when the alert went out
    // — NOT the whale's fill, which is already gone by then.
    priceAtAlert: a.base?.mid ?? null,
    pFollow: a.base?.pFollow ?? a.read?.pFollow ?? null,
    unverifiedOnSend: !!a.unverifiedOnSend,
    ...extra,
  });
}

const removeWatch = (w) => { const i = watches.indexOf(w); if (i >= 0) watches.splice(i, 1); }; // splice(-1,1) would drop someone else's watch
const ADD_STEP = 1.5, ADD_MIN_USD = 25000;
const STALE_AFTER = 5; // consecutive failed position reads before we warn (checkExits runs every 60s)
const TRIM_LEVELS = [0.25, 0.5, 0.75];
async function watchAlert(a, knownSz) {
  if (watches.some((w) => (w.address === a.address && w.coin === a.coin && !w.done) || w.alertId === a.id)) return;
  // placeholder first, so a scan and the startup backfill can't both add a watch for the same whale
  const w = { alertId: a.id, key: a.key, address: a.address, coin: a.coin, side: a.side, trader: a.trader, entryPrice: a.entryPrice,
    openedAt: a.openedAt, t: Date.now(), startSz: null, peak: 0, lastNotifiedSz: 0, trims: [], done: false, pending: true, misses: 0 };
  watches.push(w);
  // Nansen gives a bare ticker; Hyperliquid needs 'xyz:SNDK' for equity and other builder-dex perps.
  // Without this every lookup below quietly returns "nothing", which used to delete the watch and made
  // exit alerts impossible for stock perps.
  w.hlCoin = await hl.resolveCoin(a.coin).catch(() => null);
  const sz = knownSz !== undefined && knownSz !== null ? knownSz
    : (w.hlCoin ? await hl.positionSize(a.address, w.hlCoin).catch(() => null) : null);
  // A failed lookup is NOT a closed position. Keep the watch and let checkExits retry, or we go blind
  // on a whale somebody may have real money behind.
  if (sz == null) {
    Object.assign(w, { pending: false, unverified: true, startSz: null, peak: 0, lastNotifiedSz: 0 });
    console.error(`  [watch] cannot verify ${a.side} ${a.coin} by ${a.address.slice(0, 10)}… — ${w.hlCoin ? 'position lookup failed' : 'no Hyperliquid market found for this symbol'}; retrying`);
    save('alertwatch', watches);
    return;
  }
  if (Math.abs(sz) < 1e-12 || Math.sign(sz) !== (a.side === 'Long' ? 1 : -1)) { removeWatch(w); return; }
  Object.assign(w, { startSz: sz, peak: Math.abs(sz), lastNotifiedSz: Math.abs(sz), pending: false, unverified: false, misses: 0 });
  // keep the list short: drop finished watches first, then the oldest
  for (let i = 0; watches.length > 150 && i < watches.length; ) { if (watches[i].done) watches.splice(i, 1); else i++; }
  while (watches.length > 150) watches.shift();
  save('alertwatch', watches);
}

function pushExitAlert(w, extra) {
  const parent = alerts.find((x) => x.id === w.alertId);
  const a = { id: crypto.randomUUID(), t: Date.now(), key: w.key, coin: w.coin, side: w.side, trader: w.trader, address: w.address,
    entryPrice: w.entryPrice, openedAt: w.openedAt, valueUsd: parent?.valueUsd, record: parent?.record, raw: parent?.raw,
    specialist: parent?.specialist || null, intelLines: parent?.intelLines || [], read: parent?.read, parentId: w.alertId,
    // Carried from the opening alert, not recomputed: a follow-up must describe the SAME whale the
    // reader already met. Without these two the SPECIALIST/SCALPER tags silently vanished on exits.
    scalper: !!parent?.scalper, tradesPerDay: parent?.tradesPerDay ?? null, holdHours: parent?.holdHours ?? null,
    early: !!parent?.early, printer: !!parent?.printer, earlyStats: parent?.earlyStats || null, printerStats: parent?.printerStats || null,
    admittedVia: parent?.admittedVia ?? null, shareUnder1h: parent?.shareUnder1h ?? null,
    // The Telegram message id of the alert that opened this thread. A trim or an exit is meaningless
    // if you cannot tell WHICH position it belongs to, so the follow-up is sent as a reply to it and
    // Telegram renders the original above it, one tap away.
    rootMessageId: parent?.messageId ?? null, ...extra };
  a.base = { mid: extra.markPx ?? extra.exitPx ?? parent?.read?.mid ?? w.entryPrice, pFollow: parent?.read?.pFollow ?? null, at: Date.now() };
  alerts.push(a); while (alerts.length > 200) alerts.shift();
  save('alerts', alerts);
  save('alertwatch', watches); // the watch's new state goes down with the alert, so a crash can't replay it
  journal(a, { exitPx: extra.exitPx ?? null, markPx: extra.markPx ?? null, whaleRet: extra.whaleRet ?? null,
    heldMs: extra.heldMs ?? null, trimPct: extra.trimPct ?? null, remainingPct: extra.remainingPct ?? null,
    multiple: extra.multiple ?? null, sizeNow: extra.sizeNow ?? null, exitExact: extra.exitExact ?? null });
  sendExitTelegram(a).catch((e) => console.error('[telegram]', e.message));
  console.log(`  Whale ${a.kind}: ${a.trader} ${a.side} ${a.coin}${a.kind === 'trim' ? ` -${Math.round(a.trimPct * 100)}%` : a.kind === 'add' ? ` now ${a.multiple.toFixed(1)}x` : ''}`);
  return a;
}

let checking = false, checkingSince = 0;
const CHECK_TIMEOUT = 45e3; // a single whale may not hold the loop longer than this
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export async function checkExits() {
  // A hung pass used to block every later pass forever, because `checking` never cleared. If a pass has
  // been running far too long, assume it is wedged and start a fresh one rather than going silent.
  if (checking && Date.now() - checkingSince < 5 * 60e3) return;
  checking = true; checkingSince = Date.now();
  try {
    const live = watches.filter((w) => !w.done && !w.pending);
    // Run in small batches: 150 serial position reads took longer than the interval, so a busy list
    // delayed every exit behind it. Each whale is also capped, so one slow read cannot wedge the pass.
    const BATCH = 8;
    for (let i = 0; i < live.length; i += BATCH) {
      await Promise.all(live.slice(i, i + BATCH).map((w) => withTimeout(checkOne(w), CHECK_TIMEOUT)
        .catch(() => { w.misses = (w.misses || 0) + 1; if (w.misses === STALE_AFTER) { w.unverified = true; warnStale(w).catch(() => {}); } })));
    }
    save('alertwatch', watches);
  } finally { checking = false; }
}

async function checkOne(w) {
      // Two passes can overlap once the wedge-watchdog starts a fresh one, and both would happily
      // detect the same exit and fire an exit alert. One pass per watch at a time.
      if (w.busy) return;
      w.busy = true;
      try {
      if (w.done || w.pending) return;
      // A watch would keep polling and minting NEW alerts naming a trader who has objected.
      if (excluded.isExcluded(w.address)) { w.done = true; return; }
      if (Date.now() - w.t > 14 * DAY) { w.done = true; w.expired = true; return; }
      const hlCoin = w.hlCoin ??= await hl.resolveCoin(w.coin).catch(() => null);
      const pos = hlCoin ? await hl.positionInfo(w.address, hlCoin).catch(() => null) : null;
      if (!pos) {
        // Never silently skip: count the misses and say so, rather than letting a whale exit unnoticed.
        w.misses = (w.misses || 0) + 1;
        if (w.misses === STALE_AFTER) { w.unverified = true; warnStale(w).catch(() => {}); }
        return;
      }
      if (w.unverified || w.misses) { w.misses = 0; w.unverified = false; }
      // A watch created while the lookup was failing has no baseline yet: take it now.
      if (w.startSz == null) {
        const szi0 = pos.szi, dir0 = w.side === 'Long' ? 1 : -1;
        if (Math.abs(szi0) < 1e-12 || Math.sign(szi0) !== dir0) { w.done = true; return; } // closed before we ever saw it
        Object.assign(w, { startSz: szi0, peak: Math.abs(szi0), lastNotifiedSz: Math.abs(szi0) });
      }
      const sz = pos.szi;
      const dir = w.side === 'Long' ? 1 : -1;
      const open = Math.abs(sz) > 1e-12 && Math.sign(sz) === dir;
      if (!open) {
        const mark = await hl.mid(hlCoin).catch(() => null);
        const ex = await hl.whaleExit(w.address, hlCoin, w.t - 60e3, Date.now() - w.t + 120e3, w.startSz, false).catch(() => null);
        const exitPx = ex?.closed ? ex.exitPx : mark;
        w.done = true; w.closedAt = Date.now();
        pushExitAlert(w, { kind: 'exit', exitPx, markPx: mark, exitExact: !!ex?.closed,
          whaleRet: exitPx && w.entryPrice ? dir * (exitPx - w.entryPrice) / w.entryPrice : null, heldMs: Date.now() - Date.parse(w.openedAt) });
        return;
      }
      const abs = Math.abs(sz);
      w.lastNotifiedSz ??= Math.abs(w.startSz);
      if (abs > w.peak) { w.peak = abs; w.trims = []; } // new high: trims are measured from here
      const addedUsd = (abs - w.lastNotifiedSz) * (pos.entryPx || 0);
      if (abs >= w.lastNotifiedSz * ADD_STEP && addedUsd >= ADD_MIN_USD) {
        const mark = await hl.mid(hlCoin).catch(() => null);
        pushExitAlert(w, { kind: 'add', addedSz: abs - w.lastNotifiedSz, sizeNow: abs, multiple: abs / Math.abs(w.startSz), valueUsd: pos.valueUsd,
          avgEntry: pos.entryPx, markPx: mark, upnl: pos.upnl, whaleRet: mark && pos.entryPx ? dir * (mark - pos.entryPx) / pos.entryPx : null, heldMs: Date.now() - Date.parse(w.openedAt) });
        w.lastNotifiedSz = abs;
        return;
      }
      const trimmed = 1 - Math.abs(sz) / w.peak;
      const level = TRIM_LEVELS.filter((l) => trimmed >= l - 0.02 && !w.trims.includes(l)).pop();
      if (level != null) {
        TRIM_LEVELS.filter((l) => l <= level).forEach((l) => { if (!w.trims.includes(l)) w.trims.push(l); });
        const mark = await hl.mid(hlCoin).catch(() => null);
        pushExitAlert(w, { kind: 'trim', trimPct: trimmed, remainingPct: 1 - trimmed, markPx: mark, sizeNow: abs, valueUsd: pos.valueUsd, avgEntry: pos.entryPx, upnl: pos.upnl,
          whaleRet: mark && w.entryPrice ? dir * (mark - w.entryPrice) / w.entryPrice : null, heldMs: Date.now() - Date.parse(w.openedAt) });
      }
      } finally { w.busy = false; }
}

/** Alerts from the last 48h without a watch (e.g. sent before this feature) start being followed from their current size. */
export async function backfillWatches() {
  if (nansen.isDemo()) return;
  for (const a of alerts.filter((x) => !x.kind && !x.test && Date.now() - x.t < 2 * DAY)) {
    if (watches.some((w) => w.alertId === a.id)) continue;
    await watchAlert(a).catch(() => {});
  }
}
export const watching = () => watches.filter((w) => !w.done).length;

const hrsTxt = (ms) => { const h = ms / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`; };
/**
 * ---------------------------------------------------------------- the message, as a dashboard
 * Telegram HTML mode. Only &, < and > carry meaning there, and every string that reaches a message
 * from Nansen - a trader label, a coin symbol, an Agent's prose - goes through esc() on the way in.
 * This is not cosmetic: one bare "<" in a wallet label is enough for Telegram to refuse the whole
 * message, and a refused message is a lost alert on a position somebody may be holding.
 */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Telegram renders <pre> in a monospace font, which is the only way to get columns that line up on
 * both a phone and a desktop. 29 characters is the widest block that fits a 390px phone without
 * sideways scrolling, so the grid is built to that and no wider.
 *
 * Padding happens BEFORE escaping on purpose: esc() turns "&" into "&amp;", which is five
 * characters of source for one character on screen. Pad first and the column is right; pad after
 * and every row with an ampersand in it is four characters out.
 */
const LBL = 11, COL = 9;
const gRow = (label, ...cols) => esc(String(label).padEnd(LBL) + cols.map((c) => String(c).padStart(COL)).join(''));
/** A one-value row for the follow-up messages, where a value can be as wide as "1,234,567.8 PEPE". */
const kvRow = (label, value) => esc(String(label).padEnd(10) + String(value).padStart(14));

const signed = (n) => (n >= 0 ? '+' : '');
const DASH = '—';
// Missing values print as plain ASCII "n/a" rather than an em dash: inside a <pre> block an em
// dash is not guaranteed to occupy exactly one monospace cell, and one wide glyph knocks a whole
// column out of line on the phone it was widest on.
const NA = 'n/a';
const money$ = (n) => (n == null ? NA : signed(n) + money(n));
const pctOf = (n, d = 1) => (n == null ? NA : signed(n) + (n * 100).toFixed(d) + '%');
const rateOf = (n) => (n == null ? NA : Math.round(n * 100) + '%');
const intOf = (n) => (n == null ? NA : String(n));
/**
 * A price a human can read at a glance: six significant figures, with thousands separators once
 * the number is big enough to need them. Nansen hands prices over as strings often enough that
 * anything unparseable is passed straight through rather than turned into NaN.
 */
const priceTxt = (v) => {
  const n = +v;
  if (v == null || !Number.isFinite(n)) return v == null ? NA : String(v);
  const p = +n.toPrecision(6);
  return Math.abs(p) >= 1000 ? p.toLocaleString('en-US') : String(p);
};
// Read here rather than imported from roster.js, which imports this file: the alert only needs the
// number for the sentence that explains the tag.
const LB_TOP = () => Math.max(0, Number(process.env.LEADERBOARD_ALERT_TOP ?? 50));

/**
 * The tags on a line of their own, each with a glyph. They used to ride on the headline, which on a
 * phone wrapped a five-tag whale across three lines before the reader got to the grade.
 */
function tagLine(a) {
  const t = [];
  if (a.leaderboard) t.push('\u{1F3C6} LEADERBOARD');
  if (a.specialist) t.push(`\u{1F3AF} ${esc(a.coin)} SPECIALIST`);
  if (a.early) t.push('⚡ EARLY');
  if (a.printer) t.push('\u{1F5A8} PRINTER');
  if (a.scalper) t.push('⏱ SCALPER');
  return t.length ? [t.join(' · ')] : [];
}

/**
 * The whale's record as an aligned table: the month beside the last week, which is the one
 * comparison that answers "is the good month still going?". A whale with nothing closed in 7 days
 * gets an em dash in that column - saying so is more useful than dropping the row.
 */
function recordBlock(r) {
  const d30 = r?.d30, d7 = r?.d7;
  if (!d30 || !d30.closed) return [];
  // A whale with nothing closed in the last week gets a one-column table and a sentence, not a
  // column of five n/a's: the absence is one fact, and printing it five times buries the month.
  const on7 = !!(d7 && d7.closed);
  const rows = (...c) => [
    gRow('RECORD', ...c.map((x) => x.h)),
    gRow('P&L', ...c.map((x) => money$(x.d.pnl || 0))),
    gRow('Return', ...c.map((x) => pctOf(x.d.roi))),
    gRow('Win rate', ...c.map((x) => rateOf(x.d.winRate))),
    gRow('Closes', ...c.map((x) => intOf(x.d.closed))),
    gRow('Coins', ...c.map((x) => intOf(x.d.coins || 0))),
  ].join('\n');
  // Identical columns mean the month's record was all earned in its last week - the first three
  // weeks of the 30-day window are empty. A reader sees "30D - 648 closes - +$124.2K" and takes it
  // for a month of trading; it is one week's.
  //
  // It does NOT mean the wallet is new, which is what an earlier version of this line claimed. The
  // wallet that prompted it has 397 days and 3,562 fills of history on Hyperliquid - it simply sat
  // out 27 days in the middle of the window. Saying "no history" about a year-old wallet is the
  // same failure as saying "a month's record" about a week's, pointed the other way, so the wording
  // states only what the two columns actually prove.
  const allInLastWeek = on7 && d7.closed >= d30.closed && d30.closed > 0;
  const grid = on7 ? rows({ h: '30D', d: d30 }, { h: '7D', d: d7 }) : rows({ h: '30D', d: d30 });
  return ['', '<pre>' + grid + '</pre>',
    ...(on7 ? [] : ['Nothing closed in the last 7 days.']),
    ...(allInLastWeek
      ? [`\u{26A0}\u{FE0F} <b>One week, not a month.</b> Both columns are the same because this wallet `
        + `did not trade in the first three weeks of the 30-day window \u2014 the whole record above was `
        + `earned in the last 7 days.`]
      : [])];
}

/**
 * What a subscriber needs in the message itself: the odds, and where the price sits versus the
 * whale's own fill. The dealer's tells and the Smart Money positioning breakdown deliberately do
 * NOT travel in Telegram — they are on the card, one tap away, and stacking them here made every
 * alert a wall of text that people stopped reading.
 */
function oddsLines(a) {
  const r = a.read;
  if (!r) return [];
  const out = [''];
  if (r.pFollow != null) out.push(`\u{1F4CA} <b>Follow ${Math.round(r.pFollow * 100)}%</b> · Fade ${Math.round((1 - r.pFollow) * 100)}%`);
  if (r.moveSinceEntry != null) {
    const m = r.moveSinceEntry * 100;            // + = the whale is in profit (already flipped for the side)
    const raw = a.side === 'Short' ? -m : m;     // + = the price went up
    // Always measured from the WHALE'S OWN FILL, never from the price when the alert was sent. The
    // re-check block quotes that other baseline, and with the two stacked in one message a reader
    // takes them for the same number and assumes one is broken. Say which point each one counts from.
    const dir = `${esc(a.coin)} ${raw >= 0 ? 'up' : 'down'} ${Math.abs(raw).toFixed(2)}% from their entry`;
    out.push(`\u{1F4CD} ${Math.abs(m) < 0.3 ? `Entry now within ${Math.abs(m).toFixed(2)}% of the whale's fill · ${dir}`
      : `Entry now <b>${m > 0 ? `${m.toFixed(2)}% worse` : `${Math.abs(m).toFixed(2)}% better`}</b> than their fill · ${dir}`}`);
  }
  return out;
}

/** One-line reminder of who this whale is, so a follow-up alert also says how reliable they are. */
function whoLine(a) {
  const d30 = a.record?.d30, g = a.record?.trust?.grade;
  if (!d30 || !d30.closed) return [];
  return ['', `Grade <b>${esc(g || '?')}</b> · 30D ${money$(d30.pnl || 0)} · ${rateOf(d30.winRate)} wins over ${d30.closed} close${d30.closed === 1 ? '' : 's'} · ${d30.coins || 0} coins`];
}

/**
 * Each tag earns itself in one line, UNDER the numbers rather than above them. Telegram has no
 * tooltip, so a tag nobody can read is just noise — but the sentence that explains it is not the
 * thing a reader came for, so it does not get to push the grid down the screen.
 */
function tagNotes(a) {
  const out = [];
  if (a.leaderboard) out.push(`\u{1F3C6} Top ${LB_TOP()} on the whale board by 30-day return, over a real sample of closed trades.`);
  if (a.specialist) out.push(`\u{1F3AF} ${Math.round(a.specialist.share * 100)}% of their closes are ${esc(a.coin)}: ${money$(a.specialist.pnl)} realized, ${pctOf(a.specialist.roi)} return in 30D.`);
  const e = a.earlyStats;
  if (a.early) out.push(`⚡ ${!e ? 'Gets in before big moves and holds for them.'
    : e.via === 'proven' ? `In before ${e.goodFinds} of only ${e.finds} chance${e.finds === 1 ? '' : 's'} in 30 days, keeping ${Math.round((e.capture || 0) * 100)}% of the move — small sample, but ${pctOf(e.roi)} return and a ${rateOf(e.winRate)} win rate behind it.`
    : `In before ${e.goodFinds} of ${e.finds} big moves and held for them, keeping ${Math.round((e.capture || 0) * 100)}% of the move.`}`);
  const f = a.printerStats;
  if (a.printer) out.push(`\u{1F5A8} ${f ? `About ${money(f.medNotional)} a position, ${rateOf(f.winRate)} win rate, ${pctOf(f.medRet)} typical return.` : 'Prints money on size under the whale floor.'}`);
  const hh = a.holdHours;
  if (a.scalper) out.push(`⏱ ${hh != null ? `Typically holds about ${hh < 1 ? `${Math.round(hh * 60)} minutes` : `${hh.toFixed(1)} hours`} — expect a short hold.` : 'Works the tape — expect a short hold.'}`);
  if (a.belowWhaleFloor) out.push(`ℹ️ Under the usual ${money(cfg.minSizeUsd)} size bar — this wallet is in on its record, not its size.`);
  return out.length ? ['', ...out] : [];
}

function exitText(a, note = null) {
  // Same tags as the alert that started this thread: a SPECIALIST's exit must not arrive as a plain whale exit.
  const ret = a.whaleRet != null ? `${signed(a.whaleRet)}${(a.whaleRet * 100).toFixed(2)}%` : NA;
  const sz = (n) => (+n).toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 1 : 4 });
  const base = a.coin.split(':').pop();
  const px = priceTxt;
  const who = esc(a.trader), side = esc(String(a.side).toUpperCase()), coin = esc(a.coin);
  const head = a.kind === 'add' ? [
    `➕ <b>WHALE ADDING</b>`, ...tagLine(a), '',
    `<b>${who}</b> added <b>${sz(a.addedSz)} ${esc(base)}</b> to <b>${side} ${coin}</b>`,
    '<pre>' + [
      kvRow('Position', `${sz(a.sizeNow)} ${base}`),
      kvRow('Value', money(a.valueUsd || 0)),
      kvRow('vs alert', `${a.multiple.toFixed(1)}x`),
      kvRow('Avg entry', px(a.avgEntry)),
      kvRow('Now', px(a.markPx)),
      kvRow('Whale', ret),
      kvRow('Unrealized', `${a.upnl >= 0 ? '+' : '-'}${money(Math.abs(a.upnl || 0))}`),
    ].join('\n') + '</pre>',
    '', 'The whale is doubling down: conviction is rising.',
  ] : a.kind === 'exit' ? [
    `\u{1F6AA} <b>WHALE EXIT</b>`, ...tagLine(a), '',
    `<b>${who}</b> closed <b>${side} ${coin}</b>`,
    '<pre>' + [
      kvRow('Held', hrsTxt(a.heldMs)),
      kvRow('Entry', px(a.entryPrice)),
      kvRow('Exit', `${a.exitExact ? '' : '~'}${px(a.exitPx)}`),
      kvRow('Whale', ret),
    ].join('\n') + '</pre>',
    '', 'Following this whale? The position you copied is now closed on their side. Check your own position.',
  ] : [
    `✂️ <b>WHALE TRIM</b>`, ...tagLine(a), '',
    `<b>${who}</b> cut <b>${Math.round(a.trimPct * 100)}%</b> of <b>${side} ${coin}</b>`,
    '<pre>' + [
      kvRow('Cut', `${Math.round(a.trimPct * 100)}%`),
      kvRow('Still open', `${Math.round(a.remainingPct * 100)}%`),
      kvRow('Held', hrsTxt(a.heldMs)),
      kvRow('Entry', px(a.entryPrice)),
      kvRow('Now', px(a.markPx)),
      kvRow('Whale', ret),
    ].join('\n') + '</pre>',
    '', 'The whale is taking some off the table. Following them? Check your position.',
  ];
  const tail = a.kind === 'exit' ? whoLine(a) : [...whoLine(a), ...oddsLines(a)];
  return [...head, ...tail, ...(note ? ['', note] : [])].join('\n');
}

/** Every alert, whatever its kind, gets the same message shape and the same three buttons. */
const textFor = (a, note = null) => (a.kind ? exitText(a, note) : alertText(a, a.intelLines || [], note));
/**
 * The exact text of a message without sending it. Exported so the smoke test can assert that the
 * dashboard renders and that every HTML tag it opens it also closes - the one defect in this file
 * that Telegram punishes by dropping the whole alert.
 */
export const renderMessage = (a, note = null) => textFor(a, note);
async function sendExitTelegram(a) {
  if (!cfg.telegram.token) return;
  // Everyone who got the opening alert gets the exit: somebody may be holding this position. The
  // operator's copy is sent first and the broadcast is not awaited, so a long subscriber list can
  // never delay the operator's own alert or the next scan.
  const fanOut = () => broadcast({ text: exitText(a), disable_web_page_preview: true, reply_markup: alertButtons(a) })
    .catch((e) => console.error('[telegram] broadcast', e.message));
  if (!cfg.telegram.chatId) { fanOut(); return; }
  // reply_to_message_id is what makes a follow-up unambiguous: Telegram shows the opening alert
  // quoted above it, and tapping that quote jumps straight to it. allow_sending_without_reply keeps
  // the alert going out even if the original was deleted or predates this field — losing the link is
  // acceptable, losing an exit alert on a position somebody may be holding is not.
  const sent = await tgHtml('sendMessage', {
    chat_id: cfg.telegram.chatId, text: exitText(a), disable_web_page_preview: true, reply_markup: alertButtons(a),
    ...(a.rootMessageId ? { reply_to_message_id: a.rootMessageId, allow_sending_without_reply: true } : {}),
  });
  if (sent?.message_id) { a.messageId = sent.message_id; save('alerts', alerts); }
  fanOut();
}

/**
 * A watch that cannot be checked is the dangerous state: somebody may be in this trade because of our
 * alert, and silence reads exactly like "still open". So we say it out loud instead of hoping.
 * Sent once per watch; a successful check clears the flag and re-arms the warning.
 */
async function warnStale(w) {
  console.error(`  [watch] STALE: ${w.side} ${w.coin} by ${w.address.slice(0, 10)}… has failed ${w.misses} checks — exit alerts are NOT guaranteed for it`);
  if (!cfg.telegram.token) return;
  // A watch we cannot read is exactly the message everyone who acted on the alert needs, not just
  // the operator - silence reads like "still open".
  const staleBody = { disable_web_page_preview: true,
    text: ['\u26a0\ufe0f <b>CANNOT TRACK THIS WHALE</b>', '',
      `<b>${esc(w.side === 'Long' ? 'LONG' : 'SHORT')} ${esc(w.coin)}</b> \u2014 ${esc(w.trader)}`,
      '', `I have failed to read this position ${w.misses} times in a row${w.hlCoin ? '' : ', and I cannot find a Hyperliquid market for this symbol'}.`,
      'You will <b>NOT</b> get a reliable exit alert for it. If you are in this trade, watch it yourself.',
      '', 'I keep retrying and will confirm if tracking recovers.'].join('\n') };
  if (cfg.telegram.chatId) {
    await tgHtml('sendMessage', { ...staleBody, chat_id: cfg.telegram.chatId })
      .catch((e) => console.error('  [watch] stale warning failed to send:', e.message));
  }
  broadcast(staleBody).catch((e) => console.error('[telegram] broadcast', e.message));
}

// ---------------------------------------------------------------- Telegram "Re-check" button
// Telegram sends button presses through getUpdates; we answer by rewriting the same message with fresh numbers.
let polling = false, pollTimer = null;
let pollGen = 0; // bumped on every start/disconnect: an in-flight loop from an older generation exits instead of re-arming
/**
 * /start and /stop from anyone, once the alerts are public. The pairing flow reads its own updates
 * while chatId is still empty, and this loop only runs once a token exists, so the two never race
 * for the same message: pairing finishes first, then the loop starts.
 */
const TG_HELP = 'Commands: /start to get whale alerts, /stop to stop them.';
const TG_OWNER_HELP = ['You are the operator. Your commands:', '',
  '/subs \u2014 how many people get the alerts, and their chat ids',
  '/kick <id> \u2014 remove someone and stop /start letting them back in',
  '/unkick <id> \u2014 let them subscribe again'].join('\n');
/** Operator-only list management, so removing someone never needs the admin page open. */
function ownerCommand(cmd, arg) {
  if (cmd === '/subs') {
    if (!subs.length) return `Nobody is subscribed yet.${blocked.length ? ` ${blocked.length} chat(s) blocked.` : ''}`;
    return [`${subs.length} subscriber${subs.length === 1 ? '' : 's'}${blocked.length ? `, ${blocked.length} blocked` : ''}:`, '',
      ...subs.slice(-50).map((s) => `${s.id} \u2014 since ${new Date(s.at).toISOString().slice(0, 10)}`),
      '', 'Remove one with /kick <id>.'].join('\n');
  }
  if (cmd === '/kick') {
    const id = String(arg || '').trim();
    if (!/^-?\d{1,20}$/.test(id)) return 'Use /kick <chat id>. Run /subs to see the ids.';
    const was = dropSub(id);
    if (!isBlocked(id)) { blocked.push(id); if (blocked.length > 5000) blocked.shift(); save('alertblocked', blocked); }
    return was ? `${id} removed and blocked. They will not be re-added by /start.` : `${id} was not subscribed, but is now blocked.`;
  }
  if (cmd === '/unkick') {
    const id = String(arg || '').trim();
    const i = blocked.indexOf(id);
    if (i < 0) return `${id || 'That id'} is not blocked.`;
    blocked.splice(i, 1); save('alertblocked', blocked);
    return `${id} unblocked. They can send /start again.`;
  }
  return null;
}
async function handleCommand(m) {
  const chat = m.chat?.id;
  if (!chat || !TG_PUBLIC) return;
  const raw = String(m.text || '').trim();
  const cmd = raw.toLowerCase().split(/[\s@]/)[0];
  const arg = raw.slice(raw.search(/\s/) + 1).trim();
  const say = (text) => tg(cfg.telegram.token, 'sendMessage', { chat_id: chat, text, disable_web_page_preview: true }).catch(() => {});
  if (isOwner(chat)) {
    const reply = ownerCommand(cmd, raw.includes(' ') ? arg : '');
    if (reply) return say(reply);
  }
  if (cmd === '/start') {
    if (isOwner(chat)) return say(`You are the operator here - you already get every alert.\n\n${TG_OWNER_HELP}`);
    if (isBlocked(chat)) return say('These alerts are not available to this chat.');
    if (isSub(chat)) return say(`You are already getting whale alerts. ${TG_HELP}`);
    if (!addSub(chat)) return say('The alert list is full right now. Try again later.');
    console.log(`  Telegram: new subscriber (${subs.length} total)`);
    return say(['\ud83d\udc0b You are in.', '',
      'You will get a message the moment a top-graded Nansen Smart Money whale opens a position, and another when they close it.',
      'Every alert carries the whale\u2019s track record, the odds, and a link to play the same hand with play money.', '',
      'This is information, not advice. Nothing here is a recommendation to trade, and no link on it earns a commission.', '',
      TG_HELP].join('\n'));
  }
  if (cmd === '/stop') {
    if (isOwner(chat)) return say('The operator cannot unsubscribe here - turn the scanner off in the app instead.');
    return say(dropSub(chat) ? 'Done, no more alerts. Send /start any time to turn them back on.' : `You are not subscribed. ${TG_HELP}`);
  }
  if (cmd === '/help' || cmd === '/status') {
    if (isOwner(chat)) return say(TG_OWNER_HELP);
    return say(isSub(chat) ? `You are getting whale alerts. ${TG_HELP}` : `You are not subscribed. ${TG_HELP}`);
  }
}

export function startTelegramPoll() {
  clearTimeout(pollTimer);
  const gen = ++pollGen;
  // Public mode needs the loop running as soon as there is a token, so /start works before (or
  // without) an operator chat ever being paired.
  if (!cfg.telegram.token || !(cfg.telegram.chatId || TG_PUBLIC)) return;
  let fails = 0;
  const loop = async () => {
    if (polling || gen !== pollGen) return;
    polling = true;
    try {
      const updates = await tg(cfg.telegram.token, 'getUpdates', { offset: cfg.telegram.offset || 0, timeout: 25, allowed_updates: TG_PUBLIC ? ['callback_query', 'message'] : ['callback_query'] }, 35e3);
      fails = 0;
      for (const u of updates || []) {
        cfg.telegram.offset = u.update_id + 1;
        if (u.message?.text) await handleCommand(u.message).catch((e) => console.warn('[telegram] command', e.message));
        const q = u.callback_query;
        // the operator and, in public mode, a subscriber may press the buttons; anyone else is
        // ignored. recheck() has its own 15s-per-alert cooldown, so a crowd cannot hammer it.
        const fromChat = String(q?.message?.chat?.id || '');
        if (q?.data?.startsWith('rc:') && (isOwner(fromChat) || (TG_PUBLIC && isSub(fromChat) && !isBlocked(fromChat)))) {
          await recheck(q).catch((e) => console.warn('[telegram] recheck', e.message));
        }
      }
      if (updates?.length) save('alertcfg', cfg);
    } catch (e) {
      fails++;
      console.warn('[telegram] poll', e.message);
      await new Promise((r) => setTimeout(r, Math.min(5 * 60e3, 5e3 * 2 ** Math.min(fails, 6)))); // back off instead of hammering
    } finally {
      polling = false;
      if (gen === pollGen && cfg.telegram.token && (cfg.telegram.chatId || TG_PUBLIC)) pollTimer = setTimeout(loop, 500);
    }
  };
  loop();
}

/**
 * One line when the whale's grade has moved since the alert. The header above keeps the grade the
 * alert was sent at, because that is what people acted on; this says where it stands now, so a reader
 * who opens the card and sees a different letter already knows why.
 */
export function gradeDriftLine(then, now) {
  if (!then?.grade || !now?.grade || then.grade === now.grade) return '';
  const up = (GRADE_RANK[now.grade] ?? 0) > (GRADE_RANK[then.grade] ?? 0);
  return `${up ? '⬆️' : '⬇️'} Grade now <b>${esc(now.grade)}</b>${now.score != null ? ` ${now.score}/100` : ''}, was <b>${esc(then.grade)}</b>${then.score != null ? ` ${then.score}/100` : ''} at the alert. The last 7 days have moved since.`;
}
const recheckedAt = new Map(); // alert id -> last re-check, so a held-down button can't hammer Hyperliquid and Nansen
async function recheck(q) {
  const id = String(q.data.slice(3)).slice(0, 64);
  const a = alerts.find((x) => x.id === id);
  const answer = (text) => tg(cfg.telegram.token, 'answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (!a) return answer('That alert is too old to re-check.');
  const last = recheckedAt.get(id) || 0;
  if (Date.now() - last < 15e3) return answer('Just re-checked, give it a few seconds.');
  recheckedAt.set(id, Date.now());
  if (recheckedAt.size > 500) for (const [k, v] of recheckedAt) if (Date.now() - v > 60 * 60e3) recheckedAt.delete(k);
  let item = null;
  try { item = await game.refreshLiveItem(a.key, a.raw); }
  catch (e) { await answer(e.status === 410 ? 'That trade left the floor.' : 'Could not read that whale right now.'); return; }
  a.base ??= { mid: a.read?.mid ?? a.entryPrice, pFollow: a.read?.pFollow ?? null, at: a.t };
  a.read = { pFollow: item.pFollow, odds: item.odds, reasons: (item.reasons || []).slice(0, 3), positioning: item.positioning, moveSinceEntry: item.moveSinceEntry, mid: item.mid };
  // A re-check that leaves a wrong size on the message is not a re-check. refreshLiveItem has just
  // read the real position, so an ordinary open alert takes the corrected figure here; adds and
  // trims already carry their own size and are left alone.
  if (!a.kind && Number.isFinite(item.valueUsd) && item.valueUsd > 0) {
    if (a.tradeUsd == null) a.tradeUsd = a.valueUsd;
    a.valueUsd = item.valueUsd;
    a.belowWhaleFloor = a.valueUsd < cfg.minSizeUsd;
  }
  const held = item.gone ? '🚪 The whale has CLOSED this position.'
    : item.trimmed >= 0.1 ? `✂️ The whale trimmed ${Math.round(item.trimmed * 100)}% of the position.`
    : '✅ The whale is still in the trade.';
  const px = (x) => +(+x).toPrecision(6);
  const dir = a.side === 'Long' ? 1 : -1;

  // An add or a trim prints its own price, return and unrealised P&L in the HEADER, from values frozen
  // when that follow-up fired. Re-checking refreshed the odds block and the note underneath but left
  // those alone, so the top of the message said "now 84083.5" while the bottom said "84472.5 now" —
  // the same message disagreeing with itself about the current price. Refresh them here too.
  // An exit is deliberately excluded: its price and return are settled history, not a live figure.
  if (a.kind === 'add' || a.kind === 'trim') {
    const entry = +a.avgEntry || +a.entryPrice;
    if (item.mid && entry) {
      a.markPx = item.mid;
      a.whaleRet = dir * (item.mid - entry) / entry;
      if (a.sizeNow != null) {
        a.upnl = a.sizeNow * (item.mid - entry) * dir;
        a.valueUsd = a.sizeNow * item.mid;
      }
    }
  }

  // What the whale themselves is up or down, counted from their own fill (their AVERAGE fill once
  // they have added). Not the same question as "how has the price moved since the alert", which the
  // line below answers, and the one a reader actually asks first.
  const entryRef = ((a.kind === 'add' || a.kind === 'trim') && +a.avgEntry) ? +a.avgEntry : +a.entryPrice;
  const whaleNow = entryRef && item.mid ? dir * (item.mid - entryRef) / entryRef : null;
  const rawSince = a.base.mid ? (item.mid - a.base.mid) / a.base.mid : null; // which way the price went
  const since = rawSince == null ? null : dir * rawSince;                     // what that meant for the trade
  const mins = Math.max(1, Math.round((Date.now() - (a.base.at || a.t)) / 60e3));
  const ago = mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
  const note = [
    // A divider, because this block is appended to a message the reader has already read once: without
    // it the fresh numbers run straight on from the old ones and it is not obvious which is which.
    '———',
    `🔄 <b>RE-CHECKED</b> ${new Date().toISOString().slice(11, 16)} UTC · ${ago} after the alert`,
    `Price: ${px(a.base.mid ?? a.entryPrice)} at the alert → ${px(item.mid)} now`,
    whaleNow == null ? ''
      : `${whaleNow >= 0 ? '🟢' : '🔴'} The whale is ${whaleNow >= 0 ? 'up' : 'down'} ${Math.abs(whaleNow * 100).toFixed(2)}% on this ${a.side.toLowerCase()}, from their ${(a.kind === 'add' || a.kind === 'trim') && +a.avgEntry ? 'average entry' : 'entry'} ${px(entryRef)} → ${px(item.mid)}`,
    since == null ? ''
      : Math.abs(since) < 0.0005 ? '➖ Flat since the alert: the same entry you were offered then'
      // `since` is the trade's P&L, already flipped for the side, so on a short a price RISE is negative.
      // Name the raw direction too, or a short reads backwards.
      : `${since >= 0 ? '📈' : '📉'} ${esc(a.coin)} is ${rawSince >= 0 ? 'up' : 'down'} ${Math.abs(rawSince * 100).toFixed(2)}% since the alert was sent · ${Math.abs(since * 100).toFixed(2)}% ${since >= 0 ? `in this ${a.side.toLowerCase()}'s favour · you'd enter ${Math.abs(since * 100).toFixed(2)}% worse than at the alert` : `against this ${a.side.toLowerCase()} · you'd enter ${Math.abs(since * 100).toFixed(2)}% better than at the alert`} (the “from the whale's entry” figure above counts from their fill, not from the alert)`,
    a.base.pFollow != null ? `Follow odds ${Math.round(a.base.pFollow * 100)}% at the alert → ${Math.round(item.pFollow * 100)}% now` : '',
    gradeDriftLine(a.record?.trust, item.record?.trust),
    held,
  ].filter(Boolean).join('\n');
  const text = textFor(a, note);
  await tgHtml('editMessageText', {
    chat_id: q.message.chat.id, message_id: q.message.message_id, text, disable_web_page_preview: true, reply_markup: alertButtons(a),
  }).catch(async (e) => { if (!/not modified/i.test(e.message)) throw e; });
  save('alerts', alerts);
  await answer(item.gone ? 'The whale has closed this position' : 'Numbers updated');
}

export function schedule() {
  clearInterval(timer);
  timer = setInterval(() => scan().catch(() => {}), cfg.intervalMin * 60e3);
}

// ---------------------------------------------------------------- Telegram (optional)
const tg = async (token, method, body, timeoutMs = 15e3) => {
  // every call is bounded: without this a hung socket freezes the poller for good
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'Telegram request failed');
  return j.result;
};

export async function connectTelegram(token) {
  token = String(token || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw Object.assign(new Error('That does not look like a bot token from @BotFather'), { status: 400 });
  const me = await tg(token, 'getMe');
  // A pairing code, so the chat that gets the alerts is provably the one the operator is holding:
  // without it, whoever messages the bot first captures the whole alert stream.
  cfg.telegram = { token, chatId: '', botName: me.username, pairCode: crypto.randomBytes(3).toString('hex').toUpperCase(), offset: 0 };
  save('alertcfg', cfg);
  return publicConfig();
}

/** After the user messages the bot, grab their chat id from the bot's updates and send a test message. */
export async function verifyTelegram() {
  if (!cfg.telegram.token) throw Object.assign(new Error('Connect a bot token first'), { status: 400 });
  pollGen++; clearTimeout(pollTimer); // Telegram allows one getUpdates at a time: stand the poller down first
  // allowed_updates is REMEMBERED BY TELEGRAM between calls when you don't pass it. The alert poller
  // asks for ['callback_query'], so a verify that left it unset silently received no `message` updates
  // at all and could never match the code — which is exactly what happens when you re-pair a bot that
  // was paired before. Always state it here.
  let updates;
  try {
    updates = await tg(cfg.telegram.token, 'getUpdates', { offset: cfg.telegram.offset || 0, timeout: 0, allowed_updates: ['message'] });
  } catch (e) {
    if (/conflict/i.test(e.message)) { // a long poll from the old loop is still draining
      await new Promise((r) => setTimeout(r, 2000));
      updates = await tg(cfg.telegram.token, 'getUpdates', { offset: cfg.telegram.offset || 0, timeout: 0, allowed_updates: ['message'] });
    } else throw e;
  }
  const code = String(cfg.telegram.pairCode || '');
  const norm = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); // tolerate spaces, /start, formatting
  const mine = updates.filter((u) => u.message?.chat?.id);
  const msg = [...mine].reverse().find((u) => !code || norm(u.message.text).includes(code));
  if (!msg) {
    const link = `https://t.me/${cfg.telegram.botName}?start=${code}`;
    throw Object.assign(new Error(mine.length
      ? `I can see ${mine.length} message${mine.length === 1 ? '' : 's'} to @${cfg.telegram.botName}, but none contains the code ${code}. Send exactly ${code} as a message, then press this again. Or open ${link} and press Start.`
      : `No message from you yet. Open ${link}, press Start, and this pairs itself. (Or search @${cfg.telegram.botName} in Telegram and send the code ${code}.)`), { status: 409 });
  }
  cfg.telegram.chatId = String(msg.message.chat.id);
  cfg.telegram.pairCode = ''; // used once
  for (const u of updates) if (u.update_id >= (cfg.telegram.offset || 0)) cfg.telegram.offset = u.update_id + 1;
  save('alertcfg', cfg);
  await tg(cfg.telegram.token, 'sendMessage', { chat_id: cfg.telegram.chatId, text: ['🐋 Follow or Fade is connected. You will get a message here when a top Smart Money whale opens a position.',
      'Every alert has a 🔄 Re-check button that updates its numbers in place, and a 📊 Full whale card button that opens the reasoning, the dealer\u2019s tells and the live Smart Money positioning on the site.',
      '', RISK_LINE].join('\n') });
  startTelegramPoll();
  return publicConfig();
}

export function disconnectTelegram() { cfg.telegram = { token: '', chatId: '', botName: '', pairCode: '', offset: 0 }; save('alertcfg', cfg); pollGen++; clearTimeout(pollTimer); return publicConfig(); }

/** Start pairing again with a fresh code, without re-entering the bot token. */
export function repairTelegram() {
  if (!cfg.telegram.token) throw Object.assign(new Error('Connect a bot token first'), { status: 400 });
  pollGen++; clearTimeout(pollTimer);
  cfg.telegram.chatId = '';
  cfg.telegram.pairCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  save('alertcfg', cfg);
  return publicConfig();
}

const money = (n) => (n < 0 ? '-' : '') + '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(n));
async function stockIntelLines(a) {
  if (!agent.isStock(a.coin)) return [];
  let r = agent.companyIntel(a.coin);
  if (r.status === 'loading') r = await agent.waitIntel(a.coin, 25e3);
  if (!r.intel) return [];
  const i = r.intel, al = agent.alignment(a.side, i.insider.signal);
  // Written by a model, so it is escaped like any other untrusted string before it goes near HTML.
  return ['', `🔎 <b>NANSEN AGENT</b> · ${esc(i.company || agent.tickerOf(a.coin))}`,
    `Insiders <b>${esc(i.insider.signal.toUpperCase())}</b>${i.insider.detail ? ` · ${esc(i.insider.detail)}` : ''}`,
    ...(i.earnings?.next ? [`Next earnings: ${esc(i.earnings.next)}`] : []),
    `Whale vs insiders: ${al === 'aligned' ? '<b>ALIGNED</b> ✅' : al === 'against' ? '<b>AGAINST</b> ⚠️' : 'no clear insider signal'}`,
    '<i>(Written by an AI model, not checked by a person. Not a recommendation.)</i>'];
}
const siteUrl = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const cardUrl = (a) => `${siteUrl()}/?view=live&trade=${encodeURIComponent(a.key)}`;
const nansenUrl = (coin) => `https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(coin)}&chain=hyperliquid`;

// Trading a whale's position is not the same bet as betting play money on it. The Telegram button
// leaves for a real venue, so the warning has to travel in the message.
// A disclosure, not a how-to. Telling someone which leverage to use is itself advice about how to
// trade, which is exactly what this product must never give.
// Said ONCE, when the bot is connected, instead of riding on every alert. Repeating it on every
// message made each alert longer than the signal inside it, and people stopped reading both. The
// site and /legal.html carry the full disclosure; this is the version a Telegram-only user sees.
// Still a disclosure, never a how-to: telling someone how to trade a signal is exactly what this
// product must not do.
const RISK_LINE = '\u26a0\ufe0f Educational play-money game. Not advice, not a signal. Anything you do outside this bot is your own decision, at your own risk, and we accept no responsibility for it.';

/** The alert message. `note` marks a re-check ("numbers as of ..."). */
function alertText(a, intel = [], note = null) {
  const r = a.record;
  const opened = a.openedAt ? Date.parse(a.openedAt) : null;
  return [
    `\u{1F40B} <b>WHALE ALERT</b> \u00b7 Grade <b>${esc(r?.trust?.grade || '?')}</b> ${r?.trust?.score ?? DASH}/100`,
    ...tagLine(a),
    ``,
    `<b>${esc(a.trader)}</b> opened <b>${esc(String(a.side).toUpperCase())} ${esc(a.coin)}</b>`,
    `${money(a.valueUsd)} @ <code>${esc(priceTxt(a.entryPrice))}</code>${opened ? ` \u00b7 ${hrsTxt(Date.now() - opened)} ago` : ''}`,
    // Say so when the feed's row and the real position disagree, instead of silently printing the
    // bigger number: a reader who also watches the Nansen feed should not have to wonder which is wrong.
    ...(Number.isFinite(a.tradeUsd) && a.valueUsd > a.tradeUsd * 1.25
      ? [`<i>Position size. The single fill Nansen reported was ${money(a.tradeUsd)}; this whale split the entry.</i>`]
      : []),
    // Sample size is the first thing that tells you whether a win rate means anything, so it is a
    // row in the grid rather than a clause at the end of a sentence.
    ...recordBlock(r),
    ...oddsLines(a),
    ...intel,
    ...tagNotes(a),
    ...(note ? ['', note] : []),
  ].join('\n');
}
const profileUrl = (a) => `https://app.nansen.ai/profiler?address=${encodeURIComponent(a.address)}&chain=hyperliquid`;
/**
 * A deep link to the alert that opened this thread. Telegram only has a linkable address for
 * messages in a channel or supergroup (id -100...), so in a plain bot DM this returns null and the
 * reply-quote on the message is what carries the reader back instead.
 */
function rootLink(a) {
  if (!a.rootMessageId) return null;
  const id = String(cfg.telegram.chatId || '');
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${a.rootMessageId}` : null;
}
const alertButtons = (a) => {
  const back = rootLink(a);
  return { inline_keyboard: [
    [{ text: '🔄 Re-check the numbers', callback_data: `rc:${a.id}` }],
    [{ text: '📊 Full whale card', url: cardUrl(a) }, { text: '🔎 See it on Nansen', url: nansenUrl(a.coin) }],
    back ? [{ text: '👤 Whale profile', url: profileUrl(a) }, { text: '⬆️ Original alert', url: back }]
         : [{ text: '👤 Whale profile', url: profileUrl(a) }],
  ] };
};

async function sendTelegram(a) {
  if (!cfg.telegram.token) return;
  const intel = await stockIntelLines(a).catch(() => []); // stock perps get a Nansen Agent insider brief
  a.intelLines = intel;
  const body = { text: alertText(a, intel), disable_web_page_preview: true, reply_markup: alertButtons(a) };
  if (cfg.telegram.chatId) {
    const sent = await tgHtml('sendMessage', { ...body, chat_id: cfg.telegram.chatId });
    // messageId is the operator's copy: it is what the exit alert replies to and what Re-check edits.
    // Subscribers each get their own copy, and Telegram gives every chat its own message id, so
    // storing one per subscriber would mean 200 alerts x every subscriber. Their copy stands alone.
    if (sent?.message_id) { a.messageId = sent.message_id; save('alerts', alerts); }
  }
  // Do not hold the scan open for the broadcast: the next alert should not wait on this one.
  broadcast(body).catch((e) => console.error('[telegram] broadcast', e.message));
}


/** Build a sample alert from the best-graded whale in the recent feed (for testing the pipeline). */
export async function testAlert() {
  const feed = await game.liveFeed();
  const best = feed.slice().sort((x, y) => (y.record?.trust?.score ?? -1) - (x.record?.trust?.score ?? -1))[0];
  if (!best) throw new Error('No whales on the floor right now');
  const a = { id: crypto.randomUUID(), t: Date.now(), key: best.key, test: true, raw: game.getRaw(best.key), coin: best.coin, side: best.side, valueUsd: best.valueUsd,
    entryPrice: best.entryPrice, openedAt: best.openedAt, trader: best.trader || 'Smart Money whale', address: best.address, record: best.record, specialist: best.record?.trust?.specialist || null,
    scalper: !!best.record?.trust?.scalper, tradesPerDay: best.record?.trust?.tradesPerDay ?? null };
  alerts.push(a); while (alerts.length > 200) alerts.shift(); save('alerts', alerts);
  // Journaled too, with test:true, so the file is a complete record of everything the bot ever sent.
  // The study filters these out; a gap in the journal would be harder to explain than a flagged row.
  journal(a);
  await sendTelegram(a).catch(() => {});
  return a;
}
