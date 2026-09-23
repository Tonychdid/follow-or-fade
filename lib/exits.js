// A whale's exits: the take-profit, stop-loss and scale-in orders they have resting on Hyperliquid.
//
// Hyperliquid shows every wallet's open orders publicly (frontendOpenOrders), including trigger
// orders. So for a whale we alert on we can say where they plan to take profit, where their stop is,
// and where they would add, and tell followers when any of that moves. Measured on the 22 whales in
// the alert feed on Sep 23: 8 had orders resting on the alerted coin, 2 of them real TP triggers on
// the whole position, and none had a stop loss. "No stop set" is information too, so it is shown.
//
// Brackets. A whale can rest a buy limit well below the price with its own TP and SL attached
// ("buy 191 ETH at 2,324, then take profit at 2,666"). Hyperliquid lists those attached orders
// next to everything else, but they are asleep: they only exist once the parent limit fills, and
// they belong to that future fill, not to the position open now. Reading them as the position's
// exits produced a "take profit" below the whale's own entry on Sep 23. So an order that is the
// child of a resting parent is never an exit of the open position; it is shown with its parent as
// the plan for that add. A trigger whose condition is already true at the current price cannot be
// live either (it would have fired), so it is set aside the same way.
//
// Pure functions here; the network read is hyperliquid.openOrders().

const sig4 = (x) => +(+x).toPrecision(4);

/**
 * Sort a whale's resting orders on one coin into take profits, stop losses and adds.
 * @param orders  rows from hyperliquid.openOrders() for this coin
 * @param side    'Long' | 'Short' (the whale's position)
 * @param posSz   the whale's position size, absolute, in coin units
 * @param mark    current price
 */
export function classify(orders, side, posSz, mark) {
  const d = side === 'Short' ? -1 : 1;
  const exitSide = d > 0 ? 'A' : 'B';            // a long exits by selling ('A'sk), a short by buying
  const out = { v: 3, tp: [], sl: [], adds: [], posSz: posSz || null, mark: mark || null, at: Date.now() };
  if (!Array.isArray(orders) || !(mark > 0)) return out;
  const asleep = new Set();                        // children of a parent order that has not filled
  for (const o of orders) for (const c of o.children || []) if (c?.oid != null) asleep.add(c.oid);
  for (const o of orders) {
    if (o.oid != null && asleep.has(o.oid)) continue;
    if (o.isTrigger && alreadyMet(o, mark)) continue;
    const sz = +o.sz || 0;
    const full = !!o.isPositionTpsl && sz === 0;   // a position TP/SL covers whatever is open at the time
    const share = full ? 1 : posSz > 0 ? sz / posSz : null;
    if (o.isTrigger) {
      const px = +o.triggerPx;
      if (!(px > 0)) continue;
      const row = { px, dist: (px - mark) / mark, share: share == null ? null : Math.min(1, share), full, sz: full ? null : sz, kind: 'trigger', type: o.orderType || null };
      if (o.side === exitSide) {
        if (/take profit/i.test(o.orderType || '')) out.tp.push(row);
        else if (/stop/i.test(o.orderType || '')) out.sl.push(row);
        else (d * (px - mark) > 0 ? out.tp : out.sl).push(row);
      } else out.adds.push({ ...row, share, kind: 'stop entry' });   // a trigger that adds on a breakout
      continue;
    }
    const px = +o.limitPx;
    if (!(px > 0) || !(sz > 0)) continue;
    const row = { px, dist: (px - mark) / mark, share, full: false, sz, kind: 'limit', type: 'Limit' };
    if (o.side === exitSide) { if (d * (px - mark) > 0) out.tp.push({ ...row, share: share == null ? null : Math.min(1, share) }); }
    else if (d * (px - mark) < 0) {
      const kids = (o.children || []).filter((c) => c?.isTrigger && +c.triggerPx > 0);
      const tp = kids.find((c) => /take profit/i.test(c.orderType || '')), sl = kids.find((c) => /stop/i.test(c.orderType || ''));
      out.adds.push(tp || sl ? { ...row, thenTp: tp ? +tp.triggerPx : null, thenSl: sl ? +sl.triggerPx : null } : row);
    }
  }
  const near = (a, b) => Math.abs(a.dist) - Math.abs(b.dist);
  out.tp.sort(near); out.sl.sort(near); out.adds.sort(near);
  return out;
}

/** "Price above 2666" while the price is 2667: a live trigger would have fired already. */
function alreadyMet(o, mark) {
  const m = /price\s+(above|below)\s+([\d.]+)/i.exec(o.triggerCondition || '');
  if (!m) return false;
  const px = +m[2];
  return m[1].toLowerCase() === 'above' ? mark > px : mark < px;
}

/** A compact fingerprint of the exits (TP and SL only), for "did anything change". */
export function signature(ex) {
  if (!ex) return null;
  // Sized by the order itself, not by its share of the position: a whale trimming or adding changes
  // the share of an order nobody touched, and that is not an exit change.
  const size = (r) => (r.full ? 'all' : r.sz != null ? sig4(r.sz) : r.share == null ? '?' : Math.round(r.share * 20) / 20);
  const k = (rows) => rows.map((r) => `${sig4(r.px)}@${size(r)}`).sort().join(',');
  return `tp:${k(ex.tp)}|sl:${k(ex.sl)}`;
}

/** What changed between two readings, in plain words (TP and SL only; adds never notify). */
export function changes(prev, cur, fmt = (x) => String(sig4(x))) {
  const out = [];
  for (const [key, name] of [['tp', 'Take profit'], ['sl', 'Stop loss']]) {
    const a = (prev?.[key] || []).map((r) => sig4(r.px)), b = (cur?.[key] || []).map((r) => sig4(r.px));
    const gone = a.filter((p) => !b.includes(p)), added = b.filter((p) => !a.includes(p));
    if (gone.length === 1 && added.length === 1) out.push(`${name} moved from ${fmt(gone[0])} to ${fmt(added[0])}`);
    else {
      for (const p of added) out.push(`${name} added at ${fmt(p)}`);
      for (const p of gone) out.push(`${name} removed (was ${fmt(p)})`);
    }
    if (!gone.length && !added.length) {
      const size = (r) => (r.full ? 'all' : r.sz != null ? sig4(r.sz) : r.share == null ? null : Math.round(r.share * 20));
      if (JSON.stringify((prev?.[key] || []).map(size)) !== JSON.stringify((cur?.[key] || []).map(size))) out.push(`${name} size changed`);
    }
  }
  return out;
}
