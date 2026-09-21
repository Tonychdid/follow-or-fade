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

  // --- security
  ok('admin is closed without a token', (await get('/api/usage')).status === 403);
  ok('path traversal is refused', (await get('/../../etc/passwd')).status === 404);
  ok('unknown routes 404', (await get('/definitely-not-a-route')).status === 404);
} catch (e) {
  failed++; console.log('  FAIL  unexpected error —', e.message);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
shutdown(failed ? 1 : 0);
