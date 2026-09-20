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
export const PRINTER_MIN_USD  = () => num('PRINTER_MIN_USD', 15000);       // never lower: below this is noise
export const PRINTER_MAX_USD  = () => num('PRINTER_MAX_USD', 50000);       // at or above this they are a whale already
export const PRINTER_MIN_TRADES = () => num('PRINTER_MIN_TRADES', 8);
export const PRINTER_MIN_WIN  = () => num('PRINTER_MIN_WIN', 0.55);
export const PRINTER_MIN_RET  = () => num('PRINTER_MIN_RET', 0.01);

// addr -> { early, printer, stats, at }. Written by the roster, read on every alert and card.
let map = load('traderclass', {});
export const classOf = (addr) => (addr ? map[String(addr).toLowerCase()] || null : null);
export const isEarly = (addr) => !!classOf(addr)?.early;
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
export function notePace(addr, tradesPerDay, scalper) {
  const k = String(addr || '').toLowerCase();
  if (!k || !map[k]) return;
  map[k].pace = tradesPerDay ?? null;
  map[k].scalper = !!scalper;
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
  if (fills.truncated) return { early: false, printer: false, truncated: true, at: new Date().toISOString() };

  const pos = positionsFromFills(fills);
  if (!pos.length) return null;

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
  const goodCoins = new Set(good.map((x) => x.coin)).size;
  const goodDays = new Set(good.map((x) => Math.floor(x.t0 / DAY))).size;
  const medNotional = median(sizes) || 0;
  const winRate = closed ? wins / closed : 0;
  const medRet = median(rets);

  const early = good.length >= MIN_GOOD() && convert >= MIN_CONVERT()
    && goodCoins >= MIN_COINS() && goodDays >= MIN_DAYS() && pnl > 0;
  const printer = medNotional >= PRINTER_MIN_USD() && medNotional < PRINTER_MAX_USD()
    && closed >= PRINTER_MIN_TRADES() && winRate >= PRINTER_MIN_WIN()
    && (medRet ?? 0) >= PRINTER_MIN_RET() && pnl > 0;

  return {
    early, printer, truncated: false, at: new Date().toISOString(),
    finds: finds.length, goodFinds: good.length, convert: +convert.toFixed(3),
    medCapture: finds.length ? +median(finds.map((x) => x.capture)).toFixed(3) : null,
    goodCoins, goodDays,
    bestFind: good.slice().sort((a, b) => b.mfe - a.mfe)[0] || null,
    trades: pos.length, closed, winRate: +winRate.toFixed(3),
    // ROUND TRIPS per day, which is NOT the same number as the scalper pace shown on a card: that one
    // comes from Nansen's closed_trade_count, which counts every closing fill, so a whale who scales
    // out of one position in twenty fills is 1 here and 20 there. Kept under its own name so the two
    // can never be compared by accident — use `scalper`/`pace` below for anything pace-related.
    roundTripsPerDay: +(closed / WINDOW_DAYS()).toFixed(1),
    medNotional: Math.round(medNotional), medRet: medRet == null ? null : +medRet.toFixed(4),
    pnl: Math.round(pnl),
  };
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
