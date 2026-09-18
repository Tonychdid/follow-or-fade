// Nansen API client: caching, rate-limit handling, credit/call accounting, demo fallback.
import { load, save } from './store.js';
import * as demo from './demo.js';

const BASE = 'https://api.nansen.ai/api/v1';
// Credit cost per endpoint (from docs.nansen.ai credits guide). Unknown endpoints default to 1.
const COST = {
  'smart-money/perp-trades': 5, 'perp-screener': 1, 'profiler/perp-pnl-summary': 1,
  'profiler/perp-positions': 1, 'profiler/perp-trades': 1, 'tgm/perp-positions': 5,
  'tgm/perp-trades': 1, 'perp-leaderboard': 5,
};
const cache = new Map();          // key -> { t, data }
const inflight = new Map();       // key -> Promise
const usage = load('usage', { calls: 0, credits: 0, byEndpoint: {}, errors: 0, firstCall: null });
const today = () => new Date().toISOString().slice(0, 10);
// Optional daily credit cap (DAILY_CREDIT_CAP). When reached, the app keeps serving cached Nansen data and
// falls back to demo data for anything new, until the next UTC day.
const CAP = () => Number(process.env.DAILY_CREDIT_CAP || 0);
export const creditsToday = () => (usage.day === today() ? usage.dayCredits || 0 : 0);
export const isCapped = () => CAP() > 0 && creditsToday() >= CAP();

export const isDemo = () => process.env.DEMO === '1' || !process.env.NANSEN_API_KEY;
export const getUsage = () => ({ calls: usage.calls, credits: usage.credits, creditsToday: creditsToday(), dailyCap: CAP() || null, capped: isCapped(), demo: isDemo() });

/** Count a call made outside post() (the Agent streams SSE). Adds to lifetime totals but not to the game's daily cap:
 *  the Research Desk has its own daily budget (AGENT_DAILY_CREDITS). */
export function track(endpoint, credits, ok = true) {
  usage.calls++;
  usage.firstCall ??= new Date().toISOString();
  const e = (usage.byEndpoint[endpoint] ??= { calls: 0, credits: 0 });
  e.calls++;
  if (ok) { e.credits += credits; usage.credits += credits; } else usage.errors++;
  save('usage', usage);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawPost(endpoint, body, attempt = 0) {
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.NANSEN_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000), // a black-holed socket would otherwise hold a page request for 5 minutes
  });
  // Count every real request that reached Nansen (this is what the buildathon counts).
  usage.calls++;
  usage.firstCall ??= new Date().toISOString();
  const e = (usage.byEndpoint[endpoint] ??= { calls: 0, credits: 0 });
  e.calls++;
  if (res.ok) {
    const c = COST[endpoint] ?? 1;
    e.credits += c; usage.credits += c;
    if (usage.day !== today()) { usage.day = today(); usage.dayCredits = 0; }
    usage.dayCredits += c;
  }
  save('usage', usage);

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 3) throw new Error(`Nansen ${endpoint} failed with ${res.status}`);
    // Retry-After is upstream-controlled: an honest "come back in 24h" would park this promise for a day,
    // and every caller sharing the in-flight key would hang with it.
    const wait = Math.min(30_000, Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1));
    await sleep(wait);
    return rawPost(endpoint, body, attempt + 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    usage.errors++;
    // The upstream text is for our logs, not for visitors: it names internal endpoints and account state.
    console.error(`[nansen] ${endpoint}: ${json.message || json.error || res.status}`);
    const err = new Error(res.status === 429 ? 'The Nansen API is rate limiting us right now, try again in a moment.' : 'Live Nansen data is unavailable right now, try again in a moment.');
    err.status = res.status >= 500 || res.status === 429 ? 503 : 502; err.code = json.code;
    throw err;
  }
  return json;
}

/** POST to a Nansen endpoint with an in-memory TTL cache (ttl in seconds). */
export async function post(endpoint, body, ttl = 300) {
  const key = endpoint + JSON.stringify(body);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl * 1000) return hit.data;
  if (isCapped() && hit) return hit.data; // over the daily cap: stale real data beats no data
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let data;
    if (isDemo()) data = await demo.post(endpoint, body);
    else if (isCapped()) {
      // Over today's cap with nothing cached: demo whales for the trade feed, nothing invented about real wallets
      if (endpoint === 'smart-money/perp-trades' || demo.isDemoAddress(body.address)) data = await demo.post(endpoint, body);
      else throw Object.assign(new Error('Daily Nansen credit cap reached'), { code: 'daily_cap' });
    } else data = await rawPost(endpoint, body);
    cache.set(key, { t: Date.now(), data });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- Typed helpers for the endpoints the game uses ----------

/** Recent position-opening trades by Nansen's Smart HL Perps Trader cohort. */
export async function smartMoneyOpens({ lookbackHours = 168, minValueUsd = 25000, pages = 2, perPage = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const r = await post('smart-money/perp-trades', {
      lookback_hours: lookbackHours,
      only_new_positions: true,
      filters: { value_usd: { min: minValueUsd } },
      pagination: { page, per_page: perPage },
      order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
    }, lookbackHours <= 2 ? 120 : 900);
    out.push(...(r.data || []));
    if (r.pagination?.is_last_page !== false) break;
  }
  return out.filter((t) => /open/i.test(t.action || ''));
}

/** A wallet's Hyperliquid perp track record over a date window. */
export async function walletSummary(address, fromIso, toIso) {
  const r = await post('profiler/perp-pnl-summary', { address, date: { from: fromIso, to: toIso } }, 86400);
  return r.data || r;
}

/** Market context for one coin over a window, for a trader cohort ('sm' | 'all'). */
export async function coinContext(symbol, fromIso, toIso, traderType = 'sm') {
  const r = await post('perp-screener', {
    date: { from: fromIso, to: toIso },
    filters: { token_symbol: symbol, trader_type: traderType },
    pagination: { page: 1, per_page: 5 },
  }, 3600);
  return (r.data || []).find((d) => d.token_symbol === symbol) || null;
}

/** Current Smart Money open positions on a coin (used in live mode). */
export async function smartMoneyPositions(symbol) {
  const r = await post('tgm/perp-positions', {
    token_symbol: symbol, label_type: 'smart_money',
    pagination: { page: 1, per_page: 100 },
    order_by: [{ field: 'position_value_usd', direction: 'DESC' }],
  }, 300);
  return r.data || [];
}
