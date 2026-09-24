/**
 * Account health: is the WALLET behind an alert in good shape right now, not just its closed trades?
 *
 * The trust grade reads realized, closed trades from Nansen. A wallet can win every close and still
 * be sitting on a huge open loss: the Sep 24 panel found an A+ wallet with a 100% win rate and a
 * single open short worth -45% of its account, and another at -110% at 12x. Their grade vs their
 * real account month return had a rank correlation of about zero. So before an alert goes out, the
 * account itself is read from Hyperliquid (free, no Nansen credits):
 *
 *   clearinghouseState   account value, total notional, every open position and its unrealized PnL
 *   portfolio            the 'month' and 'week' account value and PnL history (PnL is net of deposits)
 *
 * The gate (all routes, no exemptions) rejects a wallet when any of these is true:
 *   open unrealized PnL < -15% of account value
 *   account 30D return < 0
 *   account 7D return < -10%
 *   total notional > 10x account value
 *
 * A read that fails does not reject: the public alert fails OPEN and the verdict is 'unknown', which
 * the bot-eligibility flag treats as "not ok". Results are cached per address for a few minutes.
 */
import * as hl from './hyperliquid.js';
import { load, save } from './store.js';

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
export const HEALTH_MAX_UPNL_LOSS = () => num('HEALTH_MAX_UPNL_LOSS', 0.15);   // uPnL below -15% of AV rejects
export const HEALTH_MIN_RET30     = () => num('HEALTH_MIN_RET30', 0);          // 30D account return must be >= 0
export const HEALTH_MIN_RET7      = () => num('HEALTH_MIN_RET7', -0.10);       // 7D account return must be >= -10%
export const HEALTH_MAX_NOTIONAL_X = () => num('HEALTH_MAX_NOTIONAL_X', 10);   // total notional / AV
const CACHE_MS = () => Math.max(30, num('HEALTH_CACHE_SEC', 180)) * 1000;
const ERR_CACHE_MS = 30e3;   // a failed read is retried sooner than a good one is refreshed
// Builder dexes whose margin is separate from the main account. xyz carries the stock perps.
const DEXES = () => String(process.env.HEALTH_DEXES ?? ',xyz').split(',').map((s) => s.trim());

const DAY = 864e5;
const f = (x) => { const n = +x; return Number.isFinite(n) ? n : null; };
const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

/**
 * One portfolio window, summarised. `ret` = change in PnL over the window / median account value
 * (G2 chair: "perpMonth dPnL / median AV"; we read the all-product 'month' and 'week' windows as the
 * brief asks). `mdd` = peak-to-trough of cumulative PnL / median AV. `days` = UTC days on which the
 * PnL moved, `dailyPnl` = PnL change per UTC day, which grade v2 uses for its daily profit factor and
 * volatility.
 */
export function windowStats(w) {
  const pnl = (w?.pnlHistory || []).map(([t, v]) => [+t, f(v)]).filter(([t, v]) => Number.isFinite(t) && v != null).sort((a, b) => a[0] - b[0]);
  const av = (w?.accountValueHistory || []).map(([t, v]) => [+t, f(v)]).filter(([t, v]) => Number.isFinite(t) && v != null);
  if (pnl.length < 2) return null;
  const medAv = median(av.map(([, v]) => v).filter((v) => v > 0));
  if (!(medAv > 0)) return null;
  const dPnl = pnl[pnl.length - 1][1] - pnl[0][1];
  let peak = -Infinity, mdd = 0;
  for (const [, v] of pnl) { peak = Math.max(peak, v); mdd = Math.max(mdd, peak - v); }
  // PnL at the end of each UTC day; the change between consecutive days is that day's PnL.
  const byDay = new Map();
  for (const [t, v] of pnl) byDay.set(Math.floor(t / DAY), v);
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  const dailyPnl = [];
  for (let i = 1; i < days.length; i++) dailyPnl.push(days[i][1] - days[i - 1][1]);
  return { ret: dPnl / medAv, mdd: mdd / medAv, medAv, pnl: dPnl, dailyPnl, activeDays: dailyPnl.filter((x) => Math.abs(x) > 1e-9).length,
    first: pnl[0][0], last: pnl[pnl.length - 1][0] };
}

/**
 * Pure: the health reading from raw Hyperliquid answers. `states` is one clearinghouseState per dex
 * that answered (the main one first), `port` the portfolio map or null. Exported for the tests.
 */
export function evaluate(states, port, { now = Date.now() } = {}) {
  const ok = (states || []).filter(Boolean);
  const h = { at: now, status: 'unknown', ok: null, failedGate: null, reason: null,
    accountValue: null, notional: null, upnl: null, upnlPct: null, notionalX: null,
    ret30: null, ret7: null, mdd30: null, activeDays30: null, dailyPnl30: null, medAv30: null, ageDays: null, positions: [] };
  if (ok.length) {
    let av = 0, ntl = 0, upnl = 0;
    for (const st of ok) {
      av += f(st.marginSummary?.accountValue) || 0;
      ntl += f(st.marginSummary?.totalNtlPos) || 0;
      for (const ap of st.assetPositions || []) {
        const p = ap.position || {};
        const szi = f(p.szi), entry = f(p.entryPx), val = f(p.positionValue), u = f(p.unrealizedPnl);
        if (!szi) continue;
        upnl += u || 0;
        const mark = val && szi ? val / Math.abs(szi) : null;
        const liq = f(p.liquidationPx);
        h.positions.push({ coin: p.coin, side: szi > 0 ? 'Long' : 'Short', szi, entryPx: entry, valueUsd: val, upnl: u,
          // Loss on the position itself: unrealized PnL over what it cost to open.
          retOnNotional: entry && szi ? round((u || 0) / (Math.abs(szi) * entry)) : null,
          liqPx: liq, liqDist: liq && mark ? round(Math.abs(mark - liq) / mark) : null });
      }
    }
    h.accountValue = round(av, 2); h.notional = round(ntl, 2); h.upnl = round(upnl, 2);
    h.upnlPct = av > 0 ? round(upnl / av) : null;
    h.notionalX = av > 0 ? round(ntl / av, 3) : null;
  }
  const m = port ? windowStats(port.month) : null;
  const w = port ? windowStats(port.week) : null;
  if (m) { h.ret30 = round(m.ret); h.mdd30 = round(m.mdd); h.activeDays30 = m.activeDays; h.dailyPnl30 = m.dailyPnl.map((x) => round(x, 2)); h.medAv30 = round(m.medAv, 2); }
  if (w) h.ret7 = round(w.ret);
  const all = port?.allTime?.accountValueHistory;
  if (Array.isArray(all) && all.length) h.ageDays = round((now - Math.min(...all.map(([t]) => +t).filter(Number.isFinite))) / DAY, 1);
  return verdict(h);
}

/** The gate. Any rule broken = 'fail'; nothing broken but something unread = 'unknown'; else 'ok'. */
export function verdict(h) {
  const fails = [];
  if (h.upnlPct != null && h.upnlPct < -HEALTH_MAX_UPNL_LOSS()) fails.push(['HEALTH_UPNL', `open loss is ${(h.upnlPct * 100).toFixed(1)}% of the account (limit -${Math.round(HEALTH_MAX_UPNL_LOSS() * 100)}%)`]);
  if (h.ret30 != null && h.ret30 < HEALTH_MIN_RET30()) fails.push(['HEALTH_30D', `account is down ${(h.ret30 * 100).toFixed(1)}% over 30 days`]);
  if (h.ret7 != null && h.ret7 < HEALTH_MIN_RET7()) fails.push(['HEALTH_7D', `account is down ${(h.ret7 * 100).toFixed(1)}% over 7 days (limit ${Math.round(HEALTH_MIN_RET7() * 100)}%)`]);
  if (h.notionalX != null && h.notionalX > HEALTH_MAX_NOTIONAL_X()) fails.push(['HEALTH_LEV', `open positions are ${h.notionalX.toFixed(1)}x the account (limit ${HEALTH_MAX_NOTIONAL_X()}x)`]);
  const known = h.upnlPct != null && h.ret30 != null && h.ret7 != null && h.notionalX != null;
  if (fails.length) Object.assign(h, { status: 'fail', ok: false, failedGate: fails[0][0], reason: fails[0][1] });
  else if (known) Object.assign(h, { status: 'ok', ok: true, failedGate: null, reason: null });
  else Object.assign(h, { status: 'unknown', ok: null, failedGate: null, reason: 'account could not be read in full' });
  return h;
}

/** A health reading that could not be taken at all. */
export const unknown = (why = 'account could not be read') => ({ at: Date.now(), status: 'unknown', ok: null, failedGate: null, reason: why,
  accountValue: null, notional: null, upnl: null, upnlPct: null, notionalX: null, ret30: null, ret7: null, mdd30: null, positions: [] });

const cache = new Map();   // address -> { t, h }
/** The last reading for an address if it is still fresh, without a call. */
export function peek(address) {
  const c = cache.get(String(address || '').toLowerCase());
  return c && Date.now() - c.t < CACHE_MS() && c.h.status !== 'unknown' ? c.h : null;
}

/** Read and judge one wallet. Never throws: a failed read comes back as status 'unknown'. */
export async function read(address) {
  const k = String(address || '').toLowerCase();
  if (!k) return unknown('no address');
  const c = cache.get(k);
  if (c && Date.now() - c.t < (c.h.status === 'unknown' ? ERR_CACHE_MS : CACHE_MS())) return c.h;
  const dexes = DEXES();
  const [states, port] = await Promise.all([
    Promise.all(dexes.map((d) => hl.clearinghouse(address, d).catch(() => (d === '' ? undefined : null)))),
    hl.portfolio(address).catch(() => null),
  ]);
  // The main account is the one that matters; without it the reading is unknown, not "healthy".
  const h = states[0] === undefined ? unknown('main account could not be read') : evaluate(states.filter(Boolean), port);
  cache.set(k, { t: Date.now(), h });
  if (h.status !== 'unknown') remember(k, { t: Date.now(), h: slim(h) });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return h;
}

// ---------------------------------------------------------------- the last known reading, kept
// The live cache lasts 3 minutes, so a whale card dealt later used to lose the open-loss caps and the
// HOLDS LOSERS tag. Every good reading (and every holds-losers verdict) is also kept here, on disk, for
// HEALTH_MEMO_HOURS (26 h: the daily roster refreshes it), so every card grades with the same rules.
const MEMO_KEY = 'healthmemo';
const MEMO_MS = () => Math.max(1, num('HEALTH_MEMO_HOURS', 26)) * 3600e3;
let memo = null;
const M = () => (memo ??= load(MEMO_KEY, {}));
let saveTimer = null;
const persistSoon = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; save(MEMO_KEY, M()); }, 2000); saveTimer.unref?.(); };
const slim = (h) => ({ at: h.at ?? Date.now(), status: h.status, ok: h.ok, failedGate: h.failedGate ?? null, reason: h.reason ?? null, upnlPct: h.upnlPct ?? null,
  ret30: h.ret30 ?? null, ret7: h.ret7 ?? null, notionalX: h.notionalX ?? null, accountValue: h.accountValue ?? null,
  positions: (h.positions || []).map((p) => ({ coin: p.coin, side: p.side, retOnNotional: p.retOnNotional ?? null })) });
function remember(k, patch) {
  const m = M();
  m[k] = { ...(m[k] || {}), ...patch };
  const keys = Object.keys(m);
  if (keys.length > 5000) for (const x of keys.sort((a, b) => (m[a].t || 0) - (m[b].t || 0)).slice(0, keys.length - 5000)) delete m[x];
  persistSoon();
}
/** Keep a holds-losers verdict (it needs holding times only the roster and the alert path read). */
export function rememberHolds(address, holds) {
  const k = String(address || '').toLowerCase();
  if (k && holds) remember(k, { holds: { holdsLosers: !!holds.holdsLosers, why: holds.why || null, t: Date.now() } });
}
/** The freshest reading for an address: live if read in the last minutes, else the kept one (under 26 h). */
export function latest(address) {
  const k = String(address || '').toLowerCase();
  const m = M()[k], now = Date.now();
  const live = peek(k);
  const kept = m?.h && now - (m.t || 0) < MEMO_MS() ? m.h : null;
  const holds = m?.holds && now - (m.holds.t || 0) < MEMO_MS() ? m.holds : null;
  return { health: live || kept, holds, kept: !live && !!kept };
}
export const _resetMemo = () => { memo = {}; };           // tests

/** For tests: put a reading in the cache. */
export const _prime = (address, h) => cache.set(String(address).toLowerCase(), { t: Date.now(), h });

/**
 * The fields the journal and the reject log carry, for one alerted coin and side. Position leverage
 * is the alerted position's value over the whole account; liqDist is how far the mark is from that
 * position's liquidation price, as a fraction of the mark.
 */
export function journalFields(h, coin, side) {
  h = h || { status: null, positions: [] };   // no reading: every key present, every value null
  const want = String(coin || '').toUpperCase();
  const p = (h.positions || []).find((x) => String(x.coin || '').split(':').pop().toUpperCase() === want.split(':').pop()
    && (!side || x.side === side)) || null;
  return {
    health: h.status ?? null, healthGate: h.failedGate || null, healthReason: h.reason || null,
    whaleAccountValue: h.accountValue ?? null, whaleUpnl: h.upnl ?? null, whaleUpnlPct: h.upnlPct ?? null,
    whaleNotionalX: h.notionalX ?? null, whaleRet30: h.ret30 ?? null, whaleRet7: h.ret7 ?? null,
    positionLeverage: p && h.accountValue > 0 && p.valueUsd != null ? round(p.valueUsd / h.accountValue, 3) : null,
    liqDist: p?.liqDist ?? null,
  };
}
