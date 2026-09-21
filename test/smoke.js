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
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3000 + Math.floor(Math.random() * 900) + 60;
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

  const bet = await (await get('/api/bet', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ player: player.id, roundId: round.roundId, choice: 'follow', stake: 500 }),
  })).json();
  ok('the bet resolves', ['win', 'loss', 'push'].includes(bet.result), JSON.stringify(bet).slice(0, 90));
  ok('bankroll moves by the stake', bet.player && bet.player.bankroll !== player.bankroll);

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
