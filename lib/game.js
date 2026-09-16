import crypto from 'node:crypto';
import * as nansen from './nansen.js';
import * as hl from './hyperliquid.js';
import * as oddsEngine from './odds.js';
import { load, save } from './store.js';

const H = () => Number(process.env.HORIZON_HOURS || 4) * 3600e3;
const START_BANKROLL = 10_000;
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
const tradeKey = (t) => (t.transaction_hash || '') + ':' + t.trader_address + ':' + t.token_symbol + ':' + t.block_timestamp;

const players = load('players', {});
const liveBets = load('livebets', []);
const samples = load('samples', {}); // tradeKey -> { f, win, ret } resolved trades used for calibration
oddsEngine.calibrate(Object.values(samples)); // start with the odds learned on the last run
const rounds = new Map();            // roundId -> private round (outcome never leaves the server before a bet)

// ------------------------------------------------------------------ players
export function createPlayer(name) {
  const id = crypto.randomUUID();
  const clean = String(name || '').replace(/[^\w .\-]/g, '').trim().slice(0, 18) || `anon-${id.slice(0, 4)}`;
  players[id] = { id, name: clean, bankroll: START_BANKROLL, peak: START_BANKROLL, bets: 0, wins: 0,
    streak: 0, bestStreak: 0, busts: 0, whalesSlain: 0, played: [], history: [], createdAt: Date.now() };
  save('players', players);
  return publicPlayer(players[id]);
}
export function getPlayer(id) { return players[id] ? publicPlayer(players[id]) : null; }
function publicPlayer(p) {
  const { played, ...rest } = p;
  return { ...rest, history: p.history.slice(-30) };
}
export function leaderboard() {
  return Object.values(players).filter((p) => p.bets > 0)
    .sort((a, b) => b.bankroll - a.bankroll).slice(0, 25)
    .map((p) => ({ name: p.name, bankroll: Math.round(p.bankroll), bets: p.bets,
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

// ------------------------------------------------------------------ replay pool
async function pool() {
  const trades = await nansen.smartMoneyOpens({ lookbackHours: 168 });
  const cutoff = Date.now() - H() - 5 * 60e3;
  const seen = new Set();
  return trades.filter((t) => {
    const ts = Date.parse(t.block_timestamp);
    if (!(ts < cutoff) || !t.price_usd) return false;
    const k = `${t.trader_address}|${t.token_symbol}|${Math.floor(ts / 3600e3)}`; // one per wallet/coin/hour
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

export async function newRound(playerId) {
  const p = players[playerId];
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  const list = await pool();
  if (!list.length) throw new Error('No Smart Money trades available right now');
  const unplayed = list.filter((t) => !p.played.includes(tradeKey(t)));
  const candidates = (unplayed.length ? unplayed : list);
  // Try a few random trades until one has a resolvable outcome.
  for (let i = 0; i < 6; i++) {
    const t = candidates[Math.floor(Math.random() * candidates.length)];
    const ts = Date.parse(t.block_timestamp);
    const out = await hl.outcome(t.token_symbol, t.side, t.price_usd, ts, H()).catch(() => null);
    if (!out) continue;
    const { ctx, f } = await enrich(t);
    const pFollow = oddsEngine.probability(f);
    recordSample(tradeKey(t), f, out.ret);
    const id = crypto.randomUUID();
    rounds.set(id, { id, playerId, trade: t, ctx, f, pFollow, out, createdAt: Date.now() });
    setTimeout(() => rounds.delete(id), 30 * 60e3);
    return {
      roundId: id, coin: t.token_symbol, side: t.side, valueUsd: t.value_usd, orderType: t.type,
      entryPrice: t.price_usd, openedAt: t.block_timestamp, horizonHours: H() / 3600e3,
      pFollow, odds: oddsEngine.odds(pFollow), reasons: oddsEngine.reasons(f, ctx),
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
  const p = players[playerId];
  const r = rounds.get(roundId);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  if (!r || r.playerId !== playerId) throw Object.assign(new Error('Round expired, deal a new one'), { status: 410 });
  if (!['follow', 'fade'].includes(choice)) throw Object.assign(new Error('Choice must be follow or fade'), { status: 400 });
  stake = Math.floor(Number(stake));
  if (!(stake >= 1) || stake > p.bankroll) throw Object.assign(new Error('Invalid stake'), { status: 400 });
  rounds.delete(roundId);

  const o = oddsEngine.odds(r.pFollow);
  const push = Math.abs(r.out.ret) < 0.0001;
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
  let busted = false;
  if (p.bankroll < 10) { busted = true; p.busts++; p.bankroll = START_BANKROLL; p.streak = 0; }
  p.played.push(tradeKey(r.trade)); if (p.played.length > 500) p.played.shift();
  p.history.push({ t: Date.now(), coin: r.trade.token_symbol, side: r.trade.side, choice, stake, price, delta, ret: r.out.ret, bankroll: p.bankroll });
  if (p.history.length > 200) p.history.shift();
  save('players', players);

  return {
    result: push ? 'push' : won ? 'win' : 'loss', delta, price, stake, busted, underdog, whaleSlain: slain,
    player: publicPlayer(p),
    reveal: {
      trader: r.trade.trader_address_label || 'Unlabeled Smart Money wallet',
      address: r.trade.trader_address,
      nansenUrl: `https://app.nansen.ai/profiler?address=${r.trade.trader_address}&chain=hyperliquid`,
      ret: r.out.ret, exit: r.out.exit, mfe: r.out.mfe, mae: r.out.mae, path: r.out.path,
      whalePnlUsd: Math.round(r.trade.value_usd * r.out.ret), followWon, pFollow: r.pFollow,
    },
  };
}

// ------------------------------------------------------------------ calibration
function recordSample(key, f, ret) {
  if (Math.abs(ret) < 0.0001) return;
  samples[key] = { f, win: ret > 0, ret, at: Date.now() };
  save('samples', samples);
}

/** Resolve a batch of this week's Smart Money trades so the odds reflect how they actually performed. */
export async function calibrate(limit = Number(process.env.CALIBRATION_SAMPLE || 60)) {
  const list = await pool();
  const todo = list.filter((t) => !samples[tradeKey(t)]).slice(0, limit);
  for (const t of todo) {
    try {
      const out = await hl.outcome(t.token_symbol, t.side, t.price_usd, Date.parse(t.block_timestamp), H());
      if (!out) continue;
      const { f } = await enrich(t);
      recordSample(tradeKey(t), f, out.ret);
    } catch (e) { if (e.code === 'insufficient_credits') break; }
  }
  // Drop samples older than 8 days, then refit.
  for (const [k, s] of Object.entries(samples)) if (Date.now() - s.at > 8 * DAY) delete samples[k];
  save('samples', samples);
  return oddsEngine.calibrate(Object.values(samples));
}

export function stats() {
  const s = Object.values(samples);
  const m = oddsEngine.getModel();
  const all = Object.values(players);
  const bets = all.reduce((a, p) => a + p.bets, 0);
  return {
    horizonHours: H() / 3600e3,
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
    best: top[0] ? { coin: top[0].coin, pnl: top[0].realized_pnl_usd } : null,
    worst: top.length > 1 && top[top.length - 1].realized_pnl_usd < 0 ? { coin: top[top.length - 1].coin, pnl: top[top.length - 1].realized_pnl_usd } : null };
}
/** Trust grade from 30d and 7d records: rewards realized ROI, consistency and sample size, punishes a cold week. */
function trustGrade(d30, d7) {
  if (!d30 || !d30.closed) return { grade: '?', score: null, label: 'No track record' };
  const shrink = d30.closed / (d30.closed + 25);
  let score = 50 + Math.max(-35, Math.min(35, d30.roi * 250)) * shrink + ((d30.winRate ?? 0.5) - 0.5) * 40 * shrink + (d30.pnl > 0 ? 6 : -6);
  if (d7 && d7.closed) score += Math.max(-12, Math.min(12, d7.roi * 150)) + (d7.pnl > 0 ? 3 : -3);
  score = Math.round(Math.max(0, Math.min(100, score)));
  const grade = score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 62 ? 'B' : score >= 48 ? 'C' : score >= 35 ? 'D' : 'F';
  const label = { 'A+': 'Elite. Trust the whale', A: 'Strong hands', B: 'Solid', C: 'Coin flip', D: 'Shaky', F: 'Fade material' }[grade];
  return { grade, score, label };
}

/** Everything the Live Floor needs to show and price one Smart Money trade. */
export async function buildLiveItem(t) {
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
  const ctx = { coin: t.token_symbol, side: t.side, wallet, sm, crowd, positioning };
  const f = oddsEngine.features({ side: t.side, valueUsd: t.value_usd, ...ctx });
  const pFollow = oddsEngine.probability(f);
  const mid = await hl.mid(t.token_symbol).catch(() => null);
  if (!mid) return null;
  const item = {
    key: tradeKey(t), coin: t.token_symbol, side: t.side, valueUsd: t.value_usd, trader: t.trader_address_label,
    address: t.trader_address, entryPrice: t.price_usd, openedAt: t.block_timestamp, mid,
    moveSinceEntry: (t.side === 'Long' ? 1 : -1) * (mid - t.price_usd) / t.price_usd,
    pFollow, odds: oddsEngine.odds(pFollow), reasons: oddsEngine.reasons(f, ctx), positioning,
    record: { d7: recordOf(wallet7), d30: recordOf(wallet), trust: trustGrade(recordOf(wallet), recordOf(wallet7)) },
  };
  liveIndex.set(item.key, { t: Date.now(), item });
  rawIndex.set(item.key, t);
  return item;
}
export { recordOf, trustGrade, tradeKey };
const rawIndex = new Map();
export const getRaw = (key) => rawIndex.get(key);

let extraLive = () => [];           // alerts module plugs its pinned trades in here
export const setExtraLive = (fn) => (extraLive = fn);

export async function liveFeed() {
  const trades = await nansen.smartMoneyOpens({ lookbackHours: 6, pages: 1, perPage: 300, minValueUsd: 10000 });
  const pinned = extraLive(); // raw trades from recent whale alerts, shown first
  const seen = new Set();
  const top = [...pinned, ...trades.sort((a, b) => b.value_usd - a.value_usd)]
    .filter((t) => { const k = t.trader_address + t.token_symbol; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8 + pinned.length);
  const pinnedKeys = new Set(pinned.map(tradeKey));
  const rows = (await Promise.all(top.map((t) => buildLiveItem(t).catch(() => null)))).filter(Boolean);
  rows.forEach((r) => { if (pinnedKeys.has(r.key)) r.alert = true; });
  return rows;
}

export async function placeLiveBet(playerId, item, choice, stake, minutes = 60) {
  const p = players[playerId];
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  let t = liveIndex.get(item);
  t = t && Date.now() - t.t < 20 * 60e3 ? t.item : (await liveFeed()).find((x) => x.key === item);
  if (!t) throw Object.assign(new Error('That trade left the live feed, pick another'), { status: 410 });
  stake = Math.floor(Number(stake));
  if (!(stake >= 1) || stake > p.bankroll) throw Object.assign(new Error('Invalid stake'), { status: 400 });
  minutes = [15, 30, 60].includes(Number(minutes)) ? Number(minutes) : 15;
  const entry = await hl.mid(t.coin);
  if (!entry) throw new Error('No live price for ' + t.coin);
  p.bankroll -= stake; save('players', players);
  const bet = { id: crypto.randomUUID(), playerId, coin: t.coin, whaleSide: t.side, choice, stake,
    price: choice === 'follow' ? t.odds.follow : t.odds.fade, entry, placedAt: Date.now(),
    settleAt: Date.now() + minutes * 60e3, minutes, trader: t.trader, status: 'open' };
  liveBets.push(bet); save('livebets', liveBets);
  minuteVol(bet.coin).catch(() => {}); // warm the volatility cache so the cash-out quote is instant
  return bet;
}

export async function settleLive() {
  for (const b of liveBets) {
    if (b.status !== 'open' || Date.now() < b.settleAt) continue;
    const exit = await hl.mid(b.coin).catch(() => null);
    if (!exit) continue;
    const whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (exit - b.entry) / b.entry;
    const push = Math.abs(whaleRet) < 0.0001;
    const won = !push && (b.choice === 'follow' ? whaleRet > 0 : whaleRet < 0);
    const p = players[b.playerId];
    b.exit = exit; b.whaleRet = whaleRet; b.status = push ? 'push' : won ? 'won' : 'lost';
    b.payout = push ? b.stake : won ? Math.round(b.stake * b.price) : 0;
    if (p) {
      p.bankroll += b.payout; p.bets++; if (push) p.pushes = (p.pushes || 0) + 1;
      if (won) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else if (!push) p.streak = 0;
      p.peak = Math.max(p.peak, p.bankroll);
      p.history.push({ t: Date.now(), coin: b.coin, side: b.whaleSide, choice: b.choice, stake: b.stake, price: b.price, delta: b.payout - b.stake, ret: whaleRet, bankroll: p.bankroll, live: true, minutes: b.minutes });
    }
  }
  save('players', players); save('livebets', liveBets);
}
// ------------------------------------------------------------------ cash out
const volCache = new Map(); // coin -> { t, sigma } ; sigma = stdev of 1-minute log returns
async function minuteVol(coin) {
  const hit = volCache.get(coin);
  if (hit && Date.now() - hit.t < 60e3) return hit.sigma;
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
const CASHOUT_MARGIN = 1; // the 3% house edge is already inside the odds; no extra fee for cashing out
const HOUSE_EDGE = 0.03;
const normInv = (p) => { let lo = -8, hi = 8; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };

/**
 * Fair early-exit value of a live bet: stake x odds x P(still winning at the bell).
 * P comes from how far price has moved for you, the time left and the coin's current 1-minute volatility.
 */
async function quote(b, now) {
  const minutesLeft = (b.settleAt - Date.now()) / 60e3;
  if (b.status !== 'open' || minutesLeft <= 0.1 || !now) return null;
  const whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.entry) / b.entry;
  const myRet = b.choice === 'follow' ? whaleRet : -whaleRet;
  const sigma = await minuteVol(b.coin);
  // Start from the probability the odds were priced at (so cashing out at the moment you bet returns your stake
  // minus the house edge), then update it with how price has actually moved and how much time is left.
  const totalMin = (b.settleAt - b.placedAt) / 60e3;
  const pAtBet = Math.min(0.99, Math.max(0.01, (1 - HOUSE_EDGE) / b.price));
  const edge = normInv(pAtBet) * sigma * Math.sqrt(totalMin);        // expected move in your favour over the whole bet
  const pWin = normCdf((myRet + edge * (minutesLeft / totalMin)) / (sigma * Math.sqrt(minutesLeft)));
  const offer = Math.max(0, Math.min(Math.floor(b.stake * b.price * pWin * CASHOUT_MARGIN), Math.floor(b.stake * b.price) - 1));
  return { offer, pWin, myRet, minutesLeft };
}

export async function cashOut(playerId, betId) {
  const p = players[playerId];
  const b = liveBets.find((x) => x.id === betId && x.playerId === playerId);
  if (!p || !b) throw Object.assign(new Error('Bet not found'), { status: 404 });
  if (b.status !== 'open') throw Object.assign(new Error('This bet is already settled'), { status: 409 });
  const now = await hl.mid(b.coin);
  const q = await quote(b, now);
  if (!q) throw Object.assign(new Error('Too close to the bell to cash out'), { status: 409 });
  b.status = 'cashed'; b.exit = now; b.payout = q.offer; b.cashedAt = Date.now(); b.whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.entry) / b.entry;
  const net = q.offer - b.stake;
  p.bankroll += q.offer; p.bets++; if (net === 0) p.pushes = (p.pushes || 0) + 1;
  if (net > 0) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else if (net < 0) p.streak = 0;
  p.peak = Math.max(p.peak, p.bankroll);
  p.history.push({ t: Date.now(), coin: b.coin, side: b.whaleSide, choice: b.choice, stake: b.stake, price: b.price, delta: net, ret: b.whaleRet, bankroll: p.bankroll, live: true, minutes: b.minutes, cashed: true });
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
    return { ...b, now, whaleRet, winningNow: Math.abs(whaleRet) < 0.00003 ? null : winning, cashOut: q ? q.offer : null, pWin: q ? q.pWin : null, myRet: b.choice === 'follow' ? whaleRet : -whaleRet };
  }));
}
