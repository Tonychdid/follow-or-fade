// The Research Desk: Nansen Agent on the stocks listed on Hyperliquid.
//  - companyIntel(coin): Fast mode brief (insiders, ownership, earnings, valuation) for a stock perp a whale is trading
//  - insiderPick(): one Expert mode screen per UTC day for the best insider-buying setup, played over 1 week, 1 month or 6 months
// Answers are shared by every player and cached, so the credit cost does not grow with users.
import { load, save } from './store.js';
import * as nansen from './nansen.js';
import * as hl from './hyperliquid.js';

const BASE = 'https://api.nansen.ai/api/v1';
const COST = { fast: 200, expert: 750 };
// 750 = exactly one expert Insider Pick per day. The old 1600 allowed a second one, which doubled the
// largest single credit item on the bill for no extra product.
const BUDGET = () => Number(process.env.AGENT_DAILY_CREDITS ?? 750);
const INTEL_TTL = 12 * 3600e3;
const today = () => new Date().toISOString().slice(0, 10);

// Company tickers traded as perps on Hyperliquid builder dexes (indices, ETFs, commodities, currencies and
// private pre-IPO names are left out: they have no insider filings).
export const STOCKS = new Set(`AAOI AAPL AMAT AMD AMZN ARM ASML AVGO BABA BB BE BMNR BX CAR CIEN CIFR COHR COIN COST CRCL CRDO CRWD CRWV CVX
DELL DKNG EBAY GEV GLW GME GOOGL GPRO HIMS HOOD IBM INTC IONQ IREN LITE LLY LRCX LYTE MELI META MRNA MRVL MSFT MSTR MU NBIS NET NFLX
NOK NOW NVDA ORCL PLTR QCOM RDDT RIVN RKLB RTX SMCI SNDK SOFI STX TER TSLA TSM TTWO USAR VST WDC ZM`.split(/\s+/));
export const tickerOf = (coin) => String(coin || '').split(':').pop().toUpperCase();
export const isStock = (coin) => String(coin || '').includes(':') && STOCKS.has(tickerOf(coin));

const state = load('agent', { day: null, credits: 0, intel: {}, picks: {} });
const inflight = new Map();
const spentToday = () => (state.day === today() ? state.credits : 0);
const canSpend = (mode) => BUDGET() > 0 && spentToday() + COST[mode] <= BUDGET();
// Never negative: a call reserved at 23:55 and refunded at 00:02 would otherwise reset the day to 0
// and then subtract its reservation, handing tomorrow a bigger budget than it is allowed.
const spend = (c) => { if (state.day !== today()) { state.day = today(); state.credits = 0; } state.credits = Math.max(0, state.credits + c); save('agent', state); };

export function status() {
  const b = BUDGET();
  return { enabled: b > 0, demo: nansen.isDemo(), budget: b, spentToday: spentToday(), left: Math.max(0, b - spentToday()) };
}

/** Ask Nansen Agent and collect the streamed answer. */
async function ask(mode, text) {
  if (!canSpend(mode)) throw Object.assign(new Error('The Research Desk used today\'s Nansen Agent budget. It reopens at 00:00 UTC.'), { status: 429, code: 'agent_budget' });
  spend(COST[mode]); // reserve first so parallel requests can't overspend
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), mode === 'expert' ? 900e3 : 180e3);
  let gotResponse = false;
  try {
    const res = await fetch(`${BASE}/agent/${mode}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', apikey: process.env.NANSEN_API_KEY },
      body: JSON.stringify({ text }),
    });
    gotResponse = true;
    const cost = Number(res.headers.get('x-nansen-credits-cost')) || (res.ok ? COST[mode] : 0);
    nansen.track(`agent/${mode}`, cost, res.ok);
    if (cost !== COST[mode]) spend(cost - COST[mode]);
    if (!res.ok) throw new Error(`Nansen Agent ${mode}: ${res.status}`);
    let out = '', tools = [], buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'delta') out += ev.text || '';
        else if (ev.type === 'tool_call') tools.push(ev.name);
        else if (ev.type === 'error') throw new Error(`Nansen Agent: ${ev.error || ev.status_code}`);
      }
    }
    return { text: out, tools: [...new Set(tools)] };
  } catch (e) {
    if (!gotResponse) spend(-COST[mode]); // the request never reached Nansen: give the reservation back
    if (e.name === 'AbortError') throw new Error('Nansen Agent took too long');
    throw e;
  } finally { clearTimeout(timer); }
}

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const SIGNALS = ['buying', 'selling', 'mixed', 'none'];
const INSIDER_FIELDS = 'avgBuyPrice (number: value-weighted average price per share of the insider purchases you describe, null if none), '
  + 'firstReportDate and lastReportDate (YYYY-MM-DD report dates of those transactions, null if unknown), totalBuyUsd (number or null)';
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
function cleanInsider(x) {
  const sig = String(x?.signal || 'none').toLowerCase();
  return { signal: SIGNALS.includes(sig) ? sig : 'none', detail: clip(x?.detail, 220),
    avgBuyPrice: num(x?.avgBuyPrice), firstReportDate: isoDay(x?.firstReportDate), lastReportDate: isoDay(x?.lastReportDate), totalBuyUsd: num(x?.totalBuyUsd) };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Dates like "Sep. 8–10" or "Aug 11" or "2026-08-11" inside the agent's plain-words detail. */
function datesFromText(text) {
  const t = String(text || ''), y = new Date().getUTCFullYear(), out = [];
  for (const m of t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s*[–-]\s*(\d{1,2}))?/gi)) {
    const mo = MONTHS[m[1].toLowerCase()];
    let d1 = Date.UTC(y, mo, +m[2]); if (d1 > Date.now() + 864e5) d1 = Date.UTC(y - 1, mo, +m[2]);
    out.push(d1); if (m[3]) out.push(d1 + (+m[3] - +m[2]) * 864e5);
  }
  return out.length ? { from: Math.min(...out), to: Math.max(...out) } : null;
}
/** "$20,375,900 ... 1,000,000 shares" or "105,263 shares at $95.00" -> price per share. */
function priceFromText(text) {
  const t = String(text || '');
  const at = t.match(/shares?\s+(?:at|@)\s+(?:an?\s+average\s+(?:price\s+)?(?:of\s+)?)?\$([\d,.]+)/i);
  if (at) return num(at[1]);
  const a = t.match(/([\d,.]+)\s*(million|m)?\s+shares?[^$]{0,20}\$([\d,.]+)\s*(million|m|b|billion)?/i)
    || null;
  const b = t.match(/\$([\d,.]+)\s*(million|m|b|billion)?[^\d$]{0,40}?([\d,.]+)\s*(million|m)?\s+shares?/i);
  const scale = (u) => (/^b/i.test(u || '') ? 1e9 : /^m/i.test(u || '') ? 1e6 : 1);
  if (a) { const sh = num(a[1]) * scale(a[2]), usd = num(a[3]) * scale(a[4]); if (sh && usd) return usd / sh; }
  if (b) { const usd = num(b[1]) * scale(b[2]), sh = num(b[3]) * scale(b[4]); if (sh && usd) return usd / sh; }
  return null;
}
/**
 * Where did insiders get in? Filings price when Nansen Agent gives it, else parsed from its words,
 * else the average Hyperliquid daily price over the reported dates (an estimate, labelled as such).
 */
export async function insiderEntry(coin, ins) {
  if (!ins || ins.signal !== 'buying') return null;
  const range = ins.firstReportDate ? { from: Date.parse(ins.firstReportDate), to: Date.parse(ins.lastReportDate || ins.firstReportDate) } : datesFromText(ins.detail);
  const mid = await hl.mid(coin).catch(() => null);
  const sane = (p) => p && (!mid || (p > mid / 5 && p < mid * 5));
  let price = sane(ins.avgBuyPrice) ? ins.avgBuyPrice : null, source = price ? 'filings' : null;
  if (!price) { const p = priceFromText(ins.detail); if (sane(p)) { price = p; source = 'filings'; } }
  if (!price && range) {
    const rows = await hl.candles(coin, range.from, range.to + 864e5, '1d').catch(() => []);
    if (rows.length) { price = rows.reduce((a, r) => a + (r.h + r.l + r.c) / 3, 0) / rows.length; source = 'chart'; }
  }
  if (!price) return null;
  return { price: +price.toFixed(price < 10 ? 4 : 2), source, from: range ? new Date(range.from).toISOString().slice(0, 10) : null,
    to: range ? new Date(range.to).toISOString().slice(0, 10) : null };
}

/** Whale vs insiders: do they point the same way? */
export function alignment(side, signal) {
  if (signal === 'buying') return side === 'Long' ? 'aligned' : 'against';
  if (signal === 'selling') return side === 'Short' ? 'aligned' : 'against';
  return 'neutral';
}

// ------------------------------------------------------------------ company intel (Fast mode)
function demoIntel(t) {
  return { ticker: t, company: `${t} (sample)`, insider: { signal: ['buying', 'selling', 'mixed'][t.length % 3], detail: 'Sample research: add a Nansen API key to get live insider filings from Nansen Agent.' },
    ownership: 'Sample data', earnings: { next: 'n/a', last: 'n/a' }, valuation: 'Sample data', verdict: 'Demo mode: this card shows the layout of a Nansen Agent brief.', asOf: today(), tools: [], demo: true, at: Date.now() };
}

async function fetchIntel(t) {
  if (nansen.isDemo()) return demoIntel(t);
  const { text, tools } = await ask('fast', `Research the public company with stock ticker ${t}, traded as a stock perp on Hyperliquid. `
    + 'Reply ONLY with a JSON object, no prose, keys: company (string), insider {signal: "buying"|"selling"|"mixed"|"none", detail: string max 160 chars, '
    + 'recent insider transactions in plain words, ' + INSIDER_FIELDS + '}, ownership (max 120 chars), earnings {next: string (date if known), last: max 120 chars}, '
    + 'valuation (max 120 chars), verdict (one sentence max 160 chars, no advice), asOf (date).');
  const j = parseJson(text);
  if (!j) throw new Error('Nansen Agent answer could not be read');
  return { ticker: t, company: clip(j.company, 80), insider: cleanInsider(j.insider), ownership: clip(j.ownership, 140),
    earnings: { next: clip(j.earnings?.next, 60), last: clip(j.earnings?.last, 140) }, valuation: clip(j.valuation, 140),
    verdict: clip(j.verdict, 200), asOf: clip(j.asOf, 20), tools, at: Date.now(), coin: t };
}

/** Cached brief for a stock perp. start=false only reads the cache. */
export function companyIntel(coin, { start = true } = {}) {
  if (!isStock(coin)) return { status: 'unsupported' };
  const t = tickerOf(coin);
  const hit = state.intel[t];
  if (hit && Date.now() - hit.at < INTEL_TTL) return { status: 'ready', intel: hit };
  if (inflight.has('intel:' + t)) return { status: 'loading' };
  if (!start) return hit ? { status: 'ready', intel: hit, stale: true } : { status: 'none' };
  const reserve = state.picks[today()]?.coin || state.picks[today()]?.error ? 0 : COST.expert; // keep room for today's Insider Pick
  if (!nansen.isDemo() && !(BUDGET() > 0 && spentToday() + COST.fast + reserve <= BUDGET())) return hit ? { status: 'ready', intel: hit, stale: true } : { status: 'closed', message: "The Research Desk used today's Nansen Agent budget. It reopens at 00:00 UTC." };
  const p = fetchIntel(t)
    .then(async (intel) => { intel.insider.entry = await insiderEntry(coin, intel.insider).catch(() => null); state.intel[t] = intel; save('agent', state); })
    .catch((e) => { console.warn('[agent] intel', t, e.message); state.intel['!' + t] = { error: e.message, at: Date.now() }; })
    .finally(() => inflight.delete('intel:' + t));
  inflight.set('intel:' + t, p);
  return { status: 'loading' };
}
export async function waitIntel(coin, ms = 25e3) {
  const p = inflight.get('intel:' + tickerOf(coin));
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  const r = companyIntel(coin, { start: false });
  const err = state.intel['!' + tickerOf(coin)];
  if (r.status === 'none' && err && Date.now() - err.at < 60e3) return { status: 'error', message: 'Nansen Agent could not research this one right now. Try again in a minute.' };
  return r;
}

// ------------------------------------------------------------------ insider pick of the day (Expert mode)
async function listedStocks() {
  const bySym = new Map();
  for (const dex of ['xyz', 'km', 'cash', 'flx', 'para', 'io']) {
    const m = await hl.mids(dex).catch(() => null);
    if (!m) continue;
    for (const k of Object.keys(m)) { const t = tickerOf(k); if (STOCKS.has(t) && !bySym.has(t)) bySym.set(t, k); }
  }
  return bySym; // ticker -> preferred Hyperliquid symbol (xyz first)
}

function demoPick(listed) {
  const t = listed.has('NVDA') ? 'NVDA' : [...listed.keys()][0];
  return { ticker: t, coin: listed.get(t), company: `${t} (sample)`, side: 'Long', conviction: 3,
    insider: { signal: 'buying', detail: 'Sample pick: add a Nansen API key and Nansen Agent screens every stock on Hyperliquid for insider buying.' },
    thesis: 'Demo mode shows how the Insider Pick of the Day looks.', earnings: 'n/a', valuation: 'n/a', risks: 'Sample data', runnersUp: [], demo: true };
}

let pickRun = null;
export function insiderPick() {
  const p = state.picks[today()];
  if (p?.coin) return { status: 'ready', pick: p };
  if (pickRun) return { status: 'loading' };
  const y = state.picks[new Date(Date.now() - 864e5).toISOString().slice(0, 10)];
  return y?.coin ? { status: 'yesterday', pick: y } : { status: 'none' };
}

/** Runs the daily screen if today's pick is missing. Called by a background timer, never by players. */
export async function ensurePick() {
  if (state.picks[today()]?.coin || pickRun) return;
  if (state.picks[today()]?.error && Date.now() - state.picks[today()].at < 3 * 3600e3) return; // retry failed screens every 3h
  if (!nansen.isDemo() && !canSpend('expert')) return;
  pickRun = (async () => {
    const listed = await listedStocks();
    if (!listed.size) throw new Error('No stock perps found on Hyperliquid');
    let pick;
    if (nansen.isDemo()) pick = demoPick(listed);
    else {
      const tickers = [...listed.keys()];
      const { text, tools } = await ask('expert', `Find me stocks where insiders are buying. Screen these stocks listed on Hyperliquid: ${tickers.join(', ')}. `
        + 'Pick the single best opportunity where recent insider transactions (open-market buys by officers and directors) are most bullish, using valuation and earnings as a cross-check. '
        + 'Freshness matters: strongly prefer purchases reported in the last 5 business days, because the market reacts quickly once filings are public. '
        + 'Reply ONLY with a JSON object, no prose, keys: ticker (one of the list), company, side ("long" or "short"), conviction (1-5), '
        + 'insider {signal: "buying"|"selling"|"mixed"|"none", detail: max 200 chars, ' + INSIDER_FIELDS + '}, thesis (max 240 chars), earnings (max 120 chars), valuation (max 120 chars), '
        + 'risks (max 160 chars), runnersUp (array of up to 2 {ticker, why max 100 chars}), asOf (date).');
      const j = parseJson(text);
      const t = tickerOf(j?.ticker);
      if (!j || !listed.has(t)) throw new Error('Nansen Agent pick could not be matched to a Hyperliquid stock');
      pick = { ticker: t, coin: listed.get(t), company: clip(j.company, 80), side: String(j.side).toLowerCase() === 'short' ? 'Short' : 'Long',
        conviction: Math.max(1, Math.min(5, Math.round(Number(j.conviction) || 3))), insider: cleanInsider(j.insider), thesis: clip(j.thesis, 260),
        earnings: clip(j.earnings, 140), valuation: clip(j.valuation, 140), risks: clip(j.risks, 180),
        runnersUp: (Array.isArray(j.runnersUp) ? j.runnersUp : []).filter(Boolean).slice(0, 2).map((r) => ({ ticker: tickerOf(r.ticker), why: clip(r.why, 120) })),
        asOf: clip(j.asOf, 20), tools, screened: tickers.length };
    }
    const price = await hl.mid(pick.coin).catch(() => null);
    pick.insider.entry = await insiderEntry(pick.coin, pick.insider).catch(() => null);
    Object.assign(pick, { day: today(), at: Date.now(), priceAtPick: price, key: `pick:${today()}:${pick.coin}` });
    state.picks[today()] = pick;
    for (const d of Object.keys(state.picks).sort().slice(0, -14)) delete state.picks[d]; // keep 2 weeks
    save('agent', state);
    console.log(`[agent] Insider Pick of the Day: ${pick.side} ${pick.coin}`);
  })().catch((e) => {
    console.warn('[agent] pick', e.message);
    state.picks[today()] = { error: e.message, at: Date.now() }; save('agent', state);
  }).finally(() => { pickRun = null; });
  return pickRun;
}
/** Older cached picks (from before entry prices existed) get their insider entry filled in once. */
export async function backfillEntry(pick) {
  if (!pick || pick.insider?.entry !== undefined) return pick;
  pick.insider.entry = await insiderEntry(pick.coin, pick.insider).catch(() => null);
  save('agent', state);
  return pick;
}
export const pickHistory = () => Object.values(state.picks).filter((p) => p.coin).sort((a, b) => b.at - a.at).slice(0, 14);
