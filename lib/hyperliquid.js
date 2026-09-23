// Hyperliquid public info API (free, no key). Used for prices and to settle bets.
const INFO = 'https://api.hyperliquid.xyz/info';
const candleCache = new Map();

// Hyperliquid allows ~1,200 request weight per minute per IP; fill history is the heaviest call, so we
// queue those - ONE at a time with a 350ms gap. Two very different jobs share that queue: dealing a
// training hand (someone is staring at a spinner) and settling live bets in the background (nobody is
// waiting). A single FIFO chain meant that once a few Ride the Whale bets were open, every new hand
// queued behind the settlement sweep and the table visibly stalled after a few cards.
//
// So the queue has two lanes. Interactive work jumps ahead of background work; within a lane it stays
// FIFO. Background calls still make progress because a player can only deal so fast, and the shared
// 350ms gap keeps the rate limit intact either way.
const heavyQ = { hi: [], lo: [] };
let heavyRunning = false;
const HEAVY_MAX = 25, HEAVY_GAP = 350;
async function pumpHeavy() {
  if (heavyRunning) return;
  heavyRunning = true;
  try {
    while (heavyQ.hi.length || heavyQ.lo.length) {
      const job = heavyQ.hi.shift() || heavyQ.lo.shift();
      try { job.resolve(await job.run()); } catch (e) { job.reject(e); }
      await new Promise((r) => setTimeout(r, HEAVY_GAP));
    }
  } finally { heavyRunning = false; }
}
async function info(body, { priority = false } = {}) {
  const heavy = body.type === 'userFillsByTime';
  const run = async () => {
    for (let i = 0; i < 6; i++) {
      const res = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(heavy ? 20_000 : 8_000) }).catch(() => null);
      if (res?.ok) return res.json();
      await new Promise((r) => setTimeout(r, (res?.status === 429 ? 4000 : 800) * (i + 1)));
    }
    throw new Error('Hyperliquid info API unavailable');
  };
  if (!heavy) return run();
  if (heavyQ.hi.length + heavyQ.lo.length >= HEAVY_MAX) throw new Error('Hyperliquid fill queue is full, try again in a moment');
  return new Promise((resolve, reject) => {
    (priority ? heavyQ.hi : heavyQ.lo).push({ run, resolve, reject });
    pumpHeavy();
  });
}
/** Queue depth, for tests and diagnostics. */
export const heavyDepth = () => ({ interactive: heavyQ.hi.length, background: heavyQ.lo.length });

const midCache = new Map();
/** Mid prices for the main dex, or a HIP-3 builder dex (e.g. 'xyz' for xyz:GOLD). Cached 1.5s. */
const mids_ = (dex = '') => mids(dex);
export async function mids(dex = '') {
  const hit = midCache.get(dex);
  if (hit && Date.now() - hit.t < 1_500) return hit.data;
  const data = await info(dex ? { type: 'allMids', dex } : { type: 'allMids' });
  midCache.set(dex, { t: Date.now(), data });
  return data;
}
// ---------------------------------------------------------------- symbol resolution (HIP-3 builder dexes)
// Nansen reports a BARE ticker ('SNDK', 'TSLA'). Hyperliquid names equity and other builder-dex perps
// with a dex prefix ('xyz:SNDK'). Every position, price and fill lookup matches on the exact coin
// string, so a bare ticker silently finds nothing: allMids has no entry, clearinghouseState has no
// position, and userFills filters to zero rows. That is how a whale-exit alert can go missing —
// the lookup does not error, it just reports "not open" or "no price" and the caller believes it.
// Resolve once, here, and pass the Hyperliquid name to everything downstream.
// The builder dexes, asked of Hyperliquid rather than hard-coded, so a dex that lists after this was
// written is tracked the day it opens instead of the day somebody notices. The literal list below is
// the fallback when that call fails, and was verified complete (all 11, 523 markets) in Sep 2026 —
// keep it, because a failed lookup must never shrink coverage to the main dex alone.
const DEX_FALLBACK = ['', 'xyz', 'io', 'flx', 'cash', 'km', 'mkts', 'para', 'vntl', 'hyna', 'abcd'];
let dexList = null, dexListAt = 0;
async function dexes() {
  if (dexList && Date.now() - dexListAt < 6 * 3600e3) return dexList;
  const r = await info({ type: 'perpDexs' }).catch(() => null);
  // perpDexs returns null for the main dex and {name,...} for each builder dex.
  const names = Array.isArray(r) ? r.map((d) => (d && d.name ? String(d.name) : '')) : null;
  if (!names || !names.includes('')) return dexList || DEX_FALLBACK;   // no main dex in the answer = don't trust it
  // Union with the fallback: a dex that vanishes from one flaky response should not vanish from us.
  const merged = [...new Set(['', ...names, ...DEX_FALLBACK])];
  dexList = merged; dexListAt = Date.now();
  return merged;
}
export const knownDexes = () => dexes();

let symMap = null, symMapAt = 0;
async function symbolMap() {
  if (symMap && Date.now() - symMapAt < 10 * 60e3) return symMap;
  const m = new Map();
  let mainOk = false;
  for (const dex of await dexes()) {
    const mids = await mids_(dex).catch(() => null);
    if (!mids) continue;
    if (dex === '') mainOk = true;
    // Main dex first, so a builder-dex listing can never shadow real BTC or ETH.
    for (const k of Object.keys(mids)) { const t = k.split(':').pop().toUpperCase(); if (!m.has(t)) m.set(t, k); }
  }
  // Only cache a map the MAIN dex contributed to. Without it, one failed allMids call could pin a map
  // in which a builder-dex listing shadows real BTC or ETH for the next ten minutes.
  if (mainOk && m.size) { symMap = m; symMapAt = Date.now(); }
  // Main dex down: a stale map that the main dex DID build is safer than a fresh builder-dex-only one,
  // because only the stale one is guaranteed to map BTC to BTC.
  if (!mainOk && symMap) return symMap;
  return m;
}
/**
 * Nansen ticker -> the exact Hyperliquid coin string, or null when nothing lists it.
 * Null is meaningful: it means "cannot be checked", NOT "position closed". Callers must not
 * treat it as a flat position.
 */
export async function resolveCoin(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return null;
  if (raw.includes(':')) return raw;                 // already a Hyperliquid name
  const m = await symbolMap();
  return m.get(raw.toUpperCase()) || null;
}

/**
 * Internal: the Hyperliquid name for a caller-supplied symbol. `strict` throws instead of guessing,
 * for the position lookups where an unresolvable symbol must read as "unknown" and never as "flat".
 */
async function hlName(coin, strict = false) {
  const raw = String(coin || '');
  if (raw.includes(':')) return raw;
  const r = await resolveCoin(raw).catch(() => null);
  if (r) return r;
  if (strict) throw new Error(`No Hyperliquid market found for "${raw}"`);
  return raw;
}

/** Mid price for any coin symbol, including builder-dex symbols like 'xyz:GOLD'. */
export async function mid(coin) {
  coin = await hlName(coin);
  const dex = coin.includes(':') ? coin.split(':')[0] : '';
  const m = await mids(dex);
  return m[coin] != null ? +m[coin] : null;
}

/** 5-minute candles between two ms timestamps. Closed windows are cached forever. */
export async function candles(coin, startMs, endMs, interval = '5m') {
  coin = await hlName(coin);
  const key = `${coin}|${interval}|${startMs}|${endMs}`;
  if (candleCache.has(key)) return candleCache.get(key);
  const raw = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: startMs, endTime: endMs } });
  const rows = (raw || []).map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }));
  if (endMs < Date.now() - 60_000) { candleCache.set(key, rows); if (candleCache.size > 1000) candleCache.delete(candleCache.keys().next().value); }
  return rows;
}

/**
 * What happened to a position opened at `entryPrice` on `side` over the next `horizonMs`.
 * Returns the directional return plus the path, max favourable and max adverse excursion.
 */
export async function outcome(coin, side, entryPrice, startMs, horizonMs) {
  const endMs = startMs + horizonMs;
  if (endMs > Date.now()) return null;
  const rows = await candles(coin, startMs - 5 * 60_000, endMs);
  const win = rows.filter((r) => r.t >= startMs - 5 * 60_000 && r.t <= endMs);
  if (win.length < 3) return null;
  const dir = side === 'Long' ? 1 : -1;
  const exit = win[win.length - 1].c;
  let mfe = 0, mae = 0;
  for (const r of win) {
    const up = (r.h - entryPrice) / entryPrice, dn = (r.l - entryPrice) / entryPrice;
    mfe = Math.max(mfe, dir > 0 ? up : -dn);
    mae = Math.min(mae, dir > 0 ? dn : -up);
  }
  return { exit, ret: dir * (exit - entryPrice) / entryPrice, mfe, mae, path: win.map((r) => [r.t, r.c]) };
}

// ---------------------------------------------------------------- whale exits (free public fill history)
const fillCache = new Map();

/** All fills of a user between two times (pages through the 2,000-fill API limit). */
const recentFills = new Map(); // user -> { t, start, fills } for windows ending "now" (Ride the Whale checks)
export async function userFills(user, startMs, endMs, { priority = false } = {}) {
  const live = endMs >= Date.now() - 60e3;
  if (live) {
    const r = recentFills.get(user);
    if (r && Date.now() - r.t < 45e3 && r.start <= startMs) {
      const f = r.fills.filter((x) => x.time >= startMs); f.truncated = r.fills.truncated; return f;
    }
  }
  const key = `${user}|${startMs}|${endMs}`;
  if (fillCache.has(key)) return fillCache.get(key);
  const out = [];
  let from = startMs;
  out.truncated = false;
  for (let page = 0; page < 4; page++) {
    const batch = await info({ type: 'userFillsByTime', user, startTime: from, endTime: endMs, aggregateByTime: true }, { priority });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 2000) break;
    if (page === 3) { out.truncated = true; break; } // very high-frequency wallet: give up rather than hammer the API
    from = batch[batch.length - 1].time + 1;
    await new Promise((r) => setTimeout(r, 2500)); // full pages are heavy on the rate limit
  }
  if (endMs < Date.now() - 60e3) { fillCache.set(key, out); if (fillCache.size > 500) fillCache.delete(fillCache.keys().next().value); }
  else { recentFills.set(user, { t: Date.now(), start: startMs, fills: out }); if (recentFills.size > 500) recentFills.delete(recentFills.keys().next().value); }
  return out;
}

/** Price at a moment: close of the 1-minute candle covering that time. */
export async function priceAt(coin, ts) {
  // 1-minute candles only go back a few days; fall back to coarser candles for older moments
  for (const [iv, ms] of [['1m', 60e3], ['15m', 900e3], ['1h', 3600e3], ['4h', 14400e3]]) {
    const rows = await candles(coin, ts - 3 * ms, ts + ms, iv).catch(() => []);
    const c = rows.filter((r) => r.t <= ts).pop() || rows[0];
    if (c) return c.c;
  }
  return null;
}

/** Current position details of a user on a coin: signed size, average entry, value, unrealized PnL. null if flat. */
export async function positionInfo(user, coin) {
  coin = await hlName(coin, true);
  const dex = coin.includes(':') ? coin.split(':')[0] : '';
  const st = await info(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user });
  const p = (st?.assetPositions || []).map((a) => a.position).find((x) => x.coin === coin);
  return p ? { szi: +p.szi, entryPx: +p.entryPx, valueUsd: +p.positionValue, upnl: +p.unrealizedPnl } : { szi: 0 };
}

/**
 * How much of a perp SHORT is covered by the same wallet's spot holding of that coin, as a share of
 * the short's value (1 = fully hedged). A short sitting on matching spot is a hedge or a basis
 * trade, not a call that the price will fall, so copying it is copying half a position. Spot tokens
 * on Hyperliquid are often wrapped ("UBTC", "UETH"), so both names count. Main-dex coins only;
 * builder-dex markets (xyz:...) have no spot twin. Returns null when it cannot tell.
 */
export async function spotCover(user, coin, shortUsd) {
  const c = String(coin || '');
  if (!c || c.includes(':') || !(shortUsd > 0)) return null;
  const st = await info({ type: 'spotClearinghouseState', user }).catch(() => null);
  if (!st || !Array.isArray(st.balances)) return null;
  const want = new Set([c.toUpperCase(), 'U' + c.toUpperCase()]);
  const qty = st.balances.filter((b) => want.has(String(b.coin).toUpperCase())).reduce((a, b) => a + (+b.total || 0), 0);
  if (!qty) return 0;
  const px = await mid(c).catch(() => null);
  return px ? (qty * px) / shortUsd : null;
}

/** Current position size (signed) of a user on a coin. */
export async function positionSize(user, coin) {
  coin = await hlName(coin, true);
  const dex = coin.includes(':') ? coin.split(':')[0] : '';
  const st = await info(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user });
  const p = (st?.assetPositions || []).map((a) => a.position).find((x) => x.coin === coin);
  return p ? +p.szi : 0;
}

/**
 * Follow a whale's position on a coin from `fromMs` and work out their effective exit.
 * startSize: signed position size at fromMs (if unknown, taken from the first fill's startPosition).
 * Exit price = size-weighted average of every reduction until the position is flat, plus any remainder marked at the cap.
 * Returns { closed, exitPx, exitAt, heldMs, exits } or null if nothing can be determined.
 */
export async function whaleExit(user, coin, fromMs, capMs, startSize = null, anchorOpen = false, { priority = false } = {}) {
  coin = await hlName(coin);
  const endMs = Math.min(Date.now(), fromMs + capMs);
  const all = await userFills(user, fromMs - 5 * 60e3, endMs, { priority });
  let fills = all.filter((f) => f.coin === coin).sort((a, b) => a.time - b.time);
  if (anchorOpen) {
    // start at the whale's opening fill (closest "Open" fill to the reported open time)
    const opens = fills.filter((f) => /Open/.test(f.dir) && Math.abs(f.time - fromMs) < 5 * 60e3);
    if (!opens.length) return null;
    const o = opens.sort((a, b) => Math.abs(a.time - fromMs) - Math.abs(b.time - fromMs))[0];
    fromMs = o.time;
    fills = fills.filter((f) => f.time > o.time || f === o);
  } else {
    fills = fills.filter((f) => f.time >= fromMs);
  }
  let pos = startSize;
  let exitedSz = 0, exitedVal = 0, closedAt = null;
  const exits = [];
  for (const f of fills) {
    const start = +f.startPosition, sz = +f.sz, isBuy = f.side === 'B';
    if (pos == null) pos = start;
    const after = start + (isBuy ? sz : -sz);
    if (Math.abs(start) > 1e-12 && Math.abs(after) < Math.abs(start) || Math.sign(after) !== Math.sign(start) && Math.abs(start) > 1e-12) {
      const reduced = Math.sign(after) !== Math.sign(start) ? Math.abs(start) : Math.abs(start) - Math.abs(after);
      exitedSz += reduced; exitedVal += reduced * +f.px;
      exits.push({ t: f.time, px: +f.px, sz: reduced });
      if (Math.abs(after) < 1e-9 * Math.max(1, Math.abs(start)) || Math.sign(after) !== Math.sign(start)) { closedAt = f.time; pos = 0; break; }
    }
    pos = after;
  }
  if (!closedAt && all.truncated) return null; // too many fills to follow reliably
  if (closedAt) return { closed: true, exitPx: exitedVal / exitedSz, exitAt: closedAt, heldMs: closedAt - fromMs, fromMs, exits };
  if (Date.now() < fromMs + capMs) return { closed: false, open: true, exits, exitedSz, exitedVal, pos };
  const mark = await priceAt(coin, fromMs + capMs);
  if (!mark) return null;
  const remaining = Math.abs(pos ?? 0);
  const totSz = exitedSz + remaining;
  const exitPx = totSz > 0 ? (exitedVal + remaining * mark) / totSz : mark;
  return { closed: false, capped: true, exitPx, exitAt: fromMs + capMs, heldMs: capMs, fromMs, exits };
}

/** Price path + excursions between two times (for charts and cash-out). */
export async function pathBetween(coin, side, entryPrice, startMs, endMs) {
  const span = endMs - startMs;
  const interval = span > 12 * 3600e3 ? '15m' : '5m';
  const step = interval === '15m' ? 15 * 60e3 : 5 * 60e3;
  const rows = await candles(coin, startMs - step, endMs, interval);
  const win = rows.filter((r) => r.t >= startMs - step && r.t <= endMs);
  if (win.length < 2) return null;
  const dir = side === 'Long' ? 1 : -1;
  let mfe = 0, mae = 0;
  for (const r of win) {
    const up = (r.h - entryPrice) / entryPrice, dn = (r.l - entryPrice) / entryPrice;
    mfe = Math.max(mfe, dir > 0 ? up : -dn); mae = Math.min(mae, dir > 0 ? dn : -up);
  }
  return { path: win.map((r) => [r.t, r.c]), mfe, mae };
}
