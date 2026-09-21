import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);
loadEnv(ROOT);

const nansen = await import('./lib/nansen.js');
const game = await import('./lib/game.js');
const alerts = await import('./lib/alerts.js');
const excluded = await import('./lib/excluded.js');
const agent = await import('./lib/agent.js');
const roster = await import('./lib/roster.js');
const store = await import('./lib/store.js');
const PORT = Number(process.env.PORT || 3000);
// PUBLIC=1 when hosted for everyone: alert settings / Telegram become admin-only and the API is rate limited.
const PUBLIC = process.env.PUBLIC === '1';
// Rate limiting defaults ON. A dropped variable must cost a limit nobody wanted, never remove one.
const LIMITED = process.env.RATE_LIMIT !== '0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
// SHOW_PLANS=1 reveals the free-beta strip. Left unset, both stay hidden and the
// strip implies a future paid tier, which is what the short legal notice (LCEN art. 1-1, II) cannot
// sit beside. The Premium page itself is always shown: it offers nothing for sale. Deliberately
// opt-IN: a redeploy that loses an environment variable hides the claim rather than exposing it.
const SHOW_PLANS = process.env.SHOW_PLANS === '1';
// SHOW_LEGAL=1 publishes public/legal-full.html (the risk notice, the privacy notice and the terms).
// Off by default while the site is free and makes no offer; /legal.html (the legal notice) is always
// served. Opt-in for the same reason as SHOW_PLANS: losing the variable hides a page rather than
// publishing one that is out of date.
const SHOW_LEGAL = process.env.SHOW_LEGAL === '1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
// Everything is same-origin: fonts are self-hosted, so no visitor request reaches a third party.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': CSP, ...(process.env.PUBLIC === '1' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) };

const json = (res, code, body) => {
  let out; // stringify first: a failure after writeHead would leave a half-sent 200
  try { out = JSON.stringify(body); } catch { code = 500; out = '{"error":"Something went wrong on the table. Try again in a moment."}'; }
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY });
  res.end(out);
};
const readBody = (req) => new Promise((resolve) => {
  let d = '', done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  req.on('data', (c) => { d += c; if (d.length > 20_000) { req.destroy(); finish({}); } });
  req.on('end', () => { try { const v = JSON.parse(d || '{}'); finish(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { finish({}); } });
  req.on('aborted', () => finish({})); req.on('error', () => finish({}));
});
// constant-time compare of fixed-length digests (never throws on odd input)
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
// Fail CLOSED whenever an admin token exists: a missing PUBLIC=1 on a redeploy must never turn the
// Telegram routes and the trader opt-out into open endpoints. Only a deployment with no token at all
// (a local dev run) is trusted by default.
// Fail CLOSED on the ABSENCE of the token, not on the absence of PUBLIC. The old form fell back to
// `!PUBLIC`, so a deploy that lost BOTH variables (or set PUBLIC=true rather than PUBLIC=1) served an
// open admin panel: anonymous opt-out of every whale, and a writable Telegram token. Local dev keeps
// its convenience behind an explicit opt-in instead of behind a missing variable.
const DEV_OPEN_ADMIN = process.env.DEV_OPEN_ADMIN === '1';
const isAdmin = (req) => (ADMIN_TOKEN
  ? crypto.timingSafeEqual(sha(req.headers['x-admin-token'] || ''), sha(ADMIN_TOKEN))
  : DEV_OPEN_ADMIN && !PUBLIC);
const forbid = () => Promise.reject(Object.assign(new Error('Admin only'), { status: 403 }));
const admin = (fn) => (b, q, req) => (isAdmin(req) ? fn(b, q, req) : forbid());

// Simple per-IP rate limiting for the public site (token bucket per minute).
const buckets = new Map();
function limited(req, cost = 1, perMin = 240) {
  if (!LIMITED) return false;
  // the proxy (Railway) appends the real client address last; anything earlier in X-Forwarded-For can be forged
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Only the LAST hop is written by the proxy; x-real-ip is not used at all because a client can send
  // its own copy and Node merges duplicate headers, which would hand every request a fresh bucket.
  let ip = String(xff[xff.length - 1] || req.socket.remoteAddress || '');
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':'); // one IPv6 /64 is one client, not 2^64
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: perMin, t: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.t) / 60e3) * perMin); b.t = now;
  // Floor the debt at one minute's worth: without this, a burst buys hours of lockout for everyone
  // sharing that address (mobile CGNAT, an office proxy, a school).
  b.tokens = Math.max(-perMin, b.tokens - cost);
  buckets.set(ip, b);
  if (buckets.size > 20000) { // evict the oldest rather than clearing, which would wipe every debt
    const old = [...buckets].sort((a, b2) => a[1].t - b2[1].t).slice(0, 5000);
    for (const [k] of old) buckets.delete(k);
  }
  return b.tokens < 0;
}
// Sweep idle clients on a timer, never inside a request.
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (now - v.t > 120e3) buckets.delete(k); }, 60e3).unref();
// routes that hit Hyperliquid or Nansen cost more tokens than a plain page read
const COST = { 'POST /api/player': 20, 'GET /api/round': 4, 'GET /api/live': 2, 'POST /api/alerts/scan': 30, 'POST /api/alerts/test': 30, 'POST /api/optout': 40, 'GET /api/research/intel': 3, 'GET /api/live/one': 6, 'GET /api/challenge': 2, 'GET /api/result': 2, 'GET /api/preview': 2,
  'POST /api/live/bet': 4, 'POST /api/live/cashout': 4, 'POST /api/research/pick/bet': 4, 'GET /api/live/bets': 2, 'POST /api/bet': 2,
  'GET /api/status': 2, 'GET /api/leaderboard': 3, 'GET /api/alerts': 2 };

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /api/status': async () => ({ ...game.stats(), usage: nansen.getUsage(), public: PUBLIC, beta: { status: 'free-beta' }, plans: SHOW_PLANS, rideMaxHours: game.rideMaxHours() }),
  'POST /api/player': async (b) => game.createPlayer(b.name),
  'GET /api/player': async (_, q) => game.getPlayer(q.get('id')) ?? Promise.reject(Object.assign(new Error('Unknown player'), { status: 404 })),
  'GET /api/preview': async () => ({ hand: game.peekHand() }), // the front door shows the hand you're about to play
  'GET /api/round': async (_, q) => game.newRound(q.get('player'), q.get('challenge')),
  'GET /api/usage': admin(async () => nansen.getUsageDetail()),
  'GET /api/result': async (_, q) => ({ result: game.resultView(q.get('id')) }),
  'GET /api/challenge': async (_, q) => ({ challenge: game.challengeView(q.get('id')) }),
  'POST /api/bet': async (b) => game.placeBet(b.player, b.roundId, b.choice, b.stake),
  'GET /api/alerts': async (_, q, req) => ({ alerts: alerts.listAlerts(Number(q.get('since') || 0)), config: alerts.publicConfig(isAdmin(req)) }),
  'POST /api/alerts/config': admin(async (b, _, req) => ({ ...alerts.updateConfig(b), canAdmin: isAdmin(req) })),
  'POST /api/alerts/scan': admin(async (_, __, req) => ({ created: await alerts.scan({ force: true }), config: alerts.publicConfig(isAdmin(req)) })),
  'POST /api/alerts/test': admin(async () => alerts.testAlert()),
  'POST /api/alerts/telegram': admin(async (b) => alerts.connectTelegram(b.token)),
  'POST /api/alerts/telegram/verify': admin(async () => alerts.verifyTelegram()),
  'POST /api/alerts/telegram/disconnect': admin(async () => alerts.disconnectTelegram()),
  'POST /api/alerts/telegram/repair': admin(async () => alerts.repairTelegram()),
  'GET /api/report': async (_, q) => game.skillReport(q.get('player')),
  'GET /api/leaderboard': async () => game.leaderboard(),
  'GET /api/live': async () => game.liveFeed(),
  'GET /api/live/one': async (_, q) => game.refreshLiveItem(q.get('key')),
  'POST /api/live/bet': async (b) => game.placeLiveBet(b.player, b.key, b.choice, b.stake, b.minutes),
  'POST /api/live/cashout': async (b) => game.cashOut(b.player, b.betId),
  // Art. 21 objections come in by email and are actioned by the operator, who first checks that the
  // person controls the wallet (a signed message). There is deliberately NO public route: an
  // unverified one would let any visitor blank the game's content by excluding the whales it shows,
  // and a public "is this address excluded?" check would publish who had asked to be hidden.
  'POST /api/optout': admin(async (b) => { const r = excluded.exclude(b.address, b.note); game.forgetTrader(b.address); return r; }),
  'POST /api/optout/undo': admin(async (b) => excluded.unexclude(b.address)),
  'GET /api/optout': admin(async (_, q) => ({ excluded: excluded.isExcluded(q.get('address')), count: excluded.count() })),
  // Research Desk (Nansen Agent)
  'GET /api/research/intel': async (_, q) => {
    const coin = q.get('coin') || '';
    const pickCoin = agent.insiderPick().pick?.coin;
    if (!agent.isStock(coin)) return { status: 'unsupported' };
    if (!game.liveCoins().has(coin) && coin !== pickCoin) return agent.companyIntel(coin, { start: false });
    const r = agent.companyIntel(coin);
    return r.status === 'loading' && q.get('wait') ? agent.waitIntel(coin, 20e3) : r;
  },
  'GET /api/research/pick': async (_, q) => game.pickView(q.get('player')),
  'POST /api/research/pick/bet': async (b) => game.placePickBet(b.player, b.choice, b.stake, b.days),
  'GET /api/live/bets': async (_, q) => game.liveBetsFor(q.get('player')),
};

// index.html gets absolute social-preview URLs when PUBLIC_URL is set (X needs absolute image links)
let indexHtml = null;
const renderIndex = () => (indexHtml ??= fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replaceAll('{{PUBLIC_URL}}', () => PUBLIC_URL));

const server = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) { console.error('[http]', e.message); try { if (!res.headersSent) { res.writeHead(400); } res.end(); } catch {} }
});
server.listen(PORT, () => {
  console.log(`\n  FOLLOW or FADE  ->  http://localhost:${PORT}`);
  console.log(nansen.isDemo() ? '  Mode: DEMO DATA (add NANSEN_API_KEY to .env for live Nansen data)' : '  Mode: LIVE Nansen API');
  if (PUBLIC) console.log(`  Public mode: rate limited, alert settings are admin-only${ADMIN_TOKEN ? '' : ' (set ADMIN_TOKEN to manage them)'}`);
  if (process.env.DAILY_CREDIT_CAP) console.log(`  Daily Nansen credit cap: ${process.env.DAILY_CREDIT_CAP}`);
  console.log('');
});
server.requestTimeout = 20_000;   // a slowloris body can't hold a socket for the 300s default
server.headersTimeout = 10_000;
server.maxConnections = 2000;
server.on('error', (e) => { console.error('[server]', e.message); process.exit(1); }); // a bind failure must be loud
// never let one bad request or background hiccup take the whole site down
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message || e));

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('Bad request'); }
  // Every POST must be a same-origin JSON request. Without this, a cross-site form with
  // enctype="text/plain" is a CORS "simple request" that reaches these routes using the victim's IP.
  if (req.method === 'POST') {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send JSON' });
    const o = req.headers.origin;
    if (o && o !== (PUBLIC_URL || `http://${req.headers.host}`) && o !== `https://${req.headers.host}`) {
      return json(res, 403, { error: 'Bad origin' });
    }
  }
  const key = `${req.method} ${url.pathname}`;
  const route = routes[key];
  if (route) {
    if (limited(req, COST[key] || 1)) return json(res, 429, { error: 'Easy, high roller. Too many requests, try again in a moment.' });
    try { json(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}, url.searchParams, req)); }
    catch (e) {
      if (e.status !== 403) console.error('[api]', url.pathname, e.message);
      // expected errors carry a status and a player-friendly message; anything else stays in the logs
      json(res, e.status || 500, e.status ? { error: e.message, code: e.code } : { error: 'Something went wrong on the table. Try again in a moment.' });
    }
    return;
  }
  // Browser-openable credit ledger: /admin/usage.json?token=YOUR_ADMIN_TOKEN
  // The API route needs an x-admin-token header, which you cannot set from an address bar.
  if (url.pathname === '/admin/usage.json') {
    const t = url.searchParams.get('token') || '';
    if (!ADMIN_TOKEN || t.length !== ADMIN_TOKEN.length
        || !crypto.timingSafeEqual(sha(t), sha(ADMIN_TOKEN))) {
      if (limited(req, 10)) return json(res, 429, { error: 'Too many requests' });
      return json(res, 403, { error: 'Admin only' });
    }
    return json(res, 200, { nansen: nansen.getUsageDetail(), agent: agent.status() });
  }
  // Browser-openable admin views, same token-in-the-URL pattern as the ledger above.
  //   /admin/roster.json   who is in the whale pool right now, who entered, who dropped and why
  //   /admin/journal.jsonl every alert ever sent and how the whale's position ended (the study data)
  if (url.pathname === '/admin/roster.json' || url.pathname === '/admin/journal.jsonl') {
    const t = url.searchParams.get('token') || '';
    if (!ADMIN_TOKEN || t.length !== ADMIN_TOKEN.length
        || !crypto.timingSafeEqual(sha(t), sha(ADMIN_TOKEN))) {
      if (limited(req, 10)) return json(res, 429, { error: 'Too many requests' });
      return json(res, 403, { error: 'Admin only' });
    }
    if (url.pathname === '/admin/roster.json') {
      return json(res, 200, { current: roster.lastRoster(), due: roster.isDue(), everyDays: roster.ROSTER_DAYS(), history: roster.rosterHistory(20) });
    }
    // Streamed straight off disk: this file is meant to grow for months and must never be
    // read into memory whole just to be handed over.
    const jp = store.jsonlPath('alertjournal');
    if (!fs.existsSync(jp)) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson', ...SECURITY }); return res.end(''); }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="alertjournal.jsonl"', ...SECURITY });
    return fs.createReadStream(jp).on('error', () => { try { res.end(); } catch {} }).pipe(res);
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SECURITY });
    return res.end(renderIndex());
  }
  const file = path.join(ROOT, 'public', path.normalize(url.pathname));
  // legal-full.html is unpublished unless SHOW_LEGAL=1 — a plain 404, so its existence isn't advertised.
  // Gate on the RESOLVED path, never on url.pathname: '//legal-full.html' survives URL parsing intact and
  // only collapses to '/legal-full.html' in path.normalize above, so a raw-pathname test is bypassable.
  const GATED = !SHOW_LEGAL ? [path.join(ROOT, 'public', 'legal-full.html')] : [];
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || GATED.includes(file)
      || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (limited(req, 5)) return json(res, 429, { error: 'Too many requests' }); // a flood of unknown paths is still a flood
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(file);
  if (limited(req, ext === '.woff2' ? 1 : 2)) return json(res, 429, { error: 'Too many requests' });
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=300', ...SECURITY });
  fs.createReadStream(file).on('error', () => { try { res.end(); } catch {} }).pipe(res);
}

// Background jobs: calibrate odds on this week's Smart Money outcomes, settle live bets, scan for whale alerts.
const calibrate = () => game.calibrate().then((m) => m.n && console.log(`  Odds calibrated on ${m.n} resolved Smart Money trades`)).catch((e) => console.error('[calibrate]', e.message));
setTimeout(calibrate, 2000);
setTimeout(() => alerts.scan().catch(() => {}), 8000);
alerts.schedule();
// The whale pool re-assesses itself every ROSTER_DAYS (7): new whales in, non-performers out, with a
// written diff each time. Delayed on boot so it never competes with the first alert scan.
setTimeout(() => roster.assessPool().catch(() => {}), 45e3);
roster.schedule();
setInterval(() => alerts.checkExits().catch(() => {}), 60e3); // exits are real-money signals: check every minute
setTimeout(() => alerts.backfillWatches().catch(() => {}), 15e3);
setTimeout(() => alerts.startTelegramPoll(), 10e3); // listen for the 🔄 Re-check button on Telegram alerts // exit alerts: whales we alerted on trimming or closing
setInterval(calibrate, 60 * 60e3);
setInterval(() => game.settleLive().catch(() => {}), 5e3);
// keep the Live Floor warm (whale data is cached per hour, the trade feed per 15 min)
setTimeout(() => game.liveFeed().catch(() => {}), 5000);
// keep a deck of ready training hands so the Training Table deals instantly
setTimeout(() => game.refillDeck().catch(() => {}), 3000);
setInterval(() => game.refillDeck().catch(() => {}), 5 * 60e3);
setInterval(() => game.liveFeed().catch(() => {}), 5 * 60e3);
// Research Desk: one Nansen Agent Expert screen per UTC day for the Insider Pick, then Fast briefs for stock whales on the floor
setTimeout(() => agent.ensurePick().catch(() => {}), 20e3);
setInterval(() => agent.ensurePick().catch(() => {}), 30 * 60e3);
setInterval(async () => {
  const coins = [...game.liveCoins()].filter(agent.isStock).slice(0, 3);
  for (const c of coins) agent.companyIntel(c);
}, 10 * 60e3);
