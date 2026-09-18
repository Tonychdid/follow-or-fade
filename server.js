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
const waitlist = await import('./lib/waitlist.js');
const agent = await import('./lib/agent.js');
const PORT = Number(process.env.PORT || 3000);
// PUBLIC=1 when hosted for everyone: alert settings / Telegram become admin-only and the API is rate limited.
const PUBLIC = process.env.PUBLIC === '1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' };

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => {
  let d = '', done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  req.on('data', (c) => { d += c; if (d.length > 20_000) { req.destroy(); finish({}); } });
  req.on('end', () => { try { const v = JSON.parse(d || '{}'); finish(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { finish({}); } });
  req.on('aborted', () => finish({})); req.on('error', () => finish({}));
});
// constant-time compare of fixed-length digests (never throws on odd input)
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const isAdmin = (req) => !PUBLIC || (!!ADMIN_TOKEN && crypto.timingSafeEqual(sha(req.headers['x-admin-token'] || ''), sha(ADMIN_TOKEN)));
const forbid = () => Promise.reject(Object.assign(new Error('Admin only'), { status: 403 }));
const admin = (fn) => (b, q, req) => (isAdmin(req) ? fn(b, q, req) : forbid());

// Simple per-IP rate limiting for the public site (token bucket per minute).
const buckets = new Map();
function limited(req, cost = 1, perMin = 240) {
  if (!PUBLIC) return false;
  // the proxy (Railway) appends the real client address last; anything earlier in X-Forwarded-For can be forged
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = String(req.headers['x-real-ip'] || xff[xff.length - 1] || req.socket.remoteAddress || '');
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: perMin, t: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.t) / 60e3) * perMin); b.t = now;
  b.tokens -= cost;
  buckets.set(ip, b);
  if (buckets.size > 50000) { for (const [k, v] of buckets) if (now - v.t > 120e3) buckets.delete(k); } // drop idle clients only
  return b.tokens < 0;
}
const COST = { 'POST /api/player': 20, 'GET /api/round': 4, 'GET /api/live': 2, 'POST /api/alerts/scan': 30, 'POST /api/alerts/test': 30, 'POST /api/waitlist': 20, 'GET /api/research/intel': 3, 'GET /api/live/one': 2 };

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /api/status': async () => ({ ...game.stats(), usage: nansen.getUsage(), public: PUBLIC, beta: waitlist.beta(), ref: { url: process.env.NANSEN_REF_URL || 'https://nsn.ai/avyrion', code: process.env.NANSEN_PROMO_CODE || 'AVYRION' } }),
  'POST /api/player': async (b) => game.createPlayer(b.name),
  'GET /api/player': async (_, q) => game.getPlayer(q.get('id')) ?? Promise.reject(Object.assign(new Error('Unknown player'), { status: 404 })),
  'GET /api/round': async (_, q) => game.newRound(q.get('player')),
  'POST /api/bet': async (b) => game.placeBet(b.player, b.roundId, b.choice, b.stake),
  'GET /api/alerts': async (_, q, req) => ({ alerts: alerts.listAlerts(Number(q.get('since') || 0)), config: alerts.publicConfig(isAdmin(req)) }),
  'POST /api/alerts/config': admin(async (b, _, req) => ({ ...alerts.updateConfig(b), canAdmin: isAdmin(req) })),
  'POST /api/alerts/scan': admin(async (_, __, req) => ({ created: await alerts.scan({ force: true }), config: alerts.publicConfig(isAdmin(req)) })),
  'POST /api/alerts/test': admin(async () => alerts.testAlert()),
  'POST /api/alerts/telegram': admin(async (b) => alerts.connectTelegram(b.token)),
  'POST /api/alerts/telegram/verify': admin(async () => alerts.verifyTelegram()),
  'POST /api/alerts/telegram/disconnect': admin(async () => alerts.disconnectTelegram()),
  'GET /api/report': async (_, q) => game.skillReport(q.get('player')),
  'GET /api/leaderboard': async () => game.leaderboard(),
  'GET /api/live': async () => game.liveFeed(),
  'GET /api/live/one': async (_, q) => game.refreshLiveItem(q.get('key')),
  'POST /api/live/bet': async (b) => game.placeLiveBet(b.player, b.key, b.choice, b.stake, b.minutes),
  'POST /api/live/cashout': async (b) => game.cashOut(b.player, b.betId),
  'POST /api/waitlist': async (b) => waitlist.join(b),
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
const renderIndex = () => (indexHtml ??= fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replaceAll('{{PUBLIC_URL}}', PUBLIC_URL));

http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) { console.error('[http]', e.message); try { if (!res.headersSent) { res.writeHead(400); } res.end(); } catch {} }
}).listen(PORT, () => {
  console.log(`\n  FOLLOW or FADE  ->  http://localhost:${PORT}`);
  console.log(nansen.isDemo() ? '  Mode: DEMO DATA (add NANSEN_API_KEY to .env for live Nansen data)' : '  Mode: LIVE Nansen API');
  if (PUBLIC) console.log(`  Public mode: rate limited, alert settings are admin-only${ADMIN_TOKEN ? '' : ' (set ADMIN_TOKEN to manage them)'}`);
  if (process.env.DAILY_CREDIT_CAP) console.log(`  Daily Nansen credit cap: ${process.env.DAILY_CREDIT_CAP}`);
  console.log('');
});
// never let one bad request or background hiccup take the whole site down
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message || e));

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('Bad request'); }
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
  // Admin download of the waitlist: open /admin/waitlist.csv?token=YOUR_ADMIN_TOKEN in a browser
  if (url.pathname === '/admin/waitlist.csv') {
    req.headers['x-admin-token'] = url.searchParams.get('token') || '';
    if (!isAdmin(req)) { res.writeHead(403); return res.end('Admin only'); }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="waitlist.csv"', 'Cache-Control': 'no-store', ...SECURITY });
    return res.end(waitlist.csv());
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SECURITY });
    return res.end(renderIndex());
  }
  const file = path.join(ROOT, 'public', path.normalize(url.pathname));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300', ...SECURITY });
  fs.createReadStream(file).on('error', () => { try { res.end(); } catch {} }).pipe(res);
}

// Background jobs: calibrate odds on this week's Smart Money outcomes, settle live bets, scan for whale alerts.
const calibrate = () => game.calibrate().then((m) => m.n && console.log(`  Odds calibrated on ${m.n} resolved Smart Money trades`)).catch((e) => console.error('[calibrate]', e.message));
setTimeout(calibrate, 2000);
setTimeout(() => alerts.scan().catch(() => {}), 8000);
alerts.schedule();
setInterval(() => alerts.checkExits().catch(() => {}), 2 * 60e3);
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
