import crypto from 'node:crypto';
import * as nansen from './nansen.js';
import * as hl from './hyperliquid.js';
import * as oddsEngine from './odds.js';
import { load, save } from './store.js';
import * as coach from './coach.js';
import * as agent from './agent.js';

const MAX_HOLD = () => Number(process.env.MAX_HOLD_HOURS || 48) * 3600e3;          // training hands (replays)
// Training hands must be real positions, not scalps: whales who closed faster than this are left out of the deck and the odds.
const MIN_HOLD = () => Number(process.env.MIN_HOLD_MINUTES ?? 60) * 60e3;
// Whale results inside this band are too small to call: training hands, Ride the Whale and Insider Pick bets push (stake back).
export const PUSH_BAND = () => Number(process.env.PUSH_BAND_PCT ?? 0.2) / 100;
const bandFor = (b) => (b.ride || b.pick ? PUSH_BAND() : 0.0001); // 15-min and 4h tables keep a tiny band
const tooQuick = (out) => out && out.closed && out.heldMs < MIN_HOLD();
const RIDE_MAX = () => Number(process.env.RIDE_MAX_HOURS || 48) * 3600e3;          // Ride the Whale live bets
const START_BANKROLL = 10_000;
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
const tradeKey = (t) => (t.transaction_hash || '') + ':' + t.trader_address + ':' + t.token_symbol + ':' + t.block_timestamp;

const players = load('players', {});
const liveBets = load('livebets', []);
for (const b of liveBets) if (b.status === 'cashing') b.status = 'open'; // a cash-out interrupted by a restart never completed
const samples = load('samples', {}); // tradeKey -> { f, win, ret, heldMs } resolved trades used for calibration
const CAP_H = () => MAX_HOLD() / 3600e3;
// keep only samples judged the same way as today's hands (whale's exit, same hold cap); older ones are re-resolved
for (const [k, v] of Object.entries(samples)) if (v.target !== 'exit' || (v.capH || 24) !== CAP_H()) delete samples[k];
for (const v of Object.values(samples)) if (!v.skip && v.heldMs != null && v.heldMs < MIN_HOLD() && v.heldMs < CAP_H() * 3600e3) v.skip = 'scalp'; // kept as a marker so it isn't re-resolved
for (const v of Object.values(samples)) if (!v.skip && v.ret != null && Math.abs(v.ret) < PUSH_BAND()) v.skip = 'tiny';
const realSamples = () => Object.values(samples).filter((x) => !x.skip);
oddsEngine.calibrate(realSamples()); // start with the odds learned on the last run
// Hands this player has been dealt, kept for a week (the pool's own lifetime) rather than
// trimmed by count, so an active player can't cycle a hand back into their own deck.
const HAND_MEMORY = 7 * 864e5;
function handMap(p) {
  if (Array.isArray(p.played)) { const at = Date.now(); p.played = Object.fromEntries(p.played.map((k) => [k, at])); }
  return (p.played ??= {});
}
const seenHand = (p, key) => Object.hasOwn(handMap(p), key);
function markHand(p, key) {
  const m = handMap(p);
  m[key] = Date.now();
  const cutoff = Date.now() - HAND_MEMORY;
  for (const [k, at] of Object.entries(m)) if (at < cutoff) delete m[k];
}
for (const pl of Object.values(players)) pl.inflight = 0; // reservations never survive a restart
const rounds = new Map();
const pendingRound = new Map(); // playerId -> roundId of the hand currently on the table            // roundId -> private round (outcome never leaves the server before a bet)

// ------------------------------------------------------------------ players
// Only real UUID keys count as players (ids like "__proto__" must never resolve to Object.prototype).
const P = (id) => (typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) && Object.hasOwn(players, id) ? players[id] : null);
const openBetsOf = (id) => liveBets.filter((b) => b.playerId === id && (b.status === 'open' || b.status === 'cashing')).length;
/** Broke with nothing on the table: the house reloads you (same rule as the Training Table). */
function maybeBust(p) {
  if (!p || p.bankroll >= 10 || openBetsOf(p.id) || p.inflight) return false;
  p.busts = (p.busts || 0) + 1; p.bankroll = START_BANKROLL; p.streak = 0;
  return true;
}
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 100_000);
export function createPlayer(name) {
  // Every player is a row in a file that gets rewritten on each save, so the table has a size.
  if (Object.keys(players).length >= MAX_PLAYERS) {
    prune({ hard: true });
    if (Object.keys(players).length >= MAX_PLAYERS) throw Object.assign(new Error('The casino is full right now, try again in a few minutes.'), { status: 503 });
  }
  const id = crypto.randomUUID();
  const clean = String(name || '').replace(/[^\w .\-]/g, '').trim().slice(0, 18) || `anon-${id.slice(0, 4)}`;
  players[id] = { id, name: clean, bankroll: START_BANKROLL, peak: START_BANKROLL, bets: 0, wins: 0,
    streak: 0, bestStreak: 0, busts: 0, whalesSlain: 0, played: {}, history: [], createdAt: Date.now() };
  save('players', players);
  return publicPlayer(players[id]);
}
export function getPlayer(id) { const p = P(id); if (maybeBust(p)) save('players', players); return p ? publicPlayer(p) : null; }
function publicPlayer(p) {
  const { played, inflight, ...rest } = p;
  return { ...rest, net: Math.round(netProfit(p)), history: p.history.slice(-30) };
}
export function skillReport(id) {
  const p = P(id);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  return coach.report(p);
}

// Every reload is 10,000 the house handed you, so the board ranks on what you actually made:
// bankroll minus every stake the house ever staked you. Otherwise going all-in forever wins.
const netProfit = (p) => p.bankroll - START_BANKROLL * (1 + (p.busts || 0));
export function leaderboard() {
  return Object.values(players).filter((p) => p.bets > 0)
    .sort((a, b) => netProfit(b) - netProfit(a)).slice(0, 25)
    .map((p) => ({ name: p.name, bankroll: Math.round(p.bankroll), net: Math.round(netProfit(p)), bets: p.bets,
      winRate: p.bets - (p.pushes || 0) ? p.wins / (p.bets - (p.pushes || 0)) : 0, bestStreak: p.bestStreak, whalesSlain: p.whalesSlain, busts: p.busts }));
}

// ------------------------------------------------------------------ enrichment (point-in-time: no look-ahead)
async function enrich(t) {
  const ts = Date.parse(t.block_timestamp);
  const [wallet, sm, crowd] = await Promise.all([
    nansen.walletSummary(t.trader_address, iso(ts - 30 * DAY), iso(ts)).catch(() => null),
    nansen.coinContext(t.token_symbol, iso(ts - DAY), iso(ts), 'sm').catch(() => null),
    nansen.coinContext(t.token_symbol, iso(ts - DAY), iso(ts), 'all').catch(() => null),
  ]);
  const ctx = { coin: t.token_symbol, wallet, sm, crowd };
  const f = oddsEngine.features({ side: t.side, valueUsd: t.value_usd, ...ctx });
  return { ctx, f };
}

// ------------------------------------------------------------------ outcomes: judged on the whale's real exit
/**
 * How did this trade end? We follow the whale's own position on Hyperliquid from the opening fill until it is
 * fully closed (size-weighted exit price of every reduction), capped at MAX_HOLD, where any remainder is marked to market.
 */
const outcomeCache = new Map(); // tradeKey -> resolved outcome (history never changes once the trade is 24h old)
async function resolveOutcome(t) {
  const ck = tradeKey(t);
  if (outcomeCache.has(ck)) return outcomeCache.get(ck);
  const out = await resolveOutcomeRaw(t);
  if (out) { outcomeCache.set(ck, out); if (outcomeCache.size > 2000) outcomeCache.delete(outcomeCache.keys().next().value); }
  return out;
}
async function resolveOutcomeRaw(t) {
  const ts = Date.parse(t.block_timestamp);
  if (nansen.isDemo() || t._demo) {
    // Demo wallets have no real fills: simulate a hold of 1–24h (stable per trade) on real Hyperliquid prices
    const seed = [...tradeKey(t)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const hold = (1 + (seed % 23)) * 3600e3;
    const out = await hl.outcome(t.token_symbol, t.side, t.price_usd, ts, hold).catch(() => null);
    return out ? { ...out, heldMs: hold, closed: hold < MAX_HOLD(), capped: false, trims: 1 } : null;
  }
  const e = await hl.whaleExit(t.trader_address, t.token_symbol, ts, MAX_HOLD(), null, true).catch(() => null);
  if (!e || !e.exitPx) return null;
  const dir = t.side === 'Long' ? 1 : -1;
  const ret = dir * (e.exitPx - t.price_usd) / t.price_usd;
  const pth = await hl.pathBetween(t.token_symbol, t.side, t.price_usd, e.fromMs, e.exitAt).catch(() => null);
  return { ret, exit: e.exitPx, heldMs: e.heldMs, closed: e.closed, capped: !!e.capped, trims: e.exits.length,
    path: pth?.path?.length > 1 ? pth.path : [[e.fromMs, t.price_usd], [e.exitAt, e.exitPx]], mfe: pth?.mfe ?? Math.max(0, ret), mae: pth?.mae ?? Math.min(0, ret) };
}

// ------------------------------------------------------------------ replay pool
async function pool() {
  const trades = await nansen.smartMoneyOpens({ lookbackHours: 168 });
  const cutoff = Date.now() - MAX_HOLD() - 5 * 60e3; // only trades old enough to know how the whale exited
  const seen = new Set();
  return trades.filter((t) => {
    const ts = Date.parse(t.block_timestamp);
    if (!(ts < cutoff) || !t.price_usd) return false;
    const k = `${t.trader_address}|${t.token_symbol}|${Math.floor(ts / 3600e3)}`; // one per wallet/coin/hour
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ------------------------------------------------------------------ pre-built deck (instant training hands)
// Resolving a hand means reading the whale's fills on Hyperliquid and three Nansen lookups, which takes seconds.
// A small shared deck of ready hands is kept warm in the background so a new visitor is dealt instantly.
const DECK_SIZE = Number(process.env.DECK_SIZE || 16);
let deck = [];            // { t, out, ctx, f, at }
let refilling = null;
export function refillDeck() {
  if (refilling) return refilling;
  refilling = (async () => {
    const list = await pool();
    deck = deck.filter((h) => Date.now() - h.at < 6 * 3600e3 && list.some((t) => tradeKey(t) === tradeKey(h.t)));
    const inDeck = new Set(deck.map((h) => tradeKey(h.t)));
    const shuffled = list.filter((t) => !inDeck.has(tradeKey(t))).sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffled.length && deck.length < DECK_SIZE && i < DECK_SIZE * 3; i++) {
      const t = shuffled[i];
      const out = await resolveOutcome(t).catch(() => null);
      if (!out || tooQuick(out)) continue;
      const { ctx, f } = await enrich(t);
      deck.push({ t, out, ctx, f, at: Date.now() });
    }
  })().finally(() => { refilling = null; });
  return refilling;
}

export async function newRound(playerId) {
  const p = P(playerId);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  // Refreshing the page gives back the same unplayed hand instead of dealing (and paying for) a new one
  const pendingId = pendingRound.get(playerId);
  const pending = pendingId && rounds.get(pendingId);
  if (pending && pending.pub && Date.now() - pending.createdAt < 25 * 60e3) return pending.pub;
  // Instant deal from the pre-built deck when possible; otherwise build a hand on the spot.
  const ready = deck.filter((h) => !seenHand(p, tradeKey(h.t)));
  const quick = ready.length ? ready[Math.floor(Math.random() * ready.length)] : null;
  if (deck.length < DECK_SIZE / 2) refillDeck().catch(() => {});
  const list = quick ? [quick.t] : await pool();
  if (!list.length) throw new Error('No Smart Money trades available right now');
  const candidates = list.filter((t) => !seenHand(p, tradeKey(t)));
  if (!candidates.length) throw new Error('You have played every hand in this week\u2019s deck. New Smart Money trades arrive every few minutes.');
  // Try a few random trades until one has a resolvable outcome.
  for (let i = 0; i < 10; i++) {
    const t = quick && i === 0 ? quick.t : candidates[Math.floor(Math.random() * candidates.length)];
    const out = quick && i === 0 ? quick.out : await resolveOutcome(t);
    if (!out || tooQuick(out)) continue;
    const { ctx, f } = quick && i === 0 ? quick : await enrich(t);
    const pFollow = oddsEngine.probability(f);
    if (!nansen.isCapped() && !t._demo) recordSample(tradeKey(t), f, out.ret, out.heldMs);
    if (!(quick && i === 0) && deck.length < DECK_SIZE * 2 && !deck.some((h) => tradeKey(h.t) === tradeKey(t))) deck.push({ t, out, ctx, f, at: Date.now() });
    const id = crypto.randomUUID();
    const round = { id, playerId, trade: t, ctx, f, pFollow, out, createdAt: Date.now() };
    rounds.set(id, round);
    const prev = pendingRound.get(playerId);
    if (prev && prev !== id) rounds.delete(prev);
    pendingRound.set(playerId, id);
    markHand(p, tradeKey(t)); // as soon as it is dealt: the reveal is one click away, so it must never come back
    round.timer = setTimeout(() => { rounds.delete(id); if (pendingRound.get(playerId) === id) pendingRound.delete(playerId); }, 30 * 60e3);
    return round.pub = {
      roundId: id, coin: t.token_symbol, side: t.side, valueUsd: t.value_usd, orderType: t.type,
      entryPrice: t.price_usd, openedDay: String(t.block_timestamp).slice(0, 10), maxHoldHours: MAX_HOLD() / 3600e3, minHoldMinutes: MIN_HOLD() / 60e3,
      pFollow, odds: oddsEngine.odds(pFollow), reasons: oddsEngine.reasons(f, ctx),
      grade: trustGrade(recordOf(ctx.wallet), null, t.token_symbol),
      intel: {
        walletWinRate: ctx.wallet?.win_rate ?? null, walletClosedTrades: ctx.wallet?.closed_trade_count ?? null,
        walletPnl30d: ctx.wallet?.realized_pnl_usd ?? null,
        smFlow24h: ctx.sm ? (ctx.sm.smart_money_buy_volume != null ? ctx.sm.smart_money_buy_volume - ctx.sm.smart_money_sell_volume : ctx.sm.buy_sell_pressure ?? null) : null, crowdFlow24h: ctx.crowd?.buy_sell_pressure ?? null,
        funding: ctx.crowd?.funding ?? null, openInterest: ctx.crowd?.open_interest ?? null,
      },
    };
  }
  throw new Error('Could not resolve a round, try again');
}

export function placeBet(playerId, roundId, choice, stake) {
  const p = P(playerId);
  const r = rounds.get(roundId);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  if (!r || r.playerId !== playerId) throw Object.assign(new Error('Round expired, deal a new one'), { status: 410 });
  if (!['follow', 'fade'].includes(choice)) throw Object.assign(new Error('Choice must be follow or fade'), { status: 400 });
  stake = Math.floor(Number(stake));
  if (!(stake >= 1) || stake > p.bankroll) throw Object.assign(new Error('Invalid stake'), { status: 400 });
  rounds.delete(roundId); clearTimeout(r.timer); if (pendingRound.get(playerId) === roundId) pendingRound.delete(playerId);

  const o = oddsEngine.odds(r.pFollow);
  const push = Math.abs(r.out.ret) < PUSH_BAND();
  const followWon = r.out.ret > 0;
  const won = !push && (choice === 'follow' ? followWon : !followWon);
  const price = choice === 'follow' ? o.follow : o.fade;
  const delta = push ? 0 : won ? Math.round(stake * (price - 1)) : -stake;
  const underdog = (choice === 'follow' ? r.pFollow : 1 - r.pFollow) < 0.42;
  const slain = won && choice === 'fade' && r.pFollow >= 0.55;

  p.bankroll += delta; p.bets++; if (push) p.pushes = (p.pushes || 0) + 1;
  if (won) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else if (!push) p.streak = 0;
  if (slain) p.whalesSlain++;
  p.peak = Math.max(p.peak, p.bankroll);
  // One reload rule for the whole game: never while live chips are still on the table,
  // or a player could bet the bankroll live, go "broke" on a $1 replay hand and be handed 10,000 back.
  const busted = maybeBust(p);
  const grade = trustGrade(recordOf(r.ctx.wallet), null, r.trade.token_symbol).grade;
  p.history.push({ t: Date.now(), coin: r.trade.token_symbol, side: r.trade.side, choice, stake, price, delta, ret: r.out.ret, bankroll: p.bankroll, ...coach.snapshot(r.f, r.pFollow, choice, grade) });
  if (p.history.length > 300) p.history.shift();
  const lessonOut = coach.lesson({ f: r.f, pFollow: r.pFollow, choice, followWon, push, samples: realSamples() });
  save('players', players);

  return {
    result: push ? 'push' : won ? 'win' : 'loss', pushBand: PUSH_BAND(), delta, price, stake, busted, underdog, whaleSlain: slain,
    player: publicPlayer(p),
    reveal: {
      trader: r.trade.trader_address_label || 'Unlabeled Smart Money wallet',
      address: r.trade.trader_address,
      nansenUrl: `https://app.nansen.ai/profiler?address=${r.trade.trader_address}&chain=hyperliquid`,
      ret: r.out.ret, exit: r.out.exit, mfe: r.out.mfe, mae: r.out.mae, path: r.out.path,
      whalePnlUsd: Math.round(r.trade.value_usd * r.out.ret), followWon, pFollow: r.pFollow,
      heldMs: r.out.heldMs, closed: r.out.closed, capped: r.out.capped, trims: r.out.trims, maxHoldHours: MAX_HOLD() / 3600e3,
    },
    lesson: lessonOut, grade,
  };
}

// ------------------------------------------------------------------ calibration
function recordSample(key, f, ret, heldMs) {
  if (Math.abs(ret) < PUSH_BAND()) return; // too small to teach the odds anything
  samples[key] = { f, win: ret > 0, ret, heldMs, target: 'exit', capH: CAP_H(), at: Date.now() };
  save('samples', samples);
}

/** Resolve a batch of this week's Smart Money trades so the odds reflect how they actually performed. */
export async function calibrate(limit = Number(process.env.CALIBRATION_SAMPLE || 60)) {
  const list = await pool();
  if (realSamples().length < 60 && !process.env.CALIBRATION_SAMPLE) limit = Math.max(limit, 150); // first run: build a solid base
  const todo = list.filter((t) => !samples[tradeKey(t)]).slice(0, limit);
  for (const t of todo) {
    if (nansen.isCapped() || nansen.isDemo()) break; // never train the odds on demo data
    try {
      const out = await resolveOutcome(t);
      await new Promise((r) => setTimeout(r, 1200)); // stay well inside Hyperliquid's public rate limit
      if (!out) continue;
      if (tooQuick(out)) { samples[tradeKey(t)] = { skip: 'scalp', heldMs: out.heldMs, target: 'exit', capH: CAP_H(), at: Date.now() }; continue; }
      const { f } = await enrich(t);
      recordSample(tradeKey(t), f, out.ret, out.heldMs);
    } catch (e) { if (e.code === 'insufficient_credits') break; }
  }
  try { prune(); } catch {}
  // Drop samples older than 8 days, then refit.
  for (const [k, s] of Object.entries(samples)) if (Date.now() - s.at > 8 * DAY) delete samples[k];
  save('samples', samples);
  const real = realSamples();
  const out = oddsEngine.calibrate(real); // base model first: the live weights are fitted against it
  // How long these whales actually hold: the yardstick the 15-min and 4h tables are priced against.
  const holds = real.map((x) => x.heldMs).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (holds.length >= 20) oddsEngine.setHorizonRef(holds[Math.floor(holds.length / 2)] / 60e3);
  // Live weights learn only from the ride table: those bets settle on the whale's own exit, the same
  // target the base model predicts. A 15-minute price bet is mostly noise and would poison the fit.
  const settled = liveBets.filter((b) => !b.pick && b.ride && b.pBase != null && ['won', 'lost', 'push'].includes(b.status) && b.whaleRet != null && Math.abs(b.whaleRet) >= 0.0001);
  oddsEngine.calibrateLive(settled.map((b) => ({ late: b.late, pos: b.pos, pBase: b.pBase, followWon: b.whaleRet > 0 })));
  return out;
}

export function stats() {
  const s = realSamples();
  const m = oddsEngine.getModel();
  const all = Object.values(players);
  const bets = all.reduce((a, p) => a + p.bets, 0);
  return {
    maxHoldHours: MAX_HOLD() / 3600e3,
    medianHoldHours: (() => { const h = s.map((x) => x.heldMs).filter((x) => x != null).sort((a, b) => a - b); return h.length ? h[Math.floor(h.length / 2)] / 3600e3 : null; })(),
    closedShare: s.length ? s.filter((x) => x.heldMs != null && x.heldMs < MAX_HOLD()).length / s.length : null,
    smWinRate: s.length ? s.filter((x) => x.win).length / s.length : null,
    sampleSize: s.length,
    avgRet: s.length ? s.reduce((a, x) => a + x.ret, 0) / s.length : null,
    model: { n: m.n, updatedAt: m.updatedAt },
    players: all.length, bets,
  };
}

// ------------------------------------------------------------------ live mode
const liveIndex = new Map(); // key -> { t, item }  so placing a bet never re-fetches the feed

/** Summarize a Nansen perp PnL summary into a compact track record. */
function recordOf(w) {
  if (!w) return null;
  const top = (w.top5_coins || []).slice().sort((a, b) => b.realized_pnl_usd - a.realized_pnl_usd);
  return { pnl: w.realized_pnl_usd ?? 0, roi: w.realized_pnl_percent ?? 0, winRate: w.win_rate ?? null, closed: w.closed_trade_count ?? 0,
    wins: w.winning_trade_count ?? 0, coins: w.traded_coin_count ?? 0, fees: w.fees_usd ?? 0,
    perCoin: Object.fromEntries(top.map((c) => [String(c.coin).toUpperCase(), { pnl: c.realized_pnl_usd ?? 0, roi: c.realized_roi ?? 0, closed: c.closed_trade_count ?? 0 }])),
    best: top[0] ? { coin: top[0].coin, pnl: top[0].realized_pnl_usd } : null,
    worst: top.length > 1 && top[top.length - 1].realized_pnl_usd < 0 ? { coin: top[top.length - 1].coin, pnl: top[top.length - 1].realized_pnl_usd } : null };
}
/**
 * Specialist check: a whale who trades few coins but has proven, real profit on the coin they are opening now.
 * Judged on money made on that coin (not win rate, which is easy to inflate on one or two coins).
 */
export const SPECIALIST = { minShare: 0.4, minPnlUsd: 25000, minRoi: 0.03 };
function isSpecialist(d30, d7, coin) {
  if (!d30 || !coin || !d30.closed) return null;
  const c = d30.perCoin?.[String(coin).toUpperCase()];
  if (!c) return null;
  const share = c.closed / d30.closed;
  if (share < SPECIALIST.minShare || c.pnl < SPECIALIST.minPnlUsd || c.roi < SPECIALIST.minRoi) return null;
  const c7 = d7?.perCoin?.[String(coin).toUpperCase()];
  if (c7 && c7.pnl < 0) return null; // cold week on their own coin
  return { coin, share, pnl: c.pnl, roi: c.roi, pnl7: c7 ? c7.pnl : null };
}

/** Trust grade from 30d and 7d records: rewards realized ROI, consistency and sample size, punishes a cold week. */
function trustGrade(d30, d7, coin) {
  if (!d30 || !d30.closed) return { grade: '?', score: null, label: 'No track record' };
  const shrink = d30.closed / (d30.closed + 25);
  let score = 50 + Math.max(-35, Math.min(35, d30.roi * 250)) * shrink + ((d30.winRate ?? 0.5) - 0.5) * 40 * shrink + (d30.pnl > 0 ? 6 : -6);
  if (d7 && d7.closed) score += Math.max(-12, Math.min(12, d7.roi * 150)) + (d7.pnl > 0 ? 3 : -3);
  // Breadth guard: a win rate built on 1–2 coins is easy to inflate, so cap those whales at B.
  // (On Sep 2026 data, 30D whales trading 1–2 coins were far less consistent than those trading 3+.)
  const specialist = isSpecialist(d30, d7, coin);
  if (!specialist) {
    if ((d30.coins || 0) <= 2) score = Math.min(score, 70);
    if (d7 && d7.closed && (d7.coins || 0) <= 1) score = Math.min(score, 74);
  }
  score = Math.round(Math.max(0, Math.min(100, score)));
  const grade = score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 62 ? 'B' : score >= 48 ? 'C' : score >= 35 ? 'D' : 'F';
  const label = specialist ? `${String(coin).replace(/^\w+:/, '')} specialist` : { 'A+': 'Elite. Trust the whale', A: 'Strong hands', B: 'Solid', C: 'Coin flip', D: 'Shaky', F: 'Fade material' }[grade];
  return { grade, score, label, specialist };
}

/** Everything the Live Floor needs to show and price one Smart Money trade. */
export async function buildLiveItem(t) {
  // A trade with no usable entry price can't be priced or scored: NaN would flow into the odds and
  // then into the stake checks, so it never reaches the floor.
  if (!(Number(t?.price_usd) > 0) || !t.trader_address || !t.token_symbol) return null;
  const now = Date.now();
  const hour = Math.floor(now / 3600e3) * 3600e3;
  const [wallet, wallet7, sm, crowd] = await Promise.all([
    nansen.walletSummary(t.trader_address, iso(hour - 30 * DAY), iso(hour)).catch(() => null),
    nansen.walletSummary(t.trader_address, iso(hour - 7 * DAY), iso(hour)).catch(() => null),
    nansen.coinContext(t.token_symbol, iso(hour - DAY), iso(hour), 'sm').catch(() => null),
    nansen.coinContext(t.token_symbol, iso(hour - DAY), iso(hour), 'all').catch(() => null),
  ]);
  const positioning = sm?.smart_money_longs_count != null ? { longs: sm.smart_money_longs_count, shorts: sm.smart_money_shorts_count,
    longsUsd: Math.abs(sm.current_smart_money_position_longs_usd || 0), shortsUsd: Math.abs(sm.current_smart_money_position_shorts_usd || 0) } : null;
  const ctx = { coin: t.token_symbol, side: t.side, wallet, sm, crowd, positioning, hidePositioningReason: true }; // the live card shows the money-weighted version instead
  const f = oddsEngine.features({ side: t.side, valueUsd: t.value_usd, ...ctx });
  const pBase = oddsEngine.probability(f);
  const mid = await hl.mid(t.token_symbol).catch(() => null);
  if (!mid) return null;
  const moveSinceEntry = (t.side === 'Long' ? 1 : -1) * (mid - t.price_usd) / t.price_usd;
  const late = oddsEngine.lateFeature(moveSinceEntry);
  const pos = oddsEngine.posFeature(positioning, t.side);
  const pFollow = oddsEngine.liveAdjust(pBase, late, pos);
  const item = {
    key: tradeKey(t), demo: !!t._demo, coin: t.token_symbol, side: t.side === 'Short' ? 'Short' : 'Long', valueUsd: t.value_usd, trader: t.trader_address_label,
    address: t.trader_address, entryPrice: t.price_usd, openedAt: t.block_timestamp, mid,
    moveSinceEntry, pFollow, odds: oddsEngine.oddsFor(pFollow, 'ride'),
    // each table is a different wager, so each gets its own price (see odds.js: horizonP)
    oddsByHz: { 15: oddsEngine.oddsFor(pFollow, 15), 240: oddsEngine.oddsFor(pFollow, 240), ride: oddsEngine.oddsFor(pFollow, 'ride') },
    reasons: [oddsEngine.lateReason(moveSinceEntry, t.side), oddsEngine.posReason(positioning, t.token_symbol, t.side), ...oddsEngine.reasons(f, ctx)]
      .filter(Boolean).slice(0, 4).map(({ good, text }) => ({ good, text })), positioning,
    record: { d7: recordOf(wallet7), d30: recordOf(wallet), trust: trustGrade(recordOf(wallet), recordOf(wallet7), t.token_symbol) },
  };
  Object.defineProperty(item, 'f', { value: f, enumerable: false });
  Object.defineProperty(item, 'late', { value: { late, pos, pBase }, enumerable: false });
  liveIndex.set(item.key, { t: Date.now(), item });
  rawIndex.set(item.key, t);
  return item;
}
export { recordOf, trustGrade, tradeKey, isSpecialist };
const rawIndex = new Map();
export const getRaw = (key) => rawIndex.get(key);

/** Re-price one whale card on demand (price, odds, tells, and whether they are still in the trade). */
export async function refreshLiveItem(key, fallbackTrade = null) {
  const t = rawIndex.get(String(key)) || (fallbackTrade && tradeKey(fallbackTrade) === String(key) ? fallbackTrade : null);
  if (!t) throw Object.assign(new Error('That trade is no longer on the floor. Refresh the floor and pick another.'), { status: 410 });
  const h = await holding(t);
  const item = await buildLiveItem(t).catch(() => null);
  if (!item) throw Object.assign(new Error("Couldn't read that whale right now, try again"), { status: 503 });
  item.trimmed = h.trimmed || 0;
  item.gone = !h.open;
  if (agent.isStock(item.coin)) item.research = researchPreview(item.coin, item.side);
  if (!h.open) markClosed(t.trader_address, t.token_symbol);
  return item;
}

let extraLive = () => [];           // alerts module plugs its pinned trades in here
export const setExtraLive = (fn) => (extraLive = fn);

// Is the whale still in the trade? Read from Hyperliquid (free), cached 60s per whale+coin.
const posCache = new Map();
export function markClosed(address, coin) { posCache.set(address + ':' + coin, { t: Date.now(), sz: 0 }); }
async function holding(t) {
  if (t._demo || nansen.isDemo()) return { open: true };
  const k = t.trader_address + ':' + t.token_symbol;
  const hit = posCache.get(k);
  let sz = hit && Date.now() - hit.t < 60e3 ? hit.sz : undefined;
  if (sz === undefined) {
    sz = await hl.positionSize(t.trader_address, t.token_symbol).catch(() => null);
    if (sz != null) { posCache.set(k, { t: Date.now(), sz }); if (posCache.size > 3000) posCache.clear(); }
  }
  if (sz == null) return { open: true, unknown: true };
  const open = Math.abs(sz) > 1e-12 && Math.sign(sz) === (t.side === 'Long' ? 1 : -1);
  const opened = Math.abs(Number(t.token_amount)) || (t.value_usd && t.price_usd ? t.value_usd / t.price_usd : 0);
  return { open, trimmed: open && opened ? Math.max(0, Math.min(1, 1 - Math.abs(sz) / opened)) : 0 };
}

let feedCache = null, feedFlight = null;
export function liveFeed() {
  if (feedCache && Date.now() - feedCache.t < 20e3) return Promise.resolve(feedCache.rows);
  feedFlight ??= buildFeed().then((rows) => { feedCache = { t: Date.now(), rows }; return rows; }).finally(() => { feedFlight = null; });
  return feedFlight;
}
async function buildFeed() {
  const trades = await nansen.smartMoneyOpens({ lookbackHours: 6, pages: 1, perPage: 300, minValueUsd: 10000 });
  const pinned = extraLive(); // raw trades from recent whale alerts, shown first
  const seen = new Set();
  const candidates = [...pinned, ...trades.sort((a, b) => b.value_usd - a.value_usd)]
    .filter((t) => { const k = t.trader_address + t.token_symbol; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 18 + pinned.length);
  // only whales still holding the position make it to the floor
  const status = await Promise.all(candidates.map((t) => holding(t)));
  const pinnedKeys = new Set(pinned.map(tradeKey));
  const stillIn = candidates.map((t, i) => ({ t, h: status[i] })).filter((x) => x.h.open);
  const top = [...stillIn.filter((x) => pinnedKeys.has(tradeKey(x.t))), ...stillIn.filter((x) => !pinnedKeys.has(tradeKey(x.t))).slice(0, 8)];
  const rows = (await Promise.all(top.map(async ({ t, h }) => {
    const item = await buildLiveItem(t).catch(() => null);
    if (item) item.trimmed = h.trimmed || 0;
    return item;
  }))).filter(Boolean);
  rows.forEach((r) => {
    if (pinnedKeys.has(r.key)) r.alert = true;
    if (agent.isStock(r.coin)) r.research = researchPreview(r.coin, r.side);
  });
  return rows;
}

/** Short cached Nansen Agent verdict for a stock whale card (never triggers a new Agent call). */
function researchPreview(coin, side) {
  const r = agent.companyIntel(coin, { start: false });
  if (!r.intel) return { status: r.status };
  return { status: 'ready', signal: r.intel.insider.signal, alignment: agent.alignment(side, r.intel.insider.signal) };
}
/** Coins currently on the Live Floor (players may only ask the Research Desk about these). */
export const liveCoins = () => new Set([...liveIndex.values()].filter((x) => Date.now() - x.t < 30 * 60e3).map((x) => x.item.coin));

// ------------------------------------------------------------------ Insider Pick of the Day (Nansen Agent)
// Insiders can't profitably sell within 6 months (SEC short-swing rule) and studies find most of the post-purchase
// drift builds over months, so the pick is played over 1 week, 1 month or 6 months instead of hours.
const PICK_HORIZONS = { 7: 7 * 1440, 30: 30 * 1440, 180: 180 * 1440 };
export async function pickView(playerId) {
  const r = agent.insiderPick();
  const out = { ...r, desk: agent.status(), horizons: Object.keys(PICK_HORIZONS).map(Number) };
  if (r.pick) {
    await agent.backfillEntry(r.pick);
    const mid = await hl.mid(r.pick.coin).catch(() => null);
    out.mid = mid;
    out.move = mid && r.pick.priceAtPick ? (r.pick.side === 'Long' ? 1 : -1) * (mid - r.pick.priceAtPick) / r.pick.priceAtPick : null;
    out.odds = oddsEngine.odds(0.5);
    out.canBet = r.status === 'ready';
    if (playerId) out.myOpen = liveBets.filter((b) => b.playerId === playerId && b.pick && b.status === 'open' && b.pickDay === r.pick.day).length;
  }
  return out;
}
// +1 = you profit if the coin goes up, -1 = you profit if it goes down.
// Following a long and fading a short are the same bet; holding both sides of one coin
// locks in a risk-free split of the push band and teaches nothing.
function dirOf(whaleSide, choice) { return (whaleSide === 'Long' ? 1 : -1) * (choice === 'follow' ? 1 : -1); }
// Compare the underlying, not the raw symbol: the same stock can arrive as AAPL from one venue
// and xyz:AAPL from another, and both are the same exposure.
const sameAsset = (a, b) => a === b || agent.tickerOf(a) === agent.tickerOf(b);
function conflictOn(playerId, coin, dir) {
  return liveBets.find((b) => b.playerId === playerId && sameAsset(b.coin, coin)
    && ['open', 'cashing'].includes(b.status) && dirOf(b.whaleSide, b.choice) === -dir);
}
function conflictError(b, coin) {
  const dirWord = dirOf(b.whaleSide, b.choice) > 0 ? 'up' : 'down';
  return Object.assign(new Error(`You already have a ${b.choice.toUpperCase()} on a ${b.whaleSide.toLowerCase()} ${coin} position, so you're already betting ${coin} goes ${dirWord}. Cash that out first if you changed your mind.`), { status: 409 });
}

export async function placePickBet(playerId, choice, stake, days = 30) {
  const p = P(playerId);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  const r = agent.insiderPick();
  if (r.status !== 'ready') throw Object.assign(new Error("Today's Insider Pick isn't ready yet"), { status: 409 });
  if (!['follow', 'fade'].includes(choice)) throw Object.assign(new Error('Pick follow or fade'), { status: 400 });
  stake = Math.floor(Number(stake));
  if (!(stake >= 1) || stake > p.bankroll) throw Object.assign(new Error('Invalid stake'), { status: 400 });
  if (openBetsOf(playerId) + (p.inflight || 0) >= 12) throw Object.assign(new Error('Max 12 open bets at once. Cash out or wait for one to settle.'), { status: 429 });
  if (liveBets.some((b) => b.playerId === playerId && b.pick && b.pickDay === r.pick.day && ['open', 'cashing'].includes(b.status))) {
    throw Object.assign(new Error("One bet per Insider Pick: you already have today's on the table."), { status: 409 });
  }
  const pickDir = dirOf(r.pick.side, choice);
  const oppositePick = conflictOn(playerId, r.pick.coin, pickDir);
  if (oppositePick) throw (oppositePick.pick
    ? Object.assign(new Error(`You already have a ${oppositePick.choice.toUpperCase()} on today's Insider Pick.`), { status: 409 })
    : conflictError(oppositePick, r.pick.coin));
  p.bankroll -= stake; p.inflight = (p.inflight || 0) + 1; // reserve before any await so parallel requests can't overspend
  let entry;
  try { entry = await hl.mid(r.pick.coin); }
  catch (e) { p.bankroll += stake; save('players', players); throw e; } // a thrown price lookup must never eat the stake
  finally { p.inflight--; }
  if (!entry) { p.bankroll += stake; save('players', players); throw new Error('No live price for ' + r.pick.coin); }
  const minutes = PICK_HORIZONS[Number(days)] || PICK_HORIZONS[30];
  const odds = oddsEngine.odds(0.5);
  save('players', players);
  const racedPick = conflictOn(playerId, r.pick.coin, pickDir); // re-check: another request may have landed while we fetched the price
  if (racedPick) { p.bankroll += stake; save('players', players); throw conflictError(racedPick, r.pick.coin); }
  const bet = { id: crypto.randomUUID(), playerId, coin: r.pick.coin, whaleSide: r.pick.side, choice, stake, price: choice === 'follow' ? odds.follow : odds.fade,
    entry, placedAt: Date.now(), settleAt: Date.now() + minutes * 60e3, minutes, pickDays: minutes / 1440, pick: true, pickDay: r.pick.day, trader: 'Nansen Agent', status: 'open' };
  liveBets.push(bet); save('livebets', liveBets);
  minuteVol(bet.coin).catch(() => {});
  return bet;
}

export async function placeLiveBet(playerId, item, choice, stake, minutes = 60) {
  const p = P(playerId);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  if (!['follow', 'fade'].includes(choice)) throw Object.assign(new Error('Choice must be follow or fade'), { status: 400 });
  let t = liveIndex.get(String(item));
  t = t && Date.now() - t.t < 10 * 60e3 ? t.item : null;
  if (!t) throw Object.assign(new Error('That trade left the live feed. Refresh the floor and pick another.'), { status: 410 });
  stake = Math.floor(Number(stake));
  if (!(stake >= 1) || stake > p.bankroll) throw Object.assign(new Error('Invalid stake'), { status: 400 });
  if (openBetsOf(playerId) + (p.inflight || 0) >= 12) throw Object.assign(new Error('Max 12 open bets at once. Cash out or wait for one to settle.'), { status: 429 });
  if (t.gone) throw Object.assign(new Error('This whale already closed the position. Pick another one.'), { status: 409 });
  // one direction per coin: holding both sides cancels itself out and teaches nothing
  const dir = dirOf(t.side, choice);
  const opposite = conflictOn(playerId, t.coin, dir);
  if (opposite) throw conflictError(opposite, t.coin);
  const ride = minutes === 'ride';
  minutes = ride ? 'ride' : [15, 240].includes(Number(minutes)) ? Number(minutes) : 15;
  p.bankroll -= stake; p.inflight = (p.inflight || 0) + 1; // reserve before any await so parallel requests can't overspend
  try { return await openLiveBet(p, playerId, t, choice, stake, minutes, ride); }
  catch (e) { p.bankroll += stake; save('players', players); throw e; }
  finally { p.inflight--; }
}
async function openLiveBet(p, playerId, t, choice, stake, minutes, ride) {
  const entry = await hl.mid(t.coin);
  if (!entry) throw new Error('No live price for ' + t.coin);
  let whaleSz = null;
  const demoTrade = nansen.isDemo() || t.demo;
  if (ride && demoTrade) {
    whaleSz = 0; // demo wallets are simulated: the "whale" exits after 20–90 minutes
  } else if (ride) {
    // Ride the Whale: the bet ends when this whale closes the position, so it must still be open
    whaleSz = await hl.positionSize(t.address, t.coin).catch(() => null);
    if (whaleSz == null) throw Object.assign(new Error("Couldn't read the whale's position right now, try again"), { status: 503 });
    if (Math.abs(whaleSz) < 1e-12 || Math.sign(whaleSz) !== (t.side === 'Long' ? 1 : -1)) markClosed(t.address, t.coin);
    if (Math.abs(whaleSz) < 1e-12 || Math.sign(whaleSz) !== (t.side === 'Long' ? 1 : -1)) throw Object.assign(new Error('This whale already closed the position. Pick another whale to ride.'), { status: 409 });
  }
  const raced = conflictOn(playerId, t.coin, dirOf(t.side, choice)); // re-check: awaits above leave a window for a parallel request
  if (raced) throw conflictError(raced, t.coin);
  // Re-price on the price you are actually getting, not the one the card was built with:
  // a card can sit on the floor for minutes, and "how late you are" is part of the read.
  const moveNow = t.entryPrice > 0 ? (t.side === 'Long' ? 1 : -1) * (entry - t.entryPrice) / t.entryPrice : (t.moveSinceEntry ?? 0);
  const lateNow = oddsEngine.lateFeature(moveNow);
  const pNow = t.late?.pBase != null ? oddsEngine.liveAdjust(t.late.pBase, lateNow, t.late.pos) : t.pFollow;
  const o = oddsEngine.oddsFor(pNow, ride ? 'ride' : minutes);
  const bet = { id: crypto.randomUUID(), playerId, coin: t.coin, whaleSide: t.side, choice, stake,
    price: choice === 'follow' ? o.follow : o.fade, entry, placedAt: Date.now(),
    settleAt: Date.now() + (ride ? (demoTrade ? (20 + Math.floor(Math.random() * 70)) * 60e3 : RIDE_MAX()) : minutes * 60e3), minutes, ride, demoRide: ride && demoTrade, whale: t.address, whaleSz, trader: t.trader, status: 'open',
    whaleEntry: t.entryPrice, late: lateNow, pos: t.late?.pos ?? null, pBase: t.late?.pBase ?? null, pFollowAtBet: pNow,
    ...coach.snapshot(t.f, t.pFollow, choice, t.record?.trust?.grade) };
  liveBets.push(bet); save('livebets', liveBets); save('players', players); // bet first: a stake is never taken without one
  minuteVol(bet.coin).catch(() => {}); // warm the volatility cache so the cash-out quote is instant
  return bet;
}

function settleBet(b, exit, extra = {}) {
  if (b.status !== 'open') return false; // already cashed out or settled: never pay twice
  const whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (exit - b.entry) / b.entry;
  const push = Math.abs(whaleRet) < bandFor(b);
  const won = !push && (b.choice === 'follow' ? whaleRet > 0 : whaleRet < 0);
  const p = P(b.playerId);
  Object.assign(b, extra);
  b.exit = exit; b.whaleRet = whaleRet; if (b.whaleEntry) b.whaleTradeRet = (b.whaleSide === 'Long' ? 1 : -1) * (exit - b.whaleEntry) / b.whaleEntry;
  b.status = push ? 'push' : won ? 'won' : 'lost'; b.settledAt = Date.now();
  b.payout = push ? b.stake : won ? Math.round(b.stake * b.price) : 0;
  if (p) {
    p.bankroll += b.payout; p.bets++; if (push) p.pushes = (p.pushes || 0) + 1;
    if (won) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else if (!push) p.streak = 0;
    p.peak = Math.max(p.peak, p.bankroll);
    maybeBust(p);
    p.history.push({ t: Date.now(), coin: b.coin, side: b.whaleSide, choice: b.choice, stake: b.stake, price: b.price, delta: b.payout - b.stake, ret: whaleRet, bankroll: p.bankroll, live: true, minutes: b.minutes, pick: b.pick, sig: b.sig, pChosen: b.pChosen, modelSide: b.modelSide, grade: b.grade, heldMs: b.whaleHeldMs });
  }
  return true; // tell settleLive the books changed so players + livebets get saved
}

let settling = false;
export async function settleLive() {
  if (settling) return;
  settling = true;
  let changed = false;
  const settle = (b, px, extra) => { if (settleBet(b, px, extra)) changed = true; };
  // price at a past moment; today's price is only an acceptable stand-in right after the bell
  const bellPrice = async (b) => (await hl.priceAt(b.coin, b.settleAt).catch(() => null))
    ?? (Date.now() - b.settleAt < 30 * 60e3 ? await hl.mid(b.coin).catch(() => null) : null);
  try {
    // 1) timed bets first, so they never wait behind slow whale-fill checks
    for (const b of liveBets) {
      if (b.status !== 'open' || (b.ride && !b.demoRide) || Date.now() < b.settleAt) continue;
      const exit = await bellPrice(b);
      if (!exit || b.status !== 'open') continue;
      settle(b, exit, b.demoRide ? { whaleClosed: true, whaleHeldMs: b.settleAt - b.placedAt } : {});
    }
    // 2) Ride the Whale: follow the whale's fills (at most once a minute per bet)
    for (const b of liveBets) {
      if (b.status !== 'open' || !b.ride || b.demoRide) continue;
      if (b.lastCheck && Date.now() - b.lastCheck < 60e3 && Date.now() < b.settleAt) continue;
      b.lastCheck = Date.now();
      const e = await hl.whaleExit(b.whale, b.coin, b.placedAt, b.settleAt - b.placedAt, b.whaleSz, false).catch(() => null);
      if (b.status !== 'open') continue; // cashed out while we were reading fills
      if (!e) {
        // fills too busy to follow (or unavailable) past the cap: settle at the price at the cap
        if (Date.now() > b.settleAt + 10 * 60e3) {
          const px = await bellPrice(b) ?? await hl.mid(b.coin).catch(() => null);
          if (px && b.status === 'open') settle(b, px, { whaleClosed: false, whaleHeldMs: b.settleAt - b.placedAt });
        }
        continue;
      }
      b.whaleTrims = e.exits.length;
      if (e.closed || e.capped) { settle(b, e.exitPx, { whaleClosed: !!e.closed, whaleHeldMs: e.heldMs }); markClosed(b.whale, b.coin); }
    }
    if (changed) { save('players', players); save('livebets', liveBets); }
  } finally { settling = false; }
}

/** Housekeeping: settled bets older than 7 days and players who never bet (after 2 days) are dropped. */
/** `hard` is used when the player table is at capacity: drop never-played visitors sooner. */
export function prune({ hard = false } = {}) {
  const idleCutoff = hard ? 6 * 3600e3 : 2 * DAY;
  const cutoff = Date.now() - 7 * DAY;
  const before = liveBets.length;
  for (let i = liveBets.length - 1; i >= 0; i--) {
    const b = liveBets[i];
    if (b.status !== 'open' && b.status !== 'cashing' && (b.settledAt || b.cashedAt || b.placedAt) < cutoff) liveBets.splice(i, 1);
  }
  let removed = 0;
  for (const [id, p] of Object.entries(players)) {
    if (!p.bets && !openBetsOf(id) && Date.now() - (p.createdAt || 0) > idleCutoff) { delete players[id]; removed++; }
  }
  if (liveBets.length !== before) save('livebets', liveBets);
  if (removed) save('players', players);
  // the bet indexes only need to cover the 20-minute betting window; without this they grow all day
  const stale = Date.now() - 30 * 60e3;
  for (const [k, v] of liveIndex) if (v.t < stale) { liveIndex.delete(k); rawIndex.delete(k); }
  if (rawIndex.size > 500) for (const k of [...rawIndex.keys()].slice(0, rawIndex.size - 500)) rawIndex.delete(k);
  return { bets: before - liveBets.length, players: removed };
}
// ------------------------------------------------------------------ cash out
const volCache = new Map(); // coin -> { t, sigma } ; sigma = stdev of 1-minute log returns
async function minuteVol(coin) {
  const hit = volCache.get(coin);
  if (hit && Date.now() - hit.t < 60e3) return hit.sigma;
  if (volCache.size > 500) for (const [k, v] of volCache) if (Date.now() - v.t > 10 * 60e3) volCache.delete(k);
  const rows = await hl.candles(coin, Date.now() - 90 * 60e3, Date.now(), '1m').catch(() => []);
  const r = [];
  for (let i = 1; i < rows.length; i++) if (rows[i - 1].c > 0 && rows[i].c > 0) r.push(Math.log(rows[i].c / rows[i - 1].c));
  let sigma = 0.0008;
  if (r.length > 10) { const m = r.reduce((a, x) => a + x, 0) / r.length; sigma = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)); }
  sigma = Math.max(sigma, 0.0002);
  volCache.set(coin, { t: Date.now(), sigma });
  return sigma;
}
const normCdf = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
const CASHOUT_MARGIN = 1; // no fee for cashing out either: the offer is the bet's fair value
const HOUSE_EDGE = 0;
const normInv = (p) => { let lo = -8, hi = 8; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };

/**
 * Fair early-exit value of a live bet: stake x odds x P(still winning at the bell).
 * P comes from how far price has moved for you, the time left and the coin's current 1-minute volatility.
 */
async function quote(b, now) {
  // Ride the Whale has no fixed bell: price it on the typical remaining hold (capped at 12h)
  const minutesLeft = (b.settleAt - Date.now()) / 60e3;
  if (b.status !== 'open' || minutesLeft <= 0.1 || !now) return null;
  const whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.entry) / b.entry;
  const myRet = b.choice === 'follow' ? whaleRet : -whaleRet;
  const sigma = await minuteVol(b.coin);
  // Start from the probability the odds were priced at (so cashing out at the moment you bet returns your stake
  // minus the house edge), then update it with how price has actually moved and how much time is left.
  const totalMin = Math.max(minutesLeft, (b.settleAt - b.placedAt) / 60e3);
  const pAtBet = Math.min(0.99, Math.max(0.01, (1 - HOUSE_EDGE) / b.price));
  const edge = normInv(pAtBet) * sigma * Math.sqrt(totalMin);        // expected move in your favour over the whole bet
  const pWin = normCdf((myRet + edge * (minutesLeft / totalMin)) / (sigma * Math.sqrt(minutesLeft)));
  // round, don't floor: with no cash-out fee, an instant cash-out must return the stake, and 1000 * 2.00 * 0.5 can land on 999.9999
  // Cap just under the full payout, proportionally: a flat "-1" turned a $1 winning bet into an offer of 0.
  const cap = Math.floor(b.stake * b.price * 0.99);
  const offer = Math.max(0, Math.min(Math.round(b.stake * b.price * pWin * CASHOUT_MARGIN), cap));
  return { offer, pWin, myRet, minutesLeft };
}

export async function cashOut(playerId, betId) {
  const p = P(playerId);
  const b = liveBets.find((x) => x.id === betId && x.playerId === playerId);
  if (!p || !b) throw Object.assign(new Error('Bet not found'), { status: 404 });
  if (b.status !== 'open') throw Object.assign(new Error('This bet is already settled'), { status: 409 });
  b.status = 'cashing'; // lock: parallel cash-outs and the settlement loop now skip this bet
  let now, q;
  try {
    if (b.ride && !b.demoRide) {
      const sz = await hl.positionSize(b.whale, b.coin).catch(() => null);
      if (sz != null && (Math.abs(sz) < 1e-12 || Math.sign(sz) !== (b.whaleSide === 'Long' ? 1 : -1))) {
        throw Object.assign(new Error('The whale just exited. Your bet settles at their exit price in a moment.'), { status: 409 });
      }
    }
    now = await hl.mid(b.coin);
    q = await quote({ ...b, status: 'open' }, now);
    if (!q) throw Object.assign(new Error('Too close to the bell to cash out'), { status: 409 });
  } catch (e) { b.status = 'open'; throw e; }
  b.status = 'cashed'; b.exit = now; b.payout = q.offer; b.cashedAt = Date.now(); b.whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.entry) / b.entry;
  if (b.whaleEntry) b.whaleTradeRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.whaleEntry) / b.whaleEntry;
  const net = q.offer - b.stake;
  p.bankroll += q.offer; p.bets++; if (net === 0) p.pushes = (p.pushes || 0) + 1;
  if (net > 0) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else if (net < 0) p.streak = 0;
  p.peak = Math.max(p.peak, p.bankroll);
  maybeBust(p);
  p.history.push({ t: Date.now(), coin: b.coin, side: b.whaleSide, choice: b.choice, stake: b.stake, price: b.price, delta: net, ret: b.whaleRet, bankroll: p.bankroll, live: true, minutes: b.minutes, pick: b.pick, cashed: true, sig: b.sig, pChosen: b.pChosen, modelSide: b.modelSide, grade: b.grade });
  save('players', players); save('livebets', liveBets);
  return { bet: b, net, player: publicPlayer(p) };
}

export async function liveBetsFor(playerId) {
  const mine = liveBets.filter((b) => b.playerId === playerId).slice(-30).reverse();
  return Promise.all(mine.map(async (b) => {
    if (b.status !== 'open') return b;
    const now = await hl.mid(b.coin).catch(() => null);
    if (!now) return b;
    const whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.entry) / b.entry;
    const winning = b.choice === 'follow' ? whaleRet > 0 : whaleRet < 0;
    const q = await quote(b, now).catch(() => null);
    const whaleTradeRet = b.whaleEntry ? (b.whaleSide === 'Long' ? 1 : -1) * (now - b.whaleEntry) / b.whaleEntry : null;
    return { ...b, now, whaleRet, whaleTradeRet, winningNow: Math.abs(whaleRet) < bandFor(b) ? null : winning, band: bandFor(b), cashOut: q ? q.offer : null, pWin: q ? q.pWin : null, myRet: b.choice === 'follow' ? whaleRet : -whaleRet };
  }));
}
