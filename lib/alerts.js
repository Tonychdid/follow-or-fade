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
for (let i = watches.length - 1; i >= 0; i--) if (watches[i].pending) watches.splice(i, 1);
let lastScan = null, lastError = null, timer = null;

export function publicConfig(canAdmin = true) {
  const { telegram, ...rest } = cfg;
  return { ...rest, telegram: { connected: !!(telegram.token && telegram.chatId), hasToken: !!telegram.token, botName: telegram.botName },
    lastScan, lastError, estCreditsPerDay: Math.round((24 * 60) / cfg.intervalMin) * 5, canAdmin };
}

export function updateConfig(patch = {}) {
  if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
  if (Object.hasOwn(GRADE_RANK, patch.minGrade) && patch.minGrade !== '?') cfg.minGrade = patch.minGrade;
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
      // price it now: the odds, the tells and current Smart Money positioning go into the alert itself
      const item = await game.buildLiveItem(t).catch(() => null);
      if (item) {
        a.read = { pFollow: item.pFollow, odds: item.odds, reasons: (item.reasons || []).slice(0, 3), positioning: item.positioning, moveSinceEntry: item.moveSinceEntry, mid: item.mid };
        a.base = { mid: item.mid, pFollow: item.pFollow, at: Date.now() }; // frozen: what the numbers were when the alert went out
      }
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

// ------------------------------------------------------------------ position updates (add / trim / exit)
// After a whale alert we keep reading that whale's Hyperliquid position:
//  - ADD when they grow the position by 50%+ since the last update (conviction),
//  - TRIM when they cut 25% / 50% / 75% from the peak,
//  - EXIT when they fully close, so nobody following the whale is left holding the bag.
const ADD_STEP = 1.5, ADD_MIN_USD = 25000;
const TRIM_LEVELS = [0.25, 0.5, 0.75];
async function watchAlert(a) {
  if (watches.some((w) => (w.address === a.address && w.coin === a.coin && !w.done) || w.alertId === a.id)) return;
  // placeholder first, so a scan and the startup backfill can't both add a watch for the same whale
  const w = { alertId: a.id, key: a.key, address: a.address, coin: a.coin, side: a.side, trader: a.trader, entryPrice: a.entryPrice,
    openedAt: a.openedAt, t: Date.now(), startSz: null, peak: 0, lastNotifiedSz: 0, trims: [], done: false, pending: true };
  watches.push(w);
  const sz = await hl.positionSize(a.address, a.coin).catch(() => null);
  if (sz == null || Math.abs(sz) < 1e-12 || Math.sign(sz) !== (a.side === 'Long' ? 1 : -1)) { watches.splice(watches.indexOf(w), 1); return; }
  Object.assign(w, { startSz: sz, peak: Math.abs(sz), lastNotifiedSz: Math.abs(sz), pending: false });
  // keep the list short: drop finished watches first, then the oldest
  for (let i = 0; watches.length > 150 && i < watches.length; ) { if (watches[i].done) watches.splice(i, 1); else i++; }
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
  console.log(`  Whale ${a.kind}: ${a.trader} ${a.side} ${a.coin}${a.kind === 'trim' ? ` -${Math.round(a.trimPct * 100)}%` : a.kind === 'add' ? ` now ${a.multiple.toFixed(1)}x` : ''}`);
  return a;
}

let checking = false;
export async function checkExits() {
  if (checking) return;
  checking = true;
  try {
    for (const w of watches) {
      if (w.done || w.pending) continue;
      if (Date.now() - w.t > 14 * DAY) { w.done = true; w.expired = true; continue; }
      const pos = await hl.positionInfo(w.address, w.coin).catch(() => null);
      if (!pos) continue;
      const sz = pos.szi;
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
      const abs = Math.abs(sz);
      w.lastNotifiedSz ??= Math.abs(w.startSz);
      if (abs > w.peak) { w.peak = abs; w.trims = []; } // new high: trims are measured from here
      const addedUsd = (abs - w.lastNotifiedSz) * (pos.entryPx || 0);
      if (abs >= w.lastNotifiedSz * ADD_STEP && addedUsd >= ADD_MIN_USD) {
        const mark = await hl.mid(w.coin).catch(() => null);
        pushExitAlert(w, { kind: 'add', addedSz: abs - w.lastNotifiedSz, sizeNow: abs, multiple: abs / Math.abs(w.startSz), valueUsd: pos.valueUsd,
          avgEntry: pos.entryPx, markPx: mark, upnl: pos.upnl, whaleRet: mark && pos.entryPx ? dir * (mark - pos.entryPx) / pos.entryPx : null, heldMs: Date.now() - Date.parse(w.openedAt) });
        w.lastNotifiedSz = abs;
        continue;
      }
      const trimmed = 1 - Math.abs(sz) / w.peak;
      const level = TRIM_LEVELS.filter((l) => trimmed >= l - 0.02 && !w.trims.includes(l)).pop();
      if (level != null) {
        TRIM_LEVELS.filter((l) => l <= level).forEach((l) => { if (!w.trims.includes(l)) w.trims.push(l); });
        const mark = await hl.mid(w.coin).catch(() => null);
        pushExitAlert(w, { kind: 'trim', trimPct: trimmed, remainingPct: 1 - trimmed, markPx: mark, sizeNow: abs, valueUsd: pos.valueUsd, avgEntry: pos.entryPx, upnl: pos.upnl,
          whaleRet: mark && w.entryPrice ? dir * (mark - w.entryPrice) / w.entryPrice : null, heldMs: Date.now() - Date.parse(w.openedAt) });
      }
    }
    save('alertwatch', watches);
  } finally { checking = false; }
}
/** Alerts from the last 48h without a watch (e.g. sent before this feature) start being followed from their current size. */
export async function backfillWatches() {
  if (nansen.isDemo()) return;
  for (const a of alerts.filter((x) => !x.kind && !x.test && Date.now() - x.t < 2 * DAY)) {
    if (watches.some((w) => w.alertId === a.id)) continue;
    await watchAlert(a).catch(() => {});
  }
}
export const watching = () => watches.filter((w) => !w.done).length;

const hrsTxt = (ms) => { const h = ms / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`; };
/** The decision data a paying subscriber wants before acting: model read, the tells, and where Smart Money sits now. */
function readLines(a) {
  const r = a.read;
  if (!r) return [];
  const out = [''];
  if (r.pFollow != null) out.push(`📊 Model read: follow wins ${Math.round(r.pFollow * 100)}% · fade ${Math.round((1 - r.pFollow) * 100)}%`);
  if (r.moveSinceEntry != null) {
    const m = r.moveSinceEntry * 100;
    out.push(Math.abs(m) < 0.3 ? `Entry now: within ${Math.abs(m).toFixed(2)}% of the whale's price`
      : m > 0 ? `Entry now: ${m.toFixed(2)}% worse than the whale's (joining late)` : `Entry now: ${Math.abs(m).toFixed(2)}% better than the whale's`);
  }
  for (const x of r.reasons || []) out.push(`${x.good ? '✅' : '⚠️'} ${x.text}`);
  if (r.positioning) {
    const p = r.positioning;
    out.push(`Smart Money on ${a.coin} right now: ${p.longs} longs (${money(p.longsUsd)}) vs ${p.shorts} shorts (${money(p.shortsUsd)})`);
  }
  return out;
}

async function sendExitTelegram(a) {
  if (!cfg.telegram.token || !cfg.telegram.chatId) return;
  const site = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const ret = a.whaleRet != null ? `${a.whaleRet >= 0 ? '+' : ''}${(a.whaleRet * 100).toFixed(2)}%` : 'n/a';
  const fmtSz = (n) => (+n).toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 1 : 4 });
  const base = a.coin.split(':').pop();
  const text = a.kind === 'add' ? [
    `➕ WHALE ADDING · ${a.trader} added ${fmtSz(a.addedSz)} ${base} to ${a.side.toUpperCase()} ${a.coin}`,
    `Position now ${fmtSz(a.sizeNow)} ${base} (${money(a.valueUsd || 0)}) · ${a.multiple.toFixed(1)}x the size at the alert`,
    `Avg entry ${+(+a.avgEntry).toPrecision(6)} → now ${a.markPx != null ? +(+a.markPx).toPrecision(6) : 'n/a'} · whale ${ret} · unrealized ${a.upnl >= 0 ? '+' : '-'}${money(Math.abs(a.upnl || 0))}`,
    ``,
    `The whale is doubling down: conviction is rising.`,
    `Whale profile: https://app.nansen.ai/profiler?address=${a.address}&chain=hyperliquid`,
    `Full whale card (position, track record, tells): ${site}/?view=live&trade=${encodeURIComponent(a.key)}`,
  ] : a.kind === 'exit' ? [
    `🚪 WHALE EXIT · ${a.trader} closed ${a.side.toUpperCase()} ${a.coin}`,
    `Held ${hrsTxt(a.heldMs)} · entry ${a.entryPrice} → exit ${a.exitExact ? '' : '~'}${a.exitPx != null ? +(+a.exitPx).toPrecision(6) : 'n/a'} · whale ${ret}`,
    ``,
    `Following this whale? The position you copied is now closed on their side. Check your own position.`,
    `Whale profile: https://app.nansen.ai/profiler?address=${a.address}&chain=hyperliquid`,
    `Your position and this whale's card: ${site}/?view=live&trade=${encodeURIComponent(a.key)}`,
  ] : [
    `✂️ WHALE TRIM · ${a.trader} cut ${Math.round(a.trimPct * 100)}% of ${a.side.toUpperCase()} ${a.coin}`,
    `${Math.round(a.remainingPct * 100)}% still open · held ${hrsTxt(a.heldMs)} · entry ${a.entryPrice} → now ${a.markPx != null ? +(+a.markPx).toPrecision(6) : 'n/a'} · whale ${ret}`,
    ``,
    `The whale is taking some off the table. Following them? Check your position.`,
    `Whale profile: https://app.nansen.ai/profiler?address=${a.address}&chain=hyperliquid`,
    `Your position and this whale's card: ${site}/?view=live&trade=${encodeURIComponent(a.key)}`,
  ];
  await tg(cfg.telegram.token, 'sendMessage', { chat_id: cfg.telegram.chatId, text: text.join('\n'), disable_web_page_preview: true });
}

// ---------------------------------------------------------------- Telegram "Re-check" button
// Telegram sends button presses through getUpdates; we answer by rewriting the same message with fresh numbers.
let polling = false, pollTimer = null;
export function startTelegramPoll() {
  clearTimeout(pollTimer);
  if (!cfg.telegram.token || !cfg.telegram.chatId) return;
  const loop = async () => {
    if (polling) return;
    polling = true;
    try {
      const updates = await tg(cfg.telegram.token, 'getUpdates', { offset: cfg.telegram.offset || 0, timeout: 25, allowed_updates: ['callback_query'] });
      for (const u of updates || []) {
        cfg.telegram.offset = u.update_id + 1;
        const q = u.callback_query;
        if (q?.data?.startsWith('rc:')) await recheck(q).catch((e) => console.warn('[telegram] recheck', e.message));
      }
      if (updates?.length) save('alertcfg', cfg);
    } catch (e) { console.warn('[telegram] poll', e.message); await new Promise((r) => setTimeout(r, 15e3)); }
    finally { polling = false; pollTimer = setTimeout(loop, 500); }
  };
  loop();
}

async function recheck(q) {
  const id = q.data.slice(3);
  const a = alerts.find((x) => x.id === id);
  const answer = (text) => tg(cfg.telegram.token, 'answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (!a) return answer('That alert is too old to re-check.');
  let item = null;
  try { item = await game.refreshLiveItem(a.key, a.raw); }
  catch (e) { await answer(e.status === 410 ? 'That trade left the floor.' : 'Could not read that whale right now.'); return; }
  a.base ??= { mid: a.read?.mid ?? a.entryPrice, pFollow: a.read?.pFollow ?? null, at: a.t };
  a.read = { pFollow: item.pFollow, odds: item.odds, reasons: (item.reasons || []).slice(0, 3), positioning: item.positioning, moveSinceEntry: item.moveSinceEntry, mid: item.mid };
  const held = item.gone ? '🚪 The whale has CLOSED this position.'
    : item.trimmed >= 0.1 ? `✂️ The whale trimmed ${Math.round(item.trimmed * 100)}% of the position.`
    : '✅ The whale is still in the trade.';
  const px = (x) => +(+x).toPrecision(6);
  const dir = a.side === 'Long' ? 1 : -1;
  const since = a.base.mid ? dir * (item.mid - a.base.mid) / a.base.mid : null;
  const mins = Math.max(1, Math.round((Date.now() - (a.base.at || a.t)) / 60e3));
  const ago = mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
  const note = [
    `🔄 Re-checked ${new Date().toISOString().slice(11, 16)} UTC · ${ago} after the alert`,
    `Price: ${px(a.base.mid ?? a.entryPrice)} at the alert → ${px(item.mid)} now`,
    since == null ? ''
      : Math.abs(since) < 0.0005 ? '➖ Flat since the alert: the same entry you were offered then'
      : `${since >= 0 ? '📈' : '📉'} ${Math.abs(since * 100).toFixed(2)}% ${since >= 0 ? `in the trade's favour since the alert · you'd enter ${Math.abs(since * 100).toFixed(2)}% worse than at the alert` : `against the trade since the alert · you'd enter ${Math.abs(since * 100).toFixed(2)}% better than at the alert`}`,
    a.base.pFollow != null ? `Follow odds ${Math.round(a.base.pFollow * 100)}% at the alert → ${Math.round(item.pFollow * 100)}% now` : '',
    held,
  ].filter(Boolean).join('\n');
  const text = alertText(a, a.intelLines || [], note);
  await tg(cfg.telegram.token, 'editMessageText', {
    chat_id: q.message.chat.id, message_id: q.message.message_id, text, disable_web_page_preview: true, reply_markup: alertButtons(a),
  }).catch(async (e) => { if (!/not modified/i.test(e.message)) throw e; });
  save('alerts', alerts);
  await answer(item.gone ? 'The whale has closed this position' : 'Numbers updated');
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
  await tg(cfg.telegram.token, 'sendMessage', { chat_id: cfg.telegram.chatId, text: '🐋 Follow or Fade is connected. You will get a message here when a top Smart Money whale opens a position. Every alert has a 🔄 Re-check button that updates its numbers in place.' });
  startTelegramPoll();
  return publicConfig();
}

export function disconnectTelegram() { cfg.telegram = { token: '', chatId: '', botName: '' }; save('alertcfg', cfg); clearTimeout(pollTimer); return publicConfig(); }

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
const siteUrl = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const cardUrl = (a) => `${siteUrl()}/?view=live&trade=${encodeURIComponent(a.key)}`;
const nansenUrl = (coin) => `https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(coin)}&chain=hyperliquid`;

/** The alert message. `note` marks a re-check ("numbers as of ..."). */
function alertText(a, intel = [], note = null) {
  const r = a.record, d30 = r?.d30 || {}, d7 = r?.d7;
  return [
    `🐋 WHALE ALERT${a.specialist ? ' · SPECIALIST' : ''} · Grade ${r?.trust?.grade || '?'} (${r?.trust?.score ?? '–'}/100)`,
    ...(a.specialist ? [`${a.coin} specialist: ${Math.round(a.specialist.share * 100)}% of their closes, +${money(a.specialist.pnl)} realized on ${a.coin} (${(a.specialist.roi * 100).toFixed(1)}% return) in 30D`] : []),
    `${a.trader} just opened ${a.side.toUpperCase()} ${a.coin} · ${money(a.valueUsd)} @ ${a.entryPrice}`,
    ``,
    `30D: ${d30.pnl >= 0 ? '+' : ''}${money(d30.pnl || 0)} realized · ${Math.round((d30.winRate || 0) * 100)}% win rate · ${d30.coins || 0} coins`,
    d7 && d7.closed ? `7D: ${d7.pnl >= 0 ? '+' : ''}${money(d7.pnl)} realized · ${Math.round((d7.winRate || 0) * 100)}% win rate · ${d7.coins} coins` : `7D: no closed trades`,
    ...readLines(a),
    ...intel,
    ...(note ? ['', note] : []),
    ``,
    `Whale profile: https://app.nansen.ai/profiler?address=${a.address}&chain=hyperliquid`,
    `New to Nansen? Sign up with code ${process.env.NANSEN_PROMO_CODE || 'AVYRION'}: ${process.env.NANSEN_REF_URL || 'https://nsn.ai/avyrion'}`,
  ].join('\n');
}
const alertButtons = (a) => ({ inline_keyboard: [
  [{ text: '🔄 Re-check the numbers', callback_data: `rc:${a.id}` }],
  [{ text: '📊 Full whale card', url: cardUrl(a) }, { text: '⚡ Trade on Nansen', url: nansenUrl(a.coin) }],
] });

async function sendTelegram(a) {
  if (!cfg.telegram.token || !cfg.telegram.chatId) return;
  const intel = await stockIntelLines(a).catch(() => []); // stock perps get a Nansen Agent insider brief
  a.intelLines = intel;
  const sent = await tg(cfg.telegram.token, 'sendMessage', {
    chat_id: cfg.telegram.chatId, text: alertText(a, intel), disable_web_page_preview: true, reply_markup: alertButtons(a),
  });
  if (sent?.message_id) { a.messageId = sent.message_id; save('alerts', alerts); }
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
