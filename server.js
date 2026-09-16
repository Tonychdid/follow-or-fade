import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);
loadEnv(ROOT);

const nansen = await import('./lib/nansen.js');
const game = await import('./lib/game.js');
const PORT = Number(process.env.PORT || 3000);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } }); });

const routes = {
  'GET /api/status': async () => ({ ...game.stats(), usage: nansen.getUsage() }),
  'POST /api/player': async (b) => game.createPlayer(b.name),
  'GET /api/player': async (_, q) => game.getPlayer(q.get('id')) ?? Promise.reject(Object.assign(new Error('Unknown player'), { status: 404 })),
  'GET /api/round': async (_, q) => game.newRound(q.get('player')),
  'POST /api/bet': async (b) => game.placeBet(b.player, b.roundId, b.choice, b.stake),
  'GET /api/leaderboard': async () => game.leaderboard(),
  'GET /api/live': async () => game.liveFeed(),
  'POST /api/live/bet': async (b) => game.placeLiveBet(b.player, b.key, b.choice, b.stake, b.minutes),
  'POST /api/live/cashout': async (b) => game.cashOut(b.player, b.betId),
  'GET /api/live/bets': async (_, q) => { await game.settleLive(); return game.liveBetsFor(q.get('player')); },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try { json(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}, url.searchParams)); }
    catch (e) { console.error('[api]', url.pathname, e.message); json(res, e.status || 500, { error: e.message, code: e.code }); }
    return;
  }
  const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`\n  FOLLOW or FADE  ->  http://localhost:${PORT}`);
  console.log(nansen.isDemo() ? '  Mode: DEMO DATA (add NANSEN_API_KEY to .env for live Nansen data)\n' : '  Mode: LIVE Nansen API\n');
});

// Background jobs: calibrate odds on this week's Smart Money outcomes, settle live bets.
const calibrate = () => game.calibrate().then((m) => m.n && console.log(`  Odds calibrated on ${m.n} resolved Smart Money trades`)).catch((e) => console.error('[calibrate]', e.message));
setTimeout(calibrate, 2000);
setInterval(calibrate, 60 * 60e3);
setInterval(() => game.settleLive().catch(() => {}), 5e3);
