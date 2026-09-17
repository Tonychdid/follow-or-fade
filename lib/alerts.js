// Whale Watch: scans Nansen Smart Money perp opens and alerts when a whale with a strong track record opens a position.
import crypto from 'node:crypto';
import * as nansen from './nansen.js';
import * as game from './game.js';
import * as agent from './agent.js';
import * as hl from './hyperliquid.js';
import { load, save } from './store.js';

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
const GRADE_RANK = { 'A+': 5, A: 4, B: 3, C: 2, D: 1, F: 0, '?': -1 };

const DEFAULTS = {
  enabled: true, minGrade: 'A', minWinRate: 0.55, minClosed: 20, minCoins7d: 3, minCoins30d: 5, allowSpecialists: true, minSizeUsd: 50000, requireProfit30d: true,
  intervalMin: 5, telegram: { token: '', chatId: '', botName: '' },
};
const cfg = load('alertcfg', DEFAULTS);
for (const [k, v] of Object.entries(DEFAULTS)) if (cfg[k] === undefined) cfg[k] = v;
const alerts = load('alerts', []);         // newest last
const seen = load('alertseen', {});        // tradeKey -> ts
const watches = load('alertwatch', []);    // alerted positions we keep following until the whale exits
let lastScan = null, lastError = null, timer = null;

export function publicConfig(canAdmin = true) {
  const { telegram, ...rest } = cfg;
  return { ...rest, telegram: { connected: !!(telegram.token && telegram.chatId), hasToken: !!telegram.token, botName: telegram.botName },
    lastScan, lastError, estCreditsPerDay: Math.round((24 * 60) / cfg.intervalMin) * 5, canAdmin };
}

export function updateConfig(patch = {}) {
  if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
  if (patch.minGrade in GRADE_RANK && patch.minGrade !== '?') cfg.minGrade = patch.minGrade;
  if ([0, 0.5, 0.55, 0.6, 0.65, 0.7].includes(Number(patch.minWinRate))) cfg.minWinRate = Number(patch.minWinRate);
  if ([10000, 25000, 50000, 100000, 250000, 1000000].includes(Number(patch.minSizeUsd))) cfg.minSizeUsd = Number(patch.minSizeUsd);
  if ([2, 5, 10, 15, 30].includes(Number(patch.intervalMin))) cfg.intervalMin = Number(patch.intervalMin);
  if ([0, 2, 3, 4, 5, 8].includes(Number(patch.minCoins7d))) cfg.minCoins7d = Number(patch.minCoins7d);
  if ([0, 3, 4, 5, 8, 12].includes(Number(patch.minCoins30d))) cfg.minCoins30d = Number(patch.minCoins30d);
  if (typeof patch.allowSpecialists === 'boolean') cfg.allowSpecialists = patch.allowSpecialists;
  if (typeof patch.requireProfit30d === 'boolean') cfg.requireProfit30d = patch.requireProfit30d;
  save('alertcfg', cfg);
  schedule();
  return publicConfig();
}

export const listAlerts = (since = 0) => alerts.filter((a) => a.t > since).slice(-50).reverse();

/** Does this whale deserve an alert? Returns 'standard' | 'specialist', or null. */
function qualifies(rec, coin) {
  const d30 = rec.d30, trust = rec.trust;
  if (!d30 || d30.closed < cfg.minClosed) return null;
  if (cfg.requireProfit30d && !(d30.pnl > 0)) return null;
  const standard = GRADE_RANK[trust.grade] >= GRADE_RANK[cfg.minGrade]
    && (d30.winRate ?? 0) >= cfg.minWinRate
    // a high win rate on one or two coins is easy to inflate; require breadth
    && (d30.coins || 0) >= cfg.minCoins30d
    && ((rec.d7 && rec.d7.coins) || 0) >= cfg.minCoins7d;
  if (standard) return 'standard';
  // Specialist path: few coins, but proven realized profit on the exact coin being opened.
  if (cfg.allowSpecialists && game.isSpecialist(d30, rec.d7, coin)) return 'specialist';
  return null;
}

export async function scan({ force = false } = {}) {
  if (!cfg.enabled && !force) return [];
  if (nansen.isCapped()) { lastError = 'Daily Nansen credit cap reached, scanner paused until midnight UTC'; return []; }
  lastScan = new Date().toISOString();
  try {
    const trades = await nansen.smartMoneyOpens({ lookbackHours: 1, pages: 1, perPage: 200, minValueUsd: cfg.minSizeUsd });
    const fresh = trades.filter((t) => !seen[game.tradeKey(t)] && Date.now() - Date.parse(t.block_timestamp) < 45 * 60e3);
    const created = [];
    const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
    for (const t of fresh) {
      seen[game.tradeKey(t)] = Date.now();
      // one alert per whale per coin every 2 hours
      if (alerts.some((a) => !a.kind && a.address === t.trader_address && a.coin === t.token_symbol && Date.now() - a.t < 2 * 3600e3)) continue;
      const [w30, w7] = await Promise.all([
        nansen.walletSummary(t.trader_address, iso(hour - 30 * DAY), iso(hour)).catch(() => null),
        nansen.walletSummary(t.trader_address, iso(hour - 7 * DAY), iso(hour)).catch(() => null),
      ]);
      const rec = { d30: game.recordOf(w30), d7: game.recordOf(w7) };
      rec.trust = game.trustGrade(rec.d30, rec.d7, t.token_symbol);
      const kind = qualifies(rec, t.token_symbol);
      if (!kind) continue;
      const a = { id: crypto.randomUUID(), t: Date.now(), key: game.tradeKey(t), raw: t,
        coin: t.token_symbol, side: t.side, valueUsd: t.value_usd, entryPrice: t.price_usd, openedAt: t.block_timestamp,
        trader: t.trader_address_label || 'Smart Money whale', address: t.trader_address, record: rec, specialist: kind === 'specialist' ? rec.trust.specialist : null };
      alerts.push(a); created.push(a);
      game.buildLiveItem(t).catch(() => {}); // pre-price it so "Bet on it" is instant
      sendTelegram(a).catch((e) => console.error('[telegram]', e.message));
      if (!t._demo && !nansen.isDemo()) watchAlert(a).catch(() => {});
    }
    // housekeeping
    for (const [k, ts] of Object.entries(seen)) if (Date.now() - ts > 2 * DAY) delete seen[k];
    while (alerts.length > 200) alerts.shift();
    save('alerts', alerts); save('alertseen', seen);
    lastError = null;
    if (created.length) console.log(`  Whale alert: ${created.map((a) => `${a.record.trust.grade} ${a.side} ${a.coin}`).join(', ')}`);
    return created;
  } catch (e) {
    lastError = e.message;
    return [];
  }
}

// Alerted trades from the last 6 hours are pinned at the top of the Live Floor.
game.setExtraLive(() => alerts.filter((a) => Date.now() - Date.parse(a.openedAt) < 6 * 3600e3).filter((a) => a.raw).slice(-4).map((a) => a.raw));

// ------------------------------------------------------------------ exit alerts
// After a whale alert we keep reading that whale's Hyperliquid position. When they trim (25%, 50%, 75%) or fully close,
// everyone gets an exit alert, so nobody following the whale is left holding the bag.
const TRIM_LEVELS = [0.25, 0.5, 0.75];
async function watchAlert(a) {
  if (watches.some((w) => w.address === a.address && w.coin === a.coin && !w.done)) return;
  const sz = await hl.positionSize(a.address, a.coin).catch(() => null);
  if (sz == null || Math.abs(sz) < 1e-12 || Math.sign(sz) !== (a.side === 'Long' ? 1 : -1)) return; // already gone or not readable
  watches.push({ alertId: a.id, key: a.key, address: a.address, coin: a.coin, side: a.side, trader: a.trader, entryPrice: a.entryPrice,
    openedAt: a.openedAt, t: Date.now(), startSz: sz, peak: Math.abs(sz), trims: [], done: false });
  while (watches.length > 150) watches.shift();
  save('alertwatch', watches);
}

function pushExitAlert(w, extra) {
  const parent = alerts.find((x) => x.id === w.alertId);
  const a = { id: crypto.randomUUID(), t: Date.now(), key: w.key, coin: w.coin, side: w.side, trader: w.trader, address: w.address,
    entryPrice: w.entryPrice, openedAt: w.openedAt, valueUsd: parent?.valueUsd, record: parent?.record, parentId: w.alertId, ...extra };
  alerts.push(a); while (alerts.length > 200) alerts.shift();
  save('alerts', alerts);
  sendExitTelegram(a).catch((e) => console.error('[telegram]', e.message));
  console.log(`  Whale ${a.kind}: ${a.trader} ${a.side} ${a.coin}${a.kind === 'trim' ? ` -${Math.round(a.trimPct * 100)}%` : ''}`);
  return a;
}

let checking = false;
export async function checkExits() {
  if (checking) return;
  checking = true;
  try {
    for (const w of watches) {
      if (w.done) continue;
      if (Date.now() - w.t > 14 * DAY) { w.done = true; w.expired = true; continue; }
      const sz = await hl.positionSize(w.address, w.coin).catch(() => null);
      if (sz == null) continue;
      const dir = w.side === 'Long' ? 1 : -1;
      const open = Math.abs(sz) > 1e-12 && Math.sign(sz) === dir;
      if (!open) {
        const mark = await hl.mid(w.coin).catch(() => null);
        const ex = await hl.whaleExit(w.address, w.coin, w.t - 60e3, Date.now() - w.t + 120e3, w.startSz, false).catch(() => null);
        const exitPx = ex?.closed ? ex.exitPx : mark;
        w.done = true; w.closedAt = Date.now();
        pushExitAlert(w, { kind: 'exit', exitPx, markPx: mark, exitExact: !!ex?.closed,
          whaleRet: exitPx && w.entryPrice ? dir * (exitPx - w.entryPrice) / w.entryPrice : null, heldMs: Date.now() - Date.parse(w.openedAt) });
        continue;
      }
      if (Math.abs(sz) > w.peak) { w.peak = Math.abs(sz); continue; } // added to the position
      const trimmed = 1 - Math.abs(sz) / w.peak;
      const level = TRIM_LEVELS.filter((l) => trimmed >= l - 0.02 && !w.trims.includes(l)).pop();
      if (level != null) {
        TRIM_LEVELS.filter((l) => l <= level).forEach((l) => { if (!w.trims.includes(l)) w.trims.push(l); });
        const mark = await hl.mid(w.coin).catch(() => null);
        pushExitAlert(w, { kind: 'trim', trimPct: trimmed, remainingPct: 1 - trimmed, markPx: mark,
          whaleRet: mark && w.entryPrice ? dir * (mark - w.entryPrice) / w.entryPrice : null, heldMs: Date.now() - Date.parse(w.openedAt) });
      }
    }
    save('alertwatch', watches);
  } finally { checking = false; }
}
export const watching = () => watches.filter((w) => !w.done).length;

const hrsTxt = (ms) => { const h = ms / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`; };
async function sendExitTelegram(a) {
  if (!cfg.telegram.token || !cfg.telegram.chatId) return;
  const site = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const ret = a.whaleRet != null ? `${a.whaleRet >= 0 ? '+' : ''}${(a.whaleRet * 100).toFixed(2)}%` : 'n/a';
  const text = a.kind === 'exit' ? [
    `🚪 WHALE EXIT · ${a.trader} closed ${a.side.toUpperCase()} ${a.coin}`,
    `Held ${hrsTxt(a.heldMs)} · entry ${a.entryPrice} → exit ${a.exitExact ? '' : '~'}${a.exitPx != null ? +(+a.exitPx).toPrecision(6) : 'n/a'} · whale ${ret}`,
    ``,
    `Following this whale? The position you copied is now closed on their side. Check your own position.`,
    `Whale profile: https://app.nansen.ai/profiler?address=${a.address}&chain=hyperliquid`,
    `Your bets: ${site}/?view=live`,
  ] : [
    `✂️ WHALE TRIM · ${a.trader} cut ${Math.round(a.trimPct * 100)}% of ${a.side.toUpperCase()} ${a.coin}`,
    `${Math.round(a.remainingPct * 100)}% still open · held ${hrsTxt(a.heldMs)} · entry ${a.entryPrice} → now ${a.markPx != null ? +(+a.markPx).toPrecision(6) : 'n/a'} · whale ${ret}`,
    ``,
    `The whale is taking some off the table. Following them? Check your position.`,
    `Whale profile: https://app.nansen.ai/profiler?address=${a.address}&chain=hyperliquid`,
    `Your bets: ${site}/?view=live`,
  ];
  await tg(cfg.telegram.token, 'sendMessage', { chat_id: cfg.telegram.chatId, text: text.join('\n'), disable_web_page_preview: true });
}

export function schedule() {
  clearInterval(timer);
  timer = setInterval(() => scan().catch(() => {}), cfg.intervalMin * 60e3);
}

// ---------------------------------------------------------------- Telegram (optional)
const tg = async (token, method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'Telegram request failed');
  return j.result;
};

export async function connectTelegram(token) {
  token = String(token || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw Object.assign(new Error('That does not look like a bot token from @BotFather'), { status: 400 });
  const me = await tg(token, 'getMe');
  cfg.telegram = { token, chatId: '', botName: me.username };
  save('alertcfg', cfg);
  return publicConfig();
}

/** After the user messages the bot, grab their chat id from the bot's updates and send a test message. */
export async function verifyTelegram() {
  if (!cfg.telegram.token) throw Object.assign(new Error('Connect a bot token first'), { status: 400 });
  const updates = await tg(cfg.telegram.token, 'getUpdates', { timeout: 0 });
  const msg = [...updates].reverse().find((u) => u.message?.chat?.id);
  if (!msg) throw Object.assign(new Error(`No message found yet. Open Telegram, search @${cfg.telegram.botName}, press Start, then try again.`), { status: 409 });
  cfg.telegram.chatId = String(msg.message.chat.id);
  save('alertcfg', cfg);
  await tg(cfg.telegram.token, 'sendMessage', { chat_id: cfg.telegram.chatId, text: '🐋 Follow or Fade is connected. You will get a message here when a top Smart Money whale opens a position.' });
  return publicConfig();
}

export function disconnectTelegram() { cfg.telegram = { token: '', chatId: '', botName: '' }; save('alertcfg', cfg); return publicConfig(); }

const money = (n) => (n < 0 ? '-' : '') + '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(n));
async function stockIntelLines(a) {
  if (!agent.isStock(a.coin)) return [];
  let r = agent.companyIntel(a.coin);
  if (r.status === 'loading') r = await agent.waitIntel(a.coin, 25e3);
  if (!r.intel) return [];
  const i = r.intel, al = agent.alignment(a.side, i.insider.signal);
  return ['', `🔎 Nansen Agent on ${i.company || agent.tickerOf(a.coin)}:`,
    `Insiders ${i.insider.signal.toUpperCase()}${i.insider.detail ? ` · ${i.insider.detail}` : ''}`,
    ...(i.earnings?.next ? [`Next earnings: ${i.earnings.next}`] : []),
    `Whale vs insiders: ${al === 'aligned' ? 'ALIGNED ✅' : al === 'against' ? 'AGAINST ⚠️' : 'no clear insider signal'}`,
    '(AI research, verify before trading)'];
}
async function sendTelegram(a) {
  if (!cfg.telegram.token || !cfg.telegram.chatId) return;
  const intel = await stockIntelLines(a).catch(() => []); // stock perps get a Nansen Agent insider brief
  const r = a.record, d30 = r.d30, d7 = r.d7;
  const text = [
    `🐋 WHALE ALERT${a.specialist ? ' · SPECIALIST' : ''} · Grade ${r.trust.grade} (${r.trust.score}/100)`,
    ...(a.specialist ? [`${a.coin} specialist: ${Math.round(a.specialist.share * 100)}% of their closes, +${money(a.specialist.pnl)} realized on ${a.coin} (${(a.specialist.roi * 100).toFixed(1)}% return) in 30D`] : []),
    `${a.trader} just opened ${a.side.toUpperCase()} ${a.coin} · ${money(a.valueUsd)} @ ${a.entryPrice}`,
    ``,
    `30D: ${d30.pnl >= 0 ? '+' : ''}${money(d30.pnl)} realized · ${Math.round((d30.winRate || 0) * 100)}% win rate · ${d30.coins} coins`,
    d7 && d7.closed ? `7D: ${d7.pnl >= 0 ? '+' : ''}${money(d7.pnl)} realized · ${Math.round((d7.winRate || 0) * 100)}% win rate · ${d7.coins} coins` : `7D: no closed trades`,
    ...intel,
    ``,
    `Join the trade on Nansen: https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(a.coin)}&chain=hyperliquid`,
    `Whale profile: https://app.nansen.ai/profiler?address=${a.address}&chain=hyperliquid`,
    `New to Nansen? Sign up with code ${process.env.NANSEN_PROMO_CODE || 'AVYRION'}: ${process.env.NANSEN_REF_URL || 'https://nsn.ai/avyrion'}`,
    `Bet on it: ${(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '')}/?view=live&trade=${encodeURIComponent(a.key)}`,
  ].join('\n');
  await tg(cfg.telegram.token, 'sendMessage', { chat_id: cfg.telegram.chatId, text, disable_web_page_preview: true });
}

/** Build a sample alert from the best-graded whale in the recent feed (for testing the pipeline). */
export async function testAlert() {
  const feed = await game.liveFeed();
  const best = feed.slice().sort((x, y) => (y.record?.trust?.score ?? -1) - (x.record?.trust?.score ?? -1))[0];
  if (!best) throw new Error('No whales on the floor right now');
  const a = { id: crypto.randomUUID(), t: Date.now(), key: best.key, test: true, raw: game.getRaw(best.key), coin: best.coin, side: best.side, valueUsd: best.valueUsd,
    entryPrice: best.entryPrice, openedAt: best.openedAt, trader: best.trader || 'Smart Money whale', address: best.address, record: best.record, specialist: best.record?.trust?.specialist || null };
  alerts.push(a); save('alerts', alerts);
  await sendTelegram(a).catch(() => {});
  return a;
}
