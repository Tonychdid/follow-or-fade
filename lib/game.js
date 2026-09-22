import crypto from 'node:crypto';
import * as nansen from './nansen.js';
import * as hl from './hyperliquid.js';
import * as oddsEngine from './odds.js';
import * as proof from './proof.js';
import { load, save } from './store.js';
import * as coach from './coach.js';
import * as agent from './agent.js';
import * as excluded from './excluded.js';
import * as bots from './bots.js';
import * as tclass from './traderclass.js';

// Training hands are judged on the whale's real exit with the same backstop as a live ride, so the two
// halves of the game teach the same thing. 72h is where the gain stops (see RIDE_MAX below), and the
// 7-day Nansen pool still leaves ~130 hands old enough to have resolved — plenty for a 16-card deck.
// NOTE: changing this deliberately invalidates stored calibration samples, because a win judged at a
// 48h cap is not the same measurement as one judged at 72h. The model rebuilds over the following days.
const MAX_HOLD = () => numEnv('MAX_HOLD_HOURS', 72, 1) * 3600e3;                     // training hands (replays)
// Training hands must be real positions, not scalps: whales who closed faster than this are left out of the deck and the odds.
/** A mistyped number in the environment must fall back, never become NaN and poison every timestamp. */
function numEnv(name, fallback, min = 0) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
// Scalpers are IN. Measured on 70 live Smart Money whales (Sep 2026): 53 of them close more than
// 20 trades a day and 51 of those 53 are profitable over 30 days — so a one-hour minimum hold was
// discarding three quarters of the cohort, including its most consistent members. Quality is now
// judged on the WALLET's record (see qualifies() in alerts.js), not on how long it held.
// Set MIN_HOLD_MINUTES if sub-minute hands ever make for a dull training chart.
const MIN_HOLD = () => numEnv('MIN_HOLD_MINUTES', 0, 0) * 60e3;
// Nansen windows are rounded to a bucket so the same request repeats instead of being unique. The old
// 1-hour bucket meant every whale track record and every coin context was re-fetched 24 times a day,
// which was the single largest line on the credit bill. A 30-day track record and a 24-hour flow figure
// do not move meaningfully in six hours. CONTEXT_HOURS tunes the trade-off: lower is fresher and dearer.
export const rideMaxHours = () => RIDE_MAX() / 3600e3;
export const CONTEXT_HOURS = numEnv('CONTEXT_HOURS', 6, 1);
export const ctxBucket = (now = Date.now()) => Math.floor(now / (CONTEXT_HOURS * 3600e3)) * (CONTEXT_HOURS * 3600e3);
// Whale results inside this band are too small to call: training hands, Ride the Whale and Insider Pick bets push (stake back).
export const PUSH_BAND = () => Number(process.env.PUSH_BAND_PCT ?? 0.2) / 100;
const bandFor = (b) => (b.ride || b.pick ? PUSH_BAND() : 0.0001); // 15-min and 4h tables keep a tiny band
const tooQuick = (out) => out && out.closed && out.heldMs < MIN_HOLD();
// Ride the Whale's backstop. Measured over a 7-day observation window on 66 real Smart Money positions:
// a 24h cap let the whale decide 51% of bets, 48h decided 64%, 72h decided 73% — and 96h, 120h and 168h
// all decided the same 73%, because the remaining quarter are multi-week holders no practical cap reaches.
// So 72h captures everything capturable; anything longer only ties up chips for nothing.
const RIDE_MAX = () => numEnv('RIDE_MAX_HOURS', 72, 1) * 3600e3;
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
// Hands are remembered per TRADE, so the same wallet could come back over and over with a different
// trade — several times in a row, which reads as a broken shuffle. Keep a short list of the whales a
// player has just seen and deal round them.
const WHALE_COOLDOWN = Math.max(1, Number(process.env.WHALE_COOLDOWN || 10));
const recentWhales = (p) => (p.recentWhales ??= []);
// Which kinds of whale this player has already been dealt. Kept per player, not per deck, because
// the point is what THEY have seen — a deck full of variety teaches nothing if one player happens to
// draw four elites in a row. Reset once every profile has been met, so the rotation keeps going.
const seenProfiles = (p) => (p.seenProfiles ??= []);
const markProfile = (p, pr) => {
  if (!pr) return;
  const list = seenProfiles(p);
  if (!list.includes(pr)) list.push(pr);
  if (PROFILES.every((x) => list.includes(x))) p.seenProfiles = [];   // full lap: start a new one
};
/** Has this player seen this whale within the last `win` hands? */
const whaleCooling = (p, addr, win = WHALE_COOLDOWN) =>
  !!addr && recentWhales(p).slice(-win).includes(String(addr).toLowerCase());
function markWhale(p, addr) {
  if (!addr) return;
  const r = recentWhales(p);
  r.push(String(addr).toLowerCase());
  while (r.length > WHALE_COOLDOWN) r.shift();
}
/** The widest slice of `items` that avoids recently-seen whales; never returns empty if `items` is not.
 *  Steps the window down ONE at a time (10, 9, 8 ... 1) rather than collapsing, so a thin deck gives up
 *  as little separation as it has to and "never the same whale twice in a row" survives to the end. */
function avoidRepeats(p, items, addrOf) {
  for (let win = WHALE_COOLDOWN; win >= 1; win--) {
    const f = items.filter((x) => !whaleCooling(p, addrOf(x), win));
    if (f.length) return f;
  }
  return items; // every remaining hand is from a whale just seen: deal rather than refuse
}
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
  // recentWhales holds wallet addresses; the training hand hides the whale, so it must never ship.
  const { played, inflight, recentWhales: _rw, seenProfiles: _sp, ...rest } = p;
  return { ...rest, net: Math.round(netProfit(p)), history: p.history.slice(-30) };
}
export function skillReport(id) {
  const p = P(id);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  return coach.report(p);
}

// Every reload is 10,000 the house handed you, so the board ranks on what you actually made:
// bankroll minus every stake the house ever staked you. Otherwise going all-in forever wins.
// Chips won on a challenge hand are subtracted too: the sender is shown the outcome the moment they
// bet, so a link is a known answer to whoever holds it. It still moves your stack and still teaches
// you something; it just cannot move the ranking.
const netProfit = (p) => p.bankroll - START_BANKROLL * (1 + (p.busts || 0)) - (p.challengeNet || 0);
// Ranking on net profit alone meant ONE lucky all-in owned the board, and a new player costs nothing
// to create — so a few hundred throwaway identities shoving once each would fill every slot with
// coin flips. A short qualifying run makes the board reward reading the tells, not the sample size.
const BOARD_MIN_BETS = numEnv('BOARD_MIN_BETS', 3, 1);
/**
 * Accounts that exist to hammer the server, not to play it.
 *
 * The public board is offered as evidence that people actually use this thing, so it has to be
 * people. Four load-test rigs sat on it holding a fifth of every bet ever placed, which quietly
 * turned the one honest number on the page into a measurement of my own traffic generator.
 * Named here rather than deleted, because deleting a player would also delete their settled bets
 * out of the calibration history, and that history is real.
 */
const RIGS = new Set((process.env.BOARD_EXCLUDE ?? 'lag1,lag2,lag3,perf,perf2,perf3,smoke,shot,checkpill,sweep,off')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
export const isRig = (name) => RIGS.has(String(name || '').trim().toLowerCase());

export function leaderboard() {
  return Object.values(players).filter((p) => p.bets >= BOARD_MIN_BETS && !isRig(p.name))
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
  // A player is watching a spinner for this one, so it goes in the interactive lane ahead of the
  // background settlement sweep. Settling live bets is not urgent; dealing the next card is.
  const e = await hl.whaleExit(t.trader_address, t.token_symbol, ts, MAX_HOLD(), null, true, { priority: true }).catch(() => null);
  if (!e || !e.exitPx) return null;
  const dir = t.side === 'Long' ? 1 : -1;
  const ret = dir * (e.exitPx - t.price_usd) / t.price_usd;
  const pth = await hl.pathBetween(t.token_symbol, t.side, t.price_usd, e.fromMs, e.exitAt).catch(() => null);
  return { ret, exit: e.exitPx, heldMs: e.heldMs, closed: e.closed, capped: !!e.capped, trims: e.exits.length,
    path: pth?.path?.length > 1 ? pth.path : [[e.fromMs, t.price_usd], [e.exitAt, e.exitPx]], mfe: pth?.mfe ?? Math.max(0, ret), mae: pth?.mae ?? Math.min(0, ret) };
}

// ------------------------------------------------------------------ replay pool
/**
 * The source list the odds are trained on: Smart Money opens old enough that the whale's exit is
 * already history.
 *
 * Two numbers bracket this and the gap between them is the entire supply of training data. A trade
 * is unusable until it is older than MAX_HOLD (we cannot score an exit that has not happened yet),
 * and invisible once it is older than the lookback. At the original 168h that left a 96-hour slice
 * and a treadmill: one hour of trades aged in at the front and one aged out at the back, so the pool
 * sat flat near 370 no matter how long the server ran.
 *
 * 336h widens the slice to 264 hours. The extra trades are historical, so they resolve immediately
 * rather than being waited for - the study stops being rate-limited by the clock. Raising this
 * further keeps working, but see the look-ahead note on the proof page before you do: qualifies()
 * reads TODAY'S roster, and applying today's verdicts to ever-older trades leans harder on a roster
 * that was graded partly on those same outcomes.
 */
async function pool() {
  const trades = await nansen.smartMoneyOpens({
    lookbackHours: numEnv('POOL_LOOKBACK_HOURS', 336, 72),
    pages: numEnv('POOL_PAGES', 4, 1),
  });
  const cutoff = Date.now() - MAX_HOLD() - 5 * 60e3; // only trades old enough to know how the whale exited
  const seen = new Set();
  return trades.filter((t) => {
    const ts = Date.parse(t.block_timestamp);
    if (!(ts < cutoff) || !t.price_usd) return false;
    if (excluded.isExcluded(t.trader_address)) return false; // this trader asked not to appear
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
/**
 * The kinds of whale a player should meet, so a short session teaches the whole board rather than
 * eight variations on "A+ whale, no tags".
 *
 * Buckets are ordered most-specific first and a whale takes the FIRST one it matches, so a rare
 * profile is never swallowed by a common one: an EARLY whale who is also grade A counts as EARLY,
 * because "another A" is the thing there is already plenty of. `combo` outranks everything, since a
 * whale wearing two tags at once is the most interesting card on the table and the rarest.
 */
export const PROFILES = ['combo', 'printer', 'early', 'specialist', 'scalper', 'weak', 'mid', 'elite'];
export function profileOf(trust) {
  if (!trust) return 'elite';
  const tags = [trust.specialist, trust.early, trust.printer, trust.scalper].filter(Boolean).length;
  if (tags >= 2) return 'combo';
  if (trust.printer) return 'printer';
  if (trust.early) return 'early';
  if (trust.specialist) return 'specialist';
  if (trust.scalper) return 'scalper';
  const g = trust.grade;
  if (g === 'C' || g === 'D' || g === 'F') return 'weak';
  if (g === 'B') return 'mid';
  return 'elite';
}
/** The same call, made from a wallet address alone, before anything has been paid for. */
export function profileOfAddress(addr) {
  const c = tclass.classOf(addr);
  if (!c) return null;                       // never scored: no opinion, do not pretend to have one
  // No grade either (classified by the floor's own warm pass, which never pays for a wallet summary)
  // and no tags: still no opinion. Defaulting to 'elite' here quietly labelled 84 of 103 wallets as
  // elite whales purely for being unscored, which filled the floor with a profile nobody had earned.
  // Same freshness rule the tag itself uses, so the floor and the deck steer on the tag a card will
  // actually show rather than on a stale one.
  const earlyNow = !!c.early && tclass.findIsFresh(c);
  const tagged = earlyNow || c.printer || c.scalper === true;
  if (!c.grade && !tagged) return null;
  return profileOf({ specialist: false, early: earlyNow, printer: c.printer, scalper: c.scalper === true, grade: c.grade });
}
/** A profile worth deliberately making room for: anything other than the common, untagged case. */
const isRareProfile = (pr) => !!pr && pr !== 'elite' && pr !== 'mid';
/** A hand already in the deck: its record is built, so the real grade is available. */
const handProfile = (h) => profileOf(trustGrade(recordOf(h.ctx?.wallet), null, h.t.token_symbol, h.t.trader_address));

export function refillDeck() {
  if (refilling) return refilling;
  // pool() costs 10 Nansen credits (two pages of smart-money/perp-trades at 5 each) and this runs on a
  // five-minute timer whether or not anything needs building. With a full deck that is ~900 credits a
  // day — about half the daily spend — paid purely to confirm a full deck is still full. Skip the
  // fetch when the deck is already complete and nothing in it has aged out; hands expire after 6h and
  // newRound() still refills on demand when the deck runs low, so it can never starve the table.
  if (deck.length >= DECK_SIZE && deck.every((h) => Date.now() - h.at < 6 * 3600e3)) return Promise.resolve();
  refilling = (async () => {
    const list = await pool();
    deck = deck.filter((h) => Date.now() - h.at < 6 * 3600e3 && list.some((t) => tradeKey(t) === tradeKey(h.t)));
    const inDeck = new Set(deck.map((h) => tradeKey(h.t)));
    let shuffled = list.filter((t) => !inDeck.has(tradeKey(t))).sort(() => Math.random() - 0.5);
    // One prolific wallet can open twenty trades in a week and swamp the deck, which then forces
    // repeats on every player however well newRound shuffles. Fill in two passes: first take at most
    // two hands per wallet, then, only if the deck is still short, allow the rest. A thin week fills
    // the deck exactly as before; a normal week fills it with many different whales.
    const addrOf = (t) => String(t.trader_address || '').toLowerCase();
    const perWhale = new Map();
    for (const h of deck) perWhale.set(addrOf(h.t), (perWhale.get(addrOf(h.t)) || 0) + 1);
    // Which kinds of whale the deck is still missing. Rare profiles come first so they are built
    // while there is still room: left to a shuffle, a deck of 16 drawn from a pool that is mostly
    // ungraded A+ whales will contain nothing else, and no dealing order can conjure variety that
    // was never put in. profileOfAddress costs nothing — it reads the map the roster wrote.
    const have = new Set(deck.map(handProfile));
    // Take ONE candidate for each kind the deck is missing, then carry on with the ordinary shuffle.
    // Sorting the whole list by rarity instead was an over-correction: it front-loaded the deck with
    // combos and printers and ran out of room before reaching plain A-grade whales, which are the
    // most common real case and the one a player must absolutely see. Coverage first, then nature.
    const firstOfKind = [];
    const claimed = new Set();
    for (const kind of PROFILES) {
      if (have.has(kind)) continue;
      const hit = shuffled.find((t) => !claimed.has(t) && profileOfAddress(t.trader_address) === kind);
      if (hit) { firstOfKind.push(hit); claimed.add(hit); }
    }
    shuffled = [...firstOfKind, ...shuffled.filter((t) => !claimed.has(t))];
    let tried = 0;
    for (const cap of [2, Infinity]) {
      for (const t of shuffled) {
        if (deck.length >= DECK_SIZE || tried >= DECK_SIZE * 3) break;
        const addr = addrOf(t);
        if ((perWhale.get(addr) || 0) >= cap) continue;
        if (inDeck.has(tradeKey(t))) continue;          // added on the first pass
        tried++;
        const out = await resolveOutcome(t).catch(() => null);
        if (!out || tooQuick(out)) continue;
        if (excluded.isExcluded(t.trader_address)) continue; // an objection may have landed while we resolved
        const { ctx, f } = await enrich(t);
        deck.push({ t, out, ctx, f, at: Date.now() });
        botsPlay(t, out, f);
        inDeck.add(tradeKey(t));
        perWhale.set(addr, (perWhale.get(addr) || 0) + 1);
      }
      if (deck.length >= DECK_SIZE || tried >= DECK_SIZE * 3) break;
    }
  })().finally(() => { refilling = null; });
  return refilling;
}

/**
 * A teaser of the hand waiting in the deck, for the front door: coin, side and size only.
 * No entry price, no date, no outcome — nothing that identifies the trade well enough to look its
 * result up before betting. It is the hand the visitor is about to be dealt, not an invented example.
 */
/** Everything the table shows before a bet. Never contains the outcome. */
function roundPub(round) {
  const { id, trade: t, ctx, f, pFollow } = round;
  return {
    roundId: id, coin: t.token_symbol, side: t.side === 'Short' ? 'Short' : 'Long', valueUsd: t.value_usd, orderType: t.type,
    entryPrice: t.price_usd, openedDay: String(t.block_timestamp).slice(0, 10), maxHoldHours: MAX_HOLD() / 3600e3, minHoldMinutes: MIN_HOLD() / 60e3,
    pFollow, odds: oddsEngine.odds(pFollow), reasons: oddsEngine.reasons(f, ctx),
    grade: trustGrade(recordOf(ctx.wallet), null, t.token_symbol, t.trader_address),
    intel: {
      walletWinRate: ctx.wallet?.win_rate ?? null, walletClosedTrades: ctx.wallet?.closed_trade_count ?? null,
      walletPnl30d: ctx.wallet?.realized_pnl_usd ?? null,
      smFlow24h: ctx.sm ? (ctx.sm.smart_money_buy_volume != null ? ctx.sm.smart_money_buy_volume - ctx.sm.smart_money_sell_volume : ctx.sm.buy_sell_pressure ?? null) : null, crowdFlow24h: ctx.crowd?.buy_sell_pressure ?? null,
      funding: ctx.crowd?.funding ?? null, openInterest: ctx.crowd?.open_interest ?? null,
    },
  };
}

// ------------------------------------------------------------------ challenges
// "I faded this whale. Would you?" — a link that deals a friend the EXACT hand you played.
// The challenge never carries the outcome: the friend has to make the call to find out,
// which is the whole point. Held in memory only; a stale link just deals a normal hand.
const challenges = new Map(); // id -> { t, trade, ctx, f, by, choice, at }
const results = new Map();    // id -> a played-back challenge, so the sender hears how it went
function makeChallenge(r, playerName, choice) {
  const id = crypto.randomUUID().slice(0, 8);
  // The price path is the biggest field by far (a 48h hand is ~600 points) and the reveal chart only
  // needs its shape, so keep at most 150 evenly spaced points rather than a full copy per challenge.
  const o = r.out || {};
  const step = Math.ceil((o.path?.length || 0) / 150) || 1;
  const out = { ...o, path: o.path ? o.path.filter((_, i) => i % step === 0 || i === o.path.length - 1) : o.path };
  challenges.set(id, { trade: r.trade, ctx: r.ctx, f: r.f, pFollow: r.pFollow, out, byPlayerId: r.playerId, by: playerName, choice, at: Date.now() });
  for (const [k, v] of challenges) { // insertion order is oldest first
    if (Date.now() - v.at > 7 * DAY || challenges.size > 300) challenges.delete(k); else break;
  }
  return id;
}
/** A finished challenge, ready to send back to whoever set it. */
function makeResult(r, responderName, responderChoice, result, delta) {
  const id = crypto.randomUUID().slice(0, 8);
  const cb = r.challenge; // { by, choice }
  results.set(id, { at: Date.now(),
    coin: r.trade.token_symbol, side: r.trade.side === 'Short' ? 'Short' : 'Long',
    valueUsd: Number(r.trade.value_usd) || null,
    by: cb.by, byChoice: cb.choice,                 // who sent the challenge, and how they called it
    responder: responderName, responderChoice, result, delta,
    whaleRet: r.out?.ret ?? null, followWon: r.out ? r.out.ret > 0 : null });
  for (const [k, v] of results) { if (Date.now() - v.at > 7 * DAY || results.size > 500) results.delete(k); else break; }
  return id;
}

/** What the original challenger sees when they open the reply link. */
export function resultView(id) {
  const x = results.get(String(id || ''));
  if (!x) return null;
  const same = x.byChoice === x.responderChoice;
  const responderWon = x.result === 'push' ? null : x.result === 'win';
  return { coin: x.coin, side: x.side, valueUsd: x.valueUsd, by: x.by, byChoice: x.byChoice,
    responder: x.responder, responderChoice: x.responderChoice, result: x.result,
    whaleRet: x.whaleRet, followWon: x.followWon, same,
    // Whoever sent it sees their OWN outcome, worked out from the whale's real exit.
    senderWon: responderWon === null ? null : (same ? responderWon : !responderWon) };
}

/** Public teaser for a challenge link: the whale and the caller, never the result. */
export function challengeView(id) {
  const c = challenges.get(String(id || ''));
  if (!c) return null;
  if (excluded.isExcluded(c.trade.trader_address)) return null;
  return { coin: c.trade.token_symbol, side: c.trade.side === 'Short' ? 'Short' : 'Long',
    valueUsd: Number(c.trade.value_usd) || null, openedDay: String(c.trade.block_timestamp || '').slice(0, 10) || null,
    by: c.by, choice: c.choice };
}

export function peekHand() {
  const h = deck.find((x) => x.t && x.t.token_symbol);
  if (!h) return null;
  const t = h.t;
  // openedAt is already shown on the table before any bet, so it gives nothing away — and it stops
  // the front door implying a replay hand is happening right now.
  // Day only, never the exact timestamp: coin + side + size + a second-precision time would let someone
  // find the fill on Hyperliquid and read the outcome before betting. `demo` is withheld for the same reason.
  return { coin: t.token_symbol, side: t.side === 'Short' ? 'Short' : 'Long', valueUsd: Number(t.value_usd) || null,
    openedDay: String(t.block_timestamp || '').slice(0, 10) || null };
}

// The deck holds DECK_SIZE hands. They deal instantly, but once a player has SEEN all of them every
// further hand is built while they wait - resolveOutcome (Hyperliquid fills) plus enrich (Nansen) on
// the request path. Measured on the live site that is a hard cliff: hands 1-26 came back in ~0.25s,
// hand 27 onwards in 1.0-2.0s, and it never recovered. That is the stall people hit in a long session.
//
// So build the next one while they are reading the current one. This costs no extra credits - the hand
// was going to be built the moment they clicked anyway - it just moves off the critical path. The hand
// goes into the shared deck, so other players benefit from it too.
/**
 * The house bots play the same hand the table just built, priced by the same odds and settled by the
 * same real exit. Called as a hand is created rather than when it is dealt, so they play the whole
 * deck; bots.play() ignores a trade key it has already seen, so a hand cannot count twice.
 */
function botsPlay(t, out, f) {
  try {
    const pFollow = oddsEngine.probability(f);
    const push = Math.abs(out.ret) < PUSH_BAND();
    bots.play({ key: tradeKey(t), pFollow, odds: oddsEngine.odds(pFollow), followWon: out.ret > 0, push });
    // The same number, written down where it can be checked later. bots.play() already refuses a
    // trade key it has seen, and proof.record() is keyed the same way, so a hand cannot be counted
    // twice in either place.
    proof.record({ key: tradeKey(t), coin: t.token_symbol, side: t.side, address: t.trader_address,
      pFollow, followWon: out.ret > 0, push });
  } catch { /* a bot is a scoreboard, never a reason a hand fails to deal */ }
}

const preparing = new Set();
const PREFETCH_TARGET = Number(process.env.PREFETCH_TARGET || 3); // usable hands to keep ready per player
const PREFETCH_BATCH = Number(process.env.PREFETCH_BATCH || 3);  // most to build in one background pass
function queueNextHand(playerId) {
  if (preparing.has(playerId) || preparing.size >= 8) return; // bounded: never let prefetch become the load
  const p = P(playerId);
  if (!p) return;
  // Keep a small buffer, not just one. Building a single hand per deal cannot stay ahead: the player
  // consumes one per click and each build takes 1-2s, so the queue never catches up. Measured with a
  // forced 8-card deck, one-at-a-time left 9 of 24 hands slow; a buffer of three closes it.
  const ready = () => deck.filter((h) => !seenHand(p, tradeKey(h.t)) && !whaleCooling(p, h.t.trader_address)).length;
  if (ready() >= PREFETCH_TARGET) return;
  preparing.add(playerId);
  (async () => {
    const list = await pool();   // cached 15 min, so this is free between refreshes
    for (let built = 0; built < PREFETCH_BATCH && ready() < PREFETCH_TARGET; ) {
      const usable = list.filter((t) => !seenHand(p, tradeKey(t)) && !whaleCooling(p, t.trader_address)
        && !deck.some((h) => tradeKey(h.t) === tradeKey(t)));
      if (!usable.length) return;
      const t = usable[Math.floor(Math.random() * usable.length)];
      const out = await resolveOutcome(t);
      if (!out || tooQuick(out)) { list.splice(list.indexOf(t), 1); continue; }
      const { ctx, f } = await enrich(t);
      // The deck ceiling used to skip the push AND the counter, so once the deck was full this loop
      // could never finish: built stayed 0, ready() could not rise, and usable stayed non-empty.
      // Stop instead, and always count the pass.
      if (deck.length >= DECK_SIZE * 3) return;
      if (!deck.some((h) => tradeKey(h.t) === tradeKey(t))) deck.push({ t, out, ctx, f, at: Date.now() });
      botsPlay(t, out, f);
      built++;
    }
  })().catch(() => {}).finally(() => preparing.delete(playerId));
}

export async function newRound(playerId, challengeId = null) {
  const p = P(playerId);
  if (!p) throw Object.assign(new Error('Unknown player'), { status: 404 });
  // A challenge link deals that exact hand, even if this player has met it before: they were sent it.
  let ch = challengeId ? challenges.get(String(challengeId)) : null;
  // A challenge is for someone who has NOT seen this hand. Playing your own link back would hand you
  // the outcome first and the bet second, which is an unlimited money printer. Fall through to a
  // normal deal instead.
  if (ch && (ch.byPlayerId === playerId || seenHand(p, tradeKey(ch.trade)))) ch = null;
  // One link, one play. Scoping the guard above to a single player id was not enough: player ids are
  // free, so the sender could bet once (which shows them the outcome), then play their own link back
  // from a fresh identity. Reproduced: 10,000 -> 149,416 in three hands, top of the board.
  if (ch && ch.claimedBy && ch.claimedBy !== playerId) ch = null;
  if (ch) {
    const prevId = pendingRound.get(playerId);
    if (prevId) { const prev = rounds.get(prevId); if (prev) clearTimeout(prev.timer); rounds.delete(prevId); }
    const id = crypto.randomUUID();
    const round = { id, playerId, trade: ch.trade, ctx: ch.ctx, f: ch.f, pFollow: ch.pFollow, out: ch.out, createdAt: Date.now(),
      challenge: { by: ch.by, choice: ch.choice } };
    rounds.set(id, round);
    pendingRound.set(playerId, id);
    ch.claimedBy = playerId;   // burn the link: whoever opens it first is the one who plays it
    markHand(p, tradeKey(ch.trade));
    markWhale(p, ch.trade.trader_address);
    round.timer = setTimeout(() => { rounds.delete(id); if (pendingRound.get(playerId) === id) pendingRound.delete(playerId); }, 30 * 60e3);
    return (round.pub = { ...roundPub(round), challenge: { by: ch.by, choice: ch.choice } });
  }
  // Refreshing the page gives back the same unplayed hand instead of dealing (and paying for) a new one
  const pendingId = pendingRound.get(playerId);
  const pending = pendingId && rounds.get(pendingId);
  if (pending && pending.pub && Date.now() - pending.createdAt < 25 * 60e3) return pending.pub;
  // Instant deal from the pre-built deck when possible; otherwise build a hand on the spot.
  const readyAll = deck.filter((h) => !seenHand(p, tradeKey(h.t)));
  // Take the instant (free) deck hand ONLY if it can honour the full whale cooldown. The deck holds
  // ~16 hands, so after a run of play everything left in it tends to be a whale just seen — that is
  // what produced the same wallet three times in five hands. When the deck cannot do it, fall through
  // to the week's pool, which carries far more whales. That costs a few Nansen credits for the
  // enrichment, and only on the hands where the deck would otherwise repeat itself.
  const strict = readyAll.filter((h) => !whaleCooling(p, h.t.trader_address));
  // Among the hands that are legal to deal, prefer one showing a kind of whale this player has not
  // met. That is what gets every profile in front of them inside a short session instead of leaving
  // it to chance — with eight buckets and a random draw, meeting all of them takes far longer than
  // anyone plays for. Falls straight back to the full set when they have seen everything the deck
  // holds, so it can never refuse to deal.
  const met = seenProfiles(p);
  const fresh = strict.filter((h) => !met.includes(handProfile(h)));
  const pickFrom = fresh.length ? fresh : strict;
  const quick = pickFrom.length ? pickFrom[Math.floor(Math.random() * pickFrom.length)] : null;
  if (deck.length < DECK_SIZE / 2) refillDeck().catch(() => {});
  const list = quick ? [quick.t] : await pool();
  if (!list.length) throw new Error('No Smart Money trades available right now');
  const unseen = list.filter((t) => !seenHand(p, tradeKey(t)));
  if (!unseen.length) throw new Error('You have played every hand in this week\u2019s deck. New Smart Money trades arrive every few minutes.');
  const candidates = avoidRepeats(p, unseen, (t) => t.trader_address);
  // Try a few random trades until one has a resolvable outcome.
  for (let i = 0; i < 10; i++) {
    const t = quick && i === 0 ? quick.t : candidates[Math.floor(Math.random() * candidates.length)];
    const out = quick && i === 0 ? quick.out : await resolveOutcome(t);
    if (!out || tooQuick(out)) continue;
    const { ctx, f } = quick && i === 0 ? quick : await enrich(t);
    const pFollow = oddsEngine.probability(f);
    botsPlay(t, out, f);
    if (!nansen.isCapped() && !t._demo) recordSample(tradeKey(t), f, out.ret, out.heldMs);
    if (!(quick && i === 0) && deck.length < DECK_SIZE * 2 && !deck.some((h) => tradeKey(h.t) === tradeKey(t))) deck.push({ t, out, ctx, f, at: Date.now() });
    const id = crypto.randomUUID();
    const round = { id, playerId, trade: t, ctx, f, pFollow, out, createdAt: Date.now() };
    rounds.set(id, round);
    const prev = pendingRound.get(playerId);
    if (prev && prev !== id) { const r0 = rounds.get(prev); if (r0) clearTimeout(r0.timer); rounds.delete(prev); }
    pendingRound.set(playerId, id);
    markHand(p, tradeKey(t)); // as soon as it is dealt: the reveal is one click away, so it must never come back
    markWhale(p, t.trader_address);
    markProfile(p, profileOf(trustGrade(recordOf(ctx.wallet), null, t.token_symbol, t.trader_address)));
    round.timer = setTimeout(() => { rounds.delete(id); if (pendingRound.get(playerId) === id) pendingRound.delete(playerId); }, 30 * 60e3);
    queueNextHand(playerId); // hide the next build behind the time they spend on this card
    return round.pub = roundPub(round);
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

  // A hand dealt from someone else's link is played with the outcome already known to its sender, so
  // it stays off every ranked stat: net profit, win count, streaks and whales slain. It still counts
  // as a hand played, so farming links lowers a win rate rather than raising it.
  const fromChallenge = !!r.challenge;
  p.bankroll += delta; p.bets++; if (push) p.pushes = (p.pushes || 0) + 1;
  if (fromChallenge) { p.challengeNet = (p.challengeNet || 0) + delta; }
  else {
    if (won) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else if (!push) p.streak = 0;
    if (slain) p.whalesSlain++;
  }
  p.peak = Math.max(p.peak, p.bankroll);
  // One reload rule for the whole game: never while live chips are still on the table,
  // or a player could bet the bankroll live, go "broke" on a $1 replay hand and be handed 10,000 back.
  const busted = maybeBust(p);
  const grade = trustGrade(recordOf(r.ctx.wallet), null, r.trade.token_symbol, r.trade.trader_address).grade;
  p.history.push({ t: Date.now(), coin: r.trade.token_symbol, side: r.trade.side, choice, stake, price, delta, ret: r.out.ret, bankroll: p.bankroll, ...coach.snapshot(r.f, r.pFollow, choice, grade, trustGrade(recordOf(r.ctx?.wallet), null, r.trade.token_symbol, r.trade.trader_address)) });
  if (p.history.length > 300) p.history.shift();
  const lessonOut = coach.lesson({ f: r.f, pFollow: r.pFollow, choice, followWon, push, samples: realSamples() });
  save('players', players);

  const challenge = makeChallenge(r, p.name, choice); // a link a friend can play: same whale, outcome hidden
  // If this hand came from a friend's link, mint a reply link so the result can go straight back to
  // them instead of being screenshotted.
  const resultId = r.challenge ? makeResult(r, p.name, choice, push ? 'push' : won ? 'win' : 'loss', delta) : null;
  return {
    resultId,
    result: push ? 'push' : won ? 'win' : 'loss', pushBand: PUSH_BAND(), delta, price, stake, busted, underdog, whaleSlain: slain,
    challenge, challengedBy: r.challenge || null,
    player: publicPlayer(p),
    reveal: {
      trader: r.trade.trader_address_label || 'Unlabeled Smart Money wallet',
      address: r.trade.trader_address,
      nansenUrl: `https://app.nansen.ai/profiler?address=${encodeURIComponent(r.trade.trader_address)}&chain=hyperliquid`,
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
export async function calibrate(limit = numEnv('CALIBRATION_SAMPLE', 240, 1)) {
  const list = await pool();
  if (realSamples().length < 60 && !process.env.CALIBRATION_SAMPLE) limit = Math.max(limit, 150); // first run: build a solid base
  // Each sample costs a 1.2s courtesy pause plus a handful of cached Nansen lookups, so a big batch
  // is minutes of background work, not credits burned - and isCapped() below stops the loop dead
  // before the daily budget could ever starve the live table.
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
  // Age samples out, then refit. This is measured from when the sample was RECORDED, not when the
  // whale traded, so a widened lookback does not arrive pre-expired. It has to outlast the lookback
  // or the pool collapses in one step the day the backfill ages out; 14 days clears 336h with room.
  const keepMs = numEnv('SAMPLE_RETENTION_DAYS', 14, 1) * DAY;
  for (const [k, s] of Object.entries(samples)) if (Date.now() - s.at > keepMs) delete samples[k];
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

/**
 * The resolved training pool, for the proof desk to cross-validate. Read-only copies.
 *
 * The wallet comes back out of the sample key rather than being stored twice. The key is
 * `hash:address:symbol:timestamp` and only the first two fields are read, which matters because a
 * stock perp symbol contains a colon of its own (xyz:NBIS) and would break a naive split.
 */
export const resolvedSamples = () => Object.entries(samples).filter(([, x]) => !x.skip)
  .map(([k, x]) => ({ f: x.f, win: x.win, at: x.at, address: (k.split(':')[1] || '').toLowerCase() }));

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
export const SCALPER_PER_DAY = numEnv('SCALPER_TRADES_PER_DAY', 20, 1);
/** Works the tape rather than holding: 20+ closed trades a day, averaged over the 30-day window. */
/**
 * A scalper is a trader who does not hold, so the test is holding time — taken from real round trips
 * in traderclass, not from Nansen's closed_trade_count. That field counts every closing FILL, so a
 * trader scaling out of one position in sixty clips looked like sixty trades: it tagged 85 wallets,
 * 57 of which actually held longer than 12 hours. Unknown (never classified, or too few closed round
 * trips) returns false — no tag is better than a wrong one, and the floor warms classifications in
 * the background so unknown does not last long.
 */
const isScalper = (addr) => tclass.classOf(addr)?.scalper === true;
export // The quality half of the proven-early route. Deliberately demanding: it is what stands in for the
// sample size the pattern route gets from repetition.
const PROVEN_MIN_SCORE  = numEnv('EARLY_PROVEN_MIN_SCORE', 75, 0);
const PROVEN_MIN_ROI    = numEnv('EARLY_PROVEN_MIN_ROI', 0.05, 0);
const PROVEN_MIN_WIN    = numEnv('EARLY_PROVEN_MIN_WIN', 0.65, 0);
const PROVEN_MIN_CLOSED = numEnv('EARLY_PROVEN_MIN_CLOSED', 50, 0);
const SPECIALIST = { minShare: 0.4, minPnlUsd: 25000, minRoi: 0.03 };
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
/**
 * `addr` is optional and only carries the EARLY / PRINTER tags through. Neither one moves the score:
 * they describe a KIND of edge the grade cannot see (getting in before a move, or being too small to
 * clear the whale floor), so letting them nudge a number built from win rate and return would double
 * count the same record.
 */
function trustGrade(d30, d7, coin, addr) {
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
  // Keep it. The wallet summary behind this grade has already been paid for to build the card, so
  // storing the result costs nothing and is what lets the deck and the floor spread across grade
  // bands instead of only across tags.
  if (addr) tclass.noteGrade(addr, grade, score);
  const label = specialist ? `${String(coin).replace(/^\w+:/, '')} specialist` : { 'A+': 'Elite. Trust the whale', A: 'Strong hands', B: 'Solid', C: 'Coin flip', D: 'Shaky', F: 'Fade material' }[grade];
  const cls = addr ? tclass.classOf(addr) : null;
  // Second route into EARLY: one or two early calls, all converted, on top of a record good enough
  // that the small sample stops being the interesting thing about them. Measured on the 143-wallet
  // study, this admits 14 wallets — every one of them A+, returning 5-47% over 30 days — and still
  // turns away two excellent traders who were in front of nine and twelve big moves and held two.
  // Being a great trader is not the same as being early, so both halves have to be true.
  const provenEarly = !!cls?.earlyFew && score >= PROVEN_MIN_SCORE && (d30.roi ?? 0) >= PROVEN_MIN_ROI
    && (d30.winRate ?? 0) >= PROVEN_MIN_WIN && (d30.closed || 0) >= PROVEN_MIN_CLOSED;
  // Both routes have to be CURRENT. The tag waives the grade, return, losing-week and size rules, so
  // it may not rest on a pattern that stopped: see FIND_MAX_AGE_H in traderclass.js.
  const early = (!!cls?.early || provenEarly) && tclass.findIsFresh(cls);
  return { grade, score, label, specialist, scalper: isScalper(addr),
    // The number the SCALPER tag should actually quote: how long they hold. `tradesPerDay` is kept
    // because other screens show it, but it is Nansen's fill count and must never be read as a pace.
    holdHours: cls?.medHoldH ?? null, shareUnder1h: cls?.shareUnder1h ?? null,
    tradesPerDay: d30.closed ? +(d30.closed / 30).toFixed(1) : null,
    early, printer: !!cls?.printer,
    earlyStats: early ? { goodFinds: cls.goodFinds, finds: cls.finds, capture: cls.medCapture, coins: cls.goodCoins, days: cls.goodDays, best: cls.bestFind,
      via: cls.early ? 'pattern' : 'proven', lastFind: cls.lastGoodFind ?? null, roi: d30.roi ?? null, winRate: d30.winRate ?? null } : null,
    printerStats: cls?.printer ? { medNotional: cls.medNotional, winRate: cls.winRate, medRet: cls.medRet, closed: cls.closed } : null };
}

/** Everything the Live Floor needs to show and price one Smart Money trade. */
export async function buildLiveItem(t) {
  // A trade with no usable entry price can't be priced or scored: NaN would flow into the odds and
  // then into the stake checks, so it never reaches the floor.
  if (!(Number(t?.price_usd) > 0) || !t.trader_address || !t.token_symbol) return null;
  if (excluded.isExcluded(t.trader_address)) return null; // right to object, honoured on every path
  const now = Date.now();
  const hour = ctxBucket(now);
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
    // Ride the Whale is the only wager on the floor, so there is one price. The key is kept so a card
    // cached from before the change still reads correctly.
    oddsByHz: { ride: oddsEngine.oddsFor(pFollow, 'ride') },
    reasons: [oddsEngine.lateReason(moveSinceEntry, t.side), oddsEngine.posReason(positioning, t.token_symbol, t.side), ...oddsEngine.reasons(f, ctx)]
      .filter(Boolean).slice(0, 4).map(({ good, text }) => ({ good, text })), positioning,
    record: { d7: recordOf(wallet7), d30: recordOf(wallet), trust: trustGrade(recordOf(wallet), recordOf(wallet7), t.token_symbol, t.trader_address) },
  };
  Object.defineProperty(item, 'f', { value: f, enumerable: false });
  Object.defineProperty(item, 'late', { value: { late, pos, pBase }, enumerable: false });
  liveIndex.set(item.key, { t: Date.now(), item });
  rawIndex.set(item.key, t);
  return item;
}
export { recordOf, trustGrade, tradeKey, isSpecialist, isScalper };
const rawIndex = new Map();
export const getRaw = (key) => rawIndex.get(key);

/** Re-price one whale card on demand (price, odds, tells, and whether they are still in the trade). */
export async function refreshLiveItem(key, fallbackTrade = null) {
  const t = rawIndex.get(String(key)) || (fallbackTrade && tradeKey(fallbackTrade) === String(key) ? fallbackTrade : null);
  if (!t) throw Object.assign(new Error('That trade is no longer on the floor. Refresh the floor and pick another.'), { status: 410 });
  if (excluded.isExcluded(t.trader_address)) {
    throw Object.assign(new Error('This trader asked not to be shown in the game. Pick another whale.'), { status: 410 });
  }
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
const LIVE_HOURS = Number(process.env.LIVE_LOOKBACK_HOURS || 96);
const FLOOR_SLOTS = Number(process.env.LIVE_FLOOR_SLOTS || 8);
const FLOOR_PER_COIN = Number(process.env.LIVE_FLOOR_PER_COIN || 2);
/**
 * Pick the cards, spreading them across wallets and coins instead of taking the eight biggest.
 *
 * Ranking purely by size fills the floor with whoever trades most: a wallet that opens twenty
 * positions in six hours has twenty chances to be in the top eight, and a wallet that opens one has
 * one. Once scalpers were allowed back in, that arithmetic handed them the whole floor — every card
 * the same handful of very busy wallets.
 *
 * So: one card per wallet, at most two per coin, and no more than half the floor from wallets that
 * are clearly working the tape (three or more opens in this six-hour window). Busy-ness is counted
 * from the feed itself rather than from a whale's record, because that costs nothing and measures the
 * exact thing causing the crowding. Order is shuffled on a five-minute seed so the floor rotates
 * between visits without reshuffling under a player who is still reading it.
 */
/** Known, on either measure, NOT to be a wallet that would crowd the floor. Unknown is not slow. */
const isSlowWallet = (cls) => cls?.fast === false;

function pickFloor(stillIn, opensByWallet = new Map(), slots = FLOOR_SLOTS) {
  // Deterministic shuffle: same order for everyone for five minutes, a different one after that.
  const seed = Math.floor(Date.now() / 3e5);
  const hash = (str) => { let h = seed >>> 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const pool = stillIn.slice().sort((a, b) => hash(tradeKey(a.t)) - hash(tradeKey(b.t)));
  const out = [], perCoin = new Map(), usedWallet = new Set(), shown = new Set();
  let busy = 0;
  const busyCap = Math.max(1, Math.floor(slots / 2));
  // Pass 1 seats one card per KIND of whale, so the floor shows the range rather than eight of
  // whatever is most common; pass 2 fills whatever is left over without the restriction.
  let onePerProfile = true;
  const take = (x) => {
    const w = x.t.trader_address, c = x.t.token_symbol;
    if (usedWallet.has(w)) return false;
    if ((perCoin.get(c) || 0) >= FLOOR_PER_COIN) return false;
    const pr = profileOfAddress(w);
    // Pass 1 is for whales we can actually name a kind for, one seat each. An unscored wallet has no
    // kind, so letting it in here would spend the spread pass on exactly the cards it exists to
    // dilute; it gets its seat in pass 2 like everyone else.
    if (onePerProfile && (!pr || shown.has(pr))) return false;
    if (pr) shown.add(pr);
    // Two ways to spot a wallet that would otherwise crowd the floor: what the classifier already
    // measured over 30 days (free lookup, exact), or failing that, how many times they have opened
    // inside this window (free, and a fair proxy for a wallet we have never scored).
    const cls = tclass.classOf(w);
    // Crowding, NOT hold length — a wallet can open constantly and still hold each position for days,
    // and it is the opening frequency that takes every card. `scalper` deliberately does not appear
    // here: it answers a different question and using it would cap the wrong wallets.
    const isBusy = cls?.fast != null ? cls.fast
      : cls?.pace != null ? cls.pace >= SCALPER_PER_DAY
      // Never scored yet. Falling back to how often they appear in this window is weak — measured, it
      // catches 29 of 69 fast wallets — so it is a stopgap for the first minutes after a deploy while
      // warmClassifications() fills the map in, not the mechanism this relies on.
      : (opensByWallet.get(w) || 0) >= 3;
    if (isBusy && busy >= busyCap) return false;
    usedWallet.add(w); perCoin.set(c, (perCoin.get(c) || 0) + 1); if (isBusy) busy++;
    out.push(x);
    return true;
  };
  for (const x of pool) { if (out.length >= slots) break; take(x); }
  onePerProfile = false;
  for (const x of pool) { if (out.length >= slots) break; take(x); }
  // A quiet window may not fill the floor under the caps. Better a full floor than an empty one:
  // relax the busy cap first, then the per-coin cap, but never the one-card-per-wallet rule.
  if (out.length < slots) for (const x of pool) {
    if (out.length >= slots) break;
    if (usedWallet.has(x.t.trader_address)) continue;
    if ((perCoin.get(x.t.token_symbol) || 0) >= FLOOR_PER_COIN) continue;
    usedWallet.add(x.t.trader_address); perCoin.set(x.t.token_symbol, (perCoin.get(x.t.token_symbol) || 0) + 1); out.push(x);
  }
  if (out.length < slots) for (const x of pool) {
    if (out.length >= slots) break;
    if (usedWallet.has(x.t.trader_address)) continue;
    usedWallet.add(x.t.trader_address); out.push(x);
  }
  return out;
}

async function buildFeed() {
  // 96 hours, not 6. The floor is meant to show whales who are IN a position right now, and a six-hour
  // window silently answered a different question: who OPENED one recently. Those are the same thing
  // for a wallet that closes 300 times a day and completely different for one that holds for two days,
  // so the short window was quietly excluding every patient trader on the platform — measured holds
  // are p50 18h, p90 174h. holding() already drops anyone who has closed, so nothing stale gets in.
  // The feed costs the same 5 credits at any lookback (and caches for 15 minutes above 2h).
  // Measured: at 48h only 5 slower whales were still holding, against 19 at 96h — not enough to fill
  // half a floor, which is why the diversity cap kept having to give up and seat scalpers anyway.
  const trades = excluded.allow(await nansen.smartMoneyOpens({ lookbackHours: LIVE_HOURS, pages: 1, perPage: 300, minValueUsd: 10000 }));
  const pinned = excluded.allow(extraLive()); // raw trades from recent whale alerts, shown first
  const seen = new Set();
  // A wider candidate pool than the floor needs, because the diversity rules below can only spread
  // cards across wallets if there are wallets to spread across. Widening costs Hyperliquid calls
  // (free) rather than Nansen credits: only the cards that survive are ever priced.
  // One entry per WALLET before the slice, not one per wallet+coin. Slicing a size-ranked list that
  // still holds twenty rows from the same busy wallet spends the whole candidate pool on a handful of
  // traders, and no amount of diversity logic downstream can recover what never made the list.
  const byWallet = [...pinned, ...trades.sort((a, b) => b.value_usd - a.value_usd)]
    .filter((t) => { const k = t.trader_address; if (seen.has(k)) return false; seen.add(k); return true; });
  // Taking the biggest 36 was itself a filter against slower traders: they trade less and often
  // smaller, so a size-ranked cut removed them before any diversity rule could see them. Reserve part
  // of the pool for wallets we know are NOT fast, then fill the rest by size.
  const pinnedSet = new Set(pinned.map((t) => t.trader_address));
  // Reserve pool room for the whales worth showing, before size decides anything. Rare profiles are
  // rare by definition — measured in one 96h window: 6 early, 2 scalpers, 2 combos and 1 printer
  // against 84 untagged — so a size-ranked cut removes them all and no spreading rule downstream can
  // seat what never reached the pool. The same trap that hid slower traders.
  const rare = byWallet.filter((t) => !pinnedSet.has(t.trader_address) && isRareProfile(profileOfAddress(t.trader_address))).slice(0, 14);
  const taken = new Set(rare.map((t) => t.trader_address));
  const slower = byWallet.filter((t) => !pinnedSet.has(t.trader_address) && !taken.has(t.trader_address)
    && isSlowWallet(tclass.classOf(t.trader_address))).slice(0, 12);
  for (const t of slower) taken.add(t.trader_address);
  const candidates = [...pinned, ...rare, ...slower,
    ...byWallet.filter((t) => !pinnedSet.has(t.trader_address) && !taken.has(t.trader_address)).slice(0, 24)];
  // only whales still holding the position make it to the floor
  const status = await Promise.all(candidates.map((t) => holding(t)));
  const pinnedKeys = new Set(pinned.map(tradeKey));
  const stillIn = candidates.map((t, i) => ({ t, h: status[i] })).filter((x) => x.h.open);
  // Counted from the RAW feed, not from the de-duplicated candidate list: that list holds one row per
  // wallet, so counting it gave every wallet exactly 1 and the "is this wallet busy" test could never
  // be true. The whole diversity cap was dead code on any deployment without classifications.
  const opensByWallet = new Map();
  for (const t of trades) opensByWallet.set(t.trader_address, (opensByWallet.get(t.trader_address) || 0) + 1);
  const top = [...stillIn.filter((x) => pinnedKeys.has(tradeKey(x.t))),
    ...pickFloor(stillIn.filter((x) => !pinnedKeys.has(tradeKey(x.t))), opensByWallet)];
  const rows = (await Promise.all(top.map(async ({ t, h }) => {
    const item = await buildLiveItem(t).catch(() => null);
    if (item) item.trimmed = h.trimmed || 0;
    return item;
  }))).filter(Boolean);
  rows.forEach((r) => {
    if (pinnedKeys.has(r.key)) r.alert = true;
    if (agent.isStock(r.coin)) r.research = researchPreview(r.coin, r.side);
  });
  // Warm from the WHOLE feed, not just the wallets that made the candidate cut. The cut is ranked by
  // size, and slower traders tend to trade smaller — so warming only the candidates leaves exactly the
  // wallets this is meant to surface permanently unscored, and therefore permanently unreserved. A
  // chicken-and-egg that keeps the floor looking unchanged no matter how long it runs.
  if (!nansen.isDemo()) tclass.warmClassifications(trades.map((t) => t.trader_address)).catch(() => {});
  return excluded.allow(rows, (r) => r.address); // re-check: an objection may have landed mid-build
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
  const racedPick = conflictOn(playerId, r.pick.coin, pickDir); // re-check: another request may have landed while we fetched the price
  if (racedPick) { p.bankroll += stake; save('players', players); throw conflictError(racedPick, r.pick.coin); }
  const bet = { id: crypto.randomUUID(), playerId, coin: r.pick.coin, whaleSide: r.pick.side, choice, stake, price: choice === 'follow' ? odds.follow : odds.fade,
    entry, placedAt: Date.now(), settleAt: Date.now() + minutes * 60e3, minutes, pickDays: minutes / 1440, pick: true, pickDay: r.pick.day, trader: 'Nansen Agent', status: 'open' };
  liveBets.push(bet); save('livebets', liveBets); save('players', players); // bet first: a stake is never taken without one
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
  if (excluded.isExcluded(t.address)) throw Object.assign(new Error('This trader asked not to be shown in the game. Pick another whale.'), { status: 410 });
  // one direction per coin: holding both sides cancels itself out and teaches nothing
  const dir = dirOf(t.side, choice);
  const opposite = conflictOn(playerId, t.coin, dir);
  if (opposite) throw conflictError(opposite, t.coin);
  // Ride the Whale is the only lane on the floor. A fixed 15-minute or 4-hour clock measures short-term
  // price noise, not whether the whale was right, so it taught nothing about Smart Money. Forced here
  // rather than only in the UI: whatever `minutes` a request asks for, it is booked as a ride.
  const ride = true;
  minutes = 'ride';
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
  const o = oddsEngine.oddsFor(pNow, 'ride'); // the only horizon there is
  const bet = { id: crypto.randomUUID(), playerId, coin: t.coin, whaleSide: t.side, choice, stake,
    price: choice === 'follow' ? o.follow : o.fade, entry, placedAt: Date.now(),
    settleAt: Date.now() + (ride ? (demoTrade ? (20 + Math.floor(Math.random() * 70)) * 60e3 : RIDE_MAX()) : minutes * 60e3), minutes, ride, demoRide: ride && demoTrade, whale: t.address, whaleSz, trader: t.trader, status: 'open',
    whaleEntry: t.entryPrice, late: lateNow, pos: t.late?.pos ?? null, pBase: t.late?.pBase ?? null, pFollowAtBet: pNow,
    ...coach.snapshot(t.f, pNow, choice, t.record?.trust?.grade, t.record?.trust) }; // the probability actually booked, not the card's
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
    p.history.push({ t: Date.now(), coin: b.coin, side: b.whaleSide, choice: b.choice, stake: b.stake, price: b.price, delta: b.payout - b.stake, ret: whaleRet, bankroll: p.bankroll, live: true, minutes: b.minutes, pick: b.pick, sig: b.sig, pChosen: b.pChosen, modelSide: b.modelSide, grade: b.grade, heldMs: b.whaleHeldMs, late: b.late ?? null });
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
    // 2a) Cashed-out rides we are still following, to score the player's exit against the whale's.
    for (const b of liveBets) {
      if (!b.followUp || b.status !== 'cashed') continue;
      if (b.fuCheck && Date.now() - b.fuCheck < 60e3) continue;
      b.fuCheck = Date.now();
      const capMs = Math.max(0, (b.settleAt || b.placedAt + RIDE_MAX()) - b.placedAt);
      const e = await hl.whaleExit(b.whale, b.coin, b.placedAt, capMs, b.whaleSz, false).catch(() => null);
      const expired = Date.now() > (b.settleAt || b.placedAt + RIDE_MAX()) + 10 * 60e3;
      if (!e && !expired) continue;
      const exitPx = e?.closed || e?.capped ? e.exitPx : (expired ? await hl.mid(b.coin).catch(() => null) : null);
      if (exitPx == null) continue;
      // What the bet would have been worth had they sat on it until the whale was out.
      const wRet = (b.whaleSide === 'Long' ? 1 : -1) * (exitPx - b.entry) / b.entry;
      const push = Math.abs(wRet) < bandFor(b);
      const won = !push && (b.choice === 'follow' ? wRet > 0 : wRet < 0);
      const heldPayout = push ? b.stake : won ? Math.round(b.stake * b.price) : 0;
      b.followUp = false;
      b.heldOutcome = { payout: heldPayout, delta: heldPayout - b.stake, whaleRet: wRet,
        whaleClosed: !!e?.closed, heldMs: e?.heldMs ?? null, better: heldPayout > b.payout, at: Date.now() };
      // Write it onto the history row this cash-out created, so the Trader Profile can show the lesson.
      const p2 = P(b.playerId);
      const row = p2?.history?.slice().reverse().find((h) => h.live && h.cashed && h.t === b.historyAt);
      if (row) row.heldDelta = b.heldOutcome.delta;
      changed = true;
    }
    // 2b) Ride the Whale: follow the whale's fills (at most once a minute per bet)
    for (const b of liveBets) {
      if (b.status !== 'open' || !b.ride || b.demoRide) continue;
      // whaleExit reads fill history, the heaviest Hyperliquid call, and it is serialised. At a 72h cap a
      // bet can be open for three days, so back the polling off as it ages instead of hammering every
      // open bet once a minute: every minute for the first six hours, then every five.
      const age = Date.now() - b.placedAt;
      const every = age < 6 * 3600e3 ? 60e3 : 5 * 60e3;
      if (b.lastCheck && Date.now() - b.lastCheck < every && Date.now() < b.settleAt) continue;
      b.lastCheck = Date.now();
      const e = await hl.whaleExit(b.whale, b.coin, b.placedAt, b.settleAt - b.placedAt, b.whaleSz, false).catch(() => null);
      if (b.status !== 'open') continue; // cashed out while we were reading fills
      if (e) b.whaleTrims = e.exits.length;
      if (e && (e.closed || e.capped)) {
        settle(b, e.exitPx, { whaleClosed: !!e.closed, whaleHeldMs: e.heldMs }); markClosed(b.whale, b.coin);
        continue;
      }
      // The fill history did not show a close — either it is truncated (a very busy wallet) or the
      // closing fill fell outside the window we can read. Fills are NOT the authority on whether a
      // whale is still in a position; clearinghouseState is, and it is what cashOut checks. When the
      // two disagreed the player was told "the whale just exited, your bet settles in a moment",
      // cash-out was refused, and then nothing settled until the 72h cap. Ask the authority.
      if (Date.now() - b.placedAt > 10 * 60e3) {
        const sz = await hl.positionSize(b.whale, b.coin).catch(() => null);
        const flat = sz != null && (Math.abs(sz) < 1e-12 || Math.sign(sz) !== (b.whaleSide === 'Long' ? 1 : -1));
        if (flat && b.status === 'open') {
          // Price the part we watched leave at its own VWAP and the rest at the mark, as the cap does.
          const mid = await hl.mid(b.coin).catch(() => null);
          const remaining = Math.abs(e?.pos ?? 0), exitedSz = e?.exitedSz || 0, exitedVal = e?.exitedVal || 0;
          const tot = exitedSz + remaining;
          const px = tot > 0 && mid ? (exitedVal + remaining * mid) / tot : mid;
          if (px) { settle(b, px, { whaleClosed: true, whaleHeldMs: Date.now() - b.placedAt }); markClosed(b.whale, b.coin); continue; }
        }
      }
      if (!e && Date.now() > b.settleAt + 10 * 60e3) {
        // fills too busy to follow (or unavailable) past the cap: settle at the price at the cap
        const px = await bellPrice(b) ?? await hl.mid(b.coin).catch(() => null);
        if (px && b.status === 'open') settle(b, px, { whaleClosed: false, whaleHeldMs: b.settleAt - b.placedAt });
      }
    }
    if (changed) { save('players', players); save('livebets', liveBets); }
  } finally { settling = false; }
}

/** Housekeeping: settled bets older than 7 days and players who never bet (after 2 days) are dropped. */
/** `hard` is used when the player table is at capacity: drop never-played visitors sooner. */
/** Drop one trader from every in-memory cache at once, so an objection takes effect immediately. */
export function forgetTrader(address) {
  const a = String(address || '').toLowerCase();
  const is = (x) => String(x || '').toLowerCase() === a;
  let n = 0;
  for (const [k, v] of liveIndex) if (is(v.item?.address)) { liveIndex.delete(k); rawIndex.delete(k); n++; }
  for (const [k, t] of rawIndex) if (is(t?.trader_address)) { rawIndex.delete(k); liveIndex.delete(k); n++; }
  for (let i = deck.length - 1; i >= 0; i--) if (is(deck[i].t?.trader_address)) { deck.splice(i, 1); n++; }
  if (feedCache) feedCache.rows = feedCache.rows.filter((r) => !is(r.address));
  // Challenge links hold a full copy of the trade and would keep serving it for a week.
  for (const [k, c] of challenges) if (is(c.trade?.trader_address)) { challenges.delete(k); n++; }
  // A hand already on someone's table still reveals the address when they bet.
  for (const [k, r] of rounds) if (is(r.trade?.trader_address)) {
    clearTimeout(r.timer); rounds.delete(k);
    if (pendingRound.get(r.playerId) === k) pendingRound.delete(r.playerId);
    n++;
  }
  // Open bets are returned to their owner for days. Keep the bet so it still settles (settlement reads
  // Hyperliquid directly, not these fields) but stop republishing who the trader was.
  let bets = 0;
  for (const b of liveBets) if (is(b.whale)) { b.whale = null; b.trader = 'A trader who asked not to be named'; bets++; }
  if (bets) save('livebets', liveBets);
  // Training samples are keyed by a string containing the address, and are persisted.
  let smp = 0;
  for (const k of Object.keys(samples)) if (k.toLowerCase().includes(a)) { delete samples[k]; smp++; }
  if (smp) save('samples', samples);
  return n + bets + smp;
}

export function prune({ hard = false } = {}) {
  const idleCutoff = hard ? 6 * 3600e3 : 2 * DAY;
  const cutoff = Date.now() - 7 * DAY;
  const before = liveBets.length;
  for (let i = liveBets.length - 1; i >= 0; i--) {
    const b = liveBets[i];
    if (b.status !== 'open' && b.status !== 'cashing' && !b.followUp && (b.settledAt || b.cashedAt || b.placedAt) < cutoff) liveBets.splice(i, 1);
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
  // A ride bet ends when the whale closes, not at its 72h backstop, so quoting it against 72h would
  // pull every price back toward the prior: losers bought back far above fair value, winners far below.
  // Price it against how much of a typical hold is actually left.
  const elapsed = (Date.now() - b.placedAt) / 60e3;
  const minutesLeft = b.ride
    ? Math.max(1, Math.min(720, oddsEngine.getHorizonRef() - elapsed))
    : (b.settleAt - Date.now()) / 60e3;
  if (b.status !== 'open' || minutesLeft <= 0.1 || !now) return null;
  const whaleRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.entry) / b.entry;
  const myRet = b.choice === 'follow' ? whaleRet : -whaleRet;
  const sigma = await minuteVol(b.coin);
  // Start from the probability the odds were priced at (so cashing out at the moment you bet returns your stake
  // minus the house edge), then update it with how price has actually moved and how much time is left.
  // totalMin must equal minutesLeft at t=0 so an instant cash-out still returns exactly the stake.
  const totalMin = b.ride ? Math.max(minutesLeft, Math.min(720, oddsEngine.getHorizonRef()))
    : Math.max(minutesLeft, (b.settleAt - b.placedAt) / 60e3);
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
  // Exit timing is the skill this game is now about, so a cash-out is not the end of the story: keep
  // following the whale and, once they are actually out, work out what holding would have paid.
  if (b.ride && !b.demoRide) { b.followUp = true; b.historyAt = Date.now(); }
  if (b.whaleEntry) b.whaleTradeRet = (b.whaleSide === 'Long' ? 1 : -1) * (now - b.whaleEntry) / b.whaleEntry;
  const net = q.offer - b.stake;
  p.bankroll += q.offer; p.bets++; if (net === 0) p.pushes = (p.pushes || 0) + 1;
  if (net > 0) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else if (net < 0) p.streak = 0;
  p.peak = Math.max(p.peak, p.bankroll);
  maybeBust(p);
  p.history.push({ t: b.historyAt ?? Date.now(), coin: b.coin, side: b.whaleSide, choice: b.choice, stake: b.stake, price: b.price, delta: net, ret: b.whaleRet, bankroll: p.bankroll, live: true, minutes: b.minutes, pick: b.pick, cashed: true, sig: b.sig, pChosen: b.pChosen, modelSide: b.modelSide, grade: b.grade, late: b.late ?? null });
  save('players', players); save('livebets', liveBets);
  return { bet: b, net, player: publicPlayer(p) };
}

export async function liveBetsFor(playerId) {
  const mine = liveBets.filter((b) => b.playerId === playerId).slice(-30).reverse()
    .map((b) => (excluded.isExcluded(b.whale) ? { ...b, whale: null, trader: 'A trader who asked not to be named' } : b));
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
