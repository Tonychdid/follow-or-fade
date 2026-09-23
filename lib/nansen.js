// Nansen API client: caching, rate-limit handling, credit/call accounting, demo fallback.
import { AsyncLocalStorage } from 'node:async_hooks';
import { load, save } from './store.js';
import * as demo from './demo.js';

const BASE = 'https://api.nansen.ai/api/v1';
// Credit cost per endpoint (from docs.nansen.ai credits guide). Unknown endpoints default to 1.
// Every endpoint this app calls, and what Nansen charges for it. Five more used to sit here
// (perp-leaderboard, profiler/perp-positions, profiler/perp-trades, tgm/perp-trades, tgm/perp-positions)
// with prices but no call site anywhere in the code. A priced endpoint nobody calls is not breadth,
// it is a list of things that were considered, so they are gone. These three are the whole Nansen
// surface, plus the two Agent modes billed in lib/agent.js.
const COST = {
  'smart-money/perp-trades': 5, 'perp-screener': 1,
  'profiler/perp-pnl-summary': 1,
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
/** Full ledger for the admin usage view: which endpoint spent what, and the per-call credit price. */
const BOOT = { at: Date.now(), calls: usage.calls, credits: usage.credits };
export const getUsageDetail = () => ({
  calls: usage.calls, credits: usage.credits, errors: usage.errors, firstCall: usage.firstCall,
  // Rate since this process started. A cold start costs ~120 calls (deck, live feed, first pick), so
  // read this after a few minutes of uptime, not straight after a deploy.
  sinceBoot: (() => {
    const mins = (Date.now() - BOOT.at) / 60e3;
    return { minutes: Math.round(mins), calls: usage.calls - BOOT.calls, credits: usage.credits - BOOT.credits,
      // Withheld for the first 5 minutes: a cold start costs ~120 calls all at once, so an early
      // reading extrapolates the boot burst into a wildly wrong per-hour figure.
      callsPerHour: mins < 5 ? null : Math.round((usage.calls - BOOT.calls) / (mins / 60)),
      note: mins < 5 ? 'warming up: a cold start costs ~120 calls; check again in a few minutes' : undefined };
  })(),
  day: usage.day, creditsToday: creditsToday(), dailyCap: CAP() || null,
  byEndpoint: Object.fromEntries(Object.entries(usage.byEndpoint).map(([k, v]) =>
    [k, { calls: v.calls, credits: v.credits, perCall: COST[k] ?? (v.calls ? Math.round(v.credits / v.calls) : 1) }])),
});
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

// ---------- The call rail: which Nansen calls built what ----------
// Every hand on the table is priced from Nansen data, and a judge should be able to SEE that rather
// than take it on trust. `traced(fn)` runs fn and returns every Nansen request made inside it, with
// whether it went to the API or was served from cache, how long it took and what it cost. It uses
// AsyncLocalStorage, so no helper below has to pass anything through. The rail keeps only the
// endpoint, the cohort and timings: no wallet address, no key, nothing a visitor should not see.
const tracer = new AsyncLocalStorage();
const RAIL = [];
function noteCall(endpoint, body, how, ms, data) {
  const row = { at: Date.now(), endpoint, how, ms: Math.round(ms), credits: how === 'fresh' ? (COST[endpoint] ?? 1) : 0,
    rows: Array.isArray(data?.data) ? data.data.length : null, cohort: body?.filters?.trader_type || null };
  tracer.getStore()?.push(row);
  if (how !== 'cached') { RAIL.push(row); if (RAIL.length > 60) RAIL.shift(); }
}
export async function traced(fn) {
  const calls = [];
  const value = await tracer.run(calls, fn);
  return { value, calls };
}
/** The last Nansen requests this server actually made, newest first. */
export const recentCalls = (n = 25) => RAIL.slice(-n).reverse();

/**
 * A Nansen label is shown as the whale's name, with one exception: labels that are just a Hyperliquid
 * referral code ('Uses "XYZ" HL Referral Code'). Printing someone's referral code on this site would
 * be advertising it, which the site never does, so those wallets are named by a short address instead.
 */
export function whaleName(label, address) {
  const short = address ? `${String(address).slice(0, 6)}...${String(address).slice(-4)}` : '';
  if (!label || /referral\s*code/i.test(label)) return short ? `Smart Money wallet ${short}` : 'Smart Money wallet';
  return label;
}

/** POST to a Nansen endpoint with an in-memory TTL cache (ttl in seconds). */
export async function post(endpoint, body, ttl = 300) {
  const key = endpoint + JSON.stringify(body);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl * 1000) { noteCall(endpoint, body, 'cached', 0, hit.data); return hit.data; }
  if (isCapped() && hit) { noteCall(endpoint, body, 'cached', 0, hit.data); return hit.data; } // over the daily cap: stale real data beats no data
  if (inflight.has(key)) { noteCall(endpoint, body, 'cached', 0, null); return inflight.get(key); }
  const t0 = Date.now();
  let how = 'fresh';
  const p = (async () => {
    let data;
    if (isDemo()) { how = 'demo'; data = await demo.post(endpoint, body); }
    else if (isCapped()) {
      how = 'demo';
      // Over today's cap with nothing cached: demo whales for the trade feed, nothing invented about real wallets
      if (endpoint === 'smart-money/perp-trades' || demo.isDemoAddress(body.address)) data = await demo.post(endpoint, body);
      else throw Object.assign(new Error('Daily Nansen credit cap reached'), { code: 'daily_cap' });
    } else data = await rawPost(endpoint, body);
    cache.set(key, { t: Date.now(), data });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    noteCall(endpoint, body, how, Date.now() - t0, data);
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- Typed helpers for the endpoints the game uses ----------

/** Recent position-opening trades by Nansen's Smart HL Perps Trader cohort. */
/**
 * Should the pager ask for another page?
 *
 * Pulled out as its own function because getting it wrong is silent and expensive: the previous
 * test was `is_last_page !== false`, which ends the loop after page one whenever a response carries
 * no pagination block at all, since `undefined !== false`. With DESC ordering that leaves only the
 * NEWEST trades, and pool() then throws away everything younger than MAX_HOLD - so the training
 * pool stayed small however far back the lookback was set, and nothing anywhere said why.
 *
 * Only two things end the paging: the API saying so outright, or a short page, which proves it.
 *
 * NOT WIRED IN. Switching the live loop to this emptied the feed - `usable: 0` on /api/status and a
 * table that could not deal - so the loop below is deliberately back on the original condition until
 * the second page's behaviour is understood against the real API. Kept here, and tested, because the
 * reasoning above still holds and the next attempt should start from it rather than from scratch.
 */
export const wantsNextPage = (r, batchLen, perPage) =>
  !(r?.pagination?.is_last_page === true || batchLen < perPage);

export async function smartMoneyOpens({ lookbackHours = 168, minValueUsd = 25000, pages = 2, perPage = 500, ttlSec = null } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const r = await post('smart-money/perp-trades', {
      lookback_hours: lookbackHours,
      only_new_positions: true,
      filters: { value_usd: { min: minValueUsd } },
      pagination: { page, per_page: perPage },
      order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
    }, ttlSec ?? (lookbackHours <= 2 ? 120 : 900));   // the alert scan passes its own TTL: just under one scan
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
    // Cached for as long as the window bucket lasts. A 1-hour TTL under a 6-hour bucket would re-fetch
    // an identical request five times for nothing.
  }, Math.max(1, Number(process.env.CONTEXT_HOURS || 6)) * 3600);
  return (r.data || []).find((d) => d.token_symbol === symbol) || null;
}
