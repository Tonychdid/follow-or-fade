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
const coinHtml = (c) => c.includes(':') ? `<small class="dex">${c.split(':')[0]}</small>${c.split(':')[1]}` : c;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let player = null, round = null, lastResult = null;

// ------------------------------------------------ boot
async function boot() {
  const id = store.get('fof_player');
  if (id) player = await api('/api/player?id=' + id).catch(() => null);
  if (!player) {
    $('welcome').showModal();
    await new Promise((r) => $('welcomeForm').addEventListener('submit', r, { once: true }));
    player = await api('/api/player', { name: $('nameInput').value });
    store.set('fof_player', player.id);
  }
  renderPlayer();
  refreshStatus(); setInterval(refreshStatus, 15000);
  deal();
}

function renderPlayer(prev) {
  const b = $('bankroll');
  b.textContent = usd(player.bankroll);
  if (prev !== undefined && prev !== player.bankroll) { b.className = player.bankroll > prev ? 'up' : 'down'; setTimeout(() => (b.className = ''), 1200); }
  $('sRecord').textContent = `${player.wins}–${player.bets - player.wins}`;
  $('sStreak').textContent = player.streak; $('sBest').textContent = player.bestStreak;
  $('sSlain').textContent = player.whalesSlain; $('sBusts').textContent = player.busts;
  const h = [10000, ...player.history.map((x) => x.bankroll)];
  const min = Math.min(...h), max = Math.max(...h), span = max - min || 1;
  const pts = h.map((v, i) => `${(i / Math.max(1, h.length - 1)) * 200},${38 - ((v - min) / span) * 36}`).join(' ');
  $('spark').innerHTML = `<polyline points="${pts}" fill="none" stroke="${player.bankroll >= 10000 ? '#34d399' : '#f87171'}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  updatePotential();
}

async function refreshStatus() {
  const s = await api('/api/status').catch(() => null);
  if (!s) return;
  $('demoBadge').hidden = !s.usage.demo;
  $('uCalls').textContent = s.usage.calls.toLocaleString();
  $('uCredits').textContent = s.usage.credits.toLocaleString();
  $('uModel').textContent = s.model.n ? `${s.model.n} trades` : 'prior';
  if (s.smWinRate != null) {
    $('smWin').textContent = Math.round(s.smWinRate * 100) + '%';
    const tail = s.smWinRate < 0.55 ? ' Following blindly is not a strategy.' : ' The edge is real, but not on every trade.';
    $('smWinTxt').textContent = `of ${s.sampleSize} Smart Money position opens were in profit ${s.horizonHours}h later.` + tail;
  }
}

// ------------------------------------------------ replay
async function deal() {
  $('round').hidden = true; $('reveal').hidden = true; $('err').hidden = true; $('dealing').hidden = false;
  try {
    round = await api('/api/round?player=' + player.id);
  } catch (e) {
    $('dealing').hidden = true; showErr(e.message + ' — '); return;
  }
  const r = round;
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
  $('reasons').innerHTML = r.reasons.map((x) => `<li class="${x.good ? 'good' : ''}">${x.text}</li>`).join('');
  $('pFollowBar').style.width = (r.pFollow * 100).toFixed(1) + '%';
  $('pFollow').textContent = Math.round(r.pFollow * 100) + '%'; $('pFade').textContent = Math.round((1 - r.pFollow) * 100) + '%';
  $('oFollow').textContent = r.odds.follow.toFixed(2); $('oFade').textContent = r.odds.fade.toFixed(2);
  const s = Math.min(Number($('stakeInput').value) || 1000, player.bankroll);
  $('stakeInput').value = Math.max(1, Math.floor(s));
  updatePotential();
  $('btnFollow').disabled = $('btnFade').disabled = false;
  $('dealing').hidden = true; $('round').hidden = false;
}
function setStat(id, text, good) { const el = $(id); el.textContent = text; el.className = good == null ? '' : good ? 'pos' : 'neg'; }
function showErr(msg) { const e = $('err'); e.hidden = false; e.innerHTML = `${msg}<a href="#" id="retry">Try again</a>`; $('retry').onclick = (ev) => { ev.preventDefault(); deal(); }; }

function updatePotential() {
  if (!round || !player) return;
  const s = Math.max(0, Math.floor(Number($('stakeInput').value) || 0));
  $('wFollow').textContent = usd(s * (round.odds.follow - 1));
  $('wFade').textContent = usd(s * (round.odds.fade - 1));
}
$('stakeInput').addEventListener('input', updatePotential);
document.querySelectorAll('.chips button').forEach((b) => b.addEventListener('click', () => {
  $('stakeInput').value = Math.max(1, Math.floor(player.bankroll * Number(b.dataset.pct))); updatePotential();
}));

async function bet(choice) {
  const stake = Math.floor(Number($('stakeInput').value));
  if (!(stake >= 1) || stake > player.bankroll) return showErr('Stake must be between $1 and your bankroll. ');
  $('btnFollow').disabled = $('btnFade').disabled = true;
  let res;
  try { res = await api('/api/bet', { player: player.id, roundId: round.roundId, choice, stake }); }
  catch (e) { $('btnFollow').disabled = $('btnFade').disabled = false; return showErr(e.message + ' — '); }
  const prev = player.bankroll; player = res.player; lastResult = { ...res, round, choice };
  showReveal(res, choice); renderPlayer(prev); refreshStatus();
}
$('btnFollow').onclick = () => bet('follow');
$('btnFade').onclick = () => bet('fade');
$('btnNext').onclick = deal;

function showReveal(res, choice) {
  const v = res.reveal, r = round;
  $('round').hidden = true; $('reveal').hidden = false;
  const card = $('reveal'); card.classList.remove('flash-win', 'flash-loss'); void card.offsetWidth;
  if (res.result !== 'push') card.classList.add(res.result === 'win' ? 'flash-win' : 'flash-loss');
  const title = res.busted ? 'REKT. Bankroll reset.' : res.result === 'win' ? (res.whaleSlain ? 'Whale slain.' : 'You called it.') : res.result === 'loss' ? 'Wrong side.' : 'Push. Stake returned.';
  const sub = `You ${choice === 'follow' ? 'followed' : 'faded'} a ${r.side.toLowerCase()} on ${r.coin} at x${res.price.toFixed(2)} → ${res.delta >= 0 ? '+' : ''}${usd(res.delta)}`;
  $('verdict').className = 'verdict ' + res.result;
  $('verdict').innerHTML = `${title}<small>${sub}</small>`;
  $('vTrader').textContent = v.trader; $('vLink').href = v.nansenUrl;
  $('vH').textContent = r.horizonHours + 'h';
  setStat('vRet', pct(v.ret, 2), v.ret >= 0);
  $('vExc').textContent = `best ${pct(v.mfe, 1)} · worst ${pct(v.mae, 1)}`;
  setStat('vWhale', (v.whalePnlUsd >= 0 ? '+' : '') + compact(v.whalePnlUsd), v.whalePnlUsd >= 0);
  setStat('vYou', (res.delta >= 0 ? '+' : '') + usd(res.delta), res.delta >= 0);
  drawChart(v.path, r.entryPrice, res.result !== 'loss');
}

function drawChart(path, entry, userGood) {
  const svg = $('chart'), W = 600, Hh = 220, pad = 14;
  const ys = path.map((p) => p[1]).concat(entry);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const x = (i) => pad + (i / (path.length - 1)) * (W - pad * 2);
  const y = (v) => Hh - pad - ((v - min) / span) * (Hh - pad * 2);
  const last = path[path.length - 1][1];
  const col = userGood ? '#34d399' : '#f87171';
  const d = path.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  svg.innerHTML = `
    <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".25"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${pad}" x2="${W - pad}" y1="${y(entry)}" y2="${y(entry)}" stroke="#8b98a8" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"/>
    <text x="${pad + 4}" y="${y(entry) - 6}" fill="#8b98a8" font-size="11" font-family="JetBrains Mono">whale entry ${price(entry)}</text>
    <path d="${d}L${x(path.length - 1)},${Hh}L${pad},${Hh}Z" fill="url(#g)" opacity="0"><animate attributeName="opacity" from="0" to="1" begin="1.1s" dur=".4s" fill="freeze"/></path>
    <path id="line" pathLength="1" d="${d}" fill="none" stroke="${col}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${x(path.length - 1)}" cy="${y(last)}" r="4" fill="${col}" opacity="0"><animate attributeName="opacity" from="0" to="1" begin="1.1s" dur=".2s" fill="freeze"/></circle>`;
  const line = svg.querySelector('#line');
  line.style.strokeDasharray = '1 1';
  line.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 1100, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
}

// ------------------------------------------------ share card
$('btnShare').onclick = () => {
  const c = $('shareCanvas'), g = c.getContext('2d'), p = player, L = lastResult;
  const grd = g.createLinearGradient(0, 0, 1200, 675); grd.addColorStop(0, '#07090d'); grd.addColorStop(1, '#101722');
  g.fillStyle = grd; g.fillRect(0, 0, 1200, 675);
  g.fillStyle = 'rgba(52,211,153,.10)'; g.beginPath(); g.arc(120, 80, 320, 0, 7); g.fill();
  g.fillStyle = 'rgba(248,113,113,.08)'; g.beginPath(); g.arc(1120, 620, 300, 0, 7); g.fill();
  g.font = '800 44px Inter'; g.fillStyle = '#34d399'; g.fillText('FOLLOW', 70, 110);
  g.fillStyle = '#8b98a8'; g.font = '500 30px Inter'; g.fillText('or', 262, 110);
  g.fillStyle = '#f87171'; g.font = '800 44px Inter'; g.fillText('FADE', 305, 110);
  g.fillStyle = '#8b98a8'; g.font = '600 24px Inter'; g.fillText(p.name, 70, 180);
  g.fillStyle = '#e6edf3'; g.font = '700 120px JetBrains Mono'; g.fillText(usd(p.bankroll), 66, 320);
  const ch = (p.bankroll - 10000) / 10000;
  g.fillStyle = ch >= 0 ? '#34d399' : '#f87171'; g.font = '700 40px JetBrains Mono'; g.fillText(`${pct(ch, 0)} from $10k`, 70, 380);
  g.fillStyle = '#c9d4df'; g.font = '500 30px Inter';
  g.fillText(`${p.wins}–${p.bets - p.wins} record · best streak ${p.bestStreak} · ${p.whalesSlain} whales slain`, 70, 460);
  if (L) {
    g.fillStyle = '#8b98a8'; g.font = '500 26px Inter';
    g.fillText(`Last call: ${L.choice === 'follow' ? 'followed' : 'faded'} a ${compact(L.round.valueUsd)} ${L.round.coin} ${L.round.side.toLowerCase()} → ${L.delta >= 0 ? '+' : ''}${usd(L.delta)}`, 70, 520);
  }
  g.fillStyle = '#8b98a8'; g.font = '500 22px Inter'; g.fillText('Real Hyperliquid trades from Nansen Smart Money · odds powered by Nansen API', 70, 620);
  c.toBlob((b) => { $('shareDownload').href = URL.createObjectURL(b); });
  const text = `I turned $10k into ${usd(p.bankroll)} betting for and against @nansen_ai Smart Money on Hyperliquid. ${p.whalesSlain} whales slain. Follow or fade?`;
  $('shareX').href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text);
  $('shareDlg').showModal();
};

// ------------------------------------------------ tabs
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + t.dataset.view));
  if (t.dataset.view === 'board') loadBoard();
  if (t.dataset.view === 'live') loadLive();
}));

async function loadBoard() {
  const rows = await api('/api/leaderboard');
  $('boardBody').innerHTML = rows.length ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="${r.bankroll >= 10000 ? 'pos' : 'neg'}">${usd(r.bankroll)}</td><td>${r.bets}</td><td>${Math.round(r.winRate * 100)}%</td><td>${r.bestStreak}</td><td>${r.whalesSlain}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">No bets yet. Be the first.</td></tr>';
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------ live
let liveTimer = null;
async function loadLive() {
  $('liveList').innerHTML = '<div class="card loading" style="min-height:160px"><div class="spinner"></div></div>';
  try {
    const items = await api('/api/live');
    $('liveList').innerHTML = items.length ? items.map(liveCard).join('') : '<p class="muted">No Smart Money opens in the last 2 hours. Check back soon.</p>';
    document.querySelectorAll('[data-live]').forEach((b) => b.addEventListener('click', () => liveBet(b)));
  } catch (e) { $('liveList').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  loadLiveBets();
  clearInterval(liveTimer); liveTimer = setInterval(loadLiveBets, 20000);
}
function liveCard(t) {
  return `<div class="card lcard">
    <div class="row"><div><span class="side ${t.side}">${t.side.toUpperCase()}</span> <span class="coin">${coinHtml(t.coin)}</span></div><div class="size">${compact(t.valueUsd)}</div></div>
    <div class="meta">${esc(t.trader || 'Smart Money wallet')} · ${ago(t.openedAt)} · entry ${price(t.entryPrice)} · now ${price(t.mid)} · whale <span class="${t.moveSinceEntry >= 0 ? 'pos' : 'neg'}">(${pct(t.moveSinceEntry, 2)})</span></div>
    <ul class="reasons">${t.reasons.map((x) => `<li class="${x.good ? 'good' : ''}">${x.text}</li>`).join('')}</ul>
    <div class="probbar"><div class="pf" style="width:${(t.pFollow * 100).toFixed(1)}%"></div></div>
    <div class="problabels"><span>follow wins <b>${Math.round(t.pFollow * 100)}%</b></span><span>fade <b>${Math.round((1 - t.pFollow) * 100)}%</b></span></div>
    <div class="ctrl">
      <input type="number" min="1" value="500" aria-label="Stake" data-stake="${t.key}">
      <select data-mins="${t.key}" aria-label="Settle after"><option value="15">15m</option><option value="60" selected>1h</option><option value="240">4h</option></select>
    </div>
    <div class="actions"><button class="bet follow" data-live="${t.key}" data-choice="follow"><span>FOLLOW</span><small>x${t.odds.follow.toFixed(2)}</small></button>
    <button class="bet fade" data-live="${t.key}" data-choice="fade"><span>FADE</span><small>x${t.odds.fade.toFixed(2)}</small></button></div>
    <div class="links"><a href="https://app.nansen.ai/profiler?address=${t.address}&chain=hyperliquid" target="_blank" rel="noopener">Wallet on Nansen ↗</a><a href="https://app.hyperliquid.xyz/trade/${encodeURIComponent(t.coin)}" target="_blank" rel="noopener">Trade ${esc(t.coin)} on Hyperliquid ↗</a></div>
  </div>`;
}
async function liveBet(btn) {
  const key = btn.dataset.live;
  const stake = document.querySelector(`[data-stake="${CSS.escape(key)}"]`).value;
  const minutes = document.querySelector(`[data-mins="${CSS.escape(key)}"]`).value;
  btn.disabled = true;
  try { await api('/api/live/bet', { player: player.id, key, choice: btn.dataset.choice, stake, minutes }); player = await api('/api/player?id=' + player.id); renderPlayer(); loadLiveBets(); }
  catch (e) { alertInline(btn, e.message); }
  btn.disabled = false;
}
function alertInline(el, msg) { const p = document.createElement('p'); p.className = 'err'; p.textContent = msg; el.closest('.lcard').append(p); setTimeout(() => p.remove(), 4000); }
async function loadLiveBets() {
  const bets = await api('/api/live/bets?player=' + player.id).catch(() => []);
  const prev = player.bankroll; player = await api('/api/player?id=' + player.id); renderPlayer(prev);
  $('liveBets').innerHTML = bets.length ? bets.map((b) => {
    const left = b.settleAt - Date.now();
    const status = b.status === 'open' ? `settles in ${Math.max(0, Math.ceil(left / 60e3))}m` : b.status.toUpperCase();
    const cls = b.status === 'won' ? 'pos' : b.status === 'lost' ? 'neg' : '';
    return `<div class="lb"><span>${b.choice.toUpperCase()} ${b.coin} ${b.whaleSide.toLowerCase()}</span><span>${usd(b.stake)} @ x${b.price.toFixed(2)}</span><span>entry ${price(b.entry)}</span><span>${b.exit ? 'exit ' + price(b.exit) : ''}</span><span class="${cls}">${status}${b.payout != null && b.status !== 'open' ? ' · ' + usd(b.payout - b.stake) : ''}</span></div>`;
  }).join('') : '<p class="muted">No live bets yet.</p>';
}
$('btnRefreshLive').onclick = loadLive;

boot();
