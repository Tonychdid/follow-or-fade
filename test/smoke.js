/**
 * Smoke test — no dependencies, no API key, no network beyond localhost.
 * Boots the server in DEMO mode on a scratch data directory, exercises the full
 * loop a player takes, and checks the invariants that must never drift.
 *
 *   npm test
 *
 * Exits 0 if every check passes, 1 on the first failure (so CI can gate on it).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A random port with no check meant an occupied one reported "server did not start", which reads as
// a broken app rather than a busy machine. Ask the OS for a free one instead.
const freePort = async () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'fof-smoke-'));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const get = async (p, opts) => fetch(BASE + p, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DEMO: '1', DATA_DIR: DATA, PUBLIC: '', ADMIN_TOKEN: '', DEV_OPEN_ADMIN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const shutdown = (code) => {
  try { server.kill('SIGTERM'); } catch {}
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(code);
};

try {
  // wait for the port to answer (max ~20s)
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(200);
    try { const r = await get('/api/status'); up = r.ok; } catch {}
  }
  if (!up) { console.log('  FAIL  server did not start\n' + serverLog); shutdown(1); }
  console.log(`\nFollow or Fade — smoke test (DEMO mode, port ${PORT})\n`);

  // --- the page and its assets
  ok('homepage serves', (await get('/')).status === 200);
  ok('app.js serves', (await get('/app.js')).status === 200);
  ok('style.css serves', (await get('/style.css')).status === 200);

  // --- public API
  const status = await (await get('/api/status')).json();
  ok('status reports demo mode', status.usage?.demo === true);
  ok('live floor returns cards', Array.isArray(await (await get('/api/live')).json()));

  // --- a full hand: sit down, get dealt, call it
  const player = await (await get('/api/player', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: 'smoke' }),
  })).json();
  ok('player is created', typeof player.id === 'string' && player.id.length === 36);
  ok('player starts with chips', player.bankroll > 0, `bankroll=${player.bankroll}`);

  const round = await (await get('/api/round?player=' + player.id)).json();
  ok('a hand is dealt', typeof round.roundId === 'string');
  ok('hand has a real coin and side', !!round.coin && ['Long', 'Short'].includes(round.side));
  ok('odds are present on both sides', round.odds?.follow > 1 && round.odds?.fade > 1);

  // Play a short run rather than one hand. A payout bug only shows on a WINNING hand, so a
  // single-bet test catches an overpay about half the time - it passed three times in a row against
  // a build that paid every winner a whole extra stake. Five hands makes that a ~3% miss.
  let resolved = 0, exact = 0, seen = [], bankroll = player.bankroll;
  for (let i = 0; i < 5; i++) {
    const r = i === 0 ? round : await (await get('/api/round?player=' + player.id)).json();
    if (!r?.roundId) break;
    const bet = await (await get('/api/bet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ player: player.id, roundId: r.roundId, choice: i % 2 ? 'fade' : 'follow', stake: 500 }),
    })).json();
    if (!['win', 'loss', 'push'].includes(bet.result)) { seen.push(JSON.stringify(bet).slice(0, 80)); continue; }
    resolved++;
    // A push is not a no-op bug: inside the push band the stake comes back and the balance is
    // identical. Check the exact arithmetic for each outcome instead of "the number changed".
    const want = bet.result === 'win' ? bankroll + Math.round(bet.stake * (bet.price - 1))
      : bet.result === 'loss' ? bankroll - bet.stake
      : bankroll;
    if (bet.player?.bankroll === want) exact++;
    else seen.push(`${bet.result} at ${bet.price}: ${bankroll} -> ${bet.player?.bankroll}, expected ${want}`);
    bankroll = bet.player?.bankroll ?? bankroll;
  }
  ok('five hands all resolve', resolved === 5, `${resolved}/5 resolved ${seen.join(' | ')}`);
  ok('every payout matches the stated odds', exact === resolved && resolved > 0, seen.join(' | '));

  // --- invariants that must never drift.
  // These are product promises, not implementation details: the game takes no rake and the
  // cash-out offer is the bet's fair value. An earlier version of this test checked the odds
  // engine instead and happily passed with HOUSE_EDGE set to 0.08 — read the constants.
  const game = await readFile(path.join(ROOT, 'lib', 'game.js'), 'utf8');
  ok('house edge is zero', /const HOUSE_EDGE\s*=\s*0\s*;/.test(game),
     (game.match(/const HOUSE_EDGE\s*=\s*[^;]+;/) || ['not found'])[0]);
  ok('cash-out takes no margin', /const CASHOUT_MARGIN\s*=\s*1\s*;/.test(game),
     (game.match(/const CASHOUT_MARGIN\s*=\s*[^;]+;/) || ['not found'])[0]);
  const fair = Math.abs(round.odds.follow * round.pFollow - 1) < 0.02
            || Math.abs(round.odds.fade * (1 - round.pFollow) - 1) < 0.02;
  ok('odds match the stated probability', fair,
     `follow ${round.odds.follow} @ p=${round.pFollow.toFixed(3)}`);

  // --- the Telegram message
  // Every whale message is Telegram HTML, and Telegram answers a malformed one with 400 instead of
  // delivering it. A wallet label is a Nansen string we do not control, so the escaping is what
  // stands between one odd label and a lost alert. Render the real builder, not a copy of it.
  process.env.DATA_DIR = DATA;
  const { renderMessage } = await import(path.join(ROOT, 'lib', 'alerts.js'));
  const wh = {
    id: 't', t: Date.now(), key: 'k', coin: 'BTC', side: 'Long', valueUsd: 2.43e6, entryPrice: 111240,
        // A deliberately nasty label. <script> is not on Telegram's allow-list and the <u> is never
    // closed, so if the escaping stops working the well-formedness check fails on its own - it does
    // not depend on the ampersand also being caught, which an earlier version of this test did.
    openedAt: new Date(Date.now() - 7.2e6).toISOString(), trader: '<script>x</script> & <u>evil', address: '0x' + 'a'.repeat(40),
    record: { d30: { pnl: 1.24e6, roi: 0.42, winRate: 0.68, closed: 94, wins: 64, coins: 7 },
      d7: { pnl: 8.8e4, roi: 0.06, winRate: 0.71, closed: 14, wins: 10, coins: 3 }, trust: { grade: 'A', score: 88 } },
    read: { pFollow: 0.63, moveSinceEntry: 0.004 }, leaderboard: true, early: true,
  };
  const shapes = [renderMessage(wh), renderMessage({ ...wh, record: { ...wh.record, d7: null } }),
    renderMessage({ ...wh, kind: 'add', addedSz: 12.4, sizeNow: 34.8, multiple: 3.2, avgEntry: 111240, markPx: 112400, upnl: 8.8e4, whaleRet: 0.0104 }),
    renderMessage({ ...wh, kind: 'trim', trimPct: 0.4, remainingPct: 0.6, heldMs: 7.2e6, markPx: 112400, whaleRet: 0.0104 }),
    renderMessage({ ...wh, kind: 'exit', heldMs: 7.2e6, exitPx: 112400, whaleRet: 0.0104 })];
  // Telegram's whole allow-list, so a tag typed by mistake is caught here and not in production.
  const OK_TAGS = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler'];
  const balanced = (t) => {
    const stack = [];
    for (const m of t.matchAll(/<(\/?)([a-z-]+)(?:\s[^>]*)?>/g)) {
      if (!OK_TAGS.includes(m[2])) return `tag Telegram does not accept: <${m[2]}>`;
      if (m[1]) { if (stack.pop() !== m[2]) return `</${m[2]}> closes nothing`; } else stack.push(m[2]);
    }
    return stack.length ? `never closed: <${stack.join('>, <')}>` : '';
  };
  const bad = shapes.map(balanced).filter(Boolean);
  ok('every message shape is well-formed Telegram HTML', !bad.length, bad.join(' | '));
  // Two ways to catch a missed escape. First: the hostile label must never appear verbatim - stripping
  // tags before looking would also strip the ones the label smuggled in, so check the raw text.
  // Second: with the tags we did mean to send removed, nothing should be left holding a < or a bare &.
  const raw = shapes.filter((t) => /<script>|<u>/.test(t));
  const leftovers = shapes.map((t) => t.replace(/<\/?[a-z-]+(?:\s[^>]*)?>/g, ''))
    .map((t) => (/[<>]/.test(t) ? t.match(/.{0,20}[<>].{0,20}/)[0] : /&(?!amp;|lt;|gt;|quot;|#)/.test(t) ? 'bare &' : '')).filter(Boolean);
  ok('a wallet label containing HTML is escaped', !raw.length && !leftovers.length,
     [...(raw.length ? [`${raw.length} message(s) carry the label's own tags through`] : []), ...leftovers].join(' | '));
  // The grid only reads as a dashboard if it fits a phone: 32 monospace columns is the budget.
  const widest = Math.max(...shapes.flatMap((t) => (t.match(/<pre>[\s\S]*?<\/pre>/g) || []).join('\n')
    .replace(/<\/?pre>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.length)), 0);
  ok('the stats grid fits a phone', widest > 0 && widest <= 32, `widest line is ${widest} characters`);

  // --- security
  ok('admin is closed without a token', (await get('/api/usage')).status === 403);
  ok('path traversal is refused', (await get('/../../etc/passwd')).status === 404);
  ok('unknown routes 404', (await get('/definitely-not-a-route')).status === 404);
} catch (e) {
  failed++; console.log('  FAIL  unexpected error —', e.message);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
shutdown(failed ? 1 : 0);
