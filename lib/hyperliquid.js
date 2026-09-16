// Hyperliquid public info API (free, no key). Used for prices and to settle bets.
const INFO = 'https://api.hyperliquid.xyz/info';
const candleCache = new Map();

async function info(body) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw new Error('Hyperliquid info API unavailable');
}

const midCache = new Map();
/** Mid prices for the main dex, or a HIP-3 builder dex (e.g. 'xyz' for xyz:GOLD). Cached 1.5s. */
export async function mids(dex = '') {
  const hit = midCache.get(dex);
  if (hit && Date.now() - hit.t < 1_500) return hit.data;
  const data = await info(dex ? { type: 'allMids', dex } : { type: 'allMids' });
  midCache.set(dex, { t: Date.now(), data });
  return data;
}
/** Mid price for any coin symbol, including builder-dex symbols like 'xyz:GOLD'. */
export async function mid(coin) {
  const dex = coin.includes(':') ? coin.split(':')[0] : '';
  const m = await mids(dex);
  return m[coin] != null ? +m[coin] : null;
}

/** 5-minute candles between two ms timestamps. Closed windows are cached forever. */
export async function candles(coin, startMs, endMs, interval = '5m') {
  const key = `${coin}|${interval}|${startMs}|${endMs}`;
  if (candleCache.has(key)) return candleCache.get(key);
  const raw = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: startMs, endTime: endMs } });
  const rows = (raw || []).map((c) => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }));
  if (endMs < Date.now() - 60_000) candleCache.set(key, rows);
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
