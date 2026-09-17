// The Research Desk: Nansen Agent on the stocks listed on Hyperliquid.
//  - companyIntel(coin): Fast mode brief (insiders, ownership, earnings, valuation) for a stock perp a whale is trading
//  - insiderPick(): one Expert mode screen per UTC day for the best insider-buying setup, played as a 24h table
// Answers are shared by every player and cached, so the credit cost does not grow with users.
import { load, save } from './store.js';
import * as nansen from './nansen.js';
import * as hl from './hyperliquid.js';

const BASE = 'https://api.nansen.ai/api/v1';
const COST = { fast: 200, expert: 750 };
const BUDGET = () => Number(process.env.AGENT_DAILY_CREDITS ?? 1600);
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
const spend = (c) => { if (state.day !== today()) { state.day = today(); state.credits = 0; } state.credits += c; save('agent', state); };

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
  try {
    const res = await fetch(`${BASE}/agent/${mode}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', apikey: process.env.NANSEN_API_KEY },
      body: JSON.stringify({ text }),
    });
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
function cleanInsider(x) {
  const sig = String(x?.signal || 'none').toLowerCase();
  return { signal: SIGNALS.includes(sig) ? sig : 'none', detail: clip(x?.detail, 220) };
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
    + 'recent insider transactions in plain words}, ownership (max 120 chars), earnings {next: string (date if known), last: max 120 chars}, '
    + 'valuation (max 120 chars), verdict (one sentence max 160 chars, no advice), asOf (date).');
  const j = parseJson(text);
  if (!j) throw new Error('Nansen Agent answer could not be read');
  return { ticker: t, company: clip(j.company, 80), insider: cleanInsider(j.insider), ownership: clip(j.ownership, 140),
    earnings: { next: clip(j.earnings?.next, 60), last: clip(j.earnings?.last, 140) }, valuation: clip(j.valuation, 140),
    verdict: clip(j.verdict, 200), asOf: clip(j.asOf, 20), tools, at: Date.now() };
}

/** Cached brief for a stock perp. start=false only reads the cache. */
export function companyIntel(coin, { start = true } = {}) {
  if (!isStock(coin)) return { status: 'unsupported' };
  const t = tickerOf(coin);
  const hit = state.intel[t];
  if (hit && Date.now() - hit.at < INTEL_TTL) return { status: 'ready', intel: hit };
  if (inflight.has('intel:' + t)) return { status: 'loading' };
  if (!start) return hit ? { status: 'ready', intel: hit, stale: true } : { status: 'none' };
  const reserve = state.picks[today()]?.coin ? 0 : COST.expert; // keep room for today's Insider Pick
  if (!nansen.isDemo() && !(BUDGET() > 0 && spentToday() + COST.fast + reserve <= BUDGET())) return hit ? { status: 'ready', intel: hit, stale: true } : { status: 'closed', message: "The Research Desk used today's Nansen Agent budget. It reopens at 00:00 UTC." };
  const p = fetchIntel(t)
    .then((intel) => { state.intel[t] = intel; save('agent', state); })
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
        + 'Reply ONLY with a JSON object, no prose, keys: ticker (one of the list), company, side ("long" or "short"), conviction (1-5), '
        + 'insider {signal: "buying"|"selling"|"mixed"|"none", detail: max 200 chars}, thesis (max 240 chars), earnings (max 120 chars), valuation (max 120 chars), '
        + 'risks (max 160 chars), runnersUp (array of up to 2 {ticker, why max 100 chars}), asOf (date).');
      const j = parseJson(text);
      const t = tickerOf(j?.ticker);
      if (!j || !listed.has(t)) throw new Error('Nansen Agent pick could not be matched to a Hyperliquid stock');
      pick = { ticker: t, coin: listed.get(t), company: clip(j.company, 80), side: String(j.side).toLowerCase() === 'short' ? 'Short' : 'Long',
        conviction: Math.max(1, Math.min(5, Math.round(Number(j.conviction) || 3))), insider: cleanInsider(j.insider), thesis: clip(j.thesis, 260),
        earnings: clip(j.earnings, 140), valuation: clip(j.valuation, 140), risks: clip(j.risks, 180),
        runnersUp: (Array.isArray(j.runnersUp) ? j.runnersUp : []).slice(0, 2).map((r) => ({ ticker: tickerOf(r.ticker), why: clip(r.why, 120) })),
        asOf: clip(j.asOf, 20), tools, screened: tickers.length };
    }
    const price = await hl.mid(pick.coin).catch(() => null);
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
export const pickHistory = () => Object.values(state.picks).filter((p) => p.coin).sort((a, b) => b.at - a.at).slice(0, 14);
