import { sfx, isMuted, setMuted } from './sfx.js';
import { coinRain, burst, sparkleAt, countTo } from './fx.js';

const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
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
const LANES = { 15: 'Espresso Shot', 30: 'Champagne Round', 60: 'Cigar Lounge' };

let player = null, round = null, lastResult = null;
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
  pollBets(); setInterval(pollBets, 5000);
  deal();
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
  $('sRecord').textContent = `${player.wins}–${player.bets - player.wins}`;
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
  $('demoBadge').hidden = !s.usage.demo;
  $('uCalls').textContent = s.usage.calls.toLocaleString();
  $('uCredits').textContent = s.usage.credits.toLocaleString();
  $('uModel').textContent = s.model.n ? s.model.n.toLocaleString() : '—';
  if (s.smWinRate != null) {
    $('smWin').textContent = Math.round(s.smWinRate * 100) + '%';
    $('smWinTxt').textContent = `of ${s.sampleSize} Smart Money opens were green ${s.horizonHours}h later`;
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
  lastBets = bets;
  renderLanes();
  if (settledNow.length) await announceSettled(settledNow);
}
let lastBets = [];
function renderLanes() {
  const bets = lastBets, now = Date.now();
  for (const min of [15, 30, 60]) {
    const lane = document.querySelector(`.lane[data-min="${min}"]`);
    const mine = bets.filter((b) => (b.minutes || Math.round((b.settleAt - b.placedAt) / 60e3)) === min)
      .filter((b) => b.status === 'open' || now - (b.cashedAt || b.settleAt) < 30 * 60e3).slice(0, 6);
    lane.querySelector('.count').textContent = mine.filter((b) => b.status === 'open').length;
    lane.classList.toggle('empty', !mine.length);
    const body = lane.querySelector('.lane-body');
    const sig = mine.map((b) => b.id + b.status).join('|');
    if (body.dataset.sig !== sig) { body.dataset.sig = sig; body.innerHTML = mine.map((b) => betRow(b)).join(''); }
    for (const b of mine) updateRow(body.querySelector(`[data-id="${b.id}"]`), b, now);
  }
}
setInterval(renderLanes, 1000);

const RING = 2 * Math.PI * 18;
function betRow(b) {
  return `<div class="lbet" data-id="${b.id}">
    <div class="ring"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="4"/><circle class="arc" cx="22" cy="22" r="18" fill="none" stroke-width="4" stroke-linecap="round" stroke-dasharray="${RING}"/></svg><span class="lbl"></span></div>
    <div class="mid"><div class="l1"><span class="pill ${b.choice}">${b.choice.toUpperCase()}</span>${esc(b.coin)} ${b.whaleSide.toLowerCase()}</div>
    <div class="l2"></div></div>
    <div class="res"></div>
    ${b.status === 'open' ? `<button class="cashout" data-cashout="${b.id}" aria-label="Cash out this bet"><span>CASH OUT</span><b></b></button>` : ''}
  </div>`;
}
function updateRow(row, b, now) {
  if (!row) return;
  const total = b.settleAt - b.placedAt, left = Math.max(0, b.settleAt - now);
  const open = b.status === 'open';
  const frac = open ? left / total : 0;
  const col = open ? (b.winningNow == null ? '#d4af37' : b.winningNow ? '#22c07e' : '#e0445a') : b.status === 'won' ? '#f5d77a' : b.status === 'cashed' ? '#60a5fa' : '#6b6255';
  const arc = row.querySelector('.arc'); arc.setAttribute('stroke', col); arc.setAttribute('stroke-dashoffset', RING * (1 - frac));
  const mm = Math.floor(left / 60e3), ss = Math.floor((left % 60e3) / 1000);
  row.querySelector('.lbl').textContent = open ? `${mm}:${String(ss).padStart(2, '0')}` : ({ won: 'WON', lost: 'LOST', push: 'PUSH', cashed: 'CASHED' })[b.status];
  row.className = 'lbet ' + (open ? (b.winningNow == null ? '' : b.winningNow ? 'winning' : 'losing') : b.status);
  row.querySelector('.l2').textContent = `${usd(b.stake)} @ x${b.price.toFixed(2)} · ${price(b.entry)}${b.now ? ' → ' + price(b.now) : b.exit ? ' → ' + price(b.exit) : ''}`;
  const res = row.querySelector('.res');
  if (open) {
    const potential = Math.round(b.stake * (b.price - 1));
    res.innerHTML = b.winningNow == null ? `<span>${usd(b.stake)}</span><small>flat</small>` : b.winningNow ? `<span class="pos">+${usd(potential)}</span><small>winning now</small>` : `<span class="neg">-${usd(b.stake)}</span><small>losing now</small>`;
    const btn = row.querySelector('.cashout');
    if (btn) {
      const ok = b.cashOut != null && left > 6000;
      btn.disabled = !ok || btn.dataset.busy === '1';
      btn.querySelector('b').textContent = ok ? usd(b.cashOut) : '—';
      btn.classList.toggle('up', ok && b.cashOut >= b.stake);
    }
  } else {
    const net = (b.payout ?? 0) - b.stake;
    res.innerHTML = `<span class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net >= 0 ? '+' : ''}${usd(net)}</span><small>${b.status === 'cashed' ? 'cashed out' : 'settled'}</small>`;
  }
}

// Cash out (event delegation so the 1s refresh never swallows the click)
$('lanes').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cashout]');
  if (!btn || btn.disabled) return;
  btn.dataset.busy = '1'; btn.disabled = true;
  try {
    const r = await api('/api/live/cashout', { player: player.id, betId: btn.dataset.cashout });
    prevStatus.set(r.bet.id, 'cashed');
    const idx = lastBets.findIndex((x) => x.id === r.bet.id); if (idx >= 0) lastBets[idx] = r.bet;
    player = r.player; renderPlayer(); renderLanes();
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
  {
    const prev = player.bankroll;
    player = await api('/api/player?id=' + player.id);
    renderPlayer();
    for (const b of settledNow) {
      const net = (b.payout ?? 0) - b.stake;
      if (b.status === 'won') { sfx.ding(); setTimeout(() => sfx.win(net > 2000), 200); coinRain(net > 2000 ? 90 : 45); toast(`${LANES[b.minutes] || 'Live bet'} paid out: +${usd(net)} on ${b.coin}`); }
      else if (b.status === 'lost') { sfx.lose(); toast(`${LANES[b.minutes] || 'Live bet'} lost on ${b.coin}: ${usd(net)}`); }
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
  $('rType').textContent = r.orderType || 'Market'; $('rHorizon').textContent = r.horizonHours + 'h';
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
  const title = res.busted ? 'Rekt. The house reloads you.' : res.result === 'win' ? (res.whaleSlain ? 'Whale slain!' : big ? 'Jackpot call!' : 'You called it.') : res.result === 'loss' ? 'The house wins this one.' : 'Push. Chips returned.';
  const sub = `You ${choice === 'follow' ? 'followed' : 'faded'} a ${r.side.toLowerCase()} on ${r.coin} at x${res.price.toFixed(2)} → ${res.delta >= 0 ? '+' : ''}${usd(res.delta)}`;
  const vd = $('verdict'); vd.className = 'verdict ' + res.result; vd.innerHTML = `${esc(title)}<small>${esc(sub)}</small>`;
  void vd.offsetWidth; vd.classList.add('pop');
  $('vTrader').textContent = v.trader; $('vLink').href = v.nansenUrl; $('vH').textContent = r.horizonHours + 'h';
  setStat('vRet', pct(v.ret, 2), v.ret >= 0);
  $('vExc').textContent = `best ${pct(v.mfe, 1)} · worst ${pct(v.mae, 1)}`;
  setStat('vWhale', (v.whalePnlUsd >= 0 ? '+' : '') + compact(v.whalePnlUsd), v.whalePnlUsd >= 0);
  setStat('vYou', (res.delta >= 0 ? '+' : '') + usd(res.delta), res.delta >= 0);
  drawChart(v.path, r.entryPrice, res.result !== 'loss');
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

function drawChart(path, entry, userGood) {
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
    <circle cx="${x(path.length - 1)}" cy="${y(last)}" r="5" fill="${col}" opacity="0"><animate attributeName="opacity" from="0" to="1" begin="1.1s" dur=".2s" fill="freeze"/></circle>`;
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
  g.fillText(`${p.wins}–${p.bets - p.wins} record  ·  best streak ${p.bestStreak}  ·  ${p.whalesSlain} whales slain`, 600, 465);
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
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + t.dataset.view));
  if (t.dataset.view === 'board') loadBoard();
  if (t.dataset.view === 'live') loadLive();
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
async function loadLive() {
  $('liveList').innerHTML = '<div class="dealing" style="min-height:200px"><div class="deck"><i></i><i></i><i></i></div><p>Scanning the floor for whales…</p></div>';
  try {
    const items = await api('/api/live');
    $('liveList').innerHTML = items.length ? items.map(liveCard).join('') : '<p class="muted">No whales opened positions in the last 6 hours. Check back soon.</p>';
    wireLive();
  } catch (e) { $('liveList').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function liveCard(t, idx) {
  const k = esc(t.key);
  return `<div class="lcard" data-key="${k}">
    <div class="row"><div><span class="side ${t.side}">${t.side.toUpperCase()}</span><span class="coin">${coinHtml(t.coin)}</span></div><div class="size">${compact(t.valueUsd)}</div></div>
    <div class="meta">${esc(t.trader || 'Smart Money whale')} · ${ago(t.openedAt)} · entry ${price(t.entryPrice)} → now ${price(t.mid)} · whale <span class="${t.moveSinceEntry >= 0 ? 'pos' : 'neg'}">${pct(t.moveSinceEntry, 2)}</span></div>
    <ul class="reasons">${t.reasons.map((x) => `<li class="${x.good ? 'good' : ''}">${esc(x.text)}</li>`).join('')}</ul>
    <div class="probbar"><div class="pf" style="width:${(t.pFollow * 100).toFixed(1)}%"></div><div class="needle" style="left:calc(${(t.pFollow * 100).toFixed(1)}% - 1px)"></div></div>
    <div class="problabels"><span>Follow wins <b>${Math.round(t.pFollow * 100)}%</b></span><span>Fade wins <b>${Math.round((1 - t.pFollow) * 100)}%</b></span></div>
    <div class="horizons">
      <button class="hz on" data-min="15"><b>Espresso</b><small>15 min</small></button>
      <button class="hz" data-min="30"><b>Champagne</b><small>30 min</small></button>
      <button class="hz" data-min="60"><b>Cigar</b><small>60 min</small></button>
    </div>
    <div class="lstake"><input type="number" min="1" value="500" aria-label="Stake"><button class="minichip" data-add="100">+100</button><button class="minichip g" data-add="500">+500</button><button class="minichip r" data-add="1000">+1K</button></div>
    <div class="actions"><button class="bet follow" data-choice="follow"><span>FOLLOW</span><small>x${t.odds.follow.toFixed(2)}</small></button>
    <button class="bet fade" data-choice="fade"><span>FADE</span><small>x${t.odds.fade.toFixed(2)}</small></button></div>
    <div class="links"><a href="https://app.nansen.ai/profiler?address=${esc(t.address)}&chain=hyperliquid" target="_blank" rel="noopener">Whale on Nansen ↗</a><a href="https://app.hyperliquid.xyz/trade/${encodeURIComponent(t.coin)}" target="_blank" rel="noopener">Trade ${esc(t.coin)} on Hyperliquid ↗</a></div>
  </div>`;
}
function wireLive() {
  document.querySelectorAll('.lcard').forEach((card) => {
    const input = card.querySelector('input');
    card.querySelectorAll('.hz').forEach((h) => h.onclick = () => { card.querySelectorAll('.hz').forEach((x) => x.classList.toggle('on', x === h)); sfx.tick(); });
    card.querySelectorAll('[data-add]').forEach((c) => c.onclick = () => { input.value = Math.min(player.bankroll, (Number(input.value) || 0) + Number(c.dataset.add)); sfx.chip(); });
    card.querySelectorAll('.bet').forEach((btn) => btn.onclick = async () => {
      const minutes = Number(card.querySelector('.hz.on').dataset.min);
      btn.disabled = true; sfx.bet();
      try {
        const b = await api('/api/live/bet', { player: player.id, key: card.dataset.key, choice: btn.dataset.choice, stake: input.value, minutes });
        prevStatus.set(b.id, 'open');
        sparkleAt(btn, 26); sfx.chip();
        toast(`Chips down at the ${LANES[minutes]}: ${btn.dataset.choice.toUpperCase()} ${b.coin} for ${usd(b.stake)}`);
        player = await api('/api/player?id=' + player.id); renderPlayer(); pollBets();
      } catch (e) { toast(e.message); }
      btn.disabled = false;
    });
  });
}
$('btnRefreshLive').onclick = () => { sfx.deal(); loadLive(); };

boot();
