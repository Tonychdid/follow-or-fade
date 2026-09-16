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

export const isDemo = () => process.env.DEMO === '1' || !process.env.NANSEN_API_KEY;
export const getUsage = () => ({ ...usage, demo: isDemo() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawPost(endpoint, body, attempt = 0) {
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.NANSEN_API_KEY },
    body: JSON.stringify(body),
  });
  // Count every real request that reached Nansen (this is what the buildathon counts).
  usage.calls++;
  usage.firstCall ??= new Date().toISOString();
  const e = (usage.byEndpoint[endpoint] ??= { calls: 0, credits: 0 });
  e.calls++;
  if (res.ok) { e.credits += COST[endpoint] ?? 1; usage.credits += COST[endpoint] ?? 1; }
  save('usage', usage);

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 3) throw new Error(`Nansen ${endpoint} failed with ${res.status}`);
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
    await sleep(wait);
    return rawPost(endpoint, body, attempt + 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    usage.errors++;
    const err = new Error(`Nansen ${endpoint}: ${json.message || json.error || res.status}`);
    err.status = res.status; err.code = json.code;
    throw err;
  }
  return json;
}

/** POST to a Nansen endpoint with an in-memory TTL cache (ttl in seconds). */
export async function post(endpoint, body, ttl = 300) {
  const key = endpoint + JSON.stringify(body);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl * 1000) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const data = isDemo() ? await demo.post(endpoint, body) : await rawPost(endpoint, body);
    cache.set(key, { t: Date.now(), data });
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
