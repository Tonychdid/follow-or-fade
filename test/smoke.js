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
  // The call rail: a hand says which Nansen data priced it, and how far each feature moved the price.
  ok('a hand carries its Nansen call rail', Array.isArray(round.nansen?.why) && round.nansen.why.length === 5
    && round.nansen.why.every((w) => Number.isFinite(w.pp)), JSON.stringify(round.nansen?.why || null).slice(0, 120));
  {
    const sc = await (await get('/api/scorecard')).json();
    ok('the alert scorecard is public', sc && sc.summary && Array.isArray(sc.alerts) && typeof sc.method === 'string');
    const img = await get('/og/scorecard.png');
    const buf = Buffer.from(await img.arrayBuffer());
    ok('share images are real PNGs', img.status === 200 && buf.slice(1, 4).toString() === 'PNG' && buf.length > 2000);
    const addr = '0x' + 'ab'.repeat(20);
    const page = await (await get('/w/' + addr)).text();
    ok('a whale page carries its own share image', page.includes(`/og/w/${addr}.png`) && page.includes('twitter:card') && !page.includes('{{'));
    ok('a bad wallet address is refused', (await get('/api/whale?address=nope')).status === 400);
    const proofPage = await (await get('/proof.html')).text();
    ok('the proof desk has a share image', proofPage.includes('/og/proof.png') && !proofPage.includes('{{'));
  }
  ok('the rail names no wallet address', !JSON.stringify(round.nansen || {}).match(/0x[0-9a-f]{6,}/i));

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
    renderMessage({ ...wh, kind: 'exit', heldMs: 7.2e6, exitPx: 112400, whaleRet: 0.0104 }),
    renderMessage({ ...wh, exits: { tp: [{ px: 120000, dist: 0.07, share: 0.25, full: false, kind: 'limit' }], sl: [], adds: [{ px: 105000, dist: -0.06, share: 0.5, kind: 'limit' }] } }),
    renderMessage({ ...wh, kind: 'orders', changes: ['Stop loss added at 104,000'], markPx: 112400, whaleRet: 0.0104,
      exits: { tp: [], sl: [{ px: 104000, dist: -0.075, share: null, full: true, kind: 'trigger' }], adds: [] } })];
  {
    // A whale's exit plan, read from their resting orders. A short covers by buying: a buy limit
    // below the price is a take profit, a buy stop above is a stop loss, a sell limit above is an add.
    // The owner's copy says whether the private bot copies the alert; a subscriber's copy never mentions a bot.
    const own = renderMessage({ ...wh, botEligible: false, botReason: 'grade B is below A' }, null, true), pub = renderMessage({ ...wh, botEligible: false, botReason: 'grade B is below A' });
    ok("the owner's alert says PUBLIC ONLY and why; the public copy says nothing about a bot",
      /PUBLIC ONLY<\/b> · the bot skips it: grade B is below A/.test(own) && !/bot/i.test(pub.replace(/Nansen|whale|about/gi, '')), own);
    // The dashboard as a picture (big numbers), the rest as the caption.
    const AL = await import(path.join(ROOT, 'lib', 'alerts.js'));
    const IMG = await import(path.join(ROOT, 'lib', 'cardimg.js'));
    if (IMG.available()) {
      const pic = AL.photoFor(wh, renderMessage(wh));
      ok('an alert is drawn as a picture of its grid, the rest as the caption', pic && pic.png[0] === 0x89 && pic.png[1] === 0x50 && !/<pre>/.test(pic.caption)
        && /WHALE ALERT/.test(pic.caption) && pic.caption.length <= 1024, pic && pic.caption);
      const exitPic = AL.photoFor({ ...wh, kind: 'exit', heldMs: 7.2e6, exitPx: 112400, whaleRet: 0.0104 }, renderMessage({ ...wh, kind: 'exit', heldMs: 7.2e6, exitPx: 112400, whaleRet: 0.0104 }));
      ok('an exit is drawn as a picture too', !!exitPic && /WHALE EXIT/.test(exitPic.caption));
      ok('a message with no grid stays text', AL.photoFor(wh, '<b>hello</b>') === null);
      // Sep 25 (owner: "the message is too long"): the caption is a few short lines; the numbers are in the picture.
      const own2 = renderMessage({ ...wh, botEligible: false, botReason: 'grade B is below A' }, null, true);
      const short = AL.photoFor({ ...wh, botEligible: false, botReason: 'grade B is below A' }, own2, { owner: true });
      ok('a picture alert has a short caption with no score, exits or tag essays', short && short.caption.length < 450 && !/Whale-trade score|Entry now|Whale's exits|Top \d+ on the whale board/.test(short.caption)
        && /PUBLIC ONLY/.test(short.caption) && short.caption.split('\n').length <= 5, short && short.caption);
      const rc = { hhmm: '19:14', ago: '1.6h', baseMid: 112000, mid: 112400, since: 0.0036, whaleNow: 0.008, whaleThen: 0.004, pThen: 0.63, pNow: 0.6, exits: { tp: [], sl: [], adds: [] }, gone: false, trimmed: 0 };
      const re = AL.photoFor(wh, renderMessage(wh), { recheck: rc });
      ok('a re-checked picture says in one line whether the whale is still in', re && /Re-checked<\/b> 19:14 UTC · 1.6h after · ✅ whale still in/.test(re.caption) && re.caption.length < 450, re && re.caption);
      ok('the caption gives the whale average entry', /@ avg <code>/.test(short.caption), short.caption);
      const rc2 = { ...rc, avgThen: 111800, avgNow: 111950, sizeThen: 2.4e5, sizeNow: 3.1e5 };
      ok('a re-checked picture still draws with the average entry', !!AL.photoFor(wh, renderMessage(wh), { recheck: rc2 }));
      // Sep 25 (owner: "same format as the Elite bot"): POSITION first/now, then RECORD 30D/7D, then the exits.
      const secs0 = AL.pictureSections({ ...wh, avgEntry: 111200, valueUsd: 2.5e5, pos0: { sz: 2.2, upnl: 900, lev: 5, liqPx: 90000 },
        exits: { tp: [{ px: 120000, dist: 0.07 }], sl: [], adds: [] } });
      ok('the alert picture is laid out like the Elite card', secs0.map((x) => x.header[0]).join() === "POSITION,RECORD,WHALE'S EXITS"
        && secs0[0].header.join() === 'POSITION,FIRST,NOW' && secs0[1].header.join() === 'RECORD,30D,7D'
        && secs0[0].rows.some((r) => r[0] === 'Avg entry' && r[1] === '111,200') && secs0[0].rows.some((r) => r[0] === 'Lev · Liq' && r[1] === '5x'), JSON.stringify(secs0));
      const secsGone = AL.pictureSections({ ...wh, avgEntry: 111200 }, { ...rc, gone: true, posNow: null });
      ok('after the whale closes, NOW says closed and the exits are gone', secsGone[0].rows.find((r) => r[0] === 'Size')[2] === 'closed'
        && !secsGone.some((x) => x.header[0] === "WHALE'S EXITS"));
      const secsAdd = AL.pictureSections({ ...wh, kind: 'add', addedSz: 12.4, sizeNow: 34.8, multiple: 3.2, avgEntry: 111240, entryPrice: 110000, markPx: 112400, upnl: 8.8e4, whaleRet: 0.0104, valueUsd: 3.9e6 });
      ok('an add shows the position before and after, like the Elite ADDING card', secsAdd[0].rows.find((r) => r[0] === 'Size').slice(1).join() === '22.4,34.8');
      ok("a subscriber's picture caption never mentions a bot", !/bot/i.test(AL.captionFor({ ...wh, botEligible: true }).replace(/whale/gi, '')));
      const long = renderMessage(wh) + '\n\n' + 'x'.repeat(700) + '\n\n' + 'y'.repeat(500);
      const cap = AL.captionOf(long);
      ok('a long caption drops the extra paragraphs, never the headline', cap && cap.length <= 1024 && /WHALE ALERT/.test(cap) && !/xxxxx|yyyyy/.test(cap), cap && cap.length);
      const secs = IMG.sectionsOf([[ '', ]]);
      ok('an empty grid draws nothing', secs.length === 0);
    } else ok('the picture renderer is installed (npm install)', false);
    ok("the owner's alert says BOT ELIGIBLE when the bot may copy it", /BOT ELIGIBLE/.test(renderMessage({ ...wh, botEligible: true }, null, true)));
    shapes.push(own);
    const { feedTtlSec } = await import(path.join(ROOT, 'lib', 'alerts.js'));
    ok('the alert feed is cached for just under one scan, so every scan reads fresh trades', feedTtlSec(2) < 120 && feedTtlSec(10) < 600 && feedTtlSec(0.1) >= 30);
    // Sep 24: the scan is back to 10 minutes, but the cache fix must survive it: the feed read has to
    // expire BEFORE the next scan, or every other scan re-reads the old answer (the old ~20-minute lag).
    const { scanIntervalMin } = await import(path.join(ROOT, 'lib', 'alerts.js'));
    const iv = scanIntervalMin();
    ok('a fresh deployment scans every 10 minutes', iv === 10, `got ${iv}`);
    ok('the feed cache still expires before the next 10-minute scan', feedTtlSec(iv) < iv * 60 && feedTtlSec(iv) >= iv * 60 - 60, `ttl ${feedTtlSec(iv)}s`);
    const { classify, signature, changes } = await import(path.join(ROOT, 'lib', 'exits.js'));
    const orders = [
      { side: 'B', limitPx: '1390', sz: '300', isTrigger: false },
      { side: 'B', limitPx: '1800', triggerPx: '1800', sz: '0', isTrigger: true, isPositionTpsl: true, orderType: 'Stop Market' },
      { side: 'A', limitPx: '1720', sz: '58', isTrigger: false },
    ];
    const ex = classify(orders, 'Short', 1200, 1619);
    ok('a resting buy below the price is a short\'s take profit, sized against the position',
      ex.tp.length === 1 && ex.tp[0].px === 1390 && Math.abs(ex.tp[0].share - 0.25) < 1e-9 && ex.tp[0].dist < 0);
    ok('a position stop covers the whole position', ex.sl.length === 1 && ex.sl[0].full && ex.sl[0].px === 1800);
    ok('a sell above the price on a short is an add, never an exit', ex.adds.length === 1 && ex.adds[0].px === 1720);
    const long = classify([{ side: 'A', limitPx: '100', triggerPx: '110', sz: '0', isTrigger: true, isPositionTpsl: true, orderType: 'Take Profit Market', triggerCondition: 'Price above 110' }], 'Long', 5, 95);
    ok("a long's take-profit trigger is read from the trigger price", long.tp.length === 1 && long.tp[0].px === 110 && long.sl.length === 0);
    // Sep 23, a real ETH long (avg entry 2,702, price 2,661): three dip-buy brackets, each a buy limit
    // with its own TP/SL attached. Hyperliquid lists the attached orders on their own rows too. Read
    // naively they became "TP 2,666, 1,955 · SL 1,855, 1,756" on the open position, which is wrong:
    // the open position has no exits at all, and those orders only wake if the buy below fills.
    const kid = (oid, type, px, cond) => ({ oid, side: 'A', sz: '191', isTrigger: true, triggerPx: String(px), orderType: type, reduceOnly: true, triggerCondition: `Price ${cond} ${px}` });
    const b1 = [kid(2, 'Take Profit Market', 2666, 'above')], b2 = [kid(4, 'Take Profit Market', 1955, 'above'), kid(5, 'Stop Market', 1855, 'below')];
    const eth = classify([
      ...b1, { oid: 1, side: 'B', sz: '191', limitPx: '2324', isTrigger: false, children: b1 },
      ...b2, { oid: 3, side: 'B', sz: '292', limitPx: '1902', isTrigger: false, children: b2 },
    ], 'Long', 287.8, 2661.45);
    ok("a bracket's sleeping TP/SL are never read as exits of the open position", eth.tp.length === 0 && eth.sl.length === 0, JSON.stringify(eth));
    ok('the bracket shows up as a planned add with its own TP/SL', eth.adds.length === 2 && eth.adds[0].px === 2324 && eth.adds[0].thenTp === 2666
      && eth.adds[1].thenTp === 1955 && eth.adds[1].thenSl === 1855);
    ok('a trigger whose condition is already true cannot be live and is set aside',
      classify([kid(9, 'Take Profit Market', 1955, 'above')], 'Long', 287.8, 2661.45).tp.length === 0);
    const moved = classify([{ ...orders[0] }, { ...orders[1], triggerPx: '1750' }], 'Short', 1200, 1619);
    ok('a moved stop changes the fingerprint and is described as a move', signature(moved) !== signature(ex)
      && changes(ex, moved).some((c) => /Stop loss moved from 1800 to 1750/.test(c)), JSON.stringify(changes(ex, moved)));
    ok('an add alone never counts as an exit change', signature(ex) === signature(classify(orders.slice(0, 2), 'Short', 1200, 1619)));
    ok('a whale trimming the position is not an exit change: the orders did not move', signature(ex) === signature(classify(orders, 'Short', 900, 1619))
      && changes(ex, classify(orders, 'Short', 900, 1619)).length === 0);
    const resized = classify([{ ...orders[0], sz: '500' }, orders[1]], 'Short', 1200, 1619);
    ok('a take profit resized on the book is reported', changes(ex, resized).includes('Take profit size changed'), JSON.stringify(changes(ex, resized)));
    const msg = shapes[5], om = shapes[6];
    ok('the alert shows the exits, and says out loud when there is no stop', /Whale's exits/.test(msg) && /SL <b>none set<\/b>/.test(msg) && /TP <code>120,000<\/code>/.test(msg));
    ok('an exits-changed follow-up names the change', /WHALE MOVED THEIR EXITS/.test(om) && /Stop loss added at 104,000/.test(om));
  }
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

  // Nansen hands back ONE FILL at a time, so a whale that split an entry across 145 orders arrives
  // looking like a fraction of itself. A live ZRO alert said $25.4K against a $142K buy. The headline
  // now carries the position, and says so rather than silently printing the larger number.
  const split = renderMessage({ ...wh, valueUsd: 386000, tradeUsd: 25421 });
  ok('a split entry says the headline is the position', split.includes('Position size'),
     'the disclosure has to travel with the corrected number');
  ok('the fill Nansen reported is still shown', /\$25\.4K/.test(split), 'the smaller figure is disclosed, not hidden');
  const whole = renderMessage({ ...wh, valueUsd: 386000, tradeUsd: 380000 });
  ok('an entry that arrived whole gets no disclosure', !whole.includes('Position size'));
  ok('an alert with no tradeUsd at all gets no disclosure', !renderMessage(wh).includes('Position size'));

  // The alert freezes a grade; the card grades the whale now. A whale that alerted at C and reads A
  // on the card is one whale on two days, and the re-check has to say so instead of leaving two
  // surfaces contradicting each other with nothing to explain it.
  const { gradeDriftLine, assess } = await import(path.join(ROOT, 'lib', 'alerts.js'));
  ok('market makers never pass the alert rules, not even from the board', assess({
    d30: { closed: 500, pnl: 1e6, fees: 10, winRate: 0.99, roi: 0.2, coins: 6, perCoin: {} }, d7: { closed: 20, pnl: 1e4, coins: 4 },
    trust: { grade: 'A+', score: 99, marketMaker: true } }, 'BTC', { onBoard: true }).kind === null);
  ok('wallets too fast to copy never pass the alert rules', assess({
    d30: { closed: 2154, pnl: 1e6, fees: 10, winRate: 0.9, roi: 0.05, coins: 6, perCoin: {} }, d7: { closed: 200, pnl: 1e4, coins: 4 },
    trust: { grade: 'A+', score: 99, tooFast: true } }, 'SOL', { onBoard: true }).kind === null);
  {
    // --- Sep 24 panel decisions: routes, account health, HOLDS LOSERS, open-loss caps, LATE, the bot
    // flag, grade v2 in shadow and the reject log. Everything below is pure: no network, no Nansen.
    const A = await import(path.join(ROOT, 'lib', 'alerts.js'));
    const H = await import(path.join(ROOT, 'lib', 'health.js'));
    const TC = await import(path.join(ROOT, 'lib', 'traderclass.js'));
    const G = await import(path.join(ROOT, 'lib', 'game.js'));
    const V2 = await import(path.join(ROOT, 'lib', 'gradev2.js'));
    const DAYMS = 864e5;
    // A record that fails the generic bars on its 2% return floor, so only a route could admit it.
    const weak = { d30: { closed: 120, pnl: 5e5, fees: 1e3, winRate: 0.6, roi: 0.01, coins: 6, perCoin: {} }, d7: { closed: 20, pnl: -1e3, roi: -0.01, coins: 4 } };
    const greenWeek = { closed: 20, pnl: 1e3, roi: 0.01, coins: 4 };
    ok('the PRINTER route is gone: a printer that fails the rules is not alerted',
      A.assess({ ...weak, d7: greenWeek, trust: { grade: 'C', score: 55, printer: true } }, 'BTC').kind === null);
    const eC = A.assess({ ...weak, d7: greenWeek, trust: { grade: 'C', score: 55, early: true } }, 'BTC');
    ok('EARLY needs grade B or better', eC.kind === null && eC.gate === 'EARLY_GRADE', JSON.stringify(eC));
    const eB = A.assess({ ...weak, trust: { grade: 'B', score: 70, early: true } }, 'BTC');
    ok('EARLY no longer waives the losing-week rule', eB.kind === null && eB.gate === 'EARLY_7D', JSON.stringify(eB));
    ok('EARLY at grade B with a green week still gets in', A.assess({ ...weak, d7: greenWeek, trust: { grade: 'B', score: 70, early: true } }, 'BTC').kind === 'early');
    ok('every rejection carries a gate code for the reject log', A.assess({ ...weak, trust: { grade: 'A', score: 80, marketMaker: true } }, 'BTC').gate === 'MARKET_MAKER'
      && A.assess({ ...weak, trust: { grade: 'A', score: 80 } }, 'BTC').gate === 'ROI_30D');
    {
      // Only the proven-early source is gone from the code, not just switched off.
      const tcSrc = await readFile(path.join(ROOT, 'lib', 'traderclass.js'), 'utf8');
      const gSrc = await readFile(path.join(ROOT, 'lib', 'game.js'), 'utf8');
      ok('the proven-early route is removed', !/earlyFew|FEW_MIN_FINDS|provenEarly/.test(tcSrc + gSrc));
    }

    // Account health, from raw Hyperliquid answers.
    const now = Date.now();
    const series = (days, ret, av = 1e6) => ({
      accountValueHistory: Array.from({ length: days + 1 }, (_, i) => [now - (days - i) * DAYMS, String(av)]),
      pnlHistory: Array.from({ length: days + 1 }, (_, i) => [now - (days - i) * DAYMS, String((av * ret * i) / days)]) });
    const port = (r30, r7) => ({ month: series(30, r30), week: series(7, r7), allTime: series(400, 0.5) });
    const st = (av, ntl, upnl, pos = []) => ({ marginSummary: { accountValue: String(av), totalNtlPos: String(ntl) },
      assetPositions: [{ position: { coin: 'ZEC', szi: '-1000', entryPx: '100', positionValue: String(ntl), unrealizedPnl: String(upnl), liquidationPx: '150' } }, ...pos] });
    const good = H.evaluate([st(1e6, 2e6, 1e4)], port(0.05, 0.01));
    ok('a healthy account passes the health gate', good.status === 'ok' && good.ok === true, JSON.stringify(good).slice(0, 200));
    ok('health reads 30D and 7D account returns from the portfolio history', Math.abs(good.ret30 - 0.05) < 1e-6 && Math.abs(good.ret7 - 0.01) < 1e-6);
    ok('an open loss past 15% of the account fails', H.evaluate([st(1e6, 2e6, -2e5)], port(0.05, 0.01)).failedGate === 'HEALTH_UPNL');
    ok('a losing 30 days fails', H.evaluate([st(1e6, 2e6, 0)], port(-0.01, 0.01)).failedGate === 'HEALTH_30D');
    ok('a 7D loss past 10% fails', H.evaluate([st(1e6, 2e6, 0)], port(0.05, -0.12)).failedGate === 'HEALTH_7D');
    ok('notional over 10x the account fails', H.evaluate([st(1e6, 1.2e7, 0)], port(0.05, 0.01)).failedGate === 'HEALTH_LEV');
    const unk = H.evaluate([st(1e6, 2e6, 0)], null);
    ok('a missing portfolio reads as unknown, never as failing', unk.status === 'unknown' && unk.ok === null && !unk.failedGate);
    const jf = H.journalFields(good, 'ZEC', 'Short');
    ok('journal health fields: account value, leverage and liquidation distance', jf.health === 'ok' && jf.whaleAccountValue === 1e6
      && jf.positionLeverage === 2 && jf.liqDist > 0 && jf.liqDist < 1, JSON.stringify(jf));
    const strong = { d30: { closed: 200, pnl: 1e6, fees: 1e3, winRate: 0.7, roi: 0.2, coins: 6, perCoin: {} }, d7: { closed: 30, pnl: 1e5, roi: 0.05, coins: 4 } };
    ok('a grade B SCALPER with a real record gets in on the scalper route', A.assess({ ...strong, trust: { grade: 'B', score: 70, scalper: true } }, 'BTC').kind === 'scalper');
    ok('a grade B scalper with a losing week, or a grade C scalper, stays out',
      A.assess({ ...strong, d7: { closed: 30, pnl: -1e4, roi: -0.02, coins: 4 }, trust: { grade: 'B', score: 70, scalper: true } }, 'BTC').gate === 'SCALPER_7D'
      && A.assess({ ...strong, trust: { grade: 'C', score: 60, scalper: true } }, 'BTC').kind === null);
    ok('a scalper-route alert is public only for the B1 bot', A.botEligibility({ admittedVia: 'scalper', scalper: true, lateBy: 0, acct: { health: 'ok' }, record: { trust: { grade: 'A', scalper: true } }, holdHours: 1 })[0] === false);
    const bad = H.evaluate([st(1e6, 2e6, -2e5)], port(0.05, 0.01));
    const onBoardFail = A.assess({ ...strong, health: bad, trust: { grade: 'A+', score: 99 } }, 'BTC', { onBoard: true });
    ok('the health gate applies to every route, the board included', onBoardFail.kind === null && onBoardFail.gate === 'HEALTH_UPNL', JSON.stringify(onBoardFail));
    ok('an unreadable account does not block a public alert (fails open)', A.assess({ ...strong, health: unk, trust: { grade: 'A+', score: 99 } }, 'BTC').kind === 'standard');

    // Open-loss caps on the live grade.
    const noHL = { holdsLosers: false, why: null };
    const g0 = G.trustGrade(strong.d30, strong.d7, 'BTC', undefined, { health: null, holdsLosers: noHL });
    const g15 = G.trustGrade(strong.d30, strong.d7, 'BTC', undefined, { health: { upnlPct: -0.2 }, holdsLosers: noHL });
    const g30 = G.trustGrade(strong.d30, strong.d7, 'BTC', undefined, { health: { upnlPct: -0.35 }, holdsLosers: noHL });
    ok('an open loss of 15% of the account caps the score at 74', g0.score > 74 && g15.score <= 74 && g15.grade === 'B', `${g0.score} -> ${g15.score}`);
    ok('an open loss of 30% caps it at 35 and takes the wallet out', g30.score <= 35 && g30.openLossOut === true
      && A.assess({ ...strong, trust: g30 }, 'BTC', { onBoard: true }).gate === 'OPEN_LOSS_OUT');

    // HOLDS LOSERS.
    const perfect = { winRate: 1, closed: 23 };
    ok('HOLDS LOSERS: perfect closes with an open loss of 45% of the account', TC.holdsLosersOf(perfect, { upnlPct: -0.45, positions: [] }).holdsLosers === true);
    ok('HOLDS LOSERS needs the win rate as well', TC.holdsLosersOf({ winRate: 0.8, closed: 23 }, { upnlPct: -0.45, positions: [] }).holdsLosers === false
      && TC.holdsLosersOf({ winRate: 1, closed: 12 }, { upnlPct: -0.45, positions: [] }).holdsLosers === false);
    const deep = { upnlPct: -0.05, positions: [{ coin: 'ZEC', side: 'Short', retOnNotional: -0.25 }] };
    ok('HOLDS LOSERS: a -25% position held over 72h counts, a fresh one does not',
      TC.holdsLosersOf(perfect, deep, { 'ZEC|Short': 100 }).holdsLosers === true && TC.holdsLosersOf(perfect, deep, { 'ZEC|Short': 10 }).holdsLosers === false);
    const gH = G.trustGrade(strong.d30, strong.d7, 'BTC', undefined, { health: null, holdsLosers: { holdsLosers: true, why: 'x' } });
    ok('HOLDS LOSERS caps the grade at B', gH.holdsLosers === true && gH.score <= 74 && gH.grade === 'B');
    // A whale card dealt long after the account was read still gets the caps and the tag (kept reading).
    const addrK = '0x' + 'ab'.repeat(20);
    H.rememberHolds(addrK, { holdsLosers: true, why: 'kept verdict' });
    const gK = G.trustGrade(strong.d30, strong.d7, 'BTC', addrK);
    ok('every whale card uses the kept HOLDS LOSERS verdict, not only a 3-minute live read', gK.holdsLosers === true && gK.grade === 'B' && gK.holdsLosersWhy === 'kept verdict', JSON.stringify(gK).slice(0, 200));
    const addrN = '0x' + 'cd'.repeat(20);
    ok('a whale never read grades as before (no kept reading)', G.trustGrade(strong.d30, strong.d7, 'BTC', addrN).holdsLosers === false && H.latest(addrN).health === null);
    const hlBoard = A.assess({ ...weak, d7: greenWeek, trust: { grade: 'B', score: 74, holdsLosers: true, early: true } }, 'BTC', { onBoard: true });
    ok('HOLDS LOSERS gets no route exemption', hlBoard.kind === null && hlBoard.gate === 'HOLDS_LOSERS', JSON.stringify(hlBoard));

    // LATE and the whale-trade score in Telegram.
    const l1 = A.lateOf('Long', 100, 100.8), l2 = A.lateOf('Short', 100, 99.6), l3 = A.lateOf('Short', 100, 99), l4 = A.lateOf('Long', 100, 99);
    ok('LATE is measured past the entry in the whale\'s favour, over 0.5%', l1.late === true && Math.abs(l1.lateBy - 0.008) < 1e-9
      && l2.late === false && l3.late === true && l4.late === false && l4.lateBy === 0 && l4.moveAtSend < 0);
    const lateMsg = renderMessage({ ...wh, late: true, lateBy: 0.008 });
    ok('a late alert says so in one plain line', lateMsg.includes("LATE: price is already 0.8% past the whale's entry."), lateMsg.split('\n').find((x) => /LATE/.test(x)));
    ok('an alert on time has no LATE line', !renderMessage(wh).includes('LATE:'));
    ok('Telegram names pFollow as the whale-trade score, not the follower\'s odds',
      renderMessage(wh).includes('Whale-trade score 63%') && renderMessage(wh).includes("not a copier's") && !/Follow 63%/.test(renderMessage(wh)));
    const hlMsg = renderMessage({ ...wh, holdsLosers: true, holdsLosersWhy: '100% of closes won, but open losses are 45% of the account' });
    ok('the HOLDS LOSERS tag and its explainer travel in Telegram', /HOLDS LOSERS/.test(hlMsg) && /Holds losers: 100% of closes won/.test(hlMsg) && !balanced(hlMsg));
    ok('the new alert lines carry no em dash', ![lateMsg, hlMsg].flatMap((m) => m.split('\n')).filter((x) => /LATE:|Holds losers|Whale-trade score/.test(x)).some((x) => x.includes('\u2014')));

    // The bot flag.
    const el = { admittedVia: 'standard', lateBy: 0.002, acct: { health: 'ok' }, record: { trust: { grade: 'A' } }, holdHours: 30, openedAt: new Date(Date.now() - 10 * 60e3).toISOString() };
    ok('a clean A alert is bot-eligible', A.botEligibility(el)[0] === true);
    ok('EARLY and LEADERBOARD routes are never bot-eligible', A.botEligibility({ ...el, admittedVia: 'early' })[0] === false && A.botEligibility({ ...el, admittedVia: 'leaderboard' })[0] === false);
    ok('late over 1%, unknown health, holds losers or grade under A: not bot-eligible',
      A.botEligibility({ ...el, lateBy: 0.012 })[0] === false && A.botEligibility({ ...el, acct: { health: 'unknown' } })[0] === false
      && A.botEligibility({ ...el, holdsLosers: true })[0] === false && A.botEligibility({ ...el, record: { trust: { grade: 'B' } } })[0] === false);
    ok('a PRINTER-tagged alert on the standard route stays bot-eligible (the bot copies printers)', A.botEligibility({ ...el, printer: true })[0] === true);
    ok('scalpers, short or unknown hold times and old fills are public only, as the bot would skip them',
      A.botEligibility({ ...el, scalper: true })[0] === false && A.botEligibility({ ...el, holdHours: null })[0] === false
      && /under the bot's 4h minimum/.test(A.botEligibility({ ...el, holdHours: 2.5 })[1])
      && /filled 9\d min ago/.test(A.botEligibility({ ...el, openedAt: new Date(Date.now() - 95 * 60e3).toISOString() })[1] || ''));
    const pa2 = A.publicAlert({ id: 'y', t: 1, trader: 'x', address: '0xabc', raw: { a: 1 }, late: true, lateBy: 0.008, botEligible: false, botReason: 'grade B is below A',
      record: { d30: null, d7: null, trust: { grade: 'B', score: 70, gradeV2: 'C', scoreV2: 55, holdsLosers: false } } });
    ok('the public alert carries late, the bot flag and the shadow grade, never the raw row', pa2.late === true && pa2.lateBy === 0.008
      && pa2.botEligible === false && pa2.botReason && pa2.record.trust.gradeV2 === 'C' && !('raw' in pa2));
    ok('an alert from before the bot flag reads as not eligible', A.publicAlert({ id: 'z', t: 1, trader: 'x', address: '0x1' }).botEligible === false);

    // Grade v2, shadow only.
    const v0 = V2.gradeV2({ d30: strong.d30, d7: strong.d7 });
    ok('grade v2 scores without account data and says what it substituted', v0.scoreV2 >= 0 && v0.scoreV2 <= 100 && v0.v2.partial && v0.v2.subs.includes('s:fills/300'));
    const daily = Array.from({ length: 24 }, (_, i) => (i % 6 === 0 ? -2000 : 9000));
    const acct = { ret30: 0.2, mdd30: 0.05, ret7: 0.03, activeDays30: 24, dailyPnl30: daily, medAv30: 1e6, ageDays: 400, upnlPct: 0.01 };
    const vGood = V2.gradeV2({ d30: { ...strong.d30, roi: 0.1 }, d7: strong.d7, cls: { closed: 30, winRate: 0.65 }, health: acct });
    ok('grade v2 rewards a strong account', vGood.scoreV2 >= 75 && ['A', 'A+'].includes(vGood.gradeV2), JSON.stringify(vGood));
    ok('grade v2 caps a red account and a deep open loss', V2.gradeV2({ d30: strong.d30, d7: strong.d7, cls: { closed: 30, winRate: 0.65 }, health: { ...acct, ret30: -0.05 } }).scoreV2 <= 74
      && V2.gradeV2({ d30: strong.d30, d7: strong.d7, cls: { closed: 30, winRate: 0.65 }, health: { ...acct, upnlPct: -0.35 } }).scoreV2 <= 35);
    ok('grade v2: market makers and thin samples are unrated', V2.gradeV2({ d30: strong.d30, marketMaker: true }).gradeV2 === 'NR'
      && V2.gradeV2({ d30: strong.d30, cls: { closed: 5, winRate: 0.8 } }).gradeV2 === 'NR');
    ok('grade v2 rides beside the live grade and does not change it', g0.gradeV2 != null && g0.scoreV2 != null
      && G.trustGrade(strong.d30, strong.d7, 'BTC', undefined, { health: null, holdsLosers: noHL }).score === g0.score);

    // The reject log rotates at its cap rather than growing for ever.
    const store = await import(path.join(ROOT, 'lib', 'store.js'));
    for (let i = 0; i < 6; i++) store.appendJsonlCapped('rottest', { i, pad: 'x'.repeat(40) }, 100);
    const { existsSync, statSync } = await import('node:fs');
    ok('a capped log rotates to .1 and stays small', existsSync(store.jsonlPath('rottest.1')) && statSync(store.jsonlPath('rottest')).size < 200);
    ok('the reject log download is admin-only', (await get('/admin/rejects.jsonl')).status === 403 && (await get('/admin/rejects.jsonl?token=nope')).status === 403);
    const idx = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
    ok('the tag guide explains HOLDS LOSERS and LATE without an em dash', /HOLDS LOSERS/.test(idx) && /late-tag/.test(idx)
      && !idx.split('\n').filter((x) => /holds-tag|late-tag/.test(x)).some((x) => x.includes('\u2014')));
  }
  {
    // The public feed never republishes the raw Nansen row or a referral-code label, old alerts included.
    const { publicAlert } = await import(path.join(ROOT, 'lib', 'alerts.js'));
    const pa = publicAlert({ id: 'x', t: 1, trader: 'Uses "ABC" HL Referral Code', address: '0x1234567890abcdef', messageId: 7,
      raw: { trader_address_label: 'Uses "ABC" HL Referral Code' },
      record: { d30: { pnl: 5, roi: 0.1, winRate: 0.6, closed: 40, coins: 4, fees: 1, perCoin: { BTC: { pnl: 5 } } }, d7: null, trust: { grade: 'A', label: 'Strong hands', earlyStats: {} } } });
    const js = JSON.stringify(pa);
    ok('the public alert feed never prints a referral code', !/referral/i.test(js) && pa.trader === 'Smart Money wallet 0x1234...cdef', js);
    // An alerted position must stay re-checkable after a restart and after the opening alert ages out:
    // the trade row is rebuilt from the watch, and the key (hash:address:coin:opened) must survive
    // builder-dex coins that carry their own colon.
    const { rawFor } = await import(path.join(ROOT, 'lib', 'alerts.js'));
    const { tradeKey } = await import(path.join(ROOT, 'lib', 'game.js'));
    const t0 = { transaction_hash: '0xabc', trader_address: '0x1', token_symbol: 'xyz:SNDK', block_timestamp: '2026-09-18T04:11:48Z' };
    const k0 = tradeKey(t0);
    ok('a trade key rebuilds from its parts, builder-dex coins included', tradeKey({ ...t0, transaction_hash: k0.split(':')[0] }) === k0);
    ok('an unknown alerted trade has no row to rebuild', rawFor('nope:0x1:BTC:2026') === null);
    ok('the public alert feed drops the raw Nansen row and per-coin detail', !('raw' in pa) && !('messageId' in pa) && !js.includes('perCoin') && pa.record.d30.winRate === 0.6);
  }
  const drift = gradeDriftLine({ grade: 'C', score: 60 }, { grade: 'A', score: 75 });
  ok('a grade that moved since the alert is explained', drift.includes('Grade now <b>A</b>') && drift.includes('was <b>C</b>'), drift);
  ok('an unchanged grade adds nothing', gradeDriftLine({ grade: 'A' }, { grade: 'A' }) === '');
  ok('a missing grade adds nothing', gradeDriftLine(null, { grade: 'A' }) === '' && gradeDriftLine({ grade: 'C' }, null) === '');
  ok('a falling grade points down', gradeDriftLine({ grade: 'A' }, { grade: 'C' }).startsWith('\u2B07'));

  // Identical 30D and 7D columns mean the month's record was all earned in its last week. Found in
  // production on a wallet alerting at A+ 100/100 with "648 closes" under a 30D heading, which reads
  // as a month of track record and is one week's. It does NOT mean the wallet is new - that one has
  // 397 days of history and simply sat out the middle of the window - so the wording is checked here
  // too, not just the trigger.
  const newWallet = { d30: { pnl: 124191, roi: 0.09, winRate: 0.70, closed: 648, coins: 7 },
                      d7:  { pnl: 124191, roi: 0.09, winRate: 0.70, closed: 648, coins: 7 },
                      trust: { grade: 'A+', score: 100 } };
  const mNew = renderMessage({ ...wh, record: newWallet });
  ok('a wallet whose month is all one week says so', mNew.includes('One week, not a month.'));
  ok('the disclosure does not call the wallet new', !/new wallet/i.test(mNew), 'a dormant year-old wallet is not a new one');
  ok('a normal two-window wallet gets no disclosure', !renderMessage(wh).includes('One week, not a month.'));
  ok('a wallet with nothing closed in 7D gets no disclosure',
     !renderMessage({ ...wh, record: { ...wh.record, d7: null } }).includes('One week, not a month.'));
  // The disclosure travels as Telegram HTML like everything else, so it must survive the same checks.
  ok('the one-week disclosure is well-formed Telegram HTML', !balanced(mNew) || balanced(mNew) === '',
     String(balanced(mNew) || 'ok'));

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
  // ---- the hands are not independent draws, and the error bars have to know it ----
  // Where every hand really does come from its own wallet, the cluster-robust error must reduce to
  // the textbook one EXACTLY. If it does not, the clustering arithmetic is simply wrong.
  // ---- the pager must not stop after one page ----
  // This one cost a day: `is_last_page !== false` ended the loop after page one whenever the
  // response had no pagination block, and because the feed is ordered newest-first and pool()
  // discards anything younger than MAX_HOLD, the training pool silently stayed small. Every
  // response shape the API can return is pinned here so it cannot happen again.
  {
    // Recalibration: if dealt hands win more often than quoted, the shift moves the quote up, stays
    // bounded, and does nothing on a sample too small to trust.
    const odds = await import(path.join(ROOT, 'lib', 'odds.js'));
    const rows = Array.from({ length: 300 }, (_, i) => ({ p: 0.6, won: i % 5 !== 0 }));   // quoted 60%, won 80%
    const rc = odds.recalibrate(rows);
    ok('recalibration moves the odds toward what dealt hands actually did', rc.offset > 0.5 && rc.offset <= 1 && rc.n === 300);
    const q = 1 / (1 + Math.exp(-(Math.log(0.6 / 0.4) + rc.offset)));
    ok('after recalibration, always following is no longer free money', 0.8 / q - 1 < 0.04, `quote ${q.toFixed(3)}`);
    ok('recalibration ignores a sample too small to trust', odds.recalibrate(rows.slice(0, 10)).offset === 0);
    odds.recalibrate([]);
    // A reason shown next to a price must pull the same way as the live model does, whatever a
    // textbook would say: "good" is the sign of weight x value, never an assumed direction.
    for (const funding of [0.5, -0.5]) {
      const f = { walletEdge: 0.1, smFlow: 0.4, crowdFlow: 0.3, funding, size: 0 };
      const rs = odds.reasons(f, { wallet: { closed_trade_count: 40, win_rate: 0.6 }, sm: { volume: 1 }, crowd: { volume: 1 }, coin: 'BTC', side: 'Long' });
      const w = odds.getModel();
      const agree = rs.every((r) => {
        const k = /wallet won/.test(r.text) ? 'walletEdge' : /Smart Money flow/.test(r.text) ? 'smFlow' : /crowd/.test(r.text) ? 'crowdFlow' : /funding/.test(r.text) ? 'funding' : null;
        return !k || r.good === ((w[k] || 0) * f[k] >= 0);
      });
      ok(`reasons agree with the live weights (funding ${funding > 0 ? 'paid' : 'received'})`, agree, JSON.stringify(rs));
    }
  }
  const { wantsNextPage, whaleName, traced, post } = await import(path.join(ROOT, 'lib', 'nansen.js'));
  // A Nansen label that is only a referral code is never printed: that would advertise the code.
  ok('referral-code labels are shown as a short address', whaleName('Uses "ABC" HL Referral Code', '0x1234567890abcdef') === 'Smart Money wallet 0x1234...cdef');
  ok('real Nansen labels are kept', whaleName('Smart HL Perps Trader', '0x1') === 'Smart HL Perps Trader');
  {
    process.env.DEMO = '1';
    const { calls } = await traced(() => post('perp-screener', { filters: { token_symbol: 'BTC', trader_type: 'sm' } }, 60));
    ok('traced() records the Nansen calls made inside it', calls.length === 1 && calls[0].endpoint === 'perp-screener' && calls[0].cohort === 'sm');
  }
  {
    const { brier } = await import(path.join(ROOT, 'lib', 'proof.js'));
    const rows = Array.from({ length: 40 }, (_, i) => ({ p: 0.7, won: i % 4 !== 0, ret: i % 4 ? 0.01 : -0.01, resolved: true }));
    const b = brier(rows, 0.6);
    ok('Brier is compared with the trained base rate, not only the hindsight one', b && b.priorReference != null && b.prior === 0.6 && b.priorReference > b.reference);
  }
  ok('a full page with no pagination block asks for the next one',
     wantsNextPage({ data: [] }, 500, 500) === true);
  ok('a short page ends the paging', wantsNextPage({ data: [] }, 137, 500) === false);
  ok('the API saying last page ends the paging',
     wantsNextPage({ pagination: { is_last_page: true } }, 500, 500) === false);
  ok('the API saying NOT last page keeps going',
     wantsNextPage({ pagination: { is_last_page: false } }, 500, 500) === true);
  ok('an empty page ends the paging', wantsNextPage({}, 0, 500) === false);

  // ---- the holdout is what makes the clean record clean ----
  const keys = Array.from({ length: 5000 }, (_, i) => `h${i}:0xabc${i}:BTC:2026-09-${(i % 28) + 1}`);
  const share = keys.filter(proof.isHoldout).length / keys.length;
  ok('about one trade in five is held out of training', share > 0.17 && share < 0.23, share.toFixed(3));
  ok('the holdout is deterministic', keys.every((k) => proof.isHoldout(k) === proof.isHoldout(k)));
  // Four tests on one set of hands: a result that clears 5% on its own must not survive as
  // "significant" once the family is accounted for.
  const edge = [...rows(260, 0.6, 0.76, true), ...rows(260, 0.6, 0.68, false)];
  const E = proof.populations(edge);
  const fam = [E.tests.winRate.vsAll, E.tests.winRate.vsRejected, E.tests.return.vsAll, E.tests.return.vsRejected].filter(Boolean);
  ok('an adjusted p is never smaller than the raw one', fam.every((x) => x.pAdj >= x.pRaw - 1e-12));
  ok('significance is judged on the adjusted p', fam.every((x) => x.significant === (x.pAdj < 0.05)));

  const solo = proof.meanStats([1, -1, 0.3, -1, 0.5, -1, 0.25, -1, 2, -1], Array.from({ length: 10 }, (_, i) => 'w' + i));
  ok('with one hand per wallet the clustered error equals the textbook one',
     Math.abs(solo.seCluster - solo.seIid) < 1e-12, `${solo.seCluster} vs ${solo.seIid}`);
  // THE REPLICATION TRAP, which is the whole reason this exists. Ten wallets either side, six good
  // and four bad; copy each wallet's hands thirty times. Nothing new has been learned, so nothing
  // about the estimate or its uncertainty may move. A test that treats hands as independent sees
  // thirty times the evidence and announces a discovery.
  const clustered = (rep) => {
    const out = [];
    for (let w = 0; w < 10; w++) for (let i = 0; i < rep; i++) out.push({ p: 0.6, won: w < 6, push: false, pool: true, addr: 'f' + w });
    for (let w = 0; w < 10; w++) for (let i = 0; i < rep; i++) out.push({ p: 0.6, won: w < 4, push: false, pool: false, addr: 'r' + w });
    return out;
  };
  const thin = proof.populations(clustered(1)), fat = proof.populations(clustered(30));
  ok('duplicating a wallet does not move the estimate',
     Math.abs(thin.difference - fat.difference) < 1e-12, `${thin.difference} vs ${fat.difference}`);
  ok('duplicating a wallet thirty times does not shrink the error bar',
     Math.abs(thin.differenceSe - fat.differenceSe) < 1e-12,
     `se ${thin.differenceSe.toFixed(5)} -> ${fat.differenceSe.toFixed(5)}`);
  ok('the naive test would have been fooled by it, so the guard is earning its keep',
     Math.abs(fat.difference) > 1.96 * (thin.differenceSe / Math.sqrt(30)));
  ok('thirty-times-duplicated wallets are still not called significant', !fat.significant,
     `z ${(fat.difference / fat.differenceSe).toFixed(2)}`);
  // ALL contains FILTERED, so those two are not independent samples. Written as a contrast over the
  // disjoint groups, filtered-vs-all is an exact rescaling of filtered-vs-rejected when nothing is
  // unassessed - same z, to the last decimal. Quadrature gets this wrong, which is the point.
  const disj = [
    ...Array.from({ length: 220 }, (_, i) => ({ p: 0.6, won: i % 100 < 78, push: false, pool: true, addr: 'f' + i })),
    ...Array.from({ length: 180 }, (_, i) => ({ p: 0.6, won: i % 100 < 61, push: false, pool: false, addr: 'r' + i }))];
  const D = proof.populations(disj);
  ok('with nothing unassessed, the two comparisons agree on z',
     D.unknown === 0 && Math.abs(D.tests.return.vsAll.z - D.tests.return.vsRejected.z) < 1e-9,
     `${D.tests.return.vsAll.z.toFixed(6)} vs ${D.tests.return.vsRejected.z.toFixed(6)}`);
  // The two claims are scored apart, because the easy one can pass while the hard one is still open.
  ok('win rate and return are tested separately',
     D.tests.winRate.vsAll && D.tests.return.vsAll
     && D.tests.winRate.vsAll.diff !== D.tests.return.vsAll.diff,
     `win ${D.tests.winRate.vsAll.diff.toFixed(4)}, return ${D.tests.return.vsAll.diff.toFixed(4)}`);
  // A population measured against itself differs from itself by nothing at all.
  const selfOnly = proof.populations(Array.from({ length: 200 }, (_, i) =>
    ({ p: 0.6, won: i % 100 < 70, push: false, pool: true, addr: 'f' + i })));
  ok('a population compared with itself shows no difference',
     Math.abs(selfOnly.difference) < 1e-12, String(selfOnly.difference));
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
