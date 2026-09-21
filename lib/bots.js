/**
 * The house bots.
 *
 * Three fixed strategies that play the SAME hands the training table builds, at a flat stake, priced
 * by the same odds and settled by the same real whale exits. They exist for two reasons.
 *
 * One: a leaderboard with nobody on it invites nobody. Three rows that are always there give a new
 * player something to aim at on their first hand.
 *
 * Two, and the real reason: this whole product claims that reading the Nansen tells beats blindly
 * following Smart Money. That claim needs a number, in public, that nobody gets to tune. "Always
 * Follow" is that number. If it quietly out-earns every human on the board, the honest read is that
 * the teaching is not working yet - and the board will say so without being asked.
 *
 * They are labelled BOT everywhere and never mixed into the human rankings. A bot that could be
 * mistaken for a player would be fake social proof, which is the one thing this board must not be.
 */
import { load, save } from './store.js';

const START = 10000;
const STAKE = Math.max(1, Number(process.env.BOT_STAKE || 500));
// A trade only ever counts once, however many times it passes through the deck.
const SEEN_MS = 8 * 864e5;

const DEFS = [
  { id: 'always-follow', name: 'Always Follow', choice: () => 'follow',
    blurb: 'Backs the whale on every hand. The line you have to beat to be worth more than a copy button.' },
  { id: 'always-fade', name: 'Always Fade', choice: () => 'fade',
    blurb: 'Bets against the whale on every hand. Smart Money being wrong is not a strategy either.' },
  { id: 'coin-flip', name: 'Coin Flip', choice: () => (Math.random() < 0.5 ? 'follow' : 'fade'),
    blurb: 'Picks at random. Beat this and you are reading something; lose to it and you are not.' },
];

const fresh = (d) => ({ id: d.id, name: d.name, bankroll: START, bets: 0, wins: 0, pushes: 0,
  streak: 0, bestStreak: 0, whalesSlain: 0, busts: 0, since: Date.now() });

const state = load('bots', { rows: {}, seen: {} });
state.rows ||= {}; state.seen ||= {};
for (const d of DEFS) state.rows[d.id] ||= fresh(d);

let dirty = false;
const flush = () => { if (dirty) { save('bots', state); dirty = false; } };

/**
 * Score one hand for every bot. Called once as a hand is built, with everything already computed for
 * the human sitting at the table - so a bot costs no Nansen credits and no extra Hyperliquid call.
 * `key` is the trade key: the same hand reaching the deck twice must not be played twice.
 */
export function play({ key, pFollow, odds, followWon, push }) {
  if (!key || !odds || typeof pFollow !== 'number') return;
  if (state.seen[key]) return;
  state.seen[key] = Date.now();
  for (const [k, ts] of Object.entries(state.seen)) if (Date.now() - ts > SEEN_MS) delete state.seen[k];

  for (const d of DEFS) {
    const b = (state.rows[d.id] ||= fresh(d));
    // A bot that has run out of chips reloads on the same terms a player does, and the reload counts
    // against its net exactly the same way. Otherwise "Always Fade" could bust and quietly reset.
    if (b.bankroll < STAKE) { b.bankroll = START; b.busts++; }
    const choice = d.choice();
    const price = choice === 'follow' ? odds.follow : odds.fade;
    if (!(price > 1)) continue;
    const won = !push && (choice === 'follow' ? followWon : !followWon);
    const delta = push ? 0 : won ? Math.round(STAKE * (price - 1)) : -STAKE;
    b.bankroll += delta;
    b.bets++;
    if (push) b.pushes++;
    else if (won) { b.wins++; b.streak++; b.bestStreak = Math.max(b.bestStreak, b.streak); }
    else b.streak = 0;
    if (won && choice === 'fade' && pFollow >= 0.55) b.whalesSlain++;
  }
  dirty = true;
}

/** Same shape the player leaderboard uses, plus what makes a bot a bot. */
export function rows() {
  return DEFS.map((d) => {
    const b = state.rows[d.id] || fresh(d);
    const settled = b.bets - (b.pushes || 0);
    return {
      id: d.id, name: d.name, blurb: d.blurb, bot: true, stake: STAKE,
      bankroll: Math.round(b.bankroll),
      net: Math.round(b.bankroll - START * (1 + (b.busts || 0))),
      bets: b.bets, winRate: settled > 0 ? b.wins / settled : 0,
      bestStreak: b.bestStreak, whalesSlain: b.whalesSlain, busts: b.busts, since: b.since,
    };
  });
}

setInterval(flush, 30e3).unref?.();
process.on('SIGTERM', flush);
process.on('SIGINT', flush);
