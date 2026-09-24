/**
 * Two kinds of trader the main filters throw away, found by reading Hyperliquid directly.
 *
 * EARLY — gets in before a big move and stays for it. Measured on 143 Smart Money wallets and 2,404
 *   round trips (Sep 2026): the median entry has only 5.2% available within 48h, so 15% puts a move
 *   in the top 15% of all opportunities. The revealing number is what people do with one: the median
 *   capture on a 10%+ move is 25.9%. Most traders who catch a pump sell a quarter of it. Holding half
 *   or more is top-quartile behaviour, which is why the bar is there.
 *
 * PRINTER — too small to clear the $50k whale floor, too good to ignore. Position size between $15k and
 *   $50k with a win rate and a per-trade return that most whales do not reach.
 *
 * Everything here runs on Hyperliquid's public API, which costs no Nansen credits: the full 143-wallet
 * study above spent 5 credits, all of them on the Smart Money feed that produced the candidate list.
 * Fills are one call per wallet covering every trade they made, and candles are fetched once per coin
 * and reused, so the cost is time, not money.
 */
import * as hl from './hyperliquid.js';
import { load, save } from './store.js';

const H = 3600e3, DAY = 24 * H;
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };

export const WINDOW_DAYS   = () => num('CLASS_WINDOW_DAYS', 30);
export const HORIZON_H     = () => num('EARLY_HORIZON_HOURS', 48);   // 24h and 72h pick almost the same wallets
export const PUMP_MIN      = () => num('EARLY_PUMP_PCT', 0.15);      // top 15% of available moves
export const CAPTURE_MIN   = () => num('EARLY_CAPTURE_PCT', 0.5);    // median trader keeps 26%
export const MIN_GOOD      = () => num('EARLY_MIN_FINDS', 4);        // four in a month, not one lucky call
export const MIN_CONVERT   = () => num('EARLY_MIN_CONVERT', 0.4);
export const MIN_COINS     = () => num('EARLY_MIN_COINS', 2);
export const MIN_DAYS      = () => num('EARLY_MIN_DAYS', 3);
// How recently the last good call has to have been made. The EARLY tag is an EXEMPTION: it skips the
// grade bar, the 30-day return floor, the losing-week rule and the size floor. An exemption earned
// three weeks ago and never repeated is a historical fact, not a signal - and it was sending alerts.
// The wallet that forced this: 88% win rate over 6,001 closes in 30 days, grade C, and MINUS $310k
// over the last 7 days, still tagged EARLY on finds from the first half of the window.
export const FIND_MAX_AGE_H = () => num('EARLY_MAX_FIND_AGE_HOURS', 168);   // one week
export const PRINTER_MIN_USD  = () => num('PRINTER_MIN_USD', 15000);       // never lower: below this is noise
export const PRINTER_MAX_USD  = () => num('PRINTER_MAX_USD', 50000);       // at or above this they are a whale already
export const PRINTER_MIN_TRADES = () => num('PRINTER_MIN_TRADES', 8);
export const PRINTER_MIN_WIN  = () => num('PRINTER_MIN_WIN', 0.55);
export const PRINTER_MIN_RET  = () => num('PRINTER_MIN_RET', 0.01);
// The second, "proven-early" route into EARLY (one to three good finds on an exceptional record) was
// removed on Sep 24: the panel found 9 of 15 EARLY tags rested on 1-3 finds, and the route's alerts
// averaged -1.72%. EARLY is now the pattern route only.
/**
 * Closing fills per day above which the live floor treats a wallet as one that would crowd it.
 *
 * NOT the same scale as Nansen's closed_trade_count, despite measuring the same behaviour: userFills
 * is read with aggregateByTime, which merges fills sharing a timestamp, so this number comes out
 * roughly an order of magnitude lower. Calibrated against Nansen's own scalper flag on 70 wallets:
 * 3/day gives the best agreement (74%), where a wallet Nansen calls fast has a median of 6.2 and one
 * it calls slow has a median of 0.9. Do not "fix" this to 20 to match the other threshold — they are
 * different units, and that mistake already cost one silent failure.
 */
export const FAST_CLOSES_PER_DAY = () => num('FAST_CLOSES_PER_DAY', 3);
/**
 * What actually makes a trader a scalper: how long they hold, measured on real round trips.
 *
 * This replaced a definition taken from Nansen's closed_trade_count / 30, which was wrong in a way
 * that mattered. That field counts every closing FILL, so a trader who builds a position and scales
 * out of it in sixty clips registers sixty "closed trades". Measured on 106 wallets: of the 85 that
 * count tagged as scalpers, 57 actually held longer than 12 hours and 42 longer than a day — only 5
 * held under an hour. "Token Millionaire" made 9 round trips in 30 days with a 9.7-hour median hold;
 * one RABBYWALLET wallet made 17, median hold 47 hours, not one of them under an hour. The tag told
 * people to expect a short hold on traders who hold for days.
 *
 * Holding time is the thing the tag is about, so holding time is what it is now measured on.
 */
export const SCALP_MAX_MEDIAN_H = () => num('SCALPER_MAX_MEDIAN_HOURS', 4);
export const SCALP_MIN_QUICK    = () => num('SCALPER_MIN_SHARE_UNDER_1H', 0.5);

// addr -> { early, printer, stats, at }. Written by the roster, read on every alert and card.
let map = load('traderclass', {});
export const classOf = (addr) => (addr ? map[String(addr).toLowerCase()] || null : null);
/**
 * Is the early-finder pattern still CURRENT? Checked when the tag is read, not only when it is
 * computed, for two reasons: a classification made last week goes stale on its own without waiting
 * for a re-scoring, and an entry classified before this rule existed carries no `lastGoodFind` at
 * all - which fails closed here, as an unproven exemption should.
 */
export const findIsFresh = (c) => !!c && c.lastGoodFind != null && Date.now() - c.lastGoodFind <= FIND_MAX_AGE_H() * 3600e3;
export const isEarly = (addr) => { const c = classOf(addr); return !!c?.early && findIsFresh(c); };
export const isPrinter = (addr) => !!classOf(addr)?.printer;
export const allClassified = () => map;

/**
 * Record the Nansen-derived trading pace alongside the classification.
 *
 * The classifier cannot work this out for itself: it counts round trips, and the scalper threshold is
 * calibrated on Nansen's closed_trade_count, which counts closing fills. Rather than invent a second
 * definition, the roster hands the real one over here once it has the record, so the live floor can
 * look it up for free when deciding how many fast wallets to seat.
 */
/**
 * Record a grade we have ALREADY paid for.
 *
 * Every card the game builds fetches the whale's 30-day summary to price the hand, and that summary
 * is what a grade is computed from — so the grade is free at that moment and was being thrown away.
 * Without this, only the daily roster ever recorded one, which left 89 of 140 pool whales carrying
 * no grade at all: "untagged" became indistinguishable from "never looked at", and the deck could not
 * deliberately deal a weak whale because it had no idea which whales were weak.
 */
export function noteGrade(addr, grade, score) {
  const k = String(addr || '').toLowerCase();
  if (!k || !grade) return;
  const row = (map[k] ||= { truncated: false, at: new Date().toISOString() });
  if (row.grade === grade && row.score === score) return;   // no churn: this is called on every render
  row.grade = grade; row.score = score ?? null;
  // Persist straight away rather than waiting for the roster's flush: this is called from card
  // rendering, which the roster has nothing to do with, and a grade only held in memory is lost on
  // the next restart — which is exactly how the map ended up with 115 wallets and no grades at all.
  // save() is debounced in store.js (250ms quiet, 2s hard cap), so a burst of renders is one write.
  save('traderclass', map);
}

export function notePace(addr, tradesPerDay, grade, score) {
  const k = String(addr || '').toLowerCase();
  if (!k || !map[k]) return;
  // The grade rides along so the training deck and the live floor can steer on it for free. Working
  // it out needs a Nansen wallet summary, which the roster has just paid for anyway; without this,
  // spreading hands across grade bands would mean paying again for every candidate considered.
  if (grade) { map[k].grade = grade; map[k].score = score ?? null; }
  // Only the pace, never `scalper`. That field is derived from real holding time here, and Nansen's
  // closed_trade_count disagrees with it on 57 of 85 wallets — writing it in would put the old, wrong
  // verdict straight back on top of the measured one.
  map[k].pace = tradesPerDay ?? null;
  paceDirty = true;
}
let paceDirty = false;
export const flushPace = () => { if (paceDirty) { save('traderclass', map); paceDirty = false; } };
export const counts = () => {
  const v = Object.values(map);
  return { known: v.length, early: v.filter((x) => x.early).length, printer: v.filter((x) => x.printer).length };
};

/**
 * Round trips rebuilt from raw fills, using Hyperliquid's own `dir` ("Open Long", "Close Short", …)
 * rather than inferring direction from size deltas.
 *
 * Positions still open are included on purpose. A trader holding a 50% winner would otherwise score
 * as if the trade never happened — and that is precisely the trader being looked for. Their return is
 * taken at the fixed horizon, which is settled history by then, never a live mark.
 */
export function positionsFromFills(fills) {
  const byCoin = new Map();
  for (const f of fills) { if (!byCoin.has(f.coin)) byCoin.set(f.coin, []); byCoin.get(f.coin).push(f); }
  const out = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let open = null;
    for (const f of list) {
      const sz = Math.abs(+f.sz), px = +f.px;
      const side = /Long/.test(f.dir) ? 'Long' : /Short/.test(f.dir) ? 'Short' : null;
      if (!side) continue;                                  // "Buy"/"Liquidation" rows carry no direction
      if (/^Open/.test(f.dir)) {
        if (!open || open.side !== side) open = { side, sz: 0, notional: 0, t0: f.time, exitSz: 0, exitVal: 0, pnl: 0 };
        open.sz += sz; open.notional += sz * px;
      } else if (/^Close/.test(f.dir) && open && open.side === side) {
        const closed = Math.min(sz, open.sz);
        if (closed <= 0) continue;
        open.exitSz += closed; open.exitVal += closed * px; open.pnl += +f.closedPnl || 0; open.tN = f.time;
        open.sz -= closed;
        if (open.sz <= 1e-9) {
          out.push({ coin, side: open.side, t0: open.t0, tN: open.tN, stillOpen: false,
            entryPx: open.notional / open.exitSz, exitPx: open.exitVal / open.exitSz,
            notional: open.notional, pnl: open.pnl });
          open = null;
        }
      }
    }
    if (open && open.sz > 1e-9) {
      out.push({ coin, side: open.side, t0: open.t0, tN: null, stillOpen: true,
        entryPx: open.notional / (open.sz + open.exitSz), exitPx: null, notional: open.notional, pnl: open.pnl });
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Score one wallet. Returns null when there is not enough history to say anything. */
export async function classify(addr) {
  const now = Date.now();
  const fills = await hl.userFills(addr, now - WINDOW_DAYS() * DAY, now).catch(() => null);
  if (!fills || !fills.length) return null;
  // A wallet with more fills than we can page through cannot be scored honestly: we would be judging
  // a slice of their record and calling it the whole of it.
  // More fills than we can page through is itself the loudest possible statement about pace, so the
  // wallet is marked fast even though nothing else about it can be judged honestly.
  if (fills.truncated) return { early: false, printer: false, truncated: true, fast: true, closesPerDay: null, at: new Date().toISOString() };

  const pos = positionsFromFills(fills);
  if (!pos.length) return null;
  const closingFills = fills.filter((f) => /^Close/.test(f.dir)).length;
  const holds = pos.filter((p) => !p.stillOpen && p.tN).map((p) => (p.tN - p.t0) / H);
  const medHold = median(holds);

  const hh = HORIZON_H();
  // Candles are fetched once per coin and reused. Endpoints are snapped to the hour so the cache
  // inside hyperliquid.js actually hits across wallets in the same run.
  const from = Math.floor((now - (WINDOW_DAYS() + 4) * DAY) / H) * H, to = Math.floor(now / H) * H;
  const series = new Map();
  const finds = [], good = [], rets = [], sizes = [];
  let pnl = 0, closed = 0, wins = 0;

  for (const p of pos) {
    pnl += p.pnl || 0; sizes.push(p.notional);
    const dir = p.side === 'Long' ? 1 : -1;
    const realized = p.stillOpen ? null : (p.exitPx - p.entryPx) / p.entryPx * dir;
    if (realized != null) { closed++; if (realized > 0) wins++; rets.push(realized); }

    if (!series.has(p.coin)) series.set(p.coin, await hl.candles(p.coin, from, to, '1h').catch(() => []));
    const cs = series.get(p.coin);
    if (!cs.length) continue;
    const end = p.t0 + hh * H;
    const win = cs.filter((r) => r.t >= p.t0 - H && r.t <= end);
    if (win.length < 2) continue;                            // too recent to judge: no verdict either way
    let mfe = 0;
    for (const r of win) {
      const up = (r.h - p.entryPx) / p.entryPx, dn = (r.l - p.entryPx) / p.entryPx;
      mfe = Math.max(mfe, dir > 0 ? up : -dn);
    }
    if (mfe < PUMP_MIN()) continue;                          // no real move followed: not an opportunity
    const last = win[win.length - 1];
    const retH = (!p.stillOpen && p.tN <= end) ? realized : (last.c - p.entryPx) / p.entryPx * dir;
    const capture = retH / mfe;
    finds.push({ coin: p.coin, t0: p.t0, mfe, capture });
    if (capture >= CAPTURE_MIN()) good.push({ coin: p.coin, t0: p.t0, mfe, capture });
  }

  const convert = finds.length ? good.length / finds.length : 0;
  // The most recent good call. Everything below reads it: a pattern that has stopped is not a pattern.
  const lastGoodFind = good.length ? Math.max(...good.map((x) => x.t0)) : null;
  const findFresh = lastGoodFind != null && now - lastGoodFind <= FIND_MAX_AGE_H() * H;
  const goodCoins = new Set(good.map((x) => x.coin)).size;
  const goodDays = new Set(good.map((x) => Math.floor(x.t0 / DAY))).size;
  const medNotional = median(sizes) || 0;
  const winRate = closed ? wins / closed : 0;
  const medRet = median(rets);

  const early = findFresh && good.length >= MIN_GOOD() && convert >= MIN_CONVERT()
    && goodCoins >= MIN_COINS() && goodDays >= MIN_DAYS() && pnl > 0;
  const printer = medNotional >= PRINTER_MIN_USD() && medNotional < PRINTER_MAX_USD()
    && closed >= PRINTER_MIN_TRADES() && winRate >= PRINTER_MIN_WIN()
    && (medRet ?? 0) >= PRINTER_MIN_RET() && pnl > 0;

  return {
    early, printer, truncated: false, at: new Date().toISOString(),
    finds: finds.length, goodFinds: good.length, convert: +convert.toFixed(3), lastGoodFind,
    medCapture: finds.length ? +median(finds.map((x) => x.capture)).toFixed(3) : null,
    goodCoins, goodDays,
    bestFind: good.slice().sort((a, b) => b.mfe - a.mfe)[0] || null,
    trades: pos.length, closed, winRate: +winRate.toFixed(3),
    // ROUND TRIPS per day. NOT comparable to the scalper pace on a card, which comes from Nansen's
    // closed_trade_count — that counts every closing fill, so a whale scaling out of one position in
    // twenty fills is 1 here and 20 there. Kept under its own name so the two cannot be confused.
    roundTripsPerDay: +(closed / WINDOW_DAYS()).toFixed(1),
    // CLOSING FILLS per day. This is about CROWDING, not hold length: it is what the live floor uses
    // to stop a handful of very active wallets taking every card. Deliberately separate from
    // `scalper` below — a wallet can open constantly and still hold each position for days.
    closesPerDay: +(closingFills / WINDOW_DAYS()).toFixed(1),
    fast: closingFills / WINDOW_DAYS() >= FAST_CLOSES_PER_DAY(),
    // How long they actually hold, and therefore whether SCALPER is true of them.
    medHoldH: medHold == null ? null : +medHold.toFixed(1),
    shareUnder1h: holds.length ? +(holds.filter((h) => h < 1).length / holds.length).toFixed(2) : null,
    scalper: holds.length >= 5
      ? (medHold < SCALP_MAX_MEDIAN_H() || holds.filter((h) => h < 1).length / holds.length >= SCALP_MIN_QUICK())
      : null,   // too few closed round trips to say: null means unknown, never false
    medNotional: Math.round(medNotional), medRet: medRet == null ? null : +medRet.toFixed(4),
    pnl: Math.round(pnl),
  };
}

/**
 * HOLDS LOSERS: a near-perfect win rate that comes from never closing a loser.
 *
 * Found by the Sep 24 panel: an A+ wallet winning 100% of its closes was sitting on a single ZEC
 * short worth -45% of its account. Closing only winners makes the realized record look flawless and
 * says nothing about the account. The tag needs BOTH halves:
 *   30D win rate >= 95% over 20+ closes, AND
 *   (open unrealized PnL < -15% of account value, OR any open position at <= -20% of its cost held
 *    longer than 72 hours)
 * A tagged wallet is capped at grade B and gets no route exemption (see assess() in alerts.js).
 */
export const HL_MIN_WIN     = () => num('HOLDS_LOSERS_MIN_WIN', 0.95);
export const HL_MIN_CLOSED  = () => num('HOLDS_LOSERS_MIN_CLOSED', 20);
export const HL_UPNL        = () => num('HOLDS_LOSERS_UPNL_PCT', 0.15);
export const HL_POS_LOSS    = () => num('HOLDS_LOSERS_POSITION_LOSS', 0.20);
export const HL_HELD_H      = () => num('HOLDS_LOSERS_HELD_HOURS', 72);

/** The realized half: is the win rate high enough, on enough closes, to be suspicious? */
export const winsTooClean = (d30) => !!d30 && (d30.winRate ?? 0) >= HL_MIN_WIN() && (d30.closed || 0) >= HL_MIN_CLOSED();

/**
 * Pure verdict, given how long each deep loser has been held (hours, or null when unknown).
 * `health` is a reading from health.js. Returns { holdsLosers, why }.
 */
export function holdsLosersOf(d30, health, heldHours = {}) {
  if (!winsTooClean(d30) || !health) return { holdsLosers: false, why: null };
  if (health.upnlPct != null && health.upnlPct < -HL_UPNL()) {
    return { holdsLosers: true, why: `${Math.round((d30.winRate || 0) * 100)}% of closes won, but open losses are ${Math.round(-health.upnlPct * 100)}% of the account` };
  }
  for (const p of health.positions || []) {
    if (p.retOnNotional == null || p.retOnNotional > -HL_POS_LOSS()) continue;
    const h = heldHours[`${p.coin}|${p.side}`];
    if (h != null && h > HL_HELD_H()) {
      return { holdsLosers: true, why: `${Math.round((d30.winRate || 0) * 100)}% of closes won, but a ${p.coin} ${p.side.toLowerCase()} has been open ${Math.round(h / 24)} days at ${Math.round(p.retOnNotional * 100)}%` };
    }
  }
  return { holdsLosers: false, why: null };
}

/**
 * The same verdict with the holding time looked up. Only reads fills when it has to: the wallet must
 * already win almost every close AND hold a position at -20% or worse, which is rare, so the heavy
 * fill history is almost never requested. A position whose opening fill is not in the 30-day window
 * has been open longer than that. Never throws; unknown holding time never tags.
 */
export async function checkHoldsLosers(addr, d30, health) {
  const quick = holdsLosersOf(d30, health);
  if (quick.holdsLosers || !winsTooClean(d30) || !health) return quick;
  const deep = (health.positions || []).filter((p) => p.retOnNotional != null && p.retOnNotional <= -HL_POS_LOSS());
  if (!deep.length) return quick;
  const now = Date.now();
  const fills = await hl.userFills(addr, now - WINDOW_DAYS() * DAY, now).catch(() => null);
  if (!fills || fills.truncated) return quick;
  const open = positionsFromFills(fills).filter((p) => p.stillOpen);
  const held = {};
  for (const p of deep) {
    const o = open.filter((x) => x.coin === p.coin && x.side === p.side).sort((a, b) => b.t0 - a.t0)[0];
    held[`${p.coin}|${p.side}`] = o ? (now - o.t0) / H : WINDOW_DAYS() * 24;
  }
  return holdsLosersOf(d30, health, held);
}

// Wallets we have already tried and got nothing usable from, so a dead address is not re-fetched on
// every floor build. Cleared when the process restarts, which is the right cadence for a retry.
const attempted = new Set();
let warming = false;

/**
 * Fill in classifications for wallets the floor is about to show, a few at a time, in the background.
 *
 * Without this the map is only ever written by the daily roster, which means a fresh deployment runs
 * for up to a week with no classifications at all — and every rule that depends on them (the EARLY and
 * PRINTER tags, and the live floor's cap on fast wallets) silently does nothing. That is not a state
 * worth shipping: it looks exactly like the feature being broken.
 *
 * Free (Hyperliquid only) and deliberately slow: a handful per build, one at a time, never blocking
 * the page. The floor renders now and gets better over the next few minutes.
 */
export async function warmClassifications(addrs, max = Number(process.env.CLASS_WARM_PER_BUILD || 10)) {
  if (warming) return;
  const todo = [...new Set(addrs.map((a) => String(a || '').toLowerCase()).filter(Boolean))]
    .filter((a) => !map[a] && !attempted.has(a)).slice(0, max);
  if (!todo.length) return;
  warming = true;
  try {
    let wrote = false;
    for (const a of todo) {
      attempted.add(a);
      const r = await classify(a).catch(() => null);
      if (r) { map[a] = r; wrote = true; }
    }
    if (wrote) save('traderclass', map);
  } finally { warming = false; }
}

/** Classify a list of wallets and persist the result. Returns a summary. */
export async function classifyAll(addrs, { onProgress } = {}) {
  const next = {};
  let i = 0;
  for (const a of addrs) {
    const key = String(a).toLowerCase();
    const r = await classify(a).catch(() => null);
    if (r) next[key] = r;
    if (onProgress && ++i % 20 === 0) onProgress(i, addrs.length);
  }
  // Keep wallets from earlier runs that this run did not look at: a trader who simply did not trade
  // this week should not silently lose a tag they earned.
  map = { ...map, ...next };
  save('traderclass', map);
  const v = Object.values(next);
  return { scored: v.length, early: v.filter((x) => x.early).length, printer: v.filter((x) => x.printer).length };
}
