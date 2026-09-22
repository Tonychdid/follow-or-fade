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

  // --- the proof desk
  // This page is the product's whole credibility claim, so its arithmetic is checked against cases
  // whose answer is known by construction rather than against whatever it happened to print today.
  // Seed a roster before the proof desk first reads one: the store memoises, so the file has to be
  // on disk before the import or the lookup caches an empty list and the next three checks pass
  // against nothing.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(DATA, 'roster.json'), JSON.stringify({ at: new Date().toISOString(), whales: [
    { address: '0xPASSED', qualifies: 'standard' }, { address: '0xREJECTED', qualifies: null }] }));
  process.env.DATA_DIR = DATA;
  const proof = await import(path.join(ROOT, 'lib', 'proof.js'));
  // The three-way answer is the whole basis of the comparison. A wallet the roster has never seen
  // must come back unknown, not quietly counted as having passed.
  ok('a qualifying wallet reads as passing', proof.qualifies('0xpassed') === true);
  ok('an assessed but rejected wallet reads as failing', proof.qualifies('0xREJECTED') === false);
  ok('an unassessed wallet reads as unknown, not as passing',
     proof.qualifies('0xNEVERSEEN') === null, String(proof.qualifies('0xNEVERSEEN')));
  const rows = (n, p, truth, pool) => Array.from({ length: n }, (_, i) =>
    ({ p, won: i / n < truth, push: false, pool, addr: '0x' + (i % 7) }));
  // One won hand at even odds pays 1.00 per unit staked; the loser on the other side loses its stake.
  const one = proof.strategies([{ p: 0.5, won: true, push: false }]);
  ok('a won hand at 50% pays exactly its odds', one.follow.roi === 1 && one.fade.roi === -1,
     `follow ${one.follow.roi}, fade ${one.fade.roi}`);
  // Truncation to two decimals is deliberate (see odds.js), so 1/0.8 prices at 1.25, not 1.2500001.
  const trunc = proof.strategies([{ p: 0.8, won: true, push: false }]);
  ok('odds are truncated, never rounded up', trunc.follow.roi === 0.25, String(trunc.follow.roi));
  // A push has no winner. It must be counted and then excluded from every accuracy figure.
  ok('pushes are counted but never scored',
     proof.brier([{ p: 0.5, won: true, push: false }, { p: 0.5, won: false, push: true }]).n === 1);
  // A model that is right exactly as often as it claims must beat always-guessing the base rate.
  // Built bucket by bucket so each claimed probability gets exactly that share of winners - drawing
  // them from one counter makes the claim and the outcome correlate and tests nothing.
  const honest = [];
  for (const p of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const n = 200, wins = Math.round(n * p);
    for (let i = 0; i < n; i++) honest.push({ p, won: i < wins, push: false });
  }
  const hb = proof.brier(honest);
  ok('a calibrated model beats the base-rate reference', hb.score < hb.reference,
     `${hb.score.toFixed(4)} vs ${hb.reference.toFixed(4)}`);
  // The reliability table must SEE a model that lies. Claim 70%, win 40%, and the gap has to show.
  const liar = Array.from({ length: 400 }, (_, i) => ({ p: 0.7, won: i % 10 < 4, push: false }));
  const band = proof.reliability(liar).find((b) => b.n > 0);
  ok('the reliability table catches an overconfident model',
     band && Math.abs(band.actual - band.predicted) > 0.25, band ? `said ${band.predicted} actual ${band.actual}` : 'no band');
  // The two populations must not leak into each other, and an unassessed wallet joins neither.
  const mixed = [{ p: 0.6, won: true, push: false, pool: true, addr: 'a' },
                 { p: 0.6, won: false, push: false, pool: false, addr: 'b' },
                 { p: 0.6, won: true, push: false, pool: null, addr: 'c' }];
  const P = proof.populations(mixed);
  ok('filtered and rejected populations stay separate',
     P.all.n === 3 && P.filtered.n === 1 && P.rejected.n === 1 && P.unknown === 1,
     `all ${P.all.n}, filtered ${P.filtered.n}, rejected ${P.rejected.n}, unknown ${P.unknown}`);
  // And the comparison must have the right sign when one population really is better.
  const better = [...rows(300, 0.6, 0.85, true), ...rows(300, 0.6, 0.45, false)];
  const B = proof.populations(better);
  ok('a genuinely better filtered set shows a positive difference',
     B.difference > 0 && B.significant, `difference ${(B.difference * 100).toFixed(1)}%, significant ${B.significant}`);
  // The dangerous direction: two populations that are actually the same must NOT be called apart.
  // Claiming the filters work when they do not is the one failure this whole page exists to prevent.
  const same = [...rows(300, 0.6, 0.70, true), ...rows(300, 0.6, 0.73, false)];
  const S = proof.populations(same);
  ok('a difference smaller than the noise is not called a difference', !S.significant,
     `difference ${(S.difference * 100).toFixed(2)}%, se ${(S.differenceSe * 100).toFixed(2)}%, significant ${S.significant}`);
  // Cross-validation must never score a sample with a model that saw it.
  const cvSamples = Array.from({ length: 200 }, (_, i) => ({
    at: i, address: '0x' + (i % 9),
    f: { walletEdge: ((i % 7) - 3) / 20, smFlow: ((i % 5) - 2) / 2, crowdFlow: 0, funding: 0, size: 0 },
    win: i % 3 !== 0 }));
  const cv = proof.crossValidate(cvSamples, 10);
  ok('cross-validation predicts every sample exactly once',
     cv.rows.length === cvSamples.length, `${cv.rows.length} of ${cvSamples.length}`);
  // And it must really hold each fold out. Two rows with byte-identical features, placed in
  // different folds, are scored by two different models and so cannot get the same number. If the
  // folds ever stop being held out, every model becomes the same model and these collapse to equal
  // - which is exactly the in-sample curve this page refuses to show.
  const twin = { walletEdge: 0.11, smFlow: 0.42, crowdFlow: -0.17, funding: 0.8, size: 0.35 };
  const twins = cvSamples.map((x, i) => (i === 0 || i === 1 ? { ...x, f: { ...twin } } : x));
  const tv = proof.crossValidate(twins, 10);
  // Folds are emitted in order, 20 rows each, so the twin in fold 0 is row 0 and the twin in fold 1
  // is row 20 - the same inputs scored by two models that were trained on different data.
  ok('cross-validation really holds each fold out', tv.rows[0].p !== tv.rows[20].p,
     `fold 0 said ${tv.rows[0].p}, fold 1 said ${tv.rows[20].p}`);
  // The proof routes are public — a claim nobody can fetch is not evidence.
  const pr = await get('/api/proof');
  ok('the proof desk is public', pr.status === 200);
  const pj = await pr.json();
  ok('the proof desk reports both kinds of evidence',
     !!pj.forward && !!pj.crossValidated && !!pj.forward.populations, JSON.stringify(Object.keys(pj)));
  ok('the raw prediction record is downloadable', (await get('/api/proof/raw')).status === 200);
  ok('the Nansen call ledger is public', (await get('/api/usage')).status === 200);

  // --- security
  ok('load-test rigs are kept off the public board', !(await (await get('/api/leaderboard')).json()).some((p) => /^(lag|perf|smoke)/i.test(p.name || '')));
  ok('path traversal is refused', (await get('/../../etc/passwd')).status === 404);
  ok('unknown routes 404', (await get('/definitely-not-a-route')).status === 404);
} catch (e) {
  failed++; console.log('  FAIL  unexpected error —', e.message);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
shutdown(failed ? 1 : 0);
