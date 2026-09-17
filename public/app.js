import { sfx, isMuted, setMuted } from './sfx.js';
import { coinRain, burst, sparkleAt, countTo } from './fx.js';

const $ = (id) => document.getElementById(id);

// Auto-fit: scale the desktop layout so the whole Training Table (card, tells, chips, FOLLOW/FADE) and
// Your Table fit on screen without scrolling. 100% on big monitors, ~80% on 1080p, never below 70%.
const DESIGN_W = 1500, DESIGN_H = 886;
function autoFit() {
  const w = window.innerWidth, h = window.innerHeight;
  const fit = w < 1100 ? 1 : Math.max(0.7, Math.min(1, (h - 8) / DESIGN_H, w / DESIGN_W));
  document.documentElement.style.setProperty('--fit', fit.toFixed(3));
}
autoFit();
window.addEventListener('resize', autoFit);
// Host admin: open the site once with ?admin=YOUR_TOKEN to manage alert rules on the public version
try {
  const u = new URL(location.href);
  if (u.searchParams.get('admin')) { localStorage.setItem('fof_admin', u.searchParams.get('admin')); u.searchParams.delete('admin'); history.replaceState(null, '', u.pathname + u.search); }
} catch {}
const adminToken = () => { try { return localStorage.getItem('fof_admin') || ''; } catch { return ''; } };
const api = async (path, body) => {
  const headers = { 'x-admin-token': adminToken() };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
};
const usd = (n, d = 0) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const compact = (n) => (n < 0 ? '-' : '') + '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(n));
const pct = (x, d = 1) => (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const price = (p) => p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p >= 1 ? p.toFixed(3) : p.toPrecision(4);
const ago = (iso) => { const m = (Date.now() - Date.parse(iso)) / 60e3; return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const coinHtml = (c) => c.includes(':') ? `<small class="dex">${esc(c.split(':')[0])}</small>${esc(c.split(':')[1])}` : esc(c);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LANES = { 15: 'Espresso Shot', 30: 'Espresso Shot', 60: 'Cigar Lounge', 240: 'Cigar Lounge', 1440: 'Insider Pick', ride: 'Ride the Whale' };
const laneOf = (b) => (b.pick || Number(b.minutes) === 1440 ? '1440' : b.ride || b.minutes === 'ride' ? 'ride' : Number(b.minutes || Math.round((b.settleAt - b.placedAt) / 60e3)) >= 60 ? '240' : '15');
const hrs = (ms) => { const h = ms / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`; };

let player = null, round = null, lastResult = null;
let REF = { url: 'https://nsn.ai/avyrion', code: 'AVYRION' };
const refLink = (cls = '') => `<a class="ref-link ${cls}" href="${esc(REF.url)}" target="_blank" rel="noopener sponsored">New to Nansen? Sign up with code <b class="ref-code">${esc(REF.code)}</b> ↗</a>`;
let shownBank = 10000;

// ================================================= boot
async function boot() {
  syncMute();
  const id = store.get('fof_player');
  if (id) player = await api('/api/player?id=' + id).catch(() => null);
  if (!player) {
    $('welcome').showModal();
    await new Promise((r) => $('welcomeForm').addEventListener('submit', r, { once: true }));
    player = await api('/api/player', { name: $('nameInput').value });
    store.set('fof_player', player.id);
    sfx.chip(); coinRain(40);
  }
  shownBank = player.bankroll;
  renderPlayer();
  refreshStatus(); setInterval(refreshStatus, 15000);
  pollLoop();
  // links like /?view=live (from Telegram alerts) open straight on that tab
  const startView = (() => { try { return new URL(location.href).searchParams.get('view'); } catch { return null; } })();
  if (startView && document.querySelector(`.tab[data-view="${startView}"]`) && startView !== 'replay') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => document.querySelector(`.tab[data-view="${startView}"]`).click(), 50);
  }
  deal(); // training starts at the table
  setTimeout(() => fetchLive().catch(() => {}), 1500); // warm the Live Floor in the background
  initAlerts();
  refreshReport();

}

// ================================================= sound toggle
function syncMute() {
  $('muteBtn').classList.toggle('off', isMuted());
  $('muteIcon').setAttribute('d', isMuted()
    ? 'M4 9v6h4l5 4V5L8 9H4zm12.6 3 2.4 2.4-1.2 1.2-2.4-2.4-2.4 2.4-1.2-1.2 2.4-2.4-2.4-2.4 1.2-1.2 2.4 2.4 2.4-2.4 1.2 1.2z'
    : 'M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z');
}
$('muteBtn').onclick = () => { setMuted(!isMuted()); syncMute(); if (!isMuted()) sfx.chip(); };

// ================================================= player + rail
function renderPlayer() {
  const b = $('bankroll');
  if (player.bankroll !== shownBank) {
    b.className = player.bankroll > shownBank ? 'up' : 'down';
    countTo(b, shownBank, player.bankroll, (v) => usd(Math.round(v)));
    setTimeout(() => (b.className = ''), 1400);
    shownBank = player.bankroll;
  } else b.textContent = usd(player.bankroll);
  const losses = player.bets - player.wins - (player.pushes || 0);
  $('sRecord').textContent = `${player.wins}–${losses}` + (player.pushes ? `–${player.pushes}` : '');
  $('sStreak').textContent = player.streak;
  $('sSlain').textContent = player.whalesSlain;
  const hands = player.history.slice(-8).reverse();
  $('recentHands').innerHTML = hands.length ? hands.map((h) => `<div class="hand"><span>${h.live ? LANES[h.minutes] || 'Live' : 'Table'} · ${h.cashed ? 'Cashed out' : h.choice === 'follow' ? 'Followed' : 'Faded'} ${esc(h.coin)}</span><b class="${h.delta >= 0 ? 'pos' : 'neg'}">${h.delta >= 0 ? '+' : ''}${usd(h.delta)}</b></div>`).join('')
    : '<p class="muted" style="font-family:var(--serif);font-style:italic;font-size:15px;margin:0">No hands played yet.</p>';
  updatePotential();
}

async function refreshStatus() {
  const s = await api('/api/status').catch(() => null);
  if (!s) return;
  renderBeta(s.beta);
  if (s.ref?.url) { REF = s.ref; document.querySelectorAll('a.ref-link').forEach((a) => (a.href = REF.url)); document.querySelectorAll('.ref-code').forEach((b) => (b.textContent = REF.code)); }
  $('demoBadge').hidden = !(s.usage.demo || s.usage.capped);
  $('demoBadge').textContent = s.usage.capped ? 'DEMO DATA · daily cap reached' : 'DEMO DATA';
  $('demoBadge').title = s.usage.capped ? "Today's Nansen credit budget for the public site is used up. Cached whale data and demo whales until midnight UTC." : 'No Nansen API key: sample whales on real Hyperliquid prices';
  $('uCalls').textContent = s.usage.calls.toLocaleString();
  $('uCredits').textContent = s.usage.credits.toLocaleString();
  $('uModel').textContent = s.model.n ? s.model.n.toLocaleString() : '—';
  if (s.smWinRate != null) {
    $('smWin').textContent = Math.round(s.smWinRate * 100) + '%';
    $('smWinTxt').textContent = `of ${s.sampleSize} Smart Money opens were in profit when the whale exited${s.medianHoldHours ? ` · median hold ${hrs(s.medianHoldHours * 3600e3)}` : ''}`;
  }
}

// ---- live bets rail (polled every 5s, visible on every tab)
const prevStatus = new Map();
async function pollBets() {
  if (!player) return;
  const bets = await api('/api/live/bets?player=' + player.id).catch(() => null);
  if (!bets) return;
  let settledNow = [];
  for (const b of bets) {
    const before = prevStatus.get(b.id);
    if (before === 'open' && b.status !== 'open') settledNow.push(b);
    prevStatus.set(b.id, b.status);
  }
  const fresh = lastBets.filter((x) => x.status === 'open' && Date.now() - x.placedAt < 10e3 && !bets.some((y) => y.id === x.id));
  lastBets = [...fresh, ...bets];
  renderLanes();
  if (settledNow.length) await announceSettled(settledNow);
}
let lastBets = [];
let pending = [];            // optimistic bets shown instantly while the server confirms
async function pollLoop() {
  await pollBets().catch(() => {});
  const anyOpen = lastBets.some((b) => b.status === 'open');
  setTimeout(pollLoop, anyOpen ? 2000 : 5000); // faster refresh while chips are on the table
}
function renderLanes() {
  const now = Date.now();
  const open = [...pending, ...lastBets.filter((b) => b.status === 'open')];
  let total = 0;
  for (const min of ['15', '240', '1440', 'ride']) {
    const lane = document.querySelector(`.lane[data-min="${min}"]`);
    const mine = open.filter((b) => laneOf(b) === min);
    total += mine.length;
    lane.querySelector('.count').textContent = mine.length;
    lane.classList.toggle('empty', !mine.length);
    lane.classList.toggle('hot', mine.length > 0);
    const body = lane.querySelector('.lane-body');
    const sig = mine.map((b) => b.id).join('|');
    if (body.dataset.sig !== sig) { body.dataset.sig = sig; body.innerHTML = mine.map((b) => betRow(b)).join(''); }
    for (const b of mine) updateRow(body.querySelector(`[data-id="${b.id}"]`), b, now);
  }
  $('lanes').classList.toggle('none-open', total === 0);
  const bc = $('betsCount'); bc.hidden = !total; bc.textContent = total;
}
setInterval(renderLanes, 1000);

const RING = 2 * Math.PI * 18;
const FACE = `
<svg class="face" viewBox="0 0 64 64" aria-hidden="true">
  <defs><radialGradient id="fg" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff1a8"/><stop offset=".6" stop-color="#ffc94a"/><stop offset="1" stop-color="#d98e0b"/></radialGradient></defs>
  <circle cx="32" cy="32" r="27" fill="url(#fg)" stroke="#7a4f06" stroke-width="2"/>
  <g class="st rich">
    <text x="21" y="31" text-anchor="middle" font-size="15" font-weight="900" fill="#0f7a3d" font-family="Inter,Arial">$</text>
    <text x="43" y="31" text-anchor="middle" font-size="15" font-weight="900" fill="#0f7a3d" font-family="Inter,Arial">$</text>
    <path d="M15 22 q6 -5 12 -1 M37 21 q6 -4 12 1" stroke="#5a3a05" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M17 37 Q32 58 47 37 Z" fill="#4a1d06"/><path d="M20 38 H44 L42 42 H22 Z" fill="#fff"/>
    <ellipse cx="14" cy="38" rx="4" ry="2.5" fill="#ff8a65" opacity=".6"/><ellipse cx="50" cy="38" rx="4" ry="2.5" fill="#ff8a65" opacity=".6"/>
  </g>
  <g class="st cry">
    <path d="M14 20 l11 5 M50 20 l-11 5" stroke="#5a3a05" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M16 30 q5 4 10 0 M38 30 q5 4 10 0" stroke="#5a3a05" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M20 50 Q32 36 44 50 Q32 44 20 50 Z" fill="#4a1d06"/>
    <path d="M17 33 v20 M47 33 v20" stroke="#60a5fa" stroke-width="4" stroke-linecap="round" opacity=".85"/>
  </g>
  <g class="st meh">
    <circle cx="22" cy="28" r="3.2" fill="#5a3a05"/><circle cx="42" cy="28" r="3.2" fill="#5a3a05"/>
    <path d="M22 44 H42" stroke="#5a3a05" stroke-width="3" stroke-linecap="round"/>
  </g>
</svg>`;
function betRow(b) {
  return `<div class="lbet${b.pending ? ' pending' : ''}" data-id="${b.id}">
    <div class="ring"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="4"/><circle class="arc" cx="22" cy="22" r="18" fill="none" stroke-width="4" stroke-linecap="round" stroke-dasharray="${RING}"/></svg><span class="lbl"></span></div>
    <div class="mid"><div class="l1"><span class="pill ${b.choice}">${b.choice.toUpperCase()}</span>${esc(b.coin)} ${b.whaleSide.toLowerCase()}</div><div class="l2"></div></div>
    <div class="avatar meh" data-level="0">${FACE}<div class="fly"></div></div>
    <div class="bottom"><div class="res"></div>
    <button class="cashout" data-cashout="${b.id}" aria-label="Cash out this bet"><span>CASH OUT</span><b></b></button></div>
  </div>`;
}
function updateRow(row, b, now) {
  if (!row) return;
  const total = b.settleAt - b.placedAt, left = Math.max(0, b.settleAt - now);
  const frac = left / total;
  const mood = b.pending || b.winningNow == null ? 'meh' : b.winningNow ? 'rich' : 'cry';
  const col = mood === 'meh' ? '#d4af37' : mood === 'rich' ? '#22c07e' : '#e0445a';
  const arc = row.querySelector('.arc'); arc.setAttribute('stroke', col); arc.setAttribute('stroke-dashoffset', RING * (1 - frac));
  const mm = Math.floor(left / 60e3), ss = Math.floor((left % 60e3) / 1000);
  const hh = Math.floor(left / 3600e3), rm = Math.floor((left % 3600e3) / 60e3);
  row.querySelector('.lbl').textContent = b.ride ? 'RIDE' : left >= 3600e3 ? `${hh}h${String(rm).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  // intensity 0..3 from how confidently the bet is winning or losing right now
  const conf = b.pWin == null ? 0 : Math.abs(b.pWin - 0.5) * 2;
  const level = mood === 'meh' ? 0 : conf > 0.75 ? 3 : conf > 0.4 ? 2 : 1;
  row.className = `lbet ${b.pending ? 'pending ' : ''}${mood === 'rich' ? 'winning' : mood === 'cry' ? 'losing' : ''} lvl${level}`;
  const av = row.querySelector('.avatar');
  if (!av.classList.contains(mood) || av.dataset.level !== String(level)) {
    av.className = `avatar ${mood}`; av.dataset.level = level;
    const fly = av.querySelector('.fly');
    const n = mood === 'rich' ? level * 3 : mood === 'cry' ? level * 3 : 0;
    fly.innerHTML = Array.from({ length: n }, (_, i) => mood === 'rich'
      ? `<i class="bill" style="--d:${(i * 0.23).toFixed(2)}s;--x:${(Math.random() * 60 - 30).toFixed(0)}px;--r:${(Math.random() * 80 - 40).toFixed(0)}deg;--s:${(1.6 - level * 0.3).toFixed(2)}s">$</i>`
      : `<i class="tear" style="--d:${(i * 0.19).toFixed(2)}s;--x:${i % 2 ? 14 : -14}px;--s:${(1.4 - level * 0.25).toFixed(2)}s"></i>`).join('');
  }
  row.querySelector('.l2').textContent = b.pending ? `${usd(b.stake)} @ x${b.price.toFixed(2)} · placing chips…`
    : `${usd(b.stake)} @ x${b.price.toFixed(2)} · ${price(b.entry)}${b.now ? ' → ' + price(b.now) : ''}${b.myRet != null ? ' (' + pct(b.myRet, 2) + ')' : ''}${b.ride ? ` · ends when the whale exits${b.whaleTrims ? ` · whale trimmed ${b.whaleTrims}x` : ''} · max ${hh}h${String(rm).padStart(2, '0')} left` : ''}`;
  const potential = Math.round(b.stake * (b.price - 1));
  row.querySelector('.res').innerHTML = mood === 'meh' ? `<span>${usd(b.stake)}</span> <small>flat</small>`
    : mood === 'rich' ? `<span class="pos">+${usd(potential)}</span> <small>if it ends now</small>` : `<span class="neg">-${usd(b.stake)}</span> <small>if it ends now</small>`;
  const btn = row.querySelector('.cashout');
  const ok = !b.pending && b.cashOut != null && left > 6000;
  btn.disabled = !ok || btn.dataset.busy === '1';
  btn.querySelector('b').textContent = ok ? usd(b.cashOut) : '—';
  btn.classList.toggle('up', ok && b.cashOut >= b.stake);
}

// Cash out (event delegation so the 1s refresh never swallows the click)
$('lanes').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cashout]');
  if (!btn || btn.disabled) return;
  btn.dataset.busy = '1'; btn.disabled = true;
  try {
    const r = await api('/api/live/cashout', { player: player.id, betId: btn.dataset.cashout });
    prevStatus.set(r.bet.id, 'cashed');
    const row = btn.closest('.lbet'); row?.classList.add('leaving');
    setTimeout(() => { const idx = lastBets.findIndex((x) => x.id === r.bet.id); if (idx >= 0) lastBets[idx] = r.bet; renderLanes(); }, 550);
    player = r.player; renderPlayer(); refreshReport();
    const rect = btn.getBoundingClientRect();
    if (r.net >= 0) {
      sfx.cashout(); setTimeout(() => sfx.win(r.net > 1000), 250); coinRain(r.net > 1000 ? 100 : 60);
      burst(rect.left + rect.width / 2, rect.top, 70);
      banner('The whale is my exit liquidity', `Cashed out ${r.bet.coin} for +${usd(r.net)}`, 'win');
    } else {
      sfx.cashout(); setTimeout(() => sfx.escape(), 150);
      burst(rect.left + rect.width / 2, rect.top, 40, ['#60a5fa', '#f5d77a', '#f3ead7']);
      banner('Cashing out before the whale gets rekt', `Saved ${usd(r.bet.payout)} of your ${usd(r.bet.stake)} on ${r.bet.coin}`, 'save');
    }
  } catch (err) { toast(err.message); btn.dataset.busy = ''; }
});

function banner(title, sub, kind) {
  const el = $('banner');
  el.className = 'banner ' + kind;
  el.innerHTML = `<div class="rays"></div><div class="banner-card"><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`;
  el.hidden = false;
  clearTimeout(el._h); el._h = setTimeout(() => (el.hidden = true), 3200);
}
$('banner')?.addEventListener('click', () => ($('banner').hidden = true));

async function announceSettled(settledNow) {
  refreshReport();
  {
    const prev = player.bankroll;
    player = await api('/api/player?id=' + player.id);
    renderPlayer();
    for (const b of settledNow) {
      const net = (b.payout ?? 0) - b.stake;
      const how = b.ride ? (b.whaleClosed ? `The whale exited ${b.coin} after ${hrs(b.whaleHeldMs)}` : `24h cap on ${b.coin}`) : `${LANES[b.minutes] || 'Live bet'} on ${b.coin}`;
      if (b.status === 'won') { sfx.ding(); setTimeout(() => sfx.win(net > 2000), 200); coinRain(net > 2000 ? 90 : 45); toast(`${how}: you won +${usd(net)}`); }
      else if (b.status === 'lost') { sfx.lose(); toast(`${how}: you lost ${usd(net)}`); }
      else { sfx.push(); toast(`Push on ${b.coin}: stake returned`); }
    }
    if (prev === player.bankroll) renderPlayer();
  }
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 4200);
}

// ================================================= THE TABLE (replay)
async function deal() {
  $('round').hidden = true; $('reveal').hidden = true; $('suspense').hidden = true; $('err').hidden = true; $('dealing').hidden = false;
  try { round = await api('/api/round?player=' + player.id); }
  catch (e) { $('dealing').hidden = true; return showErr(e.message + ' — '); }
  const r = round;
  const card = $('playcard');
  card.className = 'playcard ' + r.side;
  $('cSideShort').textContent = $('cSideShort2').textContent = r.side === 'Long' ? 'L' : 'S';
  $('rSide').textContent = r.side.toUpperCase(); $('rSide').className = 'side ' + r.side;
  $('rCoin').innerHTML = coinHtml(r.coin); $('rValue').textContent = compact(r.valueUsd); $('rEntry').textContent = price(r.entryPrice);
  $('rWhen').textContent = new Date(r.openedAt).toUTCString().slice(5, 22) + ' UTC (' + ago(r.openedAt) + ')';
  $('rType').textContent = r.orderType || 'Market'; $('rHorizon').textContent = `the whale's real exit (max ${r.maxHoldHours}h)`;
  const gr = r.grade || { grade: '?' };
  $('rGrade').textContent = gr.grade === '?' ? 'Ungraded whale' : `Grade ${gr.grade}${gr.specialist ? ' · specialist' : ''}`;
  $('rGrade').className = 'grade-chip ' + ({ 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[gr.grade] || 'gc');
  const i = r.intel;
  setStat('iWin', i.walletWinRate != null ? Math.round(i.walletWinRate * 100) + '%' : 'n/a', i.walletWinRate != null ? i.walletWinRate >= 0.5 : null);
  $('iClosed').textContent = i.walletClosedTrades ? `${i.walletClosedTrades} closed trades` : 'no history';
  setStat('iPnl', i.walletPnl30d != null ? compact(i.walletPnl30d) : 'n/a', i.walletPnl30d != null ? i.walletPnl30d >= 0 : null);
  setStat('iSm', i.smFlow24h != null ? compact(i.smFlow24h) : 'n/a', i.smFlow24h != null ? i.smFlow24h >= 0 : null);
  setStat('iCrowd', i.crowdFlow24h != null ? compact(i.crowdFlow24h) : 'n/a', i.crowdFlow24h != null ? i.crowdFlow24h >= 0 : null);
  $('reasons').innerHTML = r.reasons.map((x) => `<li class="${x.good ? 'good' : ''}">${esc(x.text)}</li>`).join('');
  $('pFollowBar').style.width = '50%'; $('needle').style.left = '50%';
  $('pFollow').textContent = Math.round(r.pFollow * 100) + '%'; $('pFade').textContent = Math.round((1 - r.pFollow) * 100) + '%';
  $('oFollow').textContent = r.odds.follow.toFixed(2); $('oFade').textContent = r.odds.fade.toFixed(2);
  $('stakeInput').value = Math.max(1, Math.floor(Math.min(Number($('stakeInput').value) || 1000, player.bankroll)));
  updatePotential();
  $('btnFollow').disabled = $('btnFade').disabled = false;
  $('dealing').hidden = true; $('round').hidden = false;
  card.classList.remove('dealt'); void card.offsetWidth; card.classList.add('dealt');
  sfx.deal();
  setTimeout(() => { $('pFollowBar').style.width = (r.pFollow * 100).toFixed(1) + '%'; $('needle').style.left = `calc(${(r.pFollow * 100).toFixed(1)}% - 1px)`; }, 350);
}
function setStat(id, text, good) { const el = $(id); el.textContent = text; el.classList.remove('pos', 'neg'); if (good != null) el.classList.add(good ? 'pos' : 'neg'); }
function showErr(msg) { const e = $('err'); e.hidden = false; e.innerHTML = `${esc(msg)}<a href="#" id="retry">Try again</a>`; $('retry').onclick = (ev) => { ev.preventDefault(); deal(); }; }

function updatePotential() {
  if (!round || !player) return;
  const s = Math.max(0, Math.floor(Number($('stakeInput').value) || 0));
  $('wFollow').textContent = usd(s * (round.odds.follow - 1));
  $('wFade').textContent = usd(s * (round.odds.fade - 1));
}
$('stakeInput').addEventListener('input', () => { document.querySelectorAll('.chip').forEach((c) => c.classList.remove('picked')); updatePotential(); });
document.querySelectorAll('.chips-row .chip').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('picked', c === b));
  $('stakeInput').value = Math.max(1, Math.floor(player.bankroll * Number(b.dataset.pct)));
  sfx.chip(); updatePotential();
  if (b.dataset.pct === '1') { sparkleAt(b, 30); toast('All in. The house respects it.'); }
}));

async function bet(choice, btn) {
  const stake = Math.floor(Number($('stakeInput').value));
  if (!(stake >= 1) || stake > player.bankroll) return showErr('Stake must be between $1 and your bankroll. ');
  $('btnFollow').disabled = $('btnFade').disabled = true;
  sfx.bet(); sparkleAt(btn, 18);
  let res;
  try { res = await api('/api/bet', { player: player.id, roundId: round.roundId, choice, stake }); }
  catch (e) { $('btnFollow').disabled = $('btnFade').disabled = false; return showErr(e.message + ' — '); }
  // suspense: spin the wheel before the reveal
  $('round').hidden = true; $('suspense').hidden = false; sfx.roll(1.2);
  await sleep(1300);
  player = res.player; lastResult = { ...res, round, choice };
  showReveal(res, choice); renderPlayer(); refreshStatus();
}
$('btnFollow').onclick = (e) => bet('follow', e.currentTarget);
$('btnFade').onclick = (e) => bet('fade', e.currentTarget);
$('btnNext').onclick = () => { sfx.chip(); deal(); };

function showReveal(res, choice) {
  const v = res.reveal, r = round;
  $('suspense').hidden = true; $('reveal').hidden = false;
  const big = res.result === 'win' && (res.whaleSlain || res.price >= 2.2 || res.delta >= 5000);
  const title = res.busted ? 'Rekt. The house reloads you.' : res.result === 'win' ? (res.whaleSlain ? 'Whale slain!' : big ? 'Jackpot call!' : 'You called it.') : res.result === 'loss' ? 'The house wins this one.' : 'Push. Your chips are back.';
  const sub = `You ${choice === 'follow' ? 'followed' : 'faded'} a ${r.side.toLowerCase()} on ${r.coin} at x${res.price.toFixed(2)} → ${res.delta >= 0 ? '+' : ''}${usd(res.delta)} · the whale ${v.closed ? `closed after ${hrs(v.heldMs)}` : `was still holding after ${v.maxHoldHours}h`}`;
  const vd = $('verdict'); vd.className = 'verdict ' + res.result; vd.innerHTML = `${esc(title)}<small>${esc(sub)}</small>`;
  void vd.offsetWidth; vd.classList.add('pop');
  $('vTrader').textContent = v.trader; $('vLink').href = v.nansenUrl; $('vH').textContent = v.closed ? `· closed after ${hrs(v.heldMs)}` : `· still holding at ${v.maxHoldHours}h`;
  setStat('vRet', pct(v.ret, 2), v.ret >= 0);
  $('vExc').textContent = `${v.trims > 1 ? `scaled out in ${v.trims} fills · ` : ''}best ${pct(v.mfe, 1)} · worst ${pct(v.mae, 1)}`;
  setStat('vWhale', (v.whalePnlUsd >= 0 ? '+' : '') + compact(v.whalePnlUsd), v.whalePnlUsd >= 0);
  setStat('vYou', (res.delta >= 0 ? '+' : '') + usd(res.delta), res.delta >= 0);
  drawChart(v.path, r.entryPrice, res.result !== 'loss', v.closed ? `whale exit · ${hrs(v.heldMs)}` : `still holding · ${v.maxHoldHours}h mark`);
  renderLesson(res.lesson);
  const rt = $('btnRealTrade');
  rt.href = `https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(r.coin)}&chain=hyperliquid`;
  rt.textContent = res.result === 'win' ? `You read it right. Trade ${r.coin} for real on Nansen ↗` : `Study ${r.coin} on Nansen ↗`;
  rt.hidden = false;
  $('refTable').hidden = false;
  refreshReport();
  const felt = document.querySelector('.felt');
  if (res.result === 'win') {
    sfx.win(big);
    const rect = vd.getBoundingClientRect(); burst(rect.left + rect.width / 2, rect.top + 30, big ? 120 : 60);
    if (big) coinRain(110);
  } else if (res.result === 'loss') {
    sfx.lose(); felt.classList.remove('shake'); void felt.offsetWidth; felt.classList.add('shake');
    if (res.busted) toast('Busted. Fresh $10,000 on the house.');
  } else sfx.push();
}

function drawChart(path, entry, userGood, exitLabel = '') {
  const svg = $('chart'), W = 600, Hh = 220, pad = 14;
  const ys = path.map((p) => p[1]).concat(entry);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const x = (i) => pad + (i / (path.length - 1)) * (W - pad * 2);
  const y = (v) => Hh - pad - ((v - min) / span) * (Hh - pad * 2);
  const last = path[path.length - 1][1];
  const col = userGood ? '#f5d77a' : '#e0445a';
  const d = path.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  svg.innerHTML = `
    <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".3"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${pad}" x2="${W - pad}" y1="${y(entry)}" y2="${y(entry)}" stroke="rgba(243,234,215,.5)" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"/>
    <text x="${pad + 4}" y="${y(entry) - 6}" fill="rgba(243,234,215,.7)" font-size="11" font-family="JetBrains Mono">whale entry ${price(entry)}</text>
    <path d="${d}L${x(path.length - 1)},${Hh}L${pad},${Hh}Z" fill="url(#g)" opacity="0"><animate attributeName="opacity" from="0" to="1" begin="1.1s" dur=".4s" fill="freeze"/></path>
    <path id="line" pathLength="1" d="${d}" fill="none" stroke="${col}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${x(path.length - 1)}" cy="${y(last)}" r="5" fill="${col}" opacity="0"><animate attributeName="opacity" from="0" to="1" begin="1.1s" dur=".2s" fill="freeze"/></circle>
    ${exitLabel ? `<text x="${W - pad - 4}" y="${Math.max(14, y(last) - 10)}" text-anchor="end" fill="${col}" font-size="11" font-family="JetBrains Mono" opacity="0">${esc(exitLabel)}<animate attributeName="opacity" from="0" to="1" begin="1.2s" dur=".3s" fill="freeze"/></text>` : ''}`;
  const line = svg.querySelector('#line');
  line.style.strokeDasharray = '1 1';
  line.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 1100, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
}

// ================================================= share card
$('btnShare').onclick = () => {
  sfx.chip();
  const c = $('shareCanvas'), g = c.getContext('2d'), p = player, L = lastResult;
  const bg = g.createRadialGradient(600, 200, 50, 600, 340, 800); bg.addColorStop(0, '#146b4b'); bg.addColorStop(0.55, '#0d4a35'); bg.addColorStop(1, '#041a12');
  g.fillStyle = bg; g.fillRect(0, 0, 1200, 675);
  const rim = g.createLinearGradient(0, 0, 1200, 675); rim.addColorStop(0, '#8a6d1d'); rim.addColorStop(0.45, '#f5d77a'); rim.addColorStop(1, '#8a6d1d');
  g.strokeStyle = rim; g.lineWidth = 18; g.strokeRect(9, 9, 1182, 657);
  g.strokeStyle = 'rgba(245,215,122,.4)'; g.lineWidth = 2; g.strokeRect(34, 34, 1132, 607);
  g.textAlign = 'center';
  g.fillStyle = rim; g.font = '900 54px Cinzel, Georgia, serif'; g.fillText('FOLLOW ◆ FADE', 600, 120);
  g.fillStyle = 'rgba(243,234,215,.75)'; g.font = 'italic 500 28px "Cormorant Garamond", Georgia, serif'; g.fillText(`${p.name} at the Smart Money Casino`, 600, 165);
  g.fillStyle = '#f5d77a'; g.font = '700 130px "JetBrains Mono", monospace'; g.shadowColor = 'rgba(245,215,122,.5)'; g.shadowBlur = 30;
  g.fillText(usd(p.bankroll), 600, 330); g.shadowBlur = 0;
  const ch = (p.bankroll - 10000) / 10000;
  g.fillStyle = ch >= 0 ? '#34d399' : '#f06377'; g.font = '700 40px "JetBrains Mono", monospace'; g.fillText(`${pct(ch, 0)} from $10k`, 600, 390);
  g.fillStyle = '#f3ead7'; g.font = '600 30px Inter, sans-serif';
  g.fillText(`${p.wins}–${p.bets - p.wins - (p.pushes || 0)} record  ·  best streak ${p.bestStreak}  ·  ${p.whalesSlain} whales slain`, 600, 465);
  if (L) { g.fillStyle = 'rgba(243,234,215,.75)'; g.font = '500 26px Inter, sans-serif'; g.fillText(`Last hand: ${L.choice === 'follow' ? 'followed' : 'faded'} a ${compact(L.round.valueUsd)} ${L.round.coin} ${L.round.side.toLowerCase()} → ${L.delta >= 0 ? '+' : ''}${usd(L.delta)}`, 600, 520); }
  g.fillStyle = 'rgba(245,215,122,.8)'; g.font = '600 20px Cinzel, Georgia, serif'; g.fillText('REAL HYPERLIQUID TRADES · NANSEN SMART MONEY · ODDS BY NANSEN API', 600, 605);
  c.toBlob((b) => { $('shareDownload').href = URL.createObjectURL(b); });
  const text = `I turned $10k into ${usd(p.bankroll)} betting for and against @nansen_ai Smart Money on Hyperliquid. ${p.whalesSlain} whales slain. Follow or fade?`;
  $('shareX').href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text);
  $('shareDlg').showModal();
};

// ================================================= tabs
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  sfx.tick();
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.view === t.dataset.view));
  closeSheet();
  if (t.classList.contains('bn') || t.dataset.view === 'plans') window.scrollTo({ top: 0 });
  $('betaStrip').classList.toggle('on-plans', t.dataset.view === 'plans');
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + t.dataset.view));
  if (t.dataset.view === 'board') loadBoard();
  if (t.dataset.view === 'live') loadLive();
  if (t.dataset.view === 'replay' && !round) deal();
  if (t.dataset.view === 'report') refreshReport(true);
}));

// ================================================= hall of fame
async function loadBoard() {
  const rows = await api('/api/leaderboard');
  const podium = [rows[1], rows[0], rows[2]];
  $('podium').innerHTML = rows.length ? podium.map((r, i) => r ? `<div class="pod p${[2, 1, 3][i]}"><div class="medal">${[2, 1, 3][i]}</div><b>${esc(r.name)}</b><em>${usd(r.bankroll)}</em><div class="muted">${Math.round(r.winRate * 100)}% win rate</div></div>` : '<div></div>').join('') : '';
  $('boardBody').innerHTML = rows.length ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="${r.bankroll >= 10000 ? 'pos' : 'neg'}">${usd(r.bankroll)}</td><td>${r.bets}</td><td>${Math.round(r.winRate * 100)}%</td><td>${r.bestStreak}</td><td>${r.whalesSlain}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">No bets yet. Be the first legend.</td></tr>';
}

// ================================================= live floor
// The Live Floor: prefetched in the background, entered through a short "welcome" curtain the first time.
let liveCache = null, livePromise = null, liveShownOnce = false;
function fetchLive() {
  livePromise ??= api('/api/live').then((items) => { liveCache = { t: Date.now(), items }; return items; }).finally(() => { livePromise = null; });
  return livePromise;
}
function renderLive(items) {
  $('liveList').innerHTML = items.length ? items.map(liveCard).join('') : '<p class="muted">No whales opened positions in the last 6 hours. Check back soon.</p>';
  wireLive();
}
async function loadLive({ refresh = false } = {}) {
  loadPick();
  const fresh = liveCache && Date.now() - liveCache.t < 60e3;
  if (liveCache && !refresh) renderLive(liveCache.items);                    // show what we have instantly
  if (!liveShownOnce) { liveShownOnce = true; return enterFloor(fresh); }
  if (fresh && !refresh) return;
  if (!liveCache) $('liveList').innerHTML = '<div class="dealing" style="min-height:200px"><div class="deck"><i></i><i></i><i></i></div><p>Scanning the floor for whales…</p></div>';
  try { renderLive(await fetchLive()); } catch (e) { if (!liveCache) $('liveList').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function enterFloor(ready = false) {
  const el = $('floorIntro');
  const lines = ['Scanning Nansen Smart Money…', 'Pulling whale track records…', 'Grading every whale A+ to F…', 'Checking live Hyperliquid prices…', 'Setting the odds…'];
  let i = 0;
  const status = el.querySelector('.fi-status');
  status.textContent = lines[0];
  const ticker = setInterval(() => { i = (i + 1) % lines.length; status.classList.remove('swap'); void status.offsetWidth; status.textContent = lines[i]; status.classList.add('swap'); }, 700);
  el.hidden = false; el.classList.remove('open'); void el.offsetWidth; el.classList.add('show');
  sfx.enter();
  const minShow = sleep(ready ? 1400 : 1900);
  let items = null, err = null;
  try { [items] = await Promise.all([ready ? Promise.resolve(liveCache.items) : fetchLive(), minShow]); } catch (e) { err = e; await minShow; }
  clearInterval(ticker);
  if (items) renderLive(items); else if (err && !liveCache) $('liveList').innerHTML = `<p class="err">${esc(err.message)}</p>`;
  status.textContent = 'The floor is open.';
  el.classList.add('open'); sfx.chip();
  setTimeout(() => { el.hidden = true; el.classList.remove('show', 'open'); }, 900);
}
const liveItems = new Map();
function recordHtml(r) {
  if (!r || !r.closed) return '<div class="rec-empty">No closed perp trades in this window</div>';
  return `<div class="rec-grid">
    <div><small>Realized PnL</small><b class="${r.pnl >= 0 ? 'pos' : 'neg'}">${r.pnl >= 0 ? '+' : ''}${compact(r.pnl)}</b></div>
    <div><small>Return on closes</small><b class="${r.roi >= 0 ? 'pos' : 'neg'}">${pct(r.roi, 1)}</b></div>
    <div><small>Win rate</small><b>${r.winRate != null ? Math.round(r.winRate * 100) + '%' : 'n/a'}</b></div>
    <div><small>Closed trades</small><b>${r.closed.toLocaleString()}</b></div>
  </div>
  <div class="rec-coins">${r.best ? `Best: <b class="${r.best.pnl >= 0 ? 'pos' : 'neg'}">${esc(r.best.coin)} ${r.best.pnl >= 0 ? '+' : ''}${compact(r.best.pnl)}</b>` : ''}${r.worst ? ` · Worst: <b class="neg">${esc(r.worst.coin)} ${compact(r.worst.pnl)}</b>` : ''} · ${r.coins} coins traded</div>`;
}
function liveCard(t) {
  liveItems.set(t.key, t);
  const k = esc(t.key), tr = t.record?.trust || { grade: '?', label: 'No track record' };
  const gradeCls = { 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[tr.grade] || 'gc';
  return `<div class="lcard${t.alert ? ' alerted' : ''}" data-key="${k}">${t.alert ? '<div class="ribbon">WHALE ALERT</div>' : ''}
    <div class="row"><div><span class="side ${t.side}">${t.side.toUpperCase()}</span><span class="coin">${coinHtml(t.coin)}</span></div><div class="size">${compact(t.valueUsd)}</div></div>
    <div class="meta">${esc(t.trader || 'Smart Money whale')} · ${ago(t.openedAt)} · entry ${price(t.entryPrice)} → now ${price(t.mid)} · whale <span class="${t.moveSinceEntry >= 0 ? 'pos' : 'neg'}">${pct(t.moveSinceEntry, 2)}</span></div>

    <button class="lc-summary" aria-expanded="false"><span class="grade ${gradeCls}">${tr.grade}</span><span class="lcs-text"><b>${esc(tr.label)}</b><small>${t.record?.d30?.closed ? `30D ${t.record.d30.pnl >= 0 ? '+' : ''}${compact(t.record.d30.pnl)} · ${Math.round((t.record.d30.winRate || 0) * 100)}% wins · ${t.record.d30.coins} coins` : 'No 30D track record'}</small></span><span class="lcs-more">Details</span></button>
    ${t.research ? researchBlock(t) : ''}
    <div class="lc-more">
    <div class="dossier-box">
      <div class="dossier-top">
        <div class="grade ${gradeCls}" title="Trust score ${tr.score ?? '–'}/100, from realized return, win rate and sample size (30d), adjusted by the last 7 days">${tr.grade}</div>
        <div class="dossier-title"><b>Whale track record${tr.specialist ? ' <span class="spec-tag">SPECIALIST</span>' : ''}</b><span>${esc(tr.label)}${tr.score != null ? ` · trust ${tr.score}/100` : ''}</span></div>
        <div class="rec-tabs" role="tablist"><button class="on" data-win="d7">7D</button><button data-win="d30">30D</button></div>
      </div>
      <div class="rec-body" data-panel="d7">${recordHtml(t.record?.d7)}</div>
      <div class="rec-body" data-panel="d30" hidden>${recordHtml(t.record?.d30)}</div>
    </div>

    <ul class="reasons">${t.reasons.map((x) => `<li class="${x.good ? 'good' : ''}">${esc(x.text)}</li>`).join('')}</ul>
    </div>
    <div class="probbar"><div class="pf" style="width:${(t.pFollow * 100).toFixed(1)}%"></div><div class="needle" style="left:calc(${(t.pFollow * 100).toFixed(1)}% - 1px)"></div></div>
    <div class="problabels"><span>Follow wins <b>${Math.round(t.pFollow * 100)}%</b></span><span>Fade wins <b>${Math.round((1 - t.pFollow) * 100)}%</b></span></div>
    <div class="horizons">
      <button class="hz" data-min="15" title="Quick and just for fun: doesn't count toward your Skill Report"><b>Espresso</b><small>15 min</small></button>
      <button class="hz" data-min="240"><b>Cigar Lounge</b><small>4 hours</small></button>
      <button class="hz on ride" data-min="ride" title="Your bet ends when this whale closes the position (max 24h)"><b>Ride the Whale</b><small>until exit</small></button>
    </div>
    <div class="lstake"><input type="number" min="1" value="500" aria-label="Stake"><button class="minichip" data-add="100">+100</button><button class="minichip g" data-add="500">+500</button><button class="minichip r" data-add="1000">+1K</button><button class="minichip k" data-add="all">ALL</button></div>
    <div class="actions"><button class="bet follow" data-choice="follow"><span>FOLLOW</span><small>x${t.odds.follow.toFixed(2)}</small></button>
    <button class="bet fade" data-choice="fade"><span>FADE</span><small>x${t.odds.fade.toFixed(2)}</small></button></div>
    <div class="links"><a href="https://app.nansen.ai/profiler?address=${esc(t.address)}&chain=hyperliquid" target="_blank" rel="noopener">Whale profile on Nansen ↗</a><a class="trade-nansen" href="https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(t.coin)}&chain=hyperliquid" target="_blank" rel="noopener">Trade ${esc(t.coin)} on Nansen ↗</a></div>
    ${refLink('ref-under')}
  </div>`;
}
function wireLive() {
  document.querySelectorAll('.lcard').forEach((card) => {
    const input = card.querySelector('input');
    card.querySelectorAll('.rec-tabs button').forEach((tb) => tb.onclick = () => {
      card.querySelectorAll('.rec-tabs button').forEach((x) => x.classList.toggle('on', x === tb));
      card.querySelectorAll('.rec-body').forEach((p) => (p.hidden = p.dataset.panel !== tb.dataset.win));
      sfx.tick();
    });
    card.querySelectorAll('.hz').forEach((h) => h.onclick = () => { card.querySelectorAll('.hz').forEach((x) => x.classList.toggle('on', x === h)); sfx.tick(); });
    card.querySelectorAll('[data-add]').forEach((c) => c.onclick = () => {
      input.value = c.dataset.add === 'all' ? Math.floor(player.bankroll) : Math.min(player.bankroll, (Number(input.value) || 0) + Number(c.dataset.add));
      sfx.chip(); if (c.dataset.add === 'all') { sparkleAt(c, 20); toast('All in. The house respects it.'); }
    });
    const rq = card.querySelector('.rq-btn');
    if (rq) rq.onclick = () => openResearch(card, liveItems.get(card.dataset.key));
    const more = card.querySelector('.lc-summary');
    if (more) more.onclick = () => { card.classList.toggle('expanded'); more.setAttribute('aria-expanded', card.classList.contains('expanded')); sfx.tick(); };
    card.querySelectorAll('.bet').forEach((btn) => btn.onclick = async () => {
      const minRaw = card.querySelector('.hz.on').dataset.min; const minutes = minRaw === 'ride' ? 'ride' : Number(minRaw);
      const stake = Math.floor(Number(input.value));
      const t = liveItems.get(card.dataset.key);
      if (!(stake >= 1) || stake > player.bankroll) return toast('Stake must be between $1 and your bankroll');
      const choice = btn.dataset.choice;
      // 1) show it on Your Table instantly
      const tmp = { id: 'tmp-' + Math.random().toString(36).slice(2), pending: true, coin: t.coin, whaleSide: t.side, choice, stake,
        price: choice === 'follow' ? t.odds.follow : t.odds.fade, entry: t.mid, placedAt: Date.now(), settleAt: Date.now() + (minutes === 'ride' ? 24 * 3600e3 : minutes * 60e3), minutes, ride: minutes === 'ride', status: 'open' };
      pending.push(tmp); renderLanes();
      player.bankroll -= stake; renderPlayer();
      sfx.bet(); sparkleAt(btn, 26);
      // 2) confirm with the server
      try {
        const b = await api('/api/live/bet', { player: player.id, key: card.dataset.key, choice, stake, minutes });
        prevStatus.set(b.id, 'open');
        pending = pending.filter((x) => x !== tmp);
        lastBets = [b, ...lastBets]; renderLanes();
        sfx.chip();
        toast(`Chips down at the ${LANES[minutes]}: ${choice.toUpperCase()} ${b.coin} for ${usd(b.stake)}`);
        nudgeBets();
        pollBets();
      } catch (e) {
        pending = pending.filter((x) => x !== tmp); renderLanes();
        player.bankroll += stake; renderPlayer();
        toast(e.message);
      }
    });
  });
}
$('btnRefreshLive').onclick = () => { sfx.deal(); loadLive({ refresh: true }); };

// ================================================= whale alerts
let alertCfg = null, alertSince = 0, alertsCache = [];
const seenAlerts = () => Number(store.get('fof_alerts_seen') || 0);
const gradeClass = (g) => ({ 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[g] || 'gc');
const nansenTrade = (coin) => `https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(coin)}&chain=hyperliquid`;

async function initAlerts() {
  const r = await api('/api/alerts?since=0').catch(() => null);
  if (!r) return;
  alertsCache = r.alerts; alertCfg = r.config;
  alertSince = alertsCache[0]?.t || Date.now();
  renderAlertList(); renderAlertCfg(); updateBadge();
  setInterval(pollAlerts, 10000);
}
async function pollAlerts() {
  const r = await api('/api/alerts?since=' + alertSince).catch(() => null);
  if (!r) return;
  alertCfg = r.config; renderAlertStatus();
  if (!r.alerts.length) return;
  alertSince = r.alerts[0].t;
  alertsCache = [...r.alerts, ...alertsCache].slice(0, 50);
  renderAlertList(); updateBadge();
  announceAlert(r.alerts[0], r.alerts.length);
}
function updateBadge() {
  const n = alertsCache.filter((a) => a.t > seenAlerts()).length;
  const el = $('alertCount'); el.hidden = !n; el.textContent = n > 9 ? '9+' : n;
  $('alertBtn').classList.toggle('ringing', n > 0);
}
function alertLine(a) {
  const d30 = a.record?.d30 || {}, d7 = a.record?.d7, tr = a.record?.trust || { grade: '?' };
  return `<div class="alert-item${a.t > seenAlerts() ? ' unread' : ''}" data-id="${a.id}">
    <div class="grade ${gradeClass(tr.grade)}">${tr.grade}</div>
    <div class="ai-body">
      <div class="ai-title"><span class="side ${a.side}">${a.side.toUpperCase()}</span> <b>${esc(a.coin)}</b> <span class="mono">${compact(a.valueUsd)}</span> ${a.specialist ? `<span class="spec-tag" title="${Math.round(a.specialist.share * 100)}% of 30D closes on ${esc(a.coin)} · +${compact(a.specialist.pnl)} realized · ${(a.specialist.roi * 100).toFixed(1)}% return">SPECIALIST</span>` : ''} <span class="muted">· ${ago(a.openedAt)}${a.test ? ' · test' : ''}</span></div>
      <div class="ai-who">${esc(a.trader)} · ${esc(tr.label || '')}</div>
      ${a.specialist ? `<div class="ai-spec">${esc(a.coin)} specialist: ${Math.round(a.specialist.share * 100)}% of trades, <b class="pos">+${compact(a.specialist.pnl)}</b> realized on ${esc(a.coin)} (${(a.specialist.roi * 100).toFixed(1)}% return) in 30D</div>` : ''}
      <div class="ai-stats">30D <b class="${d30.pnl >= 0 ? 'pos' : 'neg'}">${d30.pnl >= 0 ? '+' : ''}${compact(d30.pnl || 0)}</b> · ${Math.round((d30.winRate || 0) * 100)}% wins · ${d30.coins || 0} coins${d7 && d7.closed ? ` · 7D <b class="${d7.pnl >= 0 ? 'pos' : 'neg'}">${d7.pnl >= 0 ? '+' : ''}${compact(d7.pnl)}</b> · ${d7.coins} coins` : ''}</div>
      <div class="ai-actions"><button class="gold-btn sm" data-betalert="${esc(a.key)}">Bet on it</button><a class="ghost-btn sm" href="${nansenTrade(a.coin)}" target="_blank" rel="noopener">Join on Nansen ↗</a><a class="link" href="https://app.nansen.ai/profiler?address=${esc(a.address)}&chain=hyperliquid" target="_blank" rel="noopener">Profile ↗</a></div>
    </div></div>`;
}
function renderAlertList() {
  $('alertList').innerHTML = alertsCache.length ? alertsCache.map(alertLine).join('')
    : '<p class="ap-empty">No alerts yet. The scanner checks Nansen Smart Money every few minutes and pings you when a whale matching your rules opens a position.</p>';
}
function renderAlertStatus() {
  if (!alertCfg) return;
  const last = alertCfg.lastScan ? `last scan ${ago(alertCfg.lastScan)}` : 'first scan starting';
  $('apStatus').innerHTML = alertCfg.enabled
    ? `<i class="live-dot"></i> Watching for <b>${alertCfg.minGrade === 'A+' ? 'A+' : alertCfg.minGrade + ' or better'}</b> whales opening <b>${compact(alertCfg.minSizeUsd)}+</b> · <b>${alertCfg.minCoins7d || 'any'}+/${alertCfg.minCoins30d || 'any'}+</b> coins (7D/30D)${alertCfg.allowSpecialists !== false ? ' or proven specialists' : ''} · every ${alertCfg.intervalMin} min · ${last}${alertCfg.lastError ? ` · <span class="neg">${esc(alertCfg.lastError)}</span>` : ''}`
    : '<i class="live-dot off"></i> Scanner is off';
}
function renderAlertCfg() {
  if (!alertCfg) return;
  $('apSettings').hidden = alertCfg.canAdmin === false;
  $('apPublicNote').hidden = alertCfg.canAdmin !== false;
  $('cfgEnabled').checked = alertCfg.enabled; $('cfgGrade').value = alertCfg.minGrade; $('cfgWin').value = String(alertCfg.minWinRate);
  $('cfgSize').value = String(alertCfg.minSizeUsd); $('cfgC7').value = String(alertCfg.minCoins7d ?? 3); $('cfgC30').value = String(alertCfg.minCoins30d ?? 5); $('cfgInt').value = String(alertCfg.intervalMin); $('cfgProfit').checked = alertCfg.requireProfit30d; $('cfgSpec').checked = alertCfg.allowSpecialists !== false;
  $('apCost').textContent = `Scanning every ${alertCfg.intervalMin} min uses about ${alertCfg.estCreditsPerDay.toLocaleString()} Nansen credits per day while the app is open, plus 2 credits per new whale checked.`;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('notifState').textContent = perm === 'granted' ? 'On' : perm === 'denied' ? 'Blocked in browser settings' : perm === 'unsupported' ? 'Not supported' : 'Off';
  $('notifBtn').hidden = perm !== 'default';
  $('apPublicNotif').hidden = alertCfg.canAdmin !== false;
  $('notifState2').textContent = $('notifState').textContent; $('notifBtn2').hidden = perm !== 'default';
  const tgc = alertCfg.telegram;
  $('tgState').textContent = tgc.connected ? `Connected to @${tgc.botName}` : tgc.hasToken ? 'Waiting for Start' : 'Off';
  $('tgConnect').hidden = tgc.hasToken; $('tgVerify').hidden = !(tgc.hasToken && !tgc.connected); $('tgOff').hidden = !tgc.hasToken;
  $('tgBotName').textContent = tgc.botName ? '@' + tgc.botName : 'your bot';
  renderAlertStatus();
}
async function saveCfg() {
  alertCfg = await api('/api/alerts/config', { enabled: $('cfgEnabled').checked, minGrade: $('cfgGrade').value, minWinRate: $('cfgWin').value,
    minSizeUsd: $('cfgSize').value, minCoins7d: $('cfgC7').value, minCoins30d: $('cfgC30').value, intervalMin: $('cfgInt').value, requireProfit30d: $('cfgProfit').checked, allowSpecialists: $('cfgSpec').checked }).catch((e) => { toast(e.message); return alertCfg; });
  renderAlertCfg(); sfx.tick();
}
['cfgEnabled', 'cfgGrade', 'cfgWin', 'cfgSize', 'cfgInt', 'cfgProfit', 'cfgC7', 'cfgC30', 'cfgSpec'].forEach((id) => $(id).addEventListener('change', saveCfg));

function openAlerts() {
  $('alertPanel').hidden = false; sfx.tick();
  store.set('fof_alerts_seen', String(alertsCache[0]?.t || Date.now()));
  setTimeout(() => { updateBadge(); document.querySelectorAll('.alert-item.unread').forEach((x) => x.classList.remove('unread')); }, 1500);
}
$('alertBtn').onclick = () => ($('alertPanel').hidden ? openAlerts() : ($('alertPanel').hidden = true));
$('alertClose').onclick = () => ($('alertPanel').hidden = true);
$('notifBtn').onclick = async () => { if ('Notification' in window) await Notification.requestPermission(); renderAlertCfg(); };
$('notifBtn2').onclick = async () => { if ('Notification' in window) await Notification.requestPermission(); renderAlertCfg(); };
$('scanNow').onclick = async (e) => { e.target.disabled = true; const r = await api('/api/alerts/scan', {}).catch((err) => (toast(err.message), null)); e.target.disabled = false; if (r) { alertCfg = r.config; renderAlertStatus(); if (!r.created.length) toast('Scan done. No new whale matched your rules.'); else pollAlerts(); } };
$('testAlert').onclick = async (e) => { e.target.disabled = true; await api('/api/alerts/test', {}).catch((err) => toast(err.message)); e.target.disabled = false; pollAlerts(); };
$('tgSave').onclick = async () => { try { alertCfg = await api('/api/alerts/telegram', { token: $('tgToken').value }); $('tgToken').value = ''; renderAlertCfg(); } catch (e) { toast(e.message); } };
$('tgCheck').onclick = async () => { try { alertCfg = await api('/api/alerts/telegram/verify', {}); renderAlertCfg(); toast('Telegram connected. Check your Telegram for a test message.'); sfx.ding(); } catch (e) { toast(e.message); } };
$('tgOff').onclick = async () => { alertCfg = await api('/api/alerts/telegram/disconnect', {}); renderAlertCfg(); };

// "Bet on it": jump to the Live Floor card for that trade
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-betalert]');
  if (!b) return;
  $('alertPanel').hidden = true; $('alertPop').hidden = true;
  const key = b.dataset.betalert;
  document.querySelector('.tab[data-view="live"]').click();
  for (let i = 0; i < 60; i++) { if (document.querySelector('.lcard')) break; await sleep(250); }
  const card = [...document.querySelectorAll('.lcard')].find((c) => c.dataset.key === key);
  if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('spotlight'); setTimeout(() => card.classList.remove('spotlight'), 3500); }
  else toast('That trade is no longer on the floor');
});

function announceAlert(a, count) {
  const tr = a.record?.trust || { grade: '?' }, d30 = a.record?.d30 || {};
  sfx.alarm();
  const pop = $('alertPop');
  pop.innerHTML = `<div class="ap-glow"></div><div class="ap-inner">
    <div class="ap-kicker">Whale alert${a.specialist ? ' · Specialist' : ''}${count > 1 ? ` · +${count - 1} more` : ''}</div>
    <div class="ap-main"><div class="grade ${gradeClass(tr.grade)}">${tr.grade}</div>
      <div><b>${esc(a.trader)}</b> just opened <span class="side ${a.side}">${a.side.toUpperCase()}</span> <b>${esc(a.coin)}</b> ${compact(a.valueUsd)}
      <div class="ai-stats">${a.specialist ? `${esc(a.coin)} specialist · <b class="pos">+${compact(a.specialist.pnl)}</b> on ${esc(a.coin)} · ${Math.round(a.specialist.share * 100)}% of trades` : `30D <b class="${d30.pnl >= 0 ? 'pos' : 'neg'}">${d30.pnl >= 0 ? '+' : ''}${compact(d30.pnl || 0)}</b> · ${Math.round((d30.winRate || 0) * 100)}% wins`} · trust ${tr.score ?? '–'}/100</div></div></div>
    <div class="ai-actions"><button class="gold-btn sm" data-betalert="${esc(a.key)}">Bet on it</button><a class="ghost-btn sm" href="${nansenTrade(a.coin)}" target="_blank" rel="noopener">Join on Nansen ↗</a><button class="link" id="popClose">Dismiss</button></div></div>`;
  pop.hidden = false;
  $('popClose').onclick = () => (pop.hidden = true);
  clearTimeout(pop._h); pop._h = setTimeout(() => (pop.hidden = true), 15000);
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`Whale alert · Grade ${tr.grade}`, { body: `${a.trader} opened ${a.side.toUpperCase()} ${a.coin} ${compact(a.valueUsd)} · ${a.specialist ? `${a.coin} specialist, +${compact(a.specialist.pnl)} on ${a.coin} (30D)` : `30D ${compact(d30.pnl || 0)}, ${Math.round((d30.winRate || 0) * 100)}% wins`}`, tag: a.id });
    n.onclick = () => { window.focus(); pop.querySelector('[data-betalert]')?.click(); n.close(); };
  }
}

// ================================================= coach: lessons + skill report
function renderLesson(l) {
  const el = $('lesson');
  if (!l) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="lesson-head"><span>What the data said</span><b>${esc(l.headline)}</b></div>
    ${l.tell ? `<div class="lesson-row tell"><i></i><div><p>${esc(l.tell.text)}</p>${l.tell.stat ? `<small>${esc(l.tell.stat)}</small>` : ''}</div></div>` : ''}
    ${l.trap ? `<div class="lesson-row trap"><i></i><div><p>${esc(l.trap.text)}</p>${l.trap.stat ? `<small>${esc(l.trap.stat)}</small>` : ''}</div></div>` : ''}
    ${l.model ? `<div class="lesson-foot">${esc(l.model)} <b>${esc(l.you || '')}</b></div>` : ''}`;
}
let lastReport = null;
async function refreshReport(render = false) {
  if (!player) return;
  const r = await api('/api/report?player=' + player.id).catch(() => null);
  if (!r) return;
  const leveledUp = lastReport && r.level.index > lastReport.level.index;
  lastReport = r;
  $('lvlName').textContent = r.level.name;
  $('lvlHands').textContent = `${r.hands} hand${r.hands === 1 ? '' : 's'}`;
  $('lvlBar').style.width = (r.level.progress * 100).toFixed(0) + '%';
  $('levelMini').classList.toggle('ready', r.level.index === 3);
  if (leveledUp) { sfx.win(true); coinRain(80); banner(`Level up: ${r.level.name}`, r.level.index === 3 ? 'Your reads beat the odds. Time to trade for real on Nansen.' : 'Your Skill Report has new insights.', 'win'); }
  if (render || document.getElementById('view-report').classList.contains('active')) renderReport(r);
}
function renderReport(r) {
  const body = $('reportBody');
  const steps = ['Rookie', 'Learning the tells', 'Sharp reader', 'Ready for real trades'];
  const ladder = steps.map((nm, i) => `<div class="step${i < r.level.index ? ' done' : i === r.level.index ? ' now' : ''}"><i>${i + 1}</i><span>${nm}</span></div>`).join('');
  const pat = (x) => `<div class="pat"><div class="pat-top"><span>${esc(x.label)}</span><b class="${x.n < 3 ? 'muted' : x.winRate >= 0.55 ? 'pos' : x.winRate <= 0.45 ? 'neg' : ''}">${x.winRate == null ? '–' : Math.round(x.winRate * 100) + '%'}</b></div>
    <div class="pat-bar"><i style="width:${x.winRate == null ? 0 : Math.round(x.winRate * 100)}%"></i></div><small>${x.n} hand${x.n === 1 ? '' : 's'} · ${x.pnl >= 0 ? '+' : ''}${usd(x.pnl)}</small></div>`;
  if (r.hands < 3) {
    body.innerHTML = `<div class="report-card empty"><div class="ladder">${ladder}</div><h3>Play a few hands to get your first reading</h3><p>Every bet on the Training Table or the Live Floor is analyzed: which Nansen signals you followed, which whales you trusted, and whether you beat the odds.</p><button class="gold-btn" id="goTrain">Deal a training hand</button></div>`;
    $('goTrain').onclick = () => document.querySelector('.tab[data-view="replay"]').click();
    return;
  }
  body.innerHTML = `
    <div class="report-card">
      <p class="counts-note">Counts training hands (judged on the whale's real exit), 4-hour and Ride the Whale bets${r.funHands ? `. ${r.funHands} Espresso bet${r.funHands === 1 ? ' is' : 's are'} just for fun and not counted` : ''}.</p>
      <div class="level-row"><div class="level-badge l${r.level.index}">${r.level.index + 1}</div><div><small>Your level</small><h3>${esc(r.level.name)}</h3><p>${r.level.next ? 'Next: ' + esc(r.level.next) : 'You beat the odds consistently. Take the reads you are best at to real trades on Nansen.'}</p></div></div>
      <div class="ladder">${ladder}</div>
      <div class="kpis">
        <div><small>Hands analyzed</small><b>${r.hands}</b></div>
        <div><small>Your win rate</small><b>${Math.round(r.winRate * 100)}%</b></div>
        <div><small>What the odds expected</small><b>${Math.round(r.expected * 100)}%</b></div>
        <div><small>Your edge over the odds</small><b class="${r.edge >= 0 ? 'pos' : 'neg'}">${r.edge >= 0 ? '+' : ''}${(r.edge * 100).toFixed(1)} pts</b></div>
        <div><small>Play-money PnL</small><b class="${r.pnl >= 0 ? 'pos' : 'neg'}">${r.pnl >= 0 ? '+' : ''}${usd(r.pnl)}</b></div>
      </div>
      ${r.advice.length ? `<div class="advice"><b>Coach says</b>${r.advice.map((a) => `<p>${esc(a)}</p>`).join('')}</div>` : ''}
    </div>
    <div class="report-cols">
      <div class="report-card"><h4 class="pos-h">Your strengths</h4>${r.strengths.length ? r.strengths.map(pat).join('') : '<p class="muted">Keep playing: a pattern needs 3+ hands and a 60%+ win rate to show here.</p>'}</div>
      <div class="report-card"><h4 class="neg-h">Your leaks</h4>${r.leaks.length ? r.leaks.map(pat).join('') : '<p class="muted">No leaks found yet. Patterns with a 45% or lower win rate (3+ hands) show here.</p>'}</div>
    </div>
    <div class="report-card"><h4>Every pattern we track</h4><div class="pat-grid">${r.patterns.map(pat).join('')}</div></div>
    <div class="report-card cta"><div><h4>Ready to use what you learned?</h4><p>Nansen has the same Smart Money data and a built-in trading app for Hyperliquid perps. Practice here, then trade the patterns you are best at for real.</p></div>
      <div class="ref-actions"><a class="nansen-btn big" href="https://app.nansen.ai/token-god-mode?tokenAddress=BTC&chain=hyperliquid" target="_blank" rel="noopener">Open Nansen trading ↗</a><span class="ref-codeline">New to Nansen? <a class="ref-link" href="${esc(REF.url)}" target="_blank" rel="noopener sponsored">Sign up with code <b class="ref-code">${esc(REF.code)}</b> ↗</a></span></div></div>
    <p class="disclaimer">Play money only. Past results in a game do not guarantee real trading results. Not financial advice.</p>`;
}
$('levelMini').onclick = () => document.querySelector('.tab[data-view="report"]').click();

// ================================================= mobile: Your Table as a bottom sheet
const sheetMode = () => window.matchMedia('(max-width: 1099px)').matches;
function openSheet() { if (!sheetMode()) return; $('rail').classList.add('open'); $('railBackdrop').hidden = false; document.body.classList.add('sheet-open'); sfx.tick(); }
function closeSheet() { $('rail').classList.remove('open'); $('railBackdrop').hidden = true; document.body.classList.remove('sheet-open'); }
$('betsBtn').onclick = () => ($('rail').classList.contains('open') ? closeSheet() : openSheet());
$('railClose').onclick = closeSheet;
$('railBackdrop').onclick = closeSheet;
$('levelMini').addEventListener('click', closeSheet);
window.addEventListener('resize', () => { if (!sheetMode()) closeSheet(); });
function nudgeBets() { const b = $('betsBtn'); b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge'); }

boot();


// ================================================= free beta + plans
function renderBeta(b) {
  if (!b) return;
  const d = b.daysLeft;
  $('betaDays').textContent = d == null || d <= 0 ? '' : ` · ${d} day${d === 1 ? '' : 's'} left`;
  const ends = Date.parse(b.ends + 'T12:00:00Z');
  if (d > 0 && Number.isFinite(ends)) $('betaEnds').textContent = new Date(ends).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}
$('betaGo').onclick = () => document.querySelector('.tab[data-view="plans"]').click();
let wantPlan = 'premium';
document.querySelectorAll('.pl-cta').forEach((b) => b.addEventListener('click', () => {
  sfx.chip();
  if (b.dataset.plan === 'free') return document.querySelector('.tab[data-view="replay"]').click();
  wantPlan = b.dataset.plan;
  document.querySelectorAll('.plan').forEach((p) => p.classList.toggle('picked', p.contains(b)));
  $('wfTitle').textContent = wantPlan === 'premium' ? 'Save your High Roller seat' : 'Save your Player seat';
  $('waitForm').hidden = false; $('wfDone').hidden = true;
  $('waitForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('wfEmail').focus({ preventScroll: true }), 450);
}));
$('waitForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('waitForm').querySelector('button'); if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await api('/api/waitlist', { email: $('wfEmail').value, plan: wantPlan, player: player?.name || '' });
    sfx.win(false);
    try { coinRain(40); } catch {}
    $('wfDone').hidden = false;
    $('wfDone').textContent = r.already ? "You're already on the list. We updated your plan." : `Seat saved. You're #${r.position} on the list. Enjoy the free beta meanwhile.`;
  } catch (err) { toast(err.message); }
  btn.disabled = false;
});


// ================================================= Research Desk (Nansen Agent)
const SIG_TXT = { buying: 'Insiders BUYING', selling: 'Insiders SELLING', mixed: 'Insiders MIXED', none: 'No insider trades' };
const ALIGN_TXT = { aligned: 'same side as the whale', against: 'against the whale', neutral: 'no clear signal' };
const MAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const usable = (s) => s && !/not available|unknown|n\/a/i.test(s);
function researchBlock(t) {
  const r = t.research;
  const pill = r.status === 'ready'
    ? `<span class="rq-sig ${r.signal}">${SIG_TXT[r.signal]}</span><span class="rq-al ${r.alignment}">${ALIGN_TXT[r.alignment]}</span>`
    : '<span class="rq-hint">Check what the company\'s insiders are doing</span>';
  return `<div class="rq"><button class="rq-btn" aria-expanded="false">${MAG}<span class="rq-title">Insider check <small>Nansen Agent</small></span><span class="rq-pills">${pill}</span></button><div class="rq-panel" hidden></div></div>`;
}
function intelHtml(i, side) {
  const al = i.insider.signal === 'buying' ? (side === 'Long' ? 'aligned' : 'against') : i.insider.signal === 'selling' ? (side === 'Short' ? 'aligned' : 'against') : 'neutral';
  const rows = [['Ownership', i.ownership], ['Last earnings', i.earnings?.last], ['Next earnings', i.earnings?.next], ['Valuation', i.valuation]].filter(([, v]) => usable(v));
  return `<div class="rq-head"><b>${esc(i.company || i.ticker)}</b><span class="rq-sig ${i.insider.signal}">${SIG_TXT[i.insider.signal]}</span></div>
    ${i.insider.detail ? `<p class="rq-detail">${esc(i.insider.detail)}</p>` : ''}
    <p class="rq-vs ${al}">The whale is <b>${side.toUpperCase()}</b>: ${al === 'aligned' ? 'insiders point the same way' : al === 'against' ? 'insiders point the other way' : 'insiders give no clear direction'}.</p>
    <dl class="rq-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${i.verdict ? `<p class="rq-verdict">${esc(i.verdict)}</p>` : ''}
    <p class="rq-foot">AI research by Nansen Agent${i.tools?.length ? ` · ${i.tools.length} Nansen stock data tools` : ''}${i.asOf ? ` · as of ${esc(i.asOf)}` : ''}${i.demo ? ' · sample data' : ''}. Verify before trading.</p>`;
}
async function openResearch(card, t) {
  const box = card.querySelector('.rq'), panel = box.querySelector('.rq-panel'), btn = box.querySelector('.rq-btn');
  const open = panel.hidden;
  panel.hidden = !open; btn.setAttribute('aria-expanded', open); box.classList.toggle('open', open); sfx.tick();
  if (!open || panel.dataset.done) return;
  panel.innerHTML = `<div class="rq-loading"><span class="spin"></span><div><b>Nansen Agent is reading ${esc(t.coin.split(':').pop())} insider filings…</b><small>Insider trades, ownership, earnings and valuation. Takes about 15 seconds.</small></div></div>`;
  for (let tries = 0; tries < 6; tries++) {
    const r = await api(`/api/research/intel?coin=${encodeURIComponent(t.coin)}&wait=1`).catch((e) => ({ status: 'error', message: e.message }));
    if (r.status === 'ready') {
      panel.dataset.done = '1'; panel.innerHTML = intelHtml(r.intel, t.side); sfx.ding();
      box.querySelector('.rq-pills').innerHTML = `<span class="rq-sig ${r.intel.insider.signal}">${SIG_TXT[r.intel.insider.signal]}</span>`;
      return;
    }
    if (r.status !== 'loading') { panel.innerHTML = `<p class="rq-msg">${esc(r.message || 'The Research Desk has no brief for this stock right now.')}</p>`; return; }
  }
  panel.innerHTML = '<p class="rq-msg">Nansen Agent is still working on it. Open this again in a moment.</p>';
}

// ---- Insider Pick of the Day
let pickData = null;
async function loadPick() {
  const r = await api('/api/research/pick' + (player ? `?player=${player.id}` : '')).catch(() => null);
  if (!r) return;
  pickData = r;
  renderPick();
}
function renderPick() {
  const box = $('pickBox'), r = pickData;
  if (!r || r.status === 'none' || !r.desk?.enabled) { box.innerHTML = ''; return; }
  if (r.status === 'loading') {
    box.innerHTML = `<div class="pick loading"><div class="pk-ribbon">Insider Pick of the Day</div><div class="rq-loading"><span class="spin"></span><div><b>Nansen Agent is screening every stock on Hyperliquid for insider buying…</b><small>Expert mode. Today's pick lands here in about a minute.</small></div></div></div>`;
    setTimeout(loadPick, 20e3); return;
  }
  const p = r.pick, live = r.status === 'ready';
  const ticker = p.coin.split(':').pop();
  const conv = Array.from({ length: 5 }, (_, i) => `<i class="${i < p.conviction ? 'on' : ''}"></i>`).join('');
  const facts = [['Earnings', p.earnings], ['Valuation', p.valuation], ['Risks', p.risks]].filter(([, v]) => usable(v));
  box.innerHTML = `<article class="pick${live ? '' : ' old'}">
    <div class="pk-ribbon">${live ? 'Insider Pick of the Day' : "Yesterday's Insider Pick · today's screen is coming"}</div>
    <div class="pk-top">
      <div class="pk-id"><span class="side ${p.side}">${p.side.toUpperCase()}</span><span class="coin">${coinHtml(p.coin)}</span><span class="pk-co">${esc(p.company || '')}</span></div>
      <div class="pk-px"><small>since the pick</small><b class="${(r.move ?? 0) >= 0 ? 'pos' : 'neg'}">${r.move == null ? '–' : pct(r.move, 2)}</b></div>
    </div>
    <div class="pk-sig"><span class="rq-sig ${p.insider.signal}">${SIG_TXT[p.insider.signal]}</span><span class="pk-conv" title="Nansen Agent conviction ${p.conviction}/5">Conviction ${conv}</span></div>
    ${p.insider.detail ? `<p class="pk-detail">${esc(p.insider.detail)}</p>` : ''}
    ${p.thesis ? `<p class="pk-thesis">${esc(p.thesis)}</p>` : ''}
    <details class="pk-more"><summary>Full research</summary>
      ${p.thesis ? `<p class="pk-thesis m">${esc(p.thesis)}</p>` : ''}
      <dl class="rq-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${p.runnersUp?.length ? `<div class="pk-runners"><small>Runners-up</small>${p.runnersUp.map((x) => `<span><b>${esc(x.ticker)}</b> ${esc(x.why || '')}</span>`).join('')}</div>` : ''}
    </details>
    ${live ? `<div class="pk-bet">
      <div class="lstake"><input type="number" min="1" value="500" aria-label="Stake"><button class="minichip" data-add="100">+100</button><button class="minichip g" data-add="500">+500</button><button class="minichip r" data-add="1000">+1K</button><button class="minichip k" data-add="all">ALL</button></div>
      <div class="actions"><button class="bet follow" data-choice="follow"><span>FOLLOW</span><small>x${r.odds.follow.toFixed(2)} · 24h</small></button><button class="bet fade" data-choice="fade"><span>FADE</span><small>x${r.odds.fade.toFixed(2)} · 24h</small></button></div>
    </div>` : ''}
    <div class="links"><span class="pk-src">Nansen Agent Expert · ${p.screened ? `${p.screened} Hyperliquid stocks screened` : 'Hyperliquid stocks'}${p.tools?.length ? ` · ${p.tools.filter((x) => x.startsWith('stocks_')).length} stock data tools` : ''}. AI research, verify before trading.</span><a class="trade-nansen" href="${nansenTrade(p.coin)}" target="_blank" rel="noopener">Trade ${esc(ticker)} on Nansen ↗</a></div>
    ${refLink('ref-under')}
  </article>`;
  const card = box.querySelector('.pick'), input = card.querySelector('input');
  card.querySelectorAll('[data-add]').forEach((c) => c.onclick = () => {
    input.value = c.dataset.add === 'all' ? Math.floor(player.bankroll) : Math.min(player.bankroll, (Number(input.value) || 0) + Number(c.dataset.add));
    sfx.chip(); if (c.dataset.add === 'all') sparkleAt(c, 20);
  });
  card.querySelectorAll('.bet').forEach((btn) => btn.onclick = async () => {
    const stake = Math.floor(Number(input.value)), choice = btn.dataset.choice;
    if (!(stake >= 1) || stake > player.bankroll) return toast('Stake must be between $1 and your bankroll');
    const tmp = { id: 'tmp-' + Math.random().toString(36).slice(2), pending: true, coin: p.coin, whaleSide: p.side, choice, stake, price: r.odds[choice], entry: r.mid, placedAt: Date.now(), settleAt: Date.now() + 864e5, minutes: 1440, pick: true, status: 'open' };
    pending.push(tmp); renderLanes(); player.bankroll -= stake; renderPlayer(); sfx.bet(); sparkleAt(btn, 26);
    try {
      const b = await api('/api/research/pick/bet', { player: player.id, choice, stake });
      prevStatus.set(b.id, 'open');
      pending = pending.filter((x) => x !== tmp); lastBets = [b, ...lastBets]; renderLanes(); sfx.chip();
      toast(`Chips down on the Insider Pick: ${choice === 'follow' ? 'following' : 'fading'} ${ticker} for ${usd(stake)}, settles in 24h`);
      nudgeBets(); pollBets();
    } catch (e) { pending = pending.filter((x) => x !== tmp); renderLanes(); player.bankroll += stake; renderPlayer(); toast(e.message); }
  });
}
