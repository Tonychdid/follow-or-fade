// The alert scorecard: did the whale alerts work?
//
// The proof desk scores the table's odds. This scores the other thing people actually use, the
// alerts, and it is the cleanest evidence in the product: every alert was timestamped and sent
// BEFORE anyone knew how the trade would end, so nothing here can have been fitted to the outcome.
//
// Each alert is scored the way a follower would have lived it: in at the mark when the alert went
// out (not the whale's fill, which was already gone), out when the whale fully closed, 1x, no fees.
// Still-open alerts are marked to the current Hyperliquid price and kept out of the totals until
// the whale exits.
import { readJsonl } from './store.js';
import * as hl from './hyperliquid.js';
import * as nansen from './nansen.js';
import * as excluded from './excluded.js';
import { meanStats } from './proof.js';

export const HEADLINE_MIN = 20;       // below this many closed alerts, the page leads with counts, not a result
const OPEN_MAX_DAYS = 10;          // no exit row after this long: we lost track of it, not "still open"
const CACHE_MS = 60e3;
let cache = null, building = null;
let watchOf = () => null;          // wired from alerts.js, which owns the live watch list
export const setWatchLookup = (fn) => { watchOf = fn; };

const dirOf = (side) => (side === 'Short' ? -1 : 1);
const retFrom = (side, from, to) => (from > 0 && to > 0 ? dirOf(side) * (to - from) / from : null);

function summarise(rows) {
  const closed = rows.filter((r) => r.status === 'closed' && r.ret != null);
  const s = meanStats(closed.map((r) => r.ret), closed.map((r) => r.address));
  const wins = closed.filter((r) => r.ret > 0).length;
  const sorted = closed.map((r) => r.ret).sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  const whale = closed.filter((r) => r.whaleRet != null);
  return {
    alerts: rows.length, closed: closed.length, open: rows.filter((r) => r.status === 'open').length,
    untracked: rows.filter((r) => r.status === 'untracked').length,
    wins, winRate: closed.length ? wins / closed.length : null,
    avgRet: s.mean, se: s.se, lo: s.se != null ? s.mean - 1.96 * s.se : null, hi: s.se != null ? s.mean + 1.96 * s.se : null,
    medianRet: median, sumRet: closed.reduce((a, r) => a + r.ret, 0), wallets: s.clusters,
    whaleAvgRet: whale.length ? whale.reduce((a, r) => a + r.whaleRet, 0) / whale.length : null,
    // Still-open alerts marked to the current price: shown beside the closed result, never mixed into it.
    openMarked: (() => { const o = rows.filter((r) => r.status === 'open' && r.openRet != null);
      return { n: o.length, up: o.filter((r) => r.openRet > 0).length, avgRet: o.length ? o.reduce((a, r) => a + r.openRet, 0) / o.length : null }; })(),
    clustersEnough: (s.clusters || 0) >= 20,
  };
}

async function build() {
  const rows = readJsonl('alertjournal').filter((r) => !r.test);
  const exits = new Map();
  for (const r of rows) if (r.kind === 'exit' && r.parentId) exits.set(r.parentId, r);
  const opens = rows.filter((r) => (r.kind || 'open') === 'open' && r.id && !excluded.isExcluded(r.address));
  const out = [];
  const marks = new Map();
  for (const o of opens) {
    const ex = exits.get(o.id);
    const at = Date.parse(o.at);
    const from = o.priceAtAlert > 0 ? o.priceAtAlert : o.entryPrice;
    const row = {
      id: o.id, at: o.at, coin: o.coin, side: o.side, grade: o.grade, score: o.score, route: o.admittedVia || null,
      trader: nansen.whaleName(o.trader, o.address), address: o.address, valueUsd: o.valueUsd,
      whaleEntry: o.entryPrice, priceAtAlert: from, fromWhaleFill: !(o.priceAtAlert > 0),
      pFollow: o.pFollow ?? null,
    };
    if (ex) {
      Object.assign(row, { status: 'closed', exitPx: ex.exitPx ?? ex.markPx ?? null, exitExact: !!ex.exitExact, closedAt: ex.at,
        heldHours: ex.heldMs != null ? ex.heldMs / 3600e3 : null, whaleRet: ex.whaleRet ?? null });
      row.ret = retFrom(o.side, from, row.exitPx);
    } else {
      const w = watchOf(o.id);
      const tooOld = Date.now() - at > OPEN_MAX_DAYS * 86400e3;
      row.status = (w && !w.done && !tooOld) || (!w && !tooOld) ? 'open' : 'untracked';
      if (row.status === 'open') {
        if (!marks.has(o.coin)) marks.set(o.coin, await hl.mid(o.coin).catch(() => null));
        row.markPx = marks.get(o.coin);
        row.openRet = retFrom(o.side, from, row.markPx);
        row.heldHours = (Date.now() - Date.parse(o.openedAt || o.at)) / 3600e3;
      }
    }
    out.push(row);
  }
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const by = (key) => {
    const g = new Map();
    for (const r of out) { const k = r[key] ?? (key === 'route' ? 'earlier' : 'other'); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    return Object.fromEntries([...g].map(([k, v]) => [k, summarise(v)]));
  };
  return {
    generatedAt: new Date().toISOString(), headlineMin: HEADLINE_MIN,
    since: out.length ? out[out.length - 1].at : null,
    method: 'In at the Hyperliquid mark when the alert was sent, out at the whale\'s full exit, 1x, no fees or funding. Still-open alerts are marked to the current price and left out of the totals.',
    summary: summarise(out), byGrade: by('grade'), byRoute: by('route'), bySide: by('side'),
    alerts: out.slice(0, 400),
    all: out,
  };
}

/** The scorecard, rebuilt at most once a minute and never twice at the same time. */
export async function scorecard() {
  if (cache && Date.now() - cache.t < CACHE_MS) return cache.v;
  building ??= build().then((v) => { cache = { t: Date.now(), v }; return v; }).finally(() => { building = null; });
  return building;
}

/** Everything the scorecard knows about one wallet. */
export async function forWallet(address) {
  const a = String(address || '').toLowerCase();
  const sc = await scorecard();
  const rows = sc.all.filter((r) => String(r.address).toLowerCase() === a);
  return { summary: summarise(rows), alerts: rows };
}
