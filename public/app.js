import { sfx, isMuted, setMuted } from './sfx.js';
import { coinRain, burst, sparkleAt, countTo } from './fx.js';

const $ = (id) => document.getElementById(id);

// Auto-fit: scale the desktop layout so the whole Training Table (card, tells, chips, FOLLOW/FADE) and
// Your Table fit on screen without scrolling. 100% on big monitors, ~80% on 1080p, never below 70%.
const MIN_FIT = 0.62, MAX_FIT = 1.5, BOTTOM_GAP = 26, SIDE_GAP = 24;
// Three versions of this were wrong before this one, in different ways.
//   1. Divided by a hard-coded DESIGN_H of 886 when the page is ~1325px tall, so it returned 1.0 on a
//      1080p screen and scaled nothing: FOLLOW/FADE sat below the fold.
//   2. Measured the WHOLE document - which includes the legal footer and the full-height sidebar,
//      neither of which needs to be on screen - so it shrank the table until the text was too small.
//   3. Measured the right thing but iterated towards it, and a two-pass loop overshot.
//
// What has to be on screen is the felt: the card, the tells, the chips, the two buttons and the gold
// frame closing under them. The sidebar's lower half, the stat strip and the footer are scrolled to
// on purpose. So measure the felt ONCE at a known scale of 1, then solve for the scale directly -
// no iteration, no overshoot. The result is allowed above 1: on a big monitor the table should grow
// into the space rather than sit there at laptop size.
function autoFit() {
  const de = document.documentElement;
  const w = window.innerWidth, h = window.innerHeight;
  if (w < 1100) { de.style.setProperty('--fit', '1'); return; } // phone/tablet layout scrolls by design
  const felt = document.querySelector('.felt');
  const anchor = felt || document.getElementById('btnFade') || document.querySelector('.layout');
  if (!anchor) return;
  const prev = de.style.getPropertyValue('--fit');
  // Measure at 1. Setting and reading in the same task forces a reflow but never a paint, so this is
  // invisible - it is not the flash that a rAF-based reset would cause.
  de.style.setProperty('--fit', '1');
  const r = anchor.getBoundingClientRect();
  const needed = r.bottom + window.scrollY + BOTTOM_GAP;   // felt height incl. header, at scale 1
  const lay = document.querySelector('.layout');
  const natW = lay ? lay.getBoundingClientRect().width : 1500;
  if (!(needed > 0) || !(natW > 0)) { de.style.setProperty('--fit', prev || '1'); return; }
  const fit = Math.max(MIN_FIT, Math.min(MAX_FIT, (h - 8) / needed, (w - SIDE_GAP * 2) / natW));
  de.style.setProperty('--fit', fit.toFixed(3));
}

// One pass is enough now that the scale is solved rather than approached. The rAF catches fonts and
// images that land after the first call and change the felt's height.
const refit = () => { autoFit(); requestAnimationFrame(autoFit); };
refit();
window.addEventListener('resize', refit);
window.addEventListener('load', refit);
// Host admin: open the site once with ?admin=YOUR_TOKEN to manage alert rules on the public version
try {
  const u = new URL(location.href);
  if (u.searchParams.get('admin')) { localStorage.setItem('fof_admin', u.searchParams.get('admin')); u.searchParams.delete('admin'); history.replaceState(null, '', u.pathname + u.search); }
} catch {}
const adminToken = () => { try { return localStorage.getItem('fof_admin') || ''; } catch { return ''; } };
const api = async (path, body) => {
  const headers = { 'x-admin-token': adminToken() };
  if (body) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30e3);
  let res;
  try { res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal } : { headers, signal: ctl.signal }); }
  catch (e) { throw Object.assign(new Error(e.name === 'AbortError' ? 'The table is slow right now. Try again.' : 'Connection problem. Check your internet and try again.'), { status: 0 }); }
  finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || (res.status === 429 ? 'Easy, high roller. Too many requests, try again in a moment.' : 'The table is busy. Try again in a moment.')), { status: res.status });
  return data;
};
const usd = (n, d = 0) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const compact = (n) => (n < 0 ? '-' : '') + '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(n));
const pct = (x, d = 1) => (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const price = (p) => (Number.isFinite(+p) ? p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p >= 1 ? p.toFixed(3) : p.toPrecision(4) : 'n/a');
const ago = (iso) => { const m = (Date.now() - Date.parse(iso)) / 60e3; return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coinHtml = (c) => c.includes(':') ? `<small class="dex">${esc(c.split(':')[0])}</small>${esc(c.split(':')[1])}` : esc(c);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Only two live bet types remain: riding a whale to their exit, and the daily Insider Pick. The old
// 15-minute and 4-hour lanes are kept in this map only so bets placed before the change still name
// themselves correctly in a player's history.
const LANES = { 15: 'Espresso Shot', 30: 'Espresso Shot', 60: 'Cigar Lounge', 240: 'Cigar Lounge', 1440: 'Insider Pick', ride: 'Ride the Whale' };
let rideCapHours = 72; // replaced by the server's real RIDE_MAX_HOURS on the first status poll
// Two rails left. A timed bet placed before the lanes were removed still groups under Ride the Whale
// rather than vanishing; its own row keeps naming itself correctly.
const laneOf = (b) => (b.pick ? 'pick' : 'ride');
const hrs = (ms) => { const h = ms / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`; };

let player = null, round = null, lastResult = null;

let shownBank = 10000;

// ================================================= boot
/** Never leave the player staring at a blank table: say what happened and give them a way back. */
function deadEnd(msg) {
  const el = $('banner');
  if (!el) return toast(msg);
  el.hidden = false;
  el.innerHTML = '';
  el.append(Object.assign(document.createElement('span'), { textContent: msg + ' ' }));
  const b = Object.assign(document.createElement('button'), { className: 'gold-btn sm', textContent: 'Reconnect' });
  b.onclick = () => location.reload();
  el.append(b);
}

const qp = (k) => { try { return new URL(location.href).searchParams.get(k); } catch { return null; } };
let challengeId = (() => { const v = qp('challenge'); return v && /^[0-9a-f-]{4,36}$/i.test(v) ? v : null; })();

// Set when the page was opened with ?view=plans, honoured only once the server confirms Plans is on.
let wantPlansOnLoad = false;
let replyId = null;
const resultToken = (() => { const v = qp('result'); return v && /^[0-9a-f-]{4,36}$/i.test(v) ? v : null; })();

/** Send the finished hand back to whoever set the challenge. */
async function shareResult(byName) {
  if (!replyId) return;
  const link = `${siteUrl()}/?result=${encodeURIComponent(replyId)}`;
  const text = `I took your Follow or Fade challenge, ${byName}. Here's how it went:\n${link}`;
  if (navigator.share) {
    try { await navigator.share({ text, url: link }); return; }
    catch (e) { if (e?.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(link); toast('Result link copied — paste it to them'); }
  catch { prompt('Copy this and send it back:', link); }
}

/** The challenger opens the reply link and finds out how their friend called it. */
async function handleResultLink() {
  if (!resultToken) return;
  const r = (await api('/api/result?id=' + encodeURIComponent(resultToken)).catch(() => null))?.result;
  history.replaceState(null, '', location.pathname);
  const d = $('rsDlg');
  if (!r) {
    $('rsTitle').textContent = 'That link has expired';
    $('rsBody').textContent = 'Challenge results are kept for about a week. Deal yourself a fresh hand instead.';
    $('rsSub').textContent = '';
  } else {
    const coin = String(r.coin).split(':').pop();
    const mine = r.byChoice === 'fade' ? 'faded' : 'followed';
    const theirs = r.responderChoice === 'fade' ? 'faded' : 'followed';
    $('rsTitle').textContent = `${r.responder} took your challenge`;
    $('rsBody').innerHTML = r.same
      ? `You both <b>${esc(mine)}</b> the ${esc(r.side.toLowerCase())} on <b>${esc(coin)}</b>.`
      : `You <b>${esc(mine)}</b>, ${esc(r.responder)} <b>${esc(theirs)}</b> the ${esc(r.side.toLowerCase())} on <b>${esc(coin)}</b>.`;
    const verdict = r.senderWon === null ? 'Too close to call — the whale went nowhere.'
      : r.same ? (r.senderWon ? 'You were both right.' : 'You were both wrong.')
      : (r.senderWon ? `You read it better.` : `${r.responder} read it better.`);
    $('rsSub').textContent = `${verdict}${r.whaleRet != null ? ` The whale's real exit came out ${(r.whaleRet * 100).toFixed(2)}%.` : ''}`;
  }
  try { d.showModal(); } catch {}
  $('rsPlay').onclick = () => { d.close(); document.querySelector('.tab[data-view="replay"]').click(); };
  if (d.open) await new Promise((res) => d.addEventListener('close', res, { once: true }));
}

const whaleLine = (h) => {
  const size = h.valueUsd ? `<b>${compact(h.valueUsd)}</b> ` : '';
  return `${size}<b>${h.side === 'Short' ? 'SHORT' : 'LONG'}</b> on <b>${esc(String(h.coin).split(':').pop())}</b>`;
};
// A training hand is a real trade from THIS WEEK, already played out — say when it was opened rather
// than implying it is live right now. That belongs to the Live Floor, which is a different question.
const whenLine = (h) => (h.openedAt ? ` <span class="wl-when">${esc(ago(h.openedAt))}</span>` : '');
/** Fill the front door with the hand actually waiting: a friend's challenge, or the next hand in the deck. */
async function showPreviewHand() {
  const el = $('wlHeadline');
  if (!el) return;
  if (challengeId) {
    const c = (await api('/api/challenge?id=' + encodeURIComponent(challengeId)).catch(() => null))?.challenge;
    if (c) {
      $('wlHand').classList.add('challenged');
      el.innerHTML = `<span class="wl-by">${esc(c.by)} ${c.choice === 'fade' ? 'FADED' : 'FOLLOWED'} this whale.</span> ${whaleLine(c)}, opened${whenLine(c)}.`;
      const ask = document.querySelector('.wl-ask');
      if (ask) ask.innerHTML = 'Would you <b class="wl-f">FOLLOW</b> or <b class="wl-d">FADE</b>?';
      return;
    }
    challengeId = null; // stale or expired link: fall through to a normal hand
  }
  const h = (await api('/api/preview').catch(() => null))?.hand;
  if (!h || !h.coin) return; // keep the neutral line rather than make one up
  el.innerHTML = `A Smart Money whale opened a ${whaleLine(h)}${whenLine(h)}.`;
}

/**
 * The arrival flourish: once in a visitor's life, at the Training Table.
 * It cannot play on load, because browsers keep audio locked until the visitor interacts, so it waits
 * for their first click or key press. It is deliberately NOT tied to the intro overlay: a returning
 * visitor never sees that again, so hanging the sound off it meant almost nobody would ever hear it.
 * Add ?welcome=1 to the URL to hear it again (useful when recording).
 */
function armWelcome() {
  if (store.get('fof_welcomed') === '1' && !qp('welcome')) return;
  const arm = () => ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, fire, { once: true, capture: true }));
  function fire() {
    // Fallback only. The real trigger is the intro's closing button ("Deal me in"), because that is
    // the moment the visitor expects the room to open up. Defer while the nickname dialog or an intro
    // is on screen — otherwise the very first tap spends the flourish before anyone has arrived.
    if (store.get('fof_welcomed') === '1' && !qp('welcome')) return;
    if (isMuted()) { arm(); return; }                     // muted: keep it owed, try again later
    if (introOpen || $('welcome')?.open) { arm(); return; } // their buttons do the honours
    // Play straight from the gesture: sfx.welcome() awaits the audio unlock itself, and any timeout
    // here loses the gesture on a phone, which is why nobody on mobile heard it.
    store.set('fof_welcomed', '1');
    sfx.welcome();
  }
  arm();
}

async function boot() {
  syncMute();
  armWelcome();
  if (resultToken) await handleResultLink(); // settle this before the welcome dialog covers it
  const id = store.get('fof_player');
  // Esc must not leave the app without a player (browsers may close the dialog anyway, so reopen it)
  $('welcome').addEventListener('cancel', (e) => e.preventDefault());
  $('welcome').addEventListener('close', () => { if (!player && !$('welcome').dataset.submitted) setTimeout(() => { try { $('welcome').showModal(); } catch {} }, 0); });
  $('welcomeForm').addEventListener('submit', () => { $('welcome').dataset.submitted = '1'; }, { once: true });
  let lastStatus = null;
  for (let tries = 0; id && !player && tries < 4; tries++) {
    try { player = await api('/api/player?id=' + id); }
    catch (e) { lastStatus = e.status; if (e.status === 404) break; await sleep(1500 * (tries + 1)); } // network blip or 429: keep the saved player, retry
  }
  if (!player && id && lastStatus !== 404) { deadEnd("Couldn't reach the table."); return; }
  while (!player) {
    $('welcome').dataset.submitted = '';
    try { $('welcome').showModal(); } catch {}
    showPreviewHand(); // fetched alongside the dialog, so the door never waits on it
    await new Promise((r) => $('welcomeForm').addEventListener('submit', r, { once: true }));
    // a failed sign-up must reopen the dialog, not leave a blank page behind it
    try {
      player = await api('/api/player', { name: $('nameInput').value });
      store.set('fof_player', player.id);
      sfx.chip(); coinRain(40);
    } catch (e) { toast(e.message || 'Could not take a seat, try again.'); }
  }
  shownBank = player.bankroll;
  renderPlayer();
  refreshStatus(); setInterval(refreshStatus, 15000);
  pollLoop();
  // links like /?view=live (from Telegram alerts) open straight on that tab
  const startView = qp('view');
  const startTrade = qp('trade');
  if (challengeId) history.replaceState(null, '', location.pathname);
  if (startTrade) { pickCollapsedByLink = true; setTimeout(() => goToTrade(startTrade), 60); }
  if (!startTrade && startView === 'plans') {
    // Defer: paintPlans() opens it once the server confirms Plans is switched on, and silently
    // ignores it when it isn't, so the tab never flashes up and bounce back.
    history.replaceState(null, '', location.pathname);
    wantPlansOnLoad = true;
  } else if (!startTrade && ['live', 'report', 'board'].includes(startView)) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => document.querySelector(`.tab[data-view="${startView}"]`).click(), 50);
  }
  deal(); // training starts at the table
  if (!startTrade && (!startView || startView === 'replay')) setTimeout(() => showIntro('replay'), 900);
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
  $('demoBadge').hidden = !(s.usage.demo || s.usage.capped);
  $('demoBadge').textContent = s.usage.capped ? 'DEMO DATA · daily cap reached' : 'DEMO DATA';
  $('demoBadge').title = s.usage.capped ? "Today's Nansen credit budget for the public site is used up. Cached whale data and demo whales until midnight UTC." : 'No Nansen API key: sample whales on real Hyperliquid prices';
  $('uCalls').textContent = s.usage.calls.toLocaleString();
  $('uCredits').textContent = s.usage.credits.toLocaleString();
  $('uModel').textContent = s.model.n ? s.model.n.toLocaleString() : '—';
  if (s.rideMaxHours) {
    rideCapHours = s.rideMaxHours;
    const sub = $('rideLaneSub');
    if (sub) sub.textContent = `ends when the whale exits · up to ${rideCapHours}h · cash out any time`;
  }
  if (refreshStatus.plansOn !== !!s.plans) { refreshStatus.plansOn = !!s.plans; paintPlans(!!s.plans); }
  if (s.smWinRate != null) {
    $('smWin').textContent = Math.round(s.smWinRate * 100) + '%';
    $('smWinTxt').textContent = `of ${s.sampleSize} Smart Money opens were in profit when the whale exited${s.medianHoldHours ? ` · median hold ${hrs(s.medianHoldHours * 3600e3)}` : ''}`;
  }
}

// ---- live bets rail (polled every 5s, visible on every tab)
const prevStatus = new Map();
const toldHeld = new Set(); // bets whose 'what holding would have paid' verdict has been shown
const cashingOut = new Set(); // bet ids with a cash-out request in flight (survives lane re-renders)
let pollSeq = 0, pollApplied = 0;
async function pollBets() {
  if (!player) return;
  const seq = ++pollSeq;
  const bets = await api('/api/live/bets?player=' + player.id).catch(() => null);
  if (!bets || seq < pollApplied) return; // an older response arriving late must not undo a newer one
  pollApplied = seq;
  for (const b of bets) if (b.status === 'cashing') b.status = 'open';
  let settledNow = []; const heldNow = [];
  for (const b of bets) {
    const before = prevStatus.get(b.id);
    if (before === 'open' && b.status !== 'open' && b.status !== 'cashed') settledNow.push(b);
    // A cashed ride keeps being followed until the whale is actually out. When that lands, tell the
    // player what their exit was worth against the whale's — that is the skill the floor now teaches.
    if (b.status === 'cashed' && b.heldOutcome && !toldHeld.has(b.id)) { toldHeld.add(b.id); heldNow.push(b); }
    if (before !== 'cashed') prevStatus.set(b.id, b.status);
  }
  if (prevStatus.size > 400) { // the server only ever returns the last 30 bets: everything older is dead weight
    const live = new Set(bets.map((b) => b.id));
    for (const k of prevStatus.keys()) if (!live.has(k)) prevStatus.delete(k);
  }
  const fresh = lastBets.filter((x) => x.status === 'open' && Date.now() - x.placedAt < 10e3 && !bets.some((y) => y.id === x.id));
  lastBets = [...fresh, ...bets];
  renderLanes();
  if (settledNow.length) await announceSettled(settledNow);
  for (const b of heldNow) announceHeld(b);
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
  for (const min of ['pick', 'ride']) {
    const lane = document.querySelector(`.lane[data-min="${min}"]`);
    if (!lane) continue;
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
  row.querySelector('.lbl').textContent = b.ride ? 'RIDE' : left >= 48 * 3600e3 ? `${Math.round(left / 864e5)}d` : left >= 3600e3 ? `${hh}h${String(rm).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
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
    : `${usd(b.stake)} @ x${b.price.toFixed(2)} · ${price(b.entry)}${b.now ? ' → ' + price(b.now) : ''}${b.myRet != null ? ' (you ' + pct(b.myRet, 2) + ')' : ''}${b.whaleTradeRet != null && !b.pick ? ` · whale ${pct(b.whaleTradeRet, 2)} from their entry` : ''}${b.ride ? ` · ends when the whale exits${b.whaleTrims ? ` · whale trimmed ${b.whaleTrims}x` : ''} · max ${hh}h${String(rm).padStart(2, '0')} left` : ''}`;
  const potential = Math.round(b.stake * (b.price - 1));
  row.querySelector('.res').innerHTML = mood === 'meh' ? `<span>${usd(b.stake)}</span> <small>flat</small>`
    : mood === 'rich' ? `<span class="pos">+${usd(potential)}</span> <small>if it ends now</small>` : `<span class="neg">-${usd(b.stake)}</span> <small>if it ends now</small>`;
  const btn = row.querySelector('.cashout');
  const ok = !b.pending && b.cashOut != null && left > 6000;
  btn.disabled = !ok || btn.dataset.busy === '1' || cashingOut.has(b.id);
  btn.querySelector('b').textContent = ok ? usd(b.cashOut) : '—';
  btn.classList.toggle('up', ok && b.cashOut >= b.stake);
}

// Cash out (event delegation so the 1s refresh never swallows the click)
$('lanes').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cashout]');
  if (!btn || btn.disabled || cashingOut.has(btn.dataset.cashout)) return;
  const betId = btn.dataset.cashout;
  cashingOut.add(betId); btn.dataset.busy = '1'; btn.disabled = true;
  const rect = btn.getBoundingClientRect();
  try {
    const r = await api('/api/live/cashout', { player: player.id, betId: btn.dataset.cashout });
    prevStatus.set(r.bet.id, 'cashed');
    const row = btn.closest('.lbet'); row?.classList.add('leaving');
    setTimeout(() => { const idx = lastBets.findIndex((x) => x.id === r.bet.id); if (idx >= 0) lastBets[idx] = r.bet; renderLanes(); }, 550);
    player = r.player; renderPlayer(); refreshReport();
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
  finally { cashingOut.delete(betId); }
});

function banner(title, sub, kind) {
  const el = $('banner');
  el.className = 'banner ' + kind;
  el.innerHTML = `<div class="rays"></div><div class="banner-card"><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`;
  el.hidden = false;
  clearTimeout(el._h); el._h = setTimeout(() => (el.hidden = true), 3200);
}
$('banner')?.addEventListener('click', () => ($('banner').hidden = true));

/**
 * The exit-timing lesson. You cashed out early; the whale has now closed. Was getting out the right
 * call? This is the only place the game can answer that, and it is the reason cash-out exists.
 */
function announceHeld(b) {
  const h = b.heldOutcome;
  if (!h) return;
  const took = (b.payout ?? 0) - b.stake;
  const held = h.delta;
  const coin = String(b.coin).split(':').pop();
  const when = h.whaleClosed
    ? `The whale closed ${esc(coin)}${h.heldMs ? ` after ${hrs(h.heldMs)}` : ''}.`
    : `${esc(coin)} reached the ${rideCapHours}h cap with the whale still holding.`;
  const same = Math.abs(held - took) < 1;
  const line = same
    ? `Your exit and the whale's came out the same: ${took >= 0 ? '+' : ''}${usd(took)}.`
    : held > took
      ? `You took ${took >= 0 ? '+' : ''}${usd(took)}. Holding to their exit would have paid <b>${held >= 0 ? '+' : ''}${usd(held)}</b> — you left ${usd(held - took)} on the table.`
      : `You took ${took >= 0 ? '+' : ''}${usd(took)}. Holding to their exit would have paid <b>${held >= 0 ? '+' : ''}${usd(held)}</b> — <b>getting out early saved you ${usd(took - held)}</b>.`;
  toast(`${when} ${line.replace(/<\/?b>/g, '')}`);
  const box = $('heldLesson');
  if (box) {
    box.className = 'held-lesson ' + (same ? '' : held > took ? 'neg' : 'pos');
    box.innerHTML = `<b>Exit timing</b> · ${when} ${line}`;
    box.hidden = false;
    clearTimeout(box._h); box._h = setTimeout(() => (box.hidden = true), 15000);
  }
}

async function announceSettled(settledNow) {
  refreshReport();
  {
    const prev = player.bankroll;
    player = await api('/api/player?id=' + player.id);
    renderPlayer();
    for (const b of settledNow) {
      const net = (b.payout ?? 0) - b.stake;
      const dirMul = b.whaleSide === 'Long' ? 1 : -1;
      const mine = b.exit && b.entry ? (b.choice === 'follow' ? 1 : -1) * dirMul * (b.exit - b.entry) / b.entry : null;
      const both = mine != null && b.whaleTradeRet != null && !b.pick ? ` · you ${pct(mine, 2)} from your entry, whale ${pct(b.whaleTradeRet, 2)} from theirs` : '';
      const how = b.ride ? (b.whaleClosed ? `The whale exited ${b.coin} after ${hrs(b.whaleHeldMs)}` : `${Math.round((b.settleAt - b.placedAt) / 3600e3)}h cap reached on ${b.coin} — the whale was still holding`) : b.pick ? `Insider Pick (${b.pickDays || Math.round((b.settleAt - b.placedAt) / 864e5)}d) on ${b.coin}` : `${LANES[b.minutes] || 'Live bet'} on ${b.coin}`;
      if (b.status === 'won') { sfx.ding(); setTimeout(() => sfx.win(net > 2000), 200); coinRain(net > 2000 ? 90 : 45); toast(`${how}: you won +${usd(net)}${both}`); }
      else if (b.status === 'lost') { sfx.lose(); toast(`${how}: you lost ${usd(net)}${both}`); }
      else { sfx.push(); toast(b.band >= 0.001 || b.ride || b.pick ? `Too close to call on ${b.coin} (under ±${((b.band || 0.002) * 100).toFixed(1)}%): stake returned` : `Push on ${b.coin}: stake returned`); }
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
  const ch = challengeId; challengeId = null; // a challenge is played once, then it's a normal table
  try { round = await api('/api/round?player=' + player.id + (ch ? '&challenge=' + encodeURIComponent(ch) : '')); }
  catch (e) { $('dealing').hidden = true; return showErr(e.message + ' — '); }
  const r = round;
  const card = $('playcard');
  card.className = 'playcard ' + r.side;
  $('cSideShort').textContent = $('cSideShort2').textContent = r.side === 'Long' ? 'L' : 'S';
  $('rSide').textContent = r.side.toUpperCase(); $('rSide').className = 'side ' + r.side;
  $('rCoin').innerHTML = coinHtml(r.coin); $('rValue').textContent = compact(r.valueUsd); $('rEntry').textContent = price(r.entryPrice);
  $('rWhen').textContent = r.openedDay ? new Date(r.openedDay + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' · this week' : '';
  $('rType').textContent = r.orderType || 'Market'; $('rHorizon').textContent = `the whale's real exit (max ${r.maxHoldHours}h)`; $('rHorizon').title = r.minHoldMinutes ? `Only real positions: whales who closed in under ${r.minHoldMinutes >= 60 ? r.minHoldMinutes / 60 + 'h' : r.minHoldMinutes + ' min'} (scalps) are left out` : '';
  const gr = r.grade || { grade: '?' };
  // The tags used to be lower-case words crammed into the grade pill ("Grade A · early finder"),
  // which is neither the wording nor the styling the ? dialog and the live floor use. Render the
  // grade alone in the pill and hand the tags to whaleTags(), so all three surfaces agree.
  $('rGrade').textContent = gr.grade === '?' ? 'Ungraded' : gr.grade;
  $('rGrade').className = 'grade-chip ' + ({ 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[gr.grade] || 'gc');
  $('rTags').innerHTML = whaleTags(gr);
  const i = r.intel;
  setStat('iWin', i.walletWinRate != null ? Math.round(i.walletWinRate * 100) + '%' : 'n/a', i.walletWinRate != null ? i.walletWinRate >= 0.5 : null);
  $('iClosed').textContent = i.walletClosedTrades ? `${i.walletClosedTrades} closed trades` : 'no history';
  setStat('iPnl', i.walletPnl30d != null ? compact(i.walletPnl30d) : 'n/a', i.walletPnl30d != null ? i.walletPnl30d >= 0 : null);
  paintFlow('iSm', i.smFlow24h, r.side);
  paintFlow('iCrowd', i.crowdFlow24h, r.side);
  $('flowRead').innerHTML = flowRead(i.smFlow24h, i.crowdFlow24h, r.side);
  $('flowRead').hidden = !$('flowRead').innerHTML;
  $('reasons').innerHTML = r.reasons.map((x) => `<li class="${x.good ? 'good' : ''}">${esc(x.text)}</li>`).join('');
  $('pFollowBar').style.width = '50%'; $('needle').style.left = '50%';
  $('pFollow').textContent = Math.round(r.pFollow * 100) + '%'; $('pFade').textContent = Math.round((1 - r.pFollow) * 100) + '%';
  $('oFollow').textContent = r.odds.follow.toFixed(2); $('oFade').textContent = r.odds.fade.toFixed(2);
  $('stakeInput').value = Math.max(1, Math.floor(Math.min(Number($('stakeInput').value) || 1000, player.bankroll)));
  updatePotential();
  $('btnFollow').disabled = $('btnFade').disabled = false;
  $('dealing').hidden = true; $('round').hidden = false;
  // The felt is empty until the hand is on it, so a fit measured before this point sizes the
  // layout against nothing. Re-solve now that the card, the tells and the buttons are real.
  refit();
  card.classList.remove('dealt'); void card.offsetWidth; card.classList.add('dealt');
  sfx.deal();
  // On a phone the page keeps the scroll position of the hand you just finished, which lands you on the
  // FOLLOW/FADE buttons with the whale card off-screen above — you are asked to call a trade you cannot
  // see. Bring the card itself into view. 'start' rather than 'center': the card is tall on a narrow
  // screen and centring it pushes its top out of the viewport.
  scrollCardIntoView();
  setTimeout(() => { $('pFollowBar').style.width = (r.pFollow * 100).toFixed(1) + '%'; $('needle').style.left = `calc(${(r.pFollow * 100).toFixed(1)}% - 1px)`; }, 350);
}
/** Put the dealt whale card at the top of the viewport, under the sticky header. */
function scrollCardIntoView() {
  if (!sheetMode()) return;                       // desktop shows the whole hand at once
  const card = $('playcard');
  if (!card) return;
  requestAnimationFrame(() => {
    const head = document.querySelector('header.top');
    const pad = (head?.getBoundingClientRect().height || 0) + 12;
    const y = card.getBoundingClientRect().top + window.scrollY - pad;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  });
}

/**
 * Net dollars bought minus sold over 24h. The colour is the SIGN — green is net buying, red is net
 * selling — and never a verdict on the trade, because the same flow is bullish for a long and bearish
 * for a short. Whether it helps this particular whale is spelled out underneath instead of encoded in
 * a colour nobody can decode.
 */
function paintFlow(id, v, side) {
  const sub = $(id + 'Sub');
  if (v == null) { setStat(id, 'n/a', null); if (sub) sub.textContent = ''; return; }
  const buying = v >= 0;
  setStat(id, (buying ? '+' : '\u2212') + compact(Math.abs(v)), buying);
  if (!sub) return;
  const withWhale = buying === (side === 'Long');
  sub.textContent = `${buying ? 'net buying' : 'net selling'} \u00b7 ${withWhale ? 'with' : 'against'} this ${side.toLowerCase()}`;
  sub.className = 'sub ' + (withWhale ? 'pos' : 'neg');
}

/** The part people actually want: what the two numbers mean together. */
function flowRead(sm, crowd, side) {
  if (sm == null || crowd == null) return '';
  const smBuy = sm >= 0, cBuy = crowd >= 0;
  const smSide = smBuy ? 'buying' : 'selling';
  const cSide = cBuy ? 'buying' : 'selling';
  const whaleWith = smBuy === (side === 'Long');
  if (smBuy !== cBuy) {
    return `<b>They disagree.</b> Smart Money is ${smSide} while everyone else is ${cSide}. `
      + `That split is the setup this game is built on \u2014 and here Smart Money is ${whaleWith ? 'on the same side as' : 'on the opposite side to'} this ${side.toLowerCase()}.`;
  }
  return `<b>They agree.</b> Smart Money and everyone else are both ${smSide}. `
    + `Crowded trades leave less room: the move may already be priced in. Both are ${whaleWith ? 'with' : 'against'} this ${side.toLowerCase()}.`;
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
  if (!(stake >= 1) || stake > player.bankroll) return toast('Stake must be between $1 and your bankroll');
  $('btnFollow').disabled = $('btnFade').disabled = true;
  sfx.bet(); sparkleAt(btn, 18);
  let res;
  try { res = await api('/api/bet', { player: player.id, roundId: round.roundId, choice, stake }); }
  catch (e) { $('btnFollow').disabled = $('btnFade').disabled = false; return showErr(e.message + ' — '); }
  // suspense: spin the wheel before the reveal
  $('round').hidden = true; $('suspense').hidden = false; sfx.roll(1.2);
  setTimeout(() => scrollToResult('suspense'), 40);
  await sleep(1300);
  player = res.player; lastResult = { ...res, round, choice };
  showReveal(res, choice); renderPlayer(); refreshStatus();
}
$('btnFollow').onclick = (e) => bet('follow', e.currentTarget);
$('btnFade').onclick = (e) => bet('fade', e.currentTarget);
$('btnNext').onclick = () => { sfx.chip(); deal(); };

// Plain-English explanations for the four numbers above the tells. A tester asked what "Smart Money
// flow" meant, which means everyone was wondering and only one person said so.
const HELP = {
  // The whole site is built on the phrase "Smart Money", and someone new to crypto has no reason
  // to know it is a specific Nansen label rather than a figure of speech. Plain words, and honest
  // about what the label does not promise.
  smartmoney: ['What is Smart Money?', 'It is <b>Nansen\u2019s label for wallets worth watching</b> \u2014 traders whose record stands out once you follow the money on-chain. Nansen watches every wallet trading on Hyperliquid, adds up what each one has actually made and lost, and tags the ones that keep coming out ahead.<br><br>So when a card here says a <b>Smart Money whale</b> opened a trade, it means one of those wallets just put real money on the line, and you are being asked whether they are right this time.<br><br><b>It is not a tip and not a guarantee.</b> Good traders are wrong often \u2014 that is exactly what makes the call worth making.'],
  win: ['Whale win rate', 'Of everything this whale closed in the 30 days <b>before</b> this trade, the share that made money. It stops at this trade, so it can never include the hand you are being asked to judge.'],
  pnl: ['Whale realized PnL', 'Actual dollars this whale locked in over those same 30 days \u2014 profit they took, not paper gains on open positions. A high win rate with a negative PnL means lots of small wins and a few big losses.'],
  sm: ['Smart Money \u00b7 net 24h', 'Every wallet Nansen labels Smart Money, not just this whale: dollars they <b>bought minus</b> dollars they <b>sold</b> on this coin in the last 24 hours. <b>Green means net buying, red means net selling.</b> It is background on the coin, not a read on this whale.'],
  crowd: ['Everyone else \u00b7 net 24h', 'The same sum for every other trader on this coin. <b>Green means the crowd was net buying, red net selling.</b> The interesting case is when this points the opposite way to Smart Money \u2014 that is the disagreement the line underneath describes.'],
};
let helpPop = null;
const closeHelp = () => { helpPop?.remove(); helpPop = null; document.querySelectorAll('.qmark[aria-expanded=true]').forEach((b) => b.setAttribute('aria-expanded', 'false')); };
document.addEventListener('click', (e) => {
  const q = e.target.closest('.qmark');
  if (!q) { if (!e.target.closest('.help-pop')) closeHelp(); return; }
  e.preventDefault();
  const wasOpen = q.getAttribute('aria-expanded') === 'true';
  closeHelp();
  if (wasOpen) return;
  const [title, body] = HELP[q.dataset.help] || [];
  if (!title) return;
  q.setAttribute('aria-expanded', 'true');
  helpPop = document.createElement('div');
  helpPop.className = 'help-pop';
  helpPop.innerHTML = `<b>${esc(title)}</b><br>${body}`;
  document.body.append(helpPop);
  const r = q.getBoundingClientRect(), pw = helpPop.offsetWidth;
  helpPop.style.left = Math.max(12, Math.min(window.innerWidth - pw - 12, r.left + window.scrollX - pw / 2 + 7)) + 'px';
  helpPop.style.top = (r.bottom + window.scrollY + 8) + 'px';
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

// A grade badge is the most-asked-about thing on a card, and it appears in several places, so the
// explainer is wired once by delegation rather than per render.
/** showModal(), but always showing the start of the dialog.
 *  showModal focuses the first focusable child; in these panels that is the button at the bottom,
 *  so the browser scrolls straight past the content. Focus the dialog itself and reset the scroll. */
function openDialog(d) {
  if (!d) return;
  try { d.showModal(); } catch { return; }
  d.scrollTop = 0;
  try { d.focus({ preventScroll: true }); } catch { try { d.focus(); } catch {} }
  // Some engines apply the autofocus scroll a frame later; undo it on the next frame too.
  requestAnimationFrame(() => { d.scrollTop = 0; });
}

document.addEventListener('click', (e) => {
  const g = e.target.closest('#rGrade, .grade');
  if (!g) return;
  // inside the whale-record summary the badge shares a row with the expand toggle: don't do both
  e.preventDefault(); e.stopPropagation();
  sfx.tick();
  openDialog($('grDlg'));
});

/** After a bet on a phone, bring the result into view (the felt is taller than the screen). */
function scrollToResult(id) {
  if (!sheetMode()) return;
  const el = $(id);
  if (!el || el.hidden) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 72;
  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}

function showReveal(res, choice) {
  const v = res.reveal, r = round;
  $('suspense').hidden = true; $('reveal').hidden = false;
  setTimeout(() => scrollToResult('reveal'), 60);
  const big = res.result === 'win' && (res.whaleSlain || res.price >= 2.2 || res.delta >= 5000);
  const title = res.busted ? 'Rekt. The house reloads you.' : res.result === 'win' ? (res.whaleSlain ? 'Whale slain!' : big ? 'Jackpot call!' : 'You called it.') : res.result === 'loss' ? 'The house wins this one.' : 'Too close to call. Your chips are back.';
  const sub = res.result === 'push' ? `The whale moved only ${pct(v.ret, 2)}, inside the ±${((res.pushBand || 0.002) * 100).toFixed(1)}% no-call band · the whale ${v.closed ? `closed after ${hrs(v.heldMs)}` : `was still holding after ${v.maxHoldHours}h`}` : `You ${choice === 'follow' ? 'followed' : 'faded'} a ${r.side.toLowerCase()} on ${r.coin} at x${res.price.toFixed(2)} → ${res.delta >= 0 ? '+' : ''}${usd(res.delta)} · the whale ${v.closed ? `closed after ${hrs(v.heldMs)}` : `was still holding after ${v.maxHoldHours}h`}`;
  const vd = $('verdict'); vd.className = 'verdict ' + res.result; vd.innerHTML = `${esc(title)}<small>${esc(sub)}</small>`;
  void vd.offsetWidth; vd.classList.add('pop');
  $('vTrader').textContent = v.trader; $('vLink').href = v.nansenUrl; $('vH').textContent = v.closed ? `· closed after ${hrs(v.heldMs)}` : `· still holding at ${v.maxHoldHours}h`;
  setStat('vRet', pct(v.ret, 2), v.ret >= 0);
  $('vExc').textContent = `${v.trims > 1 ? `scaled out in ${v.trims} fills · ` : ''}best ${pct(v.mfe, 1)} · worst ${pct(v.mae, 1)}`;
  setStat('vWhale', (v.whalePnlUsd >= 0 ? '+' : '') + compact(v.whalePnlUsd), v.whalePnlUsd >= 0);
  setStat('vYou', (res.delta >= 0 ? '+' : '') + usd(res.delta), res.delta >= 0);
  drawChart(v.path, r.entryPrice, res.result !== 'loss', v.closed ? `whale exit · ${hrs(v.heldMs)}` : `still holding · ${v.maxHoldHours}h mark`);
  renderLesson(res.lesson);
  // If a friend sent this hand, say how the two of you called it.
  replyId = res.resultId || null;
  const cb = res.challengedBy;
  const vs = $('vsLine');
  if (vs) {
    if (cb) {
      const same = cb.choice === choice;
      const theyWon = res.result === 'push' ? null : (cb.choice === choice) === (res.result === 'win');
      vs.className = 'vs-line ' + (theyWon === null ? '' : same ? (theyWon ? 'both' : 'both neg') : (theyWon ? 'neg' : 'pos'));
      vs.innerHTML = same
        ? `You and <b>${esc(cb.by)}</b> both ${choice === 'fade' ? 'faded' : 'followed'} this whale${theyWon === null ? '.' : theyWon ? ' — and you were both right.' : ' — and you were both wrong.'}`
        : `<b>${esc(cb.by)}</b> ${cb.choice === 'fade' ? 'faded' : 'followed'}, you ${choice === 'fade' ? 'faded' : 'followed'}${theyWon === null ? '.' : theyWon ? ` — ${esc(cb.by)} read it better.` : ' — you read it better.'}`;
      // Send it straight back instead of making them screenshot the screen.
      if (replyId) {
        const b = document.createElement('button');
        b.className = 'ghost-btn sm vs-reply';
        b.textContent = `Send the result to ${cb.by}`;
        b.onclick = () => shareResult(cb.by);
        vs.append(document.createElement('br'), b);
      }
      vs.hidden = false;
    } else vs.hidden = true;
  }
  const rt = $('btnRealTrade');
  rt.href = `https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(r.coin)}&chain=hyperliquid`;
  rt.textContent = `Look ${r.coin} up on Nansen ↗`;
  rt.hidden = false;
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
  if (!Array.isArray(path) || path.length < 2) { svg.innerHTML = ''; return; } // a missing path must never break the reveal
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
// Where this copy of the game lives, so every shared card points back here.
const siteUrl = () => {
  const og = document.querySelector('meta[property="og:url"]')?.content || '';
  const u = /^https?:\/\//i.test(og) && !og.startsWith('/') ? og : location.origin + '/';
  return u.replace(/\/$/, '');
};
const siteLabel = () => siteUrl().replace(/^https?:\/\//i, '').replace(/^www\./i, '');

$('btnShare').onclick = async () => {
  try { await document.fonts.ready; } catch {} // self-hosted fonts: don't draw the card in Georgia
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
  g.fillStyle = '#f5d77a'; g.font = '700 26px Cinzel, Georgia, serif'; g.fillText(siteLabel(), 600, 578);
  g.fillStyle = 'rgba(245,215,122,.7)'; g.font = '600 18px Cinzel, Georgia, serif'; g.fillText('REAL HYPERLIQUID TRADES · NANSEN SMART MONEY · ODDS BY NANSEN API', 600, 612);
  c.toBlob((b) => {
    const a = $('shareDownload');
    if (a.dataset.blob) URL.revokeObjectURL(a.dataset.blob);   // don't leak the previous card
    a.href = a.dataset.blob = URL.createObjectURL(b);
  });
  // the tweet carries the site, so a shared card sends people here and not only to Nansen
  const text = `I turned $10k into ${usd(p.bankroll)} betting for and against @nansen_ai Smart Money on Hyperliquid. ${p.whalesSlain} whales slain.\n\nFollow or fade? ${siteUrl()}`;
  $('shareX').href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text);
  openDialog($('shareDlg'));
};

// ================================================= leaving the game
// Every link that opens a real trading venue goes through one confirmation first. It is a disclosure,
// not guidance: it states that the game is educational, that we are not involved in what happens on a
// third-party venue, and that the risk and the responsibility are entirely the player's. It must never
// tell anyone HOW to trade — naming a leverage or a margin mode would be advice, which this product
// does not give.
const TRADE_HOST = 'https://app.nansen.ai/token-god-mode';
const gateTrade = (e) => {
  const a = e.target.closest?.('a[href]');
  // Skip the dialog's own button, or it intercepts itself and the link never opens.
  if (!a || a.id === 'lvGo' || !a.href.startsWith(TRADE_HOST)) return;
  if (e.type === 'auxclick' && e.button !== 1) return;
  e.preventDefault();
  $('lvGo').href = a.href;
  sfx.tick();
  if ($('lvDlg')) openDialog($('lvDlg')); else window.open(a.href, '_blank', 'noopener');
};
document.addEventListener('click', gateTrade, true);
document.addEventListener('auxclick', gateTrade, true); // middle-click opens a tab without firing click
$('lvGo').addEventListener('click', () => $('lvDlg').close());

// Any button marked data-close-dialog closes the dialog it sits in (no inline handlers: CSP blocks them).
document.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => b.closest('dialog')?.close()));

// ================================================= challenge a friend
// The card shows the whale and the call you made, never the result: the friend has to decide for
// themselves, and only then finds out. That is the difference between a brag and a challenge.
$('btnChallenge').onclick = async () => {
  try { await document.fonts.ready; } catch {} // self-hosted fonts: don't draw the card in Georgia
  const L = lastResult;
  if (!L || !L.challenge) return toast('Play a hand first.');
  sfx.chip();
  const link = `${siteUrl()}/?challenge=${encodeURIComponent(L.challenge)}`;
  const sizeUsd = Number(L.round?.valueUsd) > 0 ? compact(L.round.valueUsd) : null;
  const c = $('chCanvas'), g = c.getContext('2d');
  const W = 1200, H = 675;
  // The card is a dare, not a spec sheet. It deliberately does NOT say which coin or which side:
  // the moment someone reads "LONG BTC" they start forming an opinion before they have seen the tells,
  // and the whole point of a challenge is that they walk in blind, exactly as the sender did.
  const gold = '#f5d77a', ivory = '#f3ead7';
  const fit = (t, n) => (t.length > n ? t.slice(0, n - 1) + '\u2026' : t);
  const track = (px) => { try { g.letterSpacing = px + 'px'; } catch {} };
  const roundRect = (x, y, w, h, r) => {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  };

  // ---- felt + spotlight
  const bg = g.createRadialGradient(600, 210, 30, 600, 340, 860);
  bg.addColorStop(0, '#12684a'); bg.addColorStop(0.45, '#0a3d2b'); bg.addColorStop(1, '#02100a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // a second pass of darkness at the corners, so the type sits in a pool of light
  const vig = g.createRadialGradient(600, 338, 260, 600, 338, 760);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.62)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);

  // ---- two face-down cards behind the type: the whale is hidden, and it looks it
  g.save();
  g.globalAlpha = 0.2;
  for (const [cx, cy, rot] of [[182, 392, -0.2], [1018, 392, 0.2]]) {
    g.save(); g.translate(cx, cy); g.rotate(rot);
    g.fillStyle = '#031a11'; g.strokeStyle = gold; g.lineWidth = 4;
    roundRect(-88, -124, 176, 248, 18); g.fill(); g.stroke();
    g.fillStyle = gold; g.font = '900 116px Cinzel, Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('?', 0, 4);
    g.restore();
  }
  g.restore();
  g.textBaseline = 'alphabetic';

  // ---- frame
  const rim = g.createLinearGradient(0, 0, W, H);
  rim.addColorStop(0, '#8a6d1d'); rim.addColorStop(0.45, gold); rim.addColorStop(1, '#8a6d1d');
  g.strokeStyle = rim; g.lineWidth = 13; g.strokeRect(6.5, 6.5, W - 13, H - 13);
  g.strokeStyle = 'rgba(245,215,122,.34)'; g.lineWidth = 2; g.strokeRect(29, 29, W - 58, H - 58);

  g.textAlign = 'center';
  track(6);
  g.fillStyle = rim; g.font = '900 28px Cinzel, Georgia, serif'; g.fillText('FOLLOW \u25c6 FADE', 600, 80);
  track(0);

  // ---- the hero line
  g.save();
  g.shadowColor = 'rgba(245,215,122,.55)'; g.shadowBlur = 34;
  const heroGrad = g.createLinearGradient(0, 124, 0, 208);
  heroGrad.addColorStop(0, '#fff3cf'); heroGrad.addColorStop(1, '#e0b64a');
  g.fillStyle = heroGrad; g.font = '900 84px Cinzel, Georgia, serif';
  track(1);
  g.fillText('I CHALLENGE YOU', 600, 196);
  track(0);
  g.restore();

  g.fillStyle = 'rgba(243,234,215,.85)'; g.font = 'italic 500 33px "Cormorant Garamond", Georgia, serif';
  g.fillText(`${fit(player.name, 20)} has already made the call.`, 600, 246);

  // One hard number, and only one: how big the position was. It proves there is a real trade behind
  // the card without giving away the coin or the direction, which is what would let them pre-judge it.
  if (sizeUsd) {
    const label = `${sizeUsd} POSITION`;
    g.font = '700 25px "JetBrains Mono", monospace';
    track(3);
    const tw = g.measureText(label).width;
    const pw = tw + 56, px = 600 - pw / 2, py = 274, ph = 46;
    g.fillStyle = 'rgba(0,0,0,.42)'; g.strokeStyle = 'rgba(245,215,122,.55)'; g.lineWidth = 2;
    roundRect(px, py, pw, ph, 24); g.fill(); g.stroke();
    g.fillStyle = gold; g.fillText(label, 600, py + 32);
    track(0);
  }

  // ---- the question, in the two colours the whole game runs on
  const qY = 398;
  g.font = '900 66px Cinzel, Georgia, serif';
  const wF = g.measureText('FOLLOW').width, wD = g.measureText('FADE').width;
  g.font = '500 34px "Cormorant Garamond", Georgia, serif';
  const wOr = g.measureText('or').width;
  const gap = 30, total = wF + gap + wOr + gap + wD;
  let x = 600 - total / 2;
  g.textAlign = 'left';
  g.font = '900 66px Cinzel, Georgia, serif'; g.fillStyle = '#a78bfa';
  g.fillText('FOLLOW', x, qY); x += wF + gap;
  g.font = 'italic 500 34px "Cormorant Garamond", Georgia, serif'; g.fillStyle = 'rgba(243,234,215,.75)';
  g.fillText('or', x, qY - 6); x += wOr + gap;
  g.font = '900 66px Cinzel, Georgia, serif'; g.fillStyle = '#fb923c';
  g.fillText('FADE', x, qY);
  g.textAlign = 'center';

  g.fillStyle = 'rgba(243,234,215,.78)'; g.font = '500 25px Inter, sans-serif';
  g.fillText("A real Smart Money trade from this week, at the whale's exact entry.", 600, 448);
  g.fillText('You get the same tells I did. The whale\u2019s real exit settles it.', 600, 482);

  // ---- call to action
  const btnW = 442, btnH = 70, btnX = 600 - btnW / 2, btnY = 518;
  const btnGrad = g.createLinearGradient(0, btnY, 0, btnY + btnH);
  btnGrad.addColorStop(0, '#f7e2a1'); btnGrad.addColorStop(1, '#d8ad3e');
  g.save(); g.shadowColor = 'rgba(245,215,122,.45)'; g.shadowBlur = 26;
  g.fillStyle = btnGrad; roundRect(btnX, btnY, btnW, btnH, 33); g.fill(); g.restore();
  g.fillStyle = '#1a1204'; g.font = '900 31px Cinzel, Georgia, serif';
  track(3); g.fillText('TAKE THE CHALLENGE', 600, btnY + 46); track(0);

  g.fillStyle = 'rgba(245,215,122,.92)'; g.font = '700 25px Cinzel, Georgia, serif';
  track(2); g.fillText(siteLabel(), 600, 632); track(0);
  c.toBlob((b) => {
    const a = $('chDownload');
    if (a.dataset.blob) URL.revokeObjectURL(a.dataset.blob);
    a.href = a.dataset.blob = URL.createObjectURL(b);
    shareBlob = b; // kept so the native share sheet can carry the card image, not just the link
  });
  $('chLink').value = link;
  // Same rule as the card: no coin, no side, no size. They call it blind or it is not a challenge.
  const text = `I challenge you.\n\nA real ${sizeUsd ? sizeUsd + ' ' : ''}@nansen_ai Smart Money position on Hyperliquid, at the whale's exact entry. I have made my call \u2014 would you FOLLOW or FADE?\n\nYou get the same tells I did, and the ending stays hidden until you call it.\n${link}`;
  $('chX').href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text);
  // Send the link straight to a chat app instead of making them copy and paste it.
  // wa.me and t.me/share both work in the mobile apps and on the web.
  $('chWa').href = 'https://wa.me/?text=' + encodeURIComponent(text);
  $('chTg').href = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text.replace(link, '').trim());
  // Where the OS offers a share sheet (every phone), one button beats a row of them: it lists every
  // app they actually have, including ones we would never think to add.
  shareText = text; shareLink = link;
  $('chNative').hidden = !navigator.share;
  openDialog($('chDlg'));
};
let shareBlob = null, shareText = '', shareLink = '';
$('chNative').onclick = async () => {
  const withFile = shareBlob && navigator.canShare?.({ files: [new File([shareBlob], 'challenge.png', { type: 'image/png' })] });
  try {
    await navigator.share(withFile
      ? { text: shareText, files: [new File([shareBlob], 'challenge.png', { type: 'image/png' })] }
      : { text: shareText, url: shareLink });
  } catch (e) {
    if (e?.name !== 'AbortError') toast('Sharing was blocked — use the buttons or copy the link.');
  }
};
$('chCopy').onclick = async () => {
  const i = $('chLink');
  try { await navigator.clipboard.writeText(i.value); toast('Challenge link copied'); }
  catch { i.select(); toast('Press Ctrl+C to copy the link'); }
  sfx.tick();
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
  const rows = await api('/api/leaderboard').catch((e) => {
    $('boardBody').innerHTML = `<tr><td colspan="7" class="err">${esc(e.message)}</td></tr>`;
    return null;
  });
  if (!rows) return;
  const podium = [rows[1], rows[0], rows[2]];
  // Ranked on net profit, not bankroll: every reload is 10,000 the house handed you, and it counts against you.
  const net = (r) => (r.net ?? r.bankroll - 10000);
  $('podium').innerHTML = rows.length ? podium.map((r, i) => r ? `<div class="pod p${[2, 1, 3][i]}"><div class="medal">${[2, 1, 3][i]}</div><b>${esc(r.name)}</b><em>${net(r) >= 0 ? '+' : ''}${usd(net(r))}</em><div class="muted">${Math.round(r.winRate * 100)}% win rate</div></div>` : '<div></div>').join('') : '';
  $('boardBody').innerHTML = rows.length ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}${r.busts ? ` <span class="muted" title="Reloaded ${r.busts}\u00d7 after going broke: each reload counts against the net">\u00b7 ${r.busts} reload${r.busts > 1 ? 's' : ''}</span>` : ''}</td><td class="${net(r) >= 0 ? 'pos' : 'neg'}">${net(r) >= 0 ? '+' : ''}${usd(net(r))}</td><td>${r.bets}</td><td>${Math.round(r.winRate * 100)}%</td><td>${r.bestStreak}</td><td>${r.whalesSlain}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">No one has qualified yet \u2014 play three hands and the seat is yours.</td></tr>';
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
  restoreFocus();
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
// Each table is a different bet, so each has its own price: 15 minutes of price action says much less
// about a whale than riding them to their exit, and the odds say so.
const hzOdds = (t, hz = 'ride') => (t.oddsByHz && t.oddsByHz[hz]) || t.odds;
// The floor re-renders on its own every few minutes; this keeps a half-typed stake across a re-render.
const cardChoice = new Map(); // key -> { stake }  (the horizon is no longer a choice)
const rememberCard = (key, patch) => { cardChoice.set(key, { ...(cardChoice.get(key) || {}), ...patch });
  if (cardChoice.size > 200) for (const k of [...cardChoice.keys()].slice(0, cardChoice.size - 200)) cardChoice.delete(k); };
function paintOdds(card) {
  const t = liveItems.get(card.dataset.key);
  if (!t) return;
  const o = hzOdds(t, 'ride');
  const set = (sel, v) => { const el = card.querySelector(sel); if (el) el.textContent = 'x' + v.toFixed(2); };
  set('.bet.follow small', o.follow); set('.bet.fade small', o.fade);
}
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

/**
 * The tags that sit beside a whale's grade. One helper, because these appear on the live card, in the
 * dossier, on the alert popup, in the alert list and on the training table — and a tag that shows in
 * one place and not another reads as a bug.
 */
function whaleTags(tr, a) {
  if (!tr) return '';
  const t = [];
  if (tr.specialist) t.push(`<span class="spec-tag" title="Trades few coins, but has proven realised profit on this one">SPECIALIST</span>`);
  if (tr.early) {
    const e = tr.earlyStats;
    const tip = !e ? 'Gets in before big moves and holds for them'
      : e.via === 'proven'
        // Small sample, so say so plainly and let the record do the arguing.
        ? `In before ${e.goodFinds === 1 ? 'a big move' : `${e.goodFinds} big moves`} and held for ${e.goodFinds === 1 ? 'it' : 'them'}, keeping ${Math.round((e.capture || 0) * 100)}% of the move. Only ${e.finds} chance${e.finds === 1 ? '' : 's'} in 30 days \u2014 a small sample \u2014 but their record is exceptional: ${((e.roi || 0) * 100).toFixed(1)}% return and a ${Math.round((e.winRate || 0) * 100)}% win rate over 30 days.`
        : `Got into ${e.goodFinds} of ${e.finds} big moves early and held for them (median ${Math.round((e.capture || 0) * 100)}% of the move captured, across ${e.coins} coins). Most traders keep about a quarter.`;
    t.push(`<span class="spec-tag early-tag" title="${esc(tip)}">EARLY</span>`);
  }
  if (tr.printer) {
    const f = tr.printerStats;
    const tip = f ? `Prints money on small size: about ${compact(f.medNotional)} a position, under the whale floor, with a ${Math.round((f.winRate || 0) * 100)}% win rate and ${((f.medRet || 0) * 100).toFixed(1)}% return on a typical trade over ${f.closed} closed trades.` : 'Prints money on size well under the whale floor';
    t.push(`<span class="spec-tag printer-tag" title="${esc(tip)}">PRINTER</span>`);
  }
  if (tr.scalper) {
    // Quote the real holding time. The old tooltip quoted Nansen's closed-trade count as if it were a
    // pace, and told people to expect a short hold from traders who hold for days.
    const h = tr.holdHours, q = tr.shareUnder1h;
    const tip = h != null
      ? `Typically holds a position about ${h < 1 ? `${Math.round(h * 60)} minutes` : `${h.toFixed(1)} hours`}${q != null && q >= 0.3 ? `, and closes ${Math.round(q * 100)}% of them inside an hour` : ''}. This whale works the tape, so the position may not last long.`
      : 'Works the tape rather than holding, so the position may not last long';
    t.push(`<span class="spec-tag scalp-tag" title="${esc(tip)}">SCALPER</span>`);
  }
  return t.length ? ' ' + t.join(' ') : '';
}

function liveCard(t) {
  t.seenAt ??= Date.now();
  liveItems.set(t.key, t);
  if (liveItems.size > 200) for (const k of [...liveItems.keys()].slice(0, liveItems.size - 200)) liveItems.delete(k);
  const k = esc(t.key), tr = t.record?.trust || { grade: '?', label: 'No track record' };
  const gradeCls = { 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[tr.grade] || 'gc';
  return `<div class="lcard${t.alert ? ' alerted' : ''}" data-key="${k}">${t.alert ? '<div class="ribbon">WHALE ALERT</div>' : ''}
    <div class="row"><div><span class="side ${t.side}">${t.side.toUpperCase()}</span><span class="coin">${coinHtml(t.coin)}</span></div><div class="row-right"><button class="lc-refresh" data-refresh="${k}" title="Re-check this whale: price, odds, tells and whether they are still in">↻ Re-check</button><div class="size">${compact(t.valueUsd)}</div></div></div>
    <div class="lc-changed" hidden></div>
    <div class="meta">${esc(t.trader || 'Smart Money whale')} · ${ago(t.openedAt)} · entry ${price(t.entryPrice)} → now ${price(t.mid)} · whale <span class="${t.moveSinceEntry >= 0 ? 'pos' : 'neg'}">${pct(t.moveSinceEntry, 2)}</span> · ${t.trimmed >= 0.1 ? `<span class="hold trim">trimmed ${Math.round(t.trimmed * 100)}%</span>` : '<span class="hold">still holding</span>'}</div>

    <button class="lc-summary" aria-expanded="false"><span class="grade ${gradeCls}">${tr.grade}</span><span class="lcs-text"><b>${esc(tr.label)}${whaleTags(tr)}</b><small>${t.record?.d30?.closed ? `30D ${t.record.d30.pnl >= 0 ? '+' : ''}${compact(t.record.d30.pnl)} · ${Math.round((t.record.d30.winRate || 0) * 100)}% wins · ${t.record.d30.coins} coins` : 'No 30D track record'}</small></span><span class="lcs-more">Details</span></button>
    ${t.research ? researchBlock(t) : ''}
    <div class="lc-more">
    <div class="dossier-box">
      <div class="dossier-top">
        <div class="grade ${gradeCls}" title="Trust score ${tr.score ?? '–'}/100, from realized return, win rate and sample size (30d), adjusted by the last 7 days">${tr.grade}</div>
        <div class="dossier-title"><b>Whale track record${whaleTags(tr)}</b><span>${esc(tr.label)}${tr.score != null ? ` · trust ${tr.score}/100` : ''}</span></div>
        <div class="rec-tabs" role="tablist"><button class="on" data-win="d7">7D</button><button data-win="d30">30D</button></div>
      </div>
      <div class="rec-body" data-panel="d7">${recordHtml(t.record?.d7)}</div>
      <div class="rec-body" data-panel="d30" hidden>${recordHtml(t.record?.d30)}</div>
    </div>

    <div class="tells-title sm">The dealer's tells <span class="legend"><i class="g"></i>favors FOLLOW <i class="r"></i>favors FADE</span></div>
    <ul class="reasons">${t.reasons.map((x) => `<li class="${x.good ? 'good' : ''}">${esc(x.text)}</li>`).join('')}</ul>
    </div>
    <div class="probbar"><div class="pf" style="width:${(t.pFollow * 100).toFixed(1)}%"></div><div class="needle" style="left:calc(${(t.pFollow * 100).toFixed(1)}% - 1px)"></div></div>
    <div class="problabels"><span>Follow wins <b>${Math.round(t.pFollow * 100)}%</b></span><span>Fade wins <b>${Math.round((1 - t.pFollow) * 100)}%</b></span></div>
    <div class="ride-note"><b>Ride the Whale</b> — this bet ends when the whale closes their position, or at the ${rideCapHours}-hour mark if they are still holding. <b>Cash out any time</b> at the current price.</div>
    <div class="lstake"><input type="number" min="1" value="500" aria-label="Stake"><button class="minichip" data-add="100">100</button><button class="minichip g" data-add="500">500</button><button class="minichip r" data-add="1000">1K</button><button class="minichip k" data-add="all">ALL</button></div>
    <div class="actions"><button class="bet follow" data-choice="follow"><span>FOLLOW</span><small>x${hzOdds(t, 'ride').follow.toFixed(2)}</small></button>
    <button class="bet fade" data-choice="fade"><span>FADE</span><small>x${hzOdds(t, 'ride').fade.toFixed(2)}</small></button></div>
    <p class="lc-src">Figures as of ${esc(new Date(t.seenAt || Date.now()).toISOString().slice(0, 16).replace('T', ' '))} UTC, from Hyperliquid and Nansen. The grade is this site's own automated heuristic, not a judgement about any person or firm. <a href="/legal.html" target="_blank" rel="noopener">Are you this trader?</a></p>
    <div class="links"><a href="https://app.nansen.ai/profiler?address=${esc(t.address)}&chain=hyperliquid" target="_blank" rel="noopener">Whale profile on Nansen ↗</a><a class="trade-nansen" href="https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(t.coin)}&chain=hyperliquid" target="_blank" rel="noopener">Look ${esc(t.coin)} up on Nansen ↗</a></div>
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
    const saved = cardChoice.get(card.dataset.key);
    if (saved?.stake >= 1) input.value = Math.min(saved.stake, Math.max(1, Math.floor(player.bankroll)));
    paintOdds(card);
    card.querySelectorAll('[data-add]').forEach((c) => c.onclick = () => {
      input.value = c.dataset.add === 'all' ? Math.floor(player.bankroll) : Math.min(Math.floor(player.bankroll), Number(c.dataset.add));
      rememberCard(card.dataset.key, { stake: Number(input.value) });
      sfx.chip(); if (c.dataset.add === 'all') { sparkleAt(c, 20); toast('All in. The house respects it.'); }
    });
    const rf = card.querySelector('[data-refresh]');
    if (rf) rf.onclick = () => recheckCard(card);
    const rq = card.querySelector('.rq-btn');
    if (rq) rq.onclick = () => openResearch(card, liveItems.get(card.dataset.key));
    const more = card.querySelector('.lc-summary');
    if (more) more.onclick = () => { card.classList.toggle('expanded'); more.setAttribute('aria-expanded', card.classList.contains('expanded')); sfx.tick(); };
    card.querySelectorAll('.bet').forEach((btn) => btn.onclick = async () => {
      if (card.dataset.busy) return;
      const minutes = 'ride'; // the only lane on the floor
      const stake = Math.floor(Number(input.value));
      const t = liveItems.get(card.dataset.key);
      if (!(stake >= 1) || stake > player.bankroll) return toast('Stake must be between $1 and your bankroll');
      const choice = btn.dataset.choice;
      card.dataset.busy = '1'; card.querySelectorAll('.bet').forEach((x) => (x.disabled = true));
      const unlock = () => { delete card.dataset.busy; card.querySelectorAll('.bet').forEach((x) => (x.disabled = false)); };
      // 1) show it on Your Table instantly
      const tmp = { id: 'tmp-' + Math.random().toString(36).slice(2), pending: true, coin: t.coin, whaleSide: t.side, choice, stake,
        price: choice === 'follow' ? hzOdds(t).follow : hzOdds(t).fade, entry: t.mid, placedAt: Date.now(), settleAt: Date.now() + rideCapHours * 3600e3, minutes, ride: true, status: 'open' };
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
        toast(`Riding the whale: ${choice.toUpperCase()} ${b.coin} for ${usd(b.stake)}`);
        nudgeBets();
        pollBets(); unlock();
      } catch (e) {
        unlock();
        pending = pending.filter((x) => x !== tmp); renderLanes();
        player.bankroll += stake; renderPlayer();
        toast(e.message);
        if (e.status === 409 || e.status === 410) {
          card.classList.add('gone'); setTimeout(() => card.remove(), 450);
          if (liveCache) liveCache.items = liveCache.items.filter((x) => x.key !== card.dataset.key);
        }
      }
    });
  });
}
$('btnRefreshLive').onclick = async () => {
  const btn = $('btnRefreshLive');
  if (btn.disabled) return;
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Refreshing…'; sfx.deal();
  $('liveList').classList.add('refreshing');
  const before = new Set((liveCache?.items || []).map((x) => x.key));
  try {
    const items = await fetchLive();
    renderLive(items); loadPick();
    const fresh = items.filter((x) => !before.has(x.key)).length, gone = [...before].filter((k) => !items.some((x) => x.key === k)).length;
    toast(`Floor refreshed · prices updated${fresh ? ` · ${fresh} new whale${fresh > 1 ? 's' : ''}` : ''}${gone ? ` · ${gone} whale${gone > 1 ? 's' : ''} exited` : ''}`);
  } catch (e) { toast(e.message); }
  $('liveList').classList.remove('refreshing');
  btn.disabled = false; btn.textContent = label;
};

// ================================================= whale alerts
let alertCfg = null, alertSince = 0, alertsCache = [];
const seenAlerts = () => Number(store.get('fof_alerts_seen') || 0);
const clearedAlerts = () => Number(store.get('fof_alerts_cleared') || 0);
const ALERT_MAX_AGE = 24 * 3600e3, ALERT_MAX_SHOWN = 25;
/** What the bell shows: cleared ones stay gone, nothing older than a day, newest 25. */
const visibleAlerts = () => alertsCache.filter((a) => a.t > clearedAlerts() && Date.now() - a.t < ALERT_MAX_AGE).slice(0, ALERT_MAX_SHOWN);
const gradeClass = (g) => ({ 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[g] || 'gc');
const nansenTrade = (coin) => `https://app.nansen.ai/token-god-mode?tokenAddress=${encodeURIComponent(coin)}&chain=hyperliquid`;

async function initAlerts() {
  const r = await api('/api/alerts?since=0').catch(() => null);
  if (!r) { setTimeout(initAlerts, 8000); return; } // a blip at boot must not silence the bell for good
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
  const n = visibleAlerts().filter((a) => a.t > seenAlerts()).length;
  const el = $('alertCount'); el.hidden = !n; el.textContent = n > 9 ? '9+' : n;
  $('alertBtn').classList.toggle('ringing', n > 0);
}
function exitLine(a) {
  const ret = a.whaleRet != null ? `<b class="${a.whaleRet >= 0 ? 'pos' : 'neg'}">${pct(a.whaleRet, 2)}</b>` : 'n/a';
  const base = a.coin.split(':').pop(), sz = (n) => (+n).toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 1 : 4 });
  if (a.kind === 'add') return {
    title: `added <b>${sz(a.addedSz)} ${esc(base)}</b> to <span class="side ${esc(a.side)}">${esc(a.side).toUpperCase()}</span> <b>${esc(a.coin)}</b>`,
    stats: `Now ${sz(a.sizeNow)} ${esc(base)} (${compact(a.valueUsd || 0)}) · <b>${a.multiple.toFixed(1)}x</b> the alerted size · avg entry ${price(a.avgEntry)} → ${a.markPx != null ? price(a.markPx) : 'n/a'} · whale ${ret}` };
  const title = a.kind === 'exit' ? `closed <span class="side ${esc(a.side)}">${esc(a.side).toUpperCase()}</span> <b>${esc(a.coin)}</b>` : `cut <b>${Math.round(a.trimPct * 100)}%</b> of <span class="side ${esc(a.side)}">${esc(a.side).toUpperCase()}</span> <b>${esc(a.coin)}</b>`;
  return { title, stats: a.kind === 'exit'
    ? `Held ${hrs(a.heldMs)} · entry ${price(a.entryPrice)} → exit ${a.exitExact ? '' : '~'}${a.exitPx != null ? price(a.exitPx) : 'n/a'} · whale ${ret}`
    : `${Math.round(a.remainingPct * 100)}% still open · entry ${price(a.entryPrice)} → now ${a.markPx != null ? price(a.markPx) : 'n/a'} · whale ${ret}` };
}
function alertLine(a) {
  if (a.kind) {
    const x = exitLine(a);
    return `<div class="alert-item exit-item ${a.kind}${a.t > seenAlerts() ? ' unread' : ''}" data-id="${a.id}">
      <div class="exit-ico">${a.kind.toUpperCase()}</div>
      <div class="ai-body"><div class="ai-title">${esc(a.trader)} ${x.title} <span class="muted">· ${ago(new Date(a.t).toISOString())}</span></div>
      <div class="ai-stats">${x.stats}</div>
      <div class="ai-actions">${a.kind === 'add' ? `<button class="gold-btn sm" data-betalert="${esc(a.key)}">Open full card</button>` : ''}<button class="${a.kind === 'add' ? 'ghost-btn' : 'gold-btn'} sm" data-mybets>My bets</button><a class="link" href="https://app.nansen.ai/profiler?address=${esc(a.address)}&chain=hyperliquid" target="_blank" rel="noopener">Profile ↗</a></div></div></div>`;
  }
  const d30 = a.record?.d30 || {}, d7 = a.record?.d7, tr = a.record?.trust || { grade: '?' };
  return `<div class="alert-item${a.t > seenAlerts() ? ' unread' : ''}" data-id="${a.id}">
    <div class="grade ${gradeClass(tr.grade)}">${tr.grade}</div>
    <div class="ai-body">
      <div class="ai-title"><span class="side ${esc(a.side)}">${esc(a.side).toUpperCase()}</span> <b>${esc(a.coin)}</b> <span class="mono">${compact(a.valueUsd)}</span> ${a.specialist ? `<span class="spec-tag" title="${Math.round(a.specialist.share * 100)}% of 30D closes on ${esc(a.coin)} · +${compact(a.specialist.pnl)} realized · ${(a.specialist.roi * 100).toFixed(1)}% return">SPECIALIST</span>` : ''}${whaleTags({ early: a.early, printer: a.printer, scalper: a.scalper, tradesPerDay: a.tradesPerDay, earlyStats: a.earlyStats, printerStats: a.printerStats })} <span class="muted">· ${ago(a.openedAt)}${a.test ? ' · test' : ''}</span></div>
      <div class="ai-who">${esc(a.trader)} · ${esc(tr.label || '')}</div>
      ${a.specialist ? `<div class="ai-spec">${esc(a.coin)} specialist: ${Math.round(a.specialist.share * 100)}% of trades, <b class="pos">+${compact(a.specialist.pnl)}</b> realized on ${esc(a.coin)} (${(a.specialist.roi * 100).toFixed(1)}% return) in 30D</div>` : ''}
      <div class="ai-stats">30D <b class="${d30.pnl >= 0 ? 'pos' : 'neg'}">${d30.pnl >= 0 ? '+' : ''}${compact(d30.pnl || 0)}</b> · ${Math.round((d30.winRate || 0) * 100)}% wins · ${d30.coins || 0} coins${d7 && d7.closed ? ` · 7D <b class="${d7.pnl >= 0 ? 'pos' : 'neg'}">${d7.pnl >= 0 ? '+' : ''}${compact(d7.pnl)}</b> · ${d7.coins} coins` : ''}</div>
      <div class="ai-actions"><button class="gold-btn sm" data-betalert="${esc(a.key)}">Open full card</button><a class="ghost-btn sm" href="${nansenTrade(a.coin)}" target="_blank" rel="noopener">See it on Nansen ↗</a><a class="link" href="https://app.nansen.ai/profiler?address=${esc(a.address)}&chain=hyperliquid" target="_blank" rel="noopener">Profile ↗</a></div>
    </div></div>`;
}
function renderAlertList() {
  const list = visibleAlerts();
  $('alertClear').hidden = !list.length;
  const rows = list.map((a) => { try { return alertLine(a); } catch { return ''; } }).filter(Boolean); // one odd row must never blank the panel
  $('alertList').innerHTML = rows.length ? rows.join('')
    : `<p class="ap-empty">${alertsCache.length ? 'List cleared. New alerts land here as soon as a whale matching the rules opens a position.' : 'No alerts yet. The scanner checks Nansen Smart Money every few minutes and pings you when a whale matching your rules opens a position.'}</p>`;
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
  $('cfgClosed').value = String(alertCfg.minClosed ?? 20); $('cfgRoi').value = String(alertCfg.minRoi30d ?? 0.02);
  $('cfgFee').value = String(alertCfg.minPnlPerFee ?? 3); $('cfgPpt').value = String(alertCfg.minPnlPerTrade ?? 10);
  $('cfgProfit7').checked = alertCfg.requireProfit7d !== false; $('cfgMajority').checked = alertCfg.requireCoinMajority !== false;
  $('cfgEarly').checked = alertCfg.allowEarly !== false; $('cfgPrinter').checked = alertCfg.allowPrinter !== false;
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
  $('tgPair').textContent = tgc.pairCode || '—';
  // One-click pairing: Telegram sends "/start <code>" for them, so there is nothing to type or mistype.
  const link = $('tgPairLink');
  link.href = tgc.pairLink || '#';
  link.textContent = tgc.pairLink ? `t.me/${tgc.botName}` : 'this pairing link';
  renderAlertStatus();
}
async function saveCfg() {
  alertCfg = await api('/api/alerts/config', { enabled: $('cfgEnabled').checked, minGrade: $('cfgGrade').value, minWinRate: $('cfgWin').value,
    minSizeUsd: $('cfgSize').value, minCoins7d: $('cfgC7').value, minCoins30d: $('cfgC30').value, intervalMin: $('cfgInt').value, requireProfit30d: $('cfgProfit').checked, allowSpecialists: $('cfgSpec').checked,
    minClosed: $('cfgClosed').value, minRoi30d: $('cfgRoi').value, minPnlPerFee: $('cfgFee').value,
    minPnlPerTrade: $('cfgPpt').value, requireProfit7d: $('cfgProfit7').checked, requireCoinMajority: $('cfgMajority').checked,
    allowEarly: $('cfgEarly').checked, allowPrinter: $('cfgPrinter').checked }).catch((e) => { toast(e.message); return alertCfg; });
  renderAlertCfg(); sfx.tick();
}
// Every control in the panel saves on change. A control left off this list renders, accepts a click
// and silently does nothing, which is worse than not shipping it.
['cfgEnabled', 'cfgGrade', 'cfgWin', 'cfgSize', 'cfgInt', 'cfgProfit', 'cfgC7', 'cfgC30', 'cfgSpec',
  'cfgClosed', 'cfgRoi', 'cfgFee', 'cfgPpt', 'cfgProfit7', 'cfgMajority', 'cfgEarly', 'cfgPrinter'].forEach((id) => $(id).addEventListener('change', saveCfg));

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
$('tgRepair').onclick = async () => {
  try { alertCfg = await api('/api/alerts/telegram/repair', {}); renderAlertCfg(); toast('New pairing code. Open the link again.'); }
  catch (e) { toast(e.message); }
};

// "Bet on it": jump to the Live Floor card for that trade
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-betalert]');
  if (!b) return;
  $('alertPanel').hidden = true; $('alertPop').hidden = true;
  goToTrade(b.dataset.betalert);
});
/** Open the Live Floor and bring one whale's card into view (alerts, Telegram "Bet on it" links). */
async function goToTrade(key) {
  suppressIntro = true; setTimeout(() => (suppressIntro = false), 8000);
  if (history.replaceState) history.replaceState(null, '', location.pathname);
  collapsePick();
  document.querySelector('.tab[data-view="live"]').click();
  const find = () => [...document.querySelectorAll('.lcard')].find((c) => c.dataset.key === key) || null;
  let card = null;
  for (let i = 0; i < 6 && !card; i++) { card = find(); if (!card) await sleep(200); } // already rendered? found instantly
  // The floor is served from a cache that can be older than the alert, so a brand new whale simply
  // is not on it yet. Rebuild once before giving up.
  if (!card) {
    try { renderLive(await fetchLive()); } catch {}
    for (let i = 0; i < 6 && !card; i++) { card = find(); if (!card) await sleep(200); }
  }
  // Still missing: the floor only shows the largest few whales, so fetch this one on its own and pin
  // it at the top. Clicking an alert should always land on THAT trade, never just near it.
  if (!card) {
    const t = await api('/api/live/one?key=' + encodeURIComponent(key)).catch(() => null);
    if (t) {
      t.alert = true;
      if (liveCache && !liveCache.items.some((x) => x.key === t.key)) liveCache.items = [t, ...liveCache.items];
      renderLive(liveCache ? liveCache.items : [t]);
      card = find();
    }
  }
  if (!card) return toast("That whale has closed the position, so the card is gone. Here are the latest whales.");
  await sleep(350);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  focusCard(card);
  recheckCard(card).catch(() => {}); // straight from an alert: show what changed since it was sent
}

// Arriving from a Telegram alert or the bell, the floor can be twenty cards deep and the gold glow
// alone is easy to lose — especially after a scroll lands you between two cards. Hold the rest of the
// floor back for the same few seconds so there is exactly one card in focus.
const FOCUS_MS = 6000;
// Arriving from Telegram on a desktop, the browser window usually has to be CLICKED before it takes
// focus, and that click lands on the page. The dismiss-on-first-touch rule below then cancelled the
// spotlight before the player had looked at anything - the reported symptom was a Live Floor with no
// glow and nothing dimmed. Ignore input for a moment after the spotlight lands so the click that
// merely brought the window forward does not count as impatience.
const FOCUS_GRACE_MS = 1500;
let focusTimer = null;
let focusArmedAt = 0;
let focusKey = null;   // which card the spotlight belongs to, by data-key
function focusCard(card) {
  const list = $('liveList');
  document.querySelectorAll('.lcard.spotlight').forEach((c) => c.classList.remove('spotlight'));
  card.classList.add('spotlight');
  focusKey = card.dataset.key || null;
  if (list) list.classList.add('focusing');
  clearTimeout(focusTimer);
  focusArmedAt = Date.now();
  focusTimer = setTimeout(clearFocus, FOCUS_MS);
}
function clearFocus() {
  clearTimeout(focusTimer); focusTimer = null; focusKey = null; focusArmedAt = 0;
  $('liveList')?.classList.remove('focusing');
  document.querySelectorAll('.lcard.spotlight').forEach((c) => c.classList.remove('spotlight'));
}
/** renderLive() replaces the whole list, which throws away the spotlighted element while `focusing`
 *  stays on the container — every card then matches the dim rule and the card you were sent to is
 *  blurred along with the rest. Re-attach the spotlight after a re-render, or drop the focus if that
 *  card is no longer on the floor. */
function restoreFocus() {
  if (!focusTimer) return;
  const card = focusKey && $('liveList')?.querySelector(`.lcard[data-key="${CSS.escape(focusKey)}"]`);
  if (card) card.classList.add('spotlight');
  else clearFocus();
}
// Don't make an impatient player wait out the countdown - but only once the spotlight has had a
// moment on screen, so window-activation clicks and a stray scroll on arrival don't eat it.
['pointerdown', 'keydown', 'wheel'].forEach((ev) =>
  window.addEventListener(ev, () => {
    if (focusTimer && Date.now() - focusArmedAt > FOCUS_GRACE_MS) clearFocus();
  }, { passive: true }));

function announceAlert(a, count) {
  if (a.kind) return announceExit(a, count);
  const tr = a.record?.trust || { grade: '?' }, d30 = a.record?.d30 || {};
  sfx.alarm();
  const pop = $('alertPop');
  pop.innerHTML = `<div class="ap-glow"></div><div class="ap-inner">
    <div class="ap-kicker">Whale alert${a.specialist ? ' · Specialist' : ''}${a.early ? ' · Early finder' : ''}${a.printer ? ' · Printer' : ''}${a.scalper ? ' · Scalper' : ''}${count > 1 ? ` · +${count - 1} more` : ''}</div>
    <div class="ap-main"><div class="grade ${gradeClass(tr.grade)}">${tr.grade}</div>
      <div><b>${esc(a.trader)}</b> just opened <span class="side ${esc(a.side)}">${esc(a.side).toUpperCase()}</span> <b>${esc(a.coin)}</b> ${compact(a.valueUsd)}
      <div class="ai-stats">${a.specialist ? `${esc(a.coin)} specialist · <b class="pos">+${compact(a.specialist.pnl)}</b> on ${esc(a.coin)} · ${Math.round(a.specialist.share * 100)}% of trades` : `30D <b class="${d30.pnl >= 0 ? 'pos' : 'neg'}">${d30.pnl >= 0 ? '+' : ''}${compact(d30.pnl || 0)}</b> · ${Math.round((d30.winRate || 0) * 100)}% wins`} · trust ${tr.score ?? '–'}/100</div></div></div>
    <div class="ai-actions"><button class="gold-btn sm" data-betalert="${esc(a.key)}">Open full card</button><a class="ghost-btn sm" href="${nansenTrade(a.coin)}" target="_blank" rel="noopener">See it on Nansen ↗</a><button class="link" id="popClose">Dismiss</button></div></div>`;
  pop.hidden = false;
  $('popClose').onclick = () => (pop.hidden = true);
  clearTimeout(pop._h); pop._h = setTimeout(() => (pop.hidden = true), 15000);
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`Whale alert · Grade ${tr.grade}${a.early ? ' · EARLY' : ''}${a.printer ? ' · PRINTER' : ''}${a.scalper ? ' · SCALPER' : ''}`, { body: `${a.trader} opened ${a.side.toUpperCase()} ${a.coin} ${compact(a.valueUsd)} · ${a.specialist ? `${a.coin} specialist, +${compact(a.specialist.pnl)} on ${a.coin} (30D)` : `30D ${compact(d30.pnl || 0)}, ${Math.round((d30.winRate || 0) * 100)}% wins`}`, tag: a.id });
    n.onclick = () => { window.focus(); pop.querySelector('[data-betalert]')?.click(); n.close(); };
  }
}

function announceExit(a, count) {
  const x = exitLine(a), pop = $('alertPop');
  sfx.alarm();
  pop.innerHTML = `<div class="ap-glow"></div><div class="ap-inner">
    <div class="ap-kicker">${{ exit: 'Whale exit', trim: 'Whale trimming', add: 'Whale adding · conviction rising' }[a.kind]}${a.specialist ? ' · SPECIALIST' : ''}${a.early ? ' · EARLY' : ''}${a.printer ? ' · PRINTER' : ''}${a.scalper ? ' · SCALPER' : ''}${count > 1 ? ` · +${count - 1} more` : ''}</div>
    <div class="ap-main"><div class="exit-ico ${a.kind}">${a.kind.toUpperCase()}</div>
      <div><b>${esc(a.trader)}</b> ${x.title}<div class="ai-stats">${x.stats}</div><div class="ai-stats">${a.kind === 'add' ? 'The whale is doubling down.' : 'Following this whale? Check your position.'}</div></div></div>
    <div class="ai-actions">${a.kind === 'add' ? `<button class="gold-btn sm" data-betalert="${esc(a.key)}">Open full card</button>` : ''}<button class="${a.kind === 'add' ? 'ghost-btn' : 'gold-btn'} sm" data-mybets>My bets</button><button class="link" id="popClose">Dismiss</button></div></div>`;
  pop.hidden = false;
  $('popClose').onclick = () => (pop.hidden = true);
  clearTimeout(pop._h); pop._h = setTimeout(() => (pop.hidden = true), 15000);
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${{ exit: 'Whale exit', trim: 'Whale trimming', add: 'Whale adding' }[a.kind]}${a.specialist ? ' · specialist' : ''} · ${a.coin}`, { body: `${a.trader} ${a.kind === 'exit' ? 'closed' : a.kind === 'add' ? `grew to ${a.multiple.toFixed(1)}x on` : `cut ${Math.round(a.trimPct * 100)}% of`} ${a.side.toUpperCase()} ${a.coin}`, tag: a.id });
    n.onclick = () => { window.focus(); n.close(); };
  }
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-mybets]')) return;
  $('alertPanel').hidden = true; $('alertPop').hidden = true;
  if (sheetMode()) openSheet(); else $('rail').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

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
  $('levelMini').classList.toggle('ready', r.level.index >= 3);
  if (leveledUp) { sfx.win(true); coinRain(80); banner(`Level up: ${r.level.name}`, r.level.index >= 3 ? 'Your reads beat the odds. Your profile says you are reading these well.' : 'Your Trader Profile has new scores.', 'win'); }
  if (render || document.getElementById('view-report').classList.contains('active')) renderReport(r);
}
/** The trader profile: named skills, each scored against what the odds expected of you. */
function profileCard(r) {
  const pr = r.profile;
  if (!pr) return '';
  const cls = (v) => (v == null ? '' : v >= 65 ? 'pos' : v <= 40 ? 'neg' : '');
  const row = (x) => `<div class="sk${x.ready ? '' : ' locked'}">
      <div class="sk-top"><span class="sk-i" aria-hidden="true">${x.icon}</span><span class="sk-l">${esc(x.label)}</span>
        <b class="${cls(x.score)}">${x.ready ? x.score + '<i>/100</i>' : '—'}</b></div>
      <div class="sk-bar"><span class="mid" aria-hidden="true"></span><i style="width:${x.ready ? x.score : 0}%"></i></div>
      <small>${x.ready ? `${x.n} hand${x.n === 1 ? '' : 's'} · you won ${Math.round(x.winRate * 100)}%, the odds expected ${Math.round(x.expected * 100)}%` : `${x.n}/${pr.minScored} hands · ${esc(x.blurb)}`}</small>
    </div>`;
  return `<div class="report-card profile">
    <div class="pf-head">
      <div><small>Your trader profile</small><h3>${esc(r.level.name)}</h3>
        <p class="muted">Every score is your edge <b>over what the odds expected of you</b>, not your win rate. 50 means you read those hands exactly as well as the data did.</p></div>
      ${pr.overall != null ? `<div class="pf-overall ${cls(pr.overall)}"><b>${pr.overall}</b><small>overall</small></div>` : ''}
    </div>
    <div class="sk-grid">${pr.scores.map(row).join('')}</div>
    <div class="pf-notes">
      ${pr.best ? `<p><b class="pos-h">Your strongest skill</b> ${esc(pr.best.label)} — ${pr.best.score}/100 over ${pr.best.n} hand${pr.best.n === 1 ? '' : 's'}.</p>` : ''}
      ${pr.worst && pr.worst.score < 50 ? `<p><b class="neg-h">Your biggest leak</b> ${esc(pr.worst.label)} — ${pr.worst.score}/100 over ${pr.worst.n} hand${pr.worst.n === 1 ? '' : 's'}.</p>` : ''}
      ${pr.training ? `<p><b>Recommended training</b> ${esc(pr.training)}</p>` : ''}
    </div>
  </div>`;
}

function renderReport(r) {
  const body = $('reportBody');
  const steps = ['Rookie', 'Apprentice', 'Whale Reader', 'Smart Money Hunter', 'Market Operator'];
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
      <p class="counts-note">Counts training hands, Ride the Whale bets and Insider Picks — all judged on a real exit, never a timer.</p>
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
    ${profileCard(r)}
    <div class="report-cols">
      <div class="report-card"><h4 class="pos-h">Your strengths</h4>${r.strengths.length ? r.strengths.map(pat).join('') : '<p class="muted">Keep playing: a pattern needs 3+ hands and a 60%+ win rate to show here.</p>'}</div>
      <div class="report-card"><h4 class="neg-h">Your leaks</h4>${r.leaks.length ? r.leaks.map(pat).join('') : '<p class="muted">No leaks found yet. Patterns with a 45% or lower win rate (3+ hands) show here.</p>'}</div>
    </div>
    ${tagCard(r)}
    <div class="report-card"><h4>Every pattern we track</h4><div class="pat-grid">${r.patterns.map(pat).join('')}</div></div>
    <div class="report-card cta"><div><h4>Where this data comes from</h4><p>Every read you are scored on is built from Nansen's Smart Money data on Hyperliquid. What you do with the skill is yours to decide — we have no relationship with Nansen and earn nothing if you go there.</p></div>
      <div class="ref-actions"><a class="nansen-btn big" href="https://app.nansen.ai/token-god-mode?tokenAddress=BTC&chain=hyperliquid" target="_blank" rel="noopener">See this data on Nansen ↗</a></div></div>
    <p class="disclaimer">Play money only. Past results in a game do not guarantee real trading results. Not financial advice.</p>`;
}
/**
 * How the player reads each KIND of whale. The grade patterns above answer "do you over-trust a good
 * record"; this answers a question the grade cannot — reading a whale who gets in before moves is a
 * different skill from reading one who never holds, and a player can be reliably good at one and
 * reliably wrong about the other.
 *
 * Every row carries its sample size, and rows without enough hands say so instead of showing a win
 * rate. A 3-hand streak presented as a finding is worse than no finding.
 */
function tagCard(r) {
  if (!r.byTag || !r.byTag.length) return '';
  const tagClass = { early: 'early-tag', printer: 'printer-tag', scalper: 'scalp-tag', specialist: '', combo: '', untagged: '', elite: '', weak: '' };
  const row = (g) => {
    const cls = tagClass[g.key] ? `spec-tag ${tagClass[g.key]}` : 'spec-tag plain-tag';
    if (!g.enough) return `<div class="tagrow thin"><span class="${cls}">${esc(g.label)}</span><small>${g.n ? `${g.n} hand${g.n === 1 ? '' : 's'} so far — ${4 - g.n} more to be scored` : 'not seen yet'}</small></div>`;
    const good = g.edge >= 0;
    return `<div class="tagrow"><span class="${cls}">${esc(g.label)}</span>
      <div class="tagbar"><i style="width:${Math.round(Math.max(2, Math.min(100, g.winRate * 100)))}%" class="${good ? 'pos' : 'neg'}"></i></div>
      <b class="${good ? 'pos' : 'neg'}">${Math.round(g.winRate * 100)}%</b>
      <small>${g.n} hands · ${g.edge >= 0 ? '+' : ''}${(g.edge * 100).toFixed(0)} pts vs the odds</small></div>`;
  };
  const rated = r.byTag.filter((g) => g.enough).length;
  return `<div class="report-card"><h4>Which whales you read best</h4>
    <p class="counts-note">${rated ? 'Win rate against each kind of whale, and how that compares with what the odds expected. Four hands minimum before a row is scored.' : 'Play a few more hands and this fills in: it scores you separately against each kind of whale.'}</p>
    ${r.byTag.map(row).join('')}</div>`;
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
$('betaGo').onclick = () => document.querySelector('.tab[data-view="plans"]').click();
// The footer is the only route to Premium on a phone, where the bottom nav has no room for it.
const goPremium = () => {
  document.querySelector('.tab[data-view="plans"]').click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
$('footPremium')?.addEventListener('click', goPremium);
$('mobPremium')?.addEventListener('click', goPremium);

// The Plans page and the beta strip are the only places the site makes a commercial offer, so they are
// hidden in the markup and revealed only when the server says SHOW_PLANS=1. Failing closed matters here:
// if the status call never lands, no offer is shown, which is the state the published mentions légales
// describe. Anyone who deep-links to #plans while it is off is put back on the Training Table.
// The Premium page makes no commercial offer at all: everything on it is free, unfinished and
// invite-only, and it says so before anything else. So the page itself is always available — people
// could not otherwise discover that Telegram alerts exist. SHOW_PLANS still gates the beta strip,
// which does imply a future paid tier.
function paintPlans(on) {
  const strip = $('betaStrip');
  if (strip) strip.hidden = !on;
  if (wantPlansOnLoad) {
    const tab = document.querySelector('.tab-plans');
    if (tab) tab.click(); // honour ?view=plans
  }
  wantPlansOnLoad = false;
}

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
    ${entryHtml(i.insider, liveItems.get([...liveItems.keys()].find((k) => liveItems.get(k).coin.split(':').pop() === i.ticker))?.mid)}
    <p class="rq-vs ${al}">The whale is <b>${side.toUpperCase()}</b>: ${al === 'aligned' ? 'insiders point the same way' : al === 'against' ? 'insiders point the other way' : 'insiders give no clear direction'}.</p>
    <dl class="rq-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${i.verdict ? `<p class="rq-verdict">${esc(i.verdict)}</p>` : ''}
    <p class="rq-foot">Written by Nansen Agent, an AI model${i.tools?.length ? ` · ${i.tools.length} Nansen stock data tools` : ''}${i.asOf ? ` · as of ${esc(i.asOf)}` : ''}${i.demo ? ' · sample data' : ''}. Not checked by a person, not a recommendation, not financial advice.</p>`;
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

const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function entryHtml(ins, mid) {
  const e = ins?.entry;
  if (!e) return '';
  const vs = mid ? (mid - e.price) / e.price : null;
  const when = e.from ? (e.from === e.to ? fmtDay(e.from) : `${fmtDay(e.from)}–${fmtDay(e.to)}`) : '';
  const age = e.to ? Math.max(0, Math.round((Date.now() - Date.parse(e.to + 'T00:00:00Z')) / 864e5)) : null;
  return `<div class="pk-entry">
    <div><small>Insiders bought at</small><b>~$${e.price.toLocaleString('en-US', { maximumFractionDigits: e.price < 10 ? 4 : 2 })}</b><em>${e.source === 'chart' ? 'estimate: average Hyperliquid price on the report dates' : 'as stated by Nansen Agent, unverified'}</em></div>
    ${mid ? `<div><small>Price now</small><b>$${mid.toLocaleString('en-US', { maximumFractionDigits: mid < 10 ? 4 : 2 })}</b><em class="${vs >= 0 ? 'pos' : 'neg'}">${pct(vs, 1)} vs insiders</em></div>` : ''}
    ${when ? `<div><small>Reported</small><b>${when}</b><em class="${age <= 5 ? 'pos' : age > 14 ? 'neg' : ''}">${age === 0 ? 'today' : age === 1 ? '1 day ago' : `${age} days ago`}${age > 14 ? ' · stale' : age <= 5 ? ' · fresh' : ''}</em></div>` : ''}
  </div>`;
}

// ---- Insider Pick of the Day
let pickData = null, pickCollapsedByLink = false, pickTimer = null;
const pickOpenPref = () => store.get('fof_pick_open') === '1';
function collapsePick() { store.set('fof_pick_open', '0'); if (pickData) renderPick(); }
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
    clearTimeout(pickTimer); pickTimer = setTimeout(loadPick, 20e3); return;
  }
  const p = r.pick, live = r.status === 'ready';
  const ticker = p.coin.split(':').pop();
  const inIt = r.myOpen > 0;
  if (!pickOpenPref() || pickCollapsedByLink) {
    const e = p.insider.entry, vs = e && r.mid ? (r.mid - e.price) / e.price : null;
    box.innerHTML = `<button class="pick-bar${live ? '' : ' old'}" aria-expanded="false">
      <span class="pb-label">${MAG}<b>${live ? 'Insider Pick' : "Yesterday's pick"}</b><small>Nansen Agent</small></span>
      <span class="pb-id"><span class="side ${p.side}">${p.side.toUpperCase()}</span><b>${esc(ticker)}</b></span>
      <span class="rq-sig ${p.insider.signal}">${SIG_TXT[p.insider.signal]}</span>
      ${vs != null ? `<span class="pb-vs ${vs >= 0 ? 'pos' : 'neg'}">${pct(vs, 1)} vs insiders</span>` : ''}
      ${inIt ? '<span class="pb-in">You\'re in · see My bets</span>' : ''}
      <span class="pb-open">View</span></button>`;
    box.querySelector('.pick-bar').onclick = () => { pickCollapsedByLink = false; store.set('fof_pick_open', '1'); sfx.tick(); renderPick(); };
    return;
  }
  const conv = Array.from({ length: 5 }, (_, i) => `<i class="${i < p.conviction ? 'on' : ''}"></i>`).join('');
  const facts = [['Earnings', p.earnings], ['Valuation', p.valuation], ['Risks', p.risks]].filter(([, v]) => usable(v));
  box.innerHTML = `<article class="pick${live ? '' : ' old'}">
    <button class="pk-hide" aria-label="Hide the Insider Pick">Hide ▴</button>
    <div class="pk-ribbon">${live ? 'Insider Pick of the Day' : "Yesterday's Insider Pick · today's screen is coming"}</div>
    <div class="pk-ai"><b>AI-generated research, for a play-money hand.</b> Nansen Agent screened Hyperliquid's listed stocks and wrote everything below, including the numbers. It has not been checked by a person, it is <b>not a recommendation to buy or sell anything</b>, and the only thing you can do with it here is bet play chips on which way it goes.</div>
    <div class="pk-top">
      <div class="pk-id"><span class="side ${p.side}">${p.side.toUpperCase()}</span><span class="coin">${coinHtml(p.coin)}</span><span class="pk-co">${esc(p.company || '')}</span></div>
      <div class="pk-px"><small>since the pick</small><b class="${(r.move ?? 0) >= 0 ? 'pos' : 'neg'}">${r.move == null ? '–' : pct(r.move, 2)}</b></div>
    </div>
    <div class="pk-sig"><span class="rq-sig ${p.insider.signal}">${SIG_TXT[p.insider.signal]}</span><span class="pk-conv" title="How confident Nansen Agent said it was in its own screen: ${p.conviction}/5. It is the model rating itself, not a measure of how likely the trade is to work.">Agent's own confidence ${conv}</span></div>
    ${p.insider.detail ? `<p class="pk-detail">${esc(p.insider.detail)}</p>` : ''}
    ${entryHtml(p.insider, r.mid)}
    ${p.thesis ? `<p class="pk-thesis">${esc(p.thesis)}</p>` : ''}
    <details class="pk-more"><summary>Full research</summary>
      ${p.thesis ? `<p class="pk-thesis m">${esc(p.thesis)}</p>` : ''}
      <dl class="rq-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${p.runnersUp?.length ? `<div class="pk-runners"><small>Runners-up</small>${p.runnersUp.map((x) => `<span><b>${esc(x.ticker)}</b> ${esc(x.why || '')}</span>`).join('')}</div>` : ''}
    </details>
    ${live ? `<div class="pk-bet">
      <div class="pk-hz-title">How long do you hold? <span>Insiders can't sell for a profit within 6 months (SEC short-swing rule), and most of the move after insider buying builds over months.</span></div>
      <div class="horizons pk-hz">${(r.horizons || [7, 30, 180]).map((d) => `<button class="hz${d === 30 ? ' on' : ''}" data-days="${d}"><b>${{ 7: '1 Week', 30: '1 Month', 180: '6 Months' }[d] || d + ' days'}</b><small>${{ 7: 'quick read', 30: 'the sweet spot', 180: 'insider clock' }[d] || ''}</small></button>`).join('')}</div>
      <div class="lstake"><input type="number" min="1" value="500" aria-label="Stake"><button class="minichip" data-add="100">100</button><button class="minichip g" data-add="500">500</button><button class="minichip r" data-add="1000">1K</button><button class="minichip k" data-add="all">ALL</button></div>
      <div class="actions"><button class="bet follow" data-choice="follow"><span>FOLLOW</span><small>x${r.odds.follow.toFixed(2)}</small></button><button class="bet fade" data-choice="fade"><span>FADE</span><small>x${r.odds.fade.toFixed(2)}</small></button></div>
    </div>` : ''}
    <div class="links"><span class="pk-src">Nansen Agent Expert · ${p.screened ? `${p.screened} Hyperliquid stocks screened` : 'Hyperliquid stocks'}${p.tools?.length ? ` · ${p.tools.filter((x) => x.startsWith('stocks_')).length} stock data tools` : ''}. Generated by an AI model and not verified by a person. Not financial advice.</span><a class="trade-nansen" href="${nansenTrade(p.coin)}" target="_blank" rel="noopener">Look up ${esc(ticker)} on Nansen ↗</a></div>
  </article>`;
  const card = box.querySelector('.pick'), input = card.querySelector('input');
  card.querySelector('.pk-hide').onclick = () => { sfx.tick(); collapsePick(); };
  card.querySelectorAll('.pk-hz .hz').forEach((h) => h.onclick = () => { card.querySelectorAll('.pk-hz .hz').forEach((x) => x.classList.toggle('on', x === h)); sfx.tick(); });
  card.querySelectorAll('[data-add]').forEach((c) => c.onclick = () => {
    input.value = c.dataset.add === 'all' ? Math.floor(player.bankroll) : Math.min(Math.floor(player.bankroll), Number(c.dataset.add));
    sfx.chip(); if (c.dataset.add === 'all') sparkleAt(c, 20);
  });
  card.querySelectorAll('.bet').forEach((btn) => btn.onclick = async () => {
    if (card.dataset.busy) return;
    const stake = Math.floor(Number(input.value)), choice = btn.dataset.choice;
    const days = Number(card.querySelector('.pk-hz .hz.on')?.dataset.days || 30);
    if (!(stake >= 1) || stake > player.bankroll) return toast('Stake must be between $1 and your bankroll');
    const tmp = { id: 'tmp-' + Math.random().toString(36).slice(2), pending: true, coin: p.coin, whaleSide: p.side, choice, stake, price: r.odds[choice], entry: r.mid, placedAt: Date.now(), settleAt: Date.now() + days * 864e5, minutes: days * 1440, pickDays: days, pick: true, status: 'open' };
    card.dataset.busy = '1'; card.querySelectorAll('.bet').forEach((x) => (x.disabled = true));
    pending.push(tmp); renderLanes(); player.bankroll -= stake; renderPlayer(); sfx.bet(); sparkleAt(btn, 26);
    try {
      const b = await api('/api/research/pick/bet', { player: player.id, choice, stake, days });
      prevStatus.set(b.id, 'open');
      pending = pending.filter((x) => x !== tmp); lastBets = [b, ...lastBets]; renderLanes(); sfx.chip();
      pickData.myOpen = (pickData.myOpen || 0) + 1; collapsePick();
      toast(`Chips down on the Insider Pick: ${choice === 'follow' ? 'following' : 'fading'} ${ticker} for ${usd(stake)}, settles in ${days === 7 ? '1 week' : days === 30 ? '1 month' : '6 months'}`);
      nudgeBets(); pollBets();
    } catch (e) { pending = pending.filter((x) => x !== tmp); renderLanes(); player.bankroll += stake; renderPlayer(); toast(e.message); }
    delete card.dataset.busy; card.querySelectorAll('.bet').forEach((x) => (x.disabled = false));
  });
}


// ================================================= section intros ("what question does this page answer?")
const INTROS = {
  replay: { kicker: 'Training Table', q: 'Was the whale right?', go: 'Deal me in',
    steps: ['You get a real Smart Money trade from this week, at the <b>whale\'s exact entry</b>. The wallet and the ending are hidden.',
      'Read Nansen\'s tells: the whale\'s track record, Smart Money flow, the crowd and funding.',
      '<b>Follow</b> if you think the whale was right, <b>Fade</b> if not. It\'s judged on when the whale really closed.',
      'After every hand you see which signal called it, and which one was the trap.'],
    how: 'Entry: <b>the whale\'s price</b> · Judged on: <b>the whale\'s real exit</b>' },
  live: { kicker: 'Live Floor', q: 'Follow or fade real positions, open right now', go: 'Take me to the floor',
    steps: ['Whales who opened in the last 6 hours and <b>still hold the position</b>, graded A+ to F by their Nansen track record.',
      'You enter at <b>today\'s price</b>, like copying the trade for real. Each card shows how far the whale is already up or down.',
      '<b>Ride the Whale</b>: your bet ends when the whale closes their position, not on a timer. <b>Cash out any time</b> — and knowing when to get out is the skill.',
      'Plus the <b>Insider Pick</b>: a stock where company insiders are buying, held 1 week to 6 months.'],
    how: 'Entry: <b>today\'s price</b> · Judged on: <b>the whale\'s real exit</b>' },
  report: { kicker: 'Trader Profile', q: 'How well do you actually read Smart Money?', go: 'Show my profile',
    steps: ['Every Training hand, Ride the Whale bet and Insider Pick is analysed.',
      'Seven named skills, each scored 0–100 against <b>what the odds expected of you</b> — 50 means you read those hands as well as the data did.',
      'Levels are earned by beating the odds, never by playing more hands: <b>Rookie</b> → <b>Market Operator</b>.'],
    how: 'Play money only. Build the skill here, then decide what to do with it.' },
};
const introSeen = (v) => store.get('fof_intro_' + v) === '1';
let introOpen = false, suppressIntro = false;
/** Split the steps into exactly three pages, any remainder going to the last one (4 -> 1,1,2). */
function introPages(steps) {
  const n = steps.length;
  if (n <= 3) return steps.map((x) => [x]).concat(Array(Math.max(0, 3 - n)).fill([])).slice(0, 3).filter((g, i) => i < Math.max(3, n));
  const per = Math.floor(n / 3);
  return [steps.slice(0, per), steps.slice(per, per * 2), steps.slice(per * 2)];
}
let introState = null;   // { view, pages, i, go } while a first-time intro is being stepped through
/**
 * First visit walks the intro three screens at a time, so nobody is handed a wall of text; the "?"
 * reopens it (force) as the single page it has always been.
 */
function showIntro(view, { force = false } = {}) {
  const it = INTROS[view];
  if (!it || introOpen || (!force && (introSeen(view) || suppressIntro))) return;
  if ($('welcome').open) return;
  introOpen = true;
  $('introKicker').textContent = it.kicker;
  $('introQ').textContent = it.q;
  $('introHow').innerHTML = it.how;
  document.querySelectorAll('.intro-compare [data-sec]').forEach((d) => d.classList.toggle('on', d.dataset.sec === view));
  const o = $('introOverlay');
  if (force) {
    introState = null;
    o.classList.remove('stepped');
    $('introSteps').style.counterReset = '';
    $('introSteps').innerHTML = it.steps.map((x) => `<li>${x}</li>`).join('');
    $('introGo').textContent = it.go;
    $('introDots').innerHTML = '';
  } else {
    const pages = introPages(it.steps).filter((g) => g.length);
    const offsets = []; let run = 0;
    for (const g of pages) { offsets.push(run); run += g.length; }
    introState = { view, pages, offsets, i: 0, go: it.go };
    o.classList.add('stepped');
    paintIntroPage();
  }
  o.hidden = false; o.classList.remove('show'); void o.offsetWidth; o.classList.add('show');
  sfx.deal();
}
function paintIntroPage() {
  const st = introState; if (!st) return;
  const last = st.i === st.pages.length - 1;
  const ol = $('introSteps');
  // the badges are a CSS counter, which would restart at 1 on every screen: continue the real numbering
  ol.style.counterReset = 's ' + (st.offsets[st.i] || 0);
  ol.innerHTML = st.pages[st.i].map((x) => `<li>${x}</li>`).join('');
  $('introGo').textContent = last ? st.go : 'Next';
  $('introHow').hidden = !last;                     // the summary line belongs on the closing screen
  document.querySelector('.intro-compare')?.toggleAttribute('hidden', !last);
  $('introDots').innerHTML = st.pages.map((_, i) =>
    `<i class="${i === st.i ? 'on' : ''}"${i < st.i ? ' data-done="1"' : ''}></i>`).join('');
}
function introNext() {
  if (!introState) return closeIntro();
  if (introState.i < introState.pages.length - 1) { introState.i++; paintIntroPage(); sfx.tick(); return; }
  closeIntro();
}
function closeIntro() {
  const o = $('introOverlay');
  document.querySelectorAll('.intro-compare [data-sec].on').forEach((d) => store.set('fof_intro_' + d.dataset.sec, '1'));
  o.hidden = true; o.classList.remove('stepped'); introOpen = false; introState = null;
  $('introSteps').style.counterReset = '';
  $('introHow').hidden = false;
  document.querySelector('.intro-compare')?.removeAttribute('hidden');
  sfx.chip();
}
// The arrival flourish belongs on the button that actually starts the game, not on whatever the
// visitor happened to touch first — and it must be fired from inside the click, or a phone drops it.
$('introGo').onclick = () => {
  const finishing = !introState || introState.i === introState.pages.length - 1;
  if (finishing && store.get('fof_welcomed') !== '1' && !isMuted()) {
    store.set('fof_welcomed', '1');
    sfx.welcome();                                  // async inside: it awaits the audio unlock itself
  }
  introNext();
};
$('introOverlay').addEventListener('click', (e) => { if (e.target === $('introOverlay')) closeIntro(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && introOpen) closeIntro(); });
// the small "?" next to each section title reopens its intro
document.querySelectorAll('[data-intro]').forEach((b) => b.addEventListener('click', () => showIntro(b.dataset.intro, { force: true })));
// show each intro the first time a section is opened
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  const v = t.dataset.view;
  if (v === 'live') setTimeout(() => showIntro('live'), liveShownOnce && !$('floorIntro').hidden ? 2400 : 400);
  else setTimeout(() => showIntro(v), 250);
}));


// ================================================= re-check one whale (from a Telegram alert, minutes later)
/** What the numbers were when the alert went out, so "what changed" is measured from there. */
function alertBaseline(key) {
  const a = alertsCache.find((x) => !x.kind && x.key === key);
  if (!a) return null;
  // a.base is frozen at send time; a.read is overwritten by every re-check, so it is not a baseline
  const b = a.base || {};
  return { at: b.at ?? a.t, pFollow: b.pFollow ?? null, entry: b.mid ?? a.entryPrice ?? null, label: `the alert ${ago(new Date(b.at ?? a.t).toISOString())}` };
}
async function recheckCard(card) {
  const key = card.dataset.key;
  const btn = card.querySelector('[data-refresh]');
  const before = liveItems.get(key);
  const base = alertBaseline(key) || (before ? { at: before.seenAt || Date.now(), pFollow: before.pFollow, entry: before.mid, label: 'you opened this card' } : null);
  if (btn) { btn.disabled = true; btn.textContent = '↻ Checking…'; }
  try {
    const t = await api('/api/live/one?key=' + encodeURIComponent(key));
    const box = card.querySelector('.lc-changed');
    const lines = [];
    if (base) {
      if (base.entry != null) {
        // `move` is the trade's P&L since the baseline, already flipped for the side. It said
        // "in the whale's favour" whatever the sign — which was flatly wrong on a losing move, and on a
        // short it hid the fact that the price had gone the other way. Say both, and name the baseline.
        const raw = (t.mid - base.entry) / base.entry;
        const move = (t.side === 'Long' ? 1 : -1) * raw;
        const side = t.side.toLowerCase();
        lines.push(`${esc(t.coin)} is <b>${raw >= 0 ? 'up' : 'down'} ${Math.abs(raw * 100).toFixed(2)}%</b> since ${esc(base.label)} — `
          + `<span class="${move >= 0 ? 'pos' : 'neg'}">${Math.abs(move * 100).toFixed(2)}% ${move >= 0 ? `in this ${side}'s favour` : `against this ${side}`}</span>`);
      }
      if (base.pFollow != null) {
        const d = t.pFollow - base.pFollow;
        lines.push(`Follow odds ${Math.round(base.pFollow * 100)}% → <b>${Math.round(t.pFollow * 100)}%</b>${Math.abs(d) < 0.005 ? ' (unchanged)' : d > 0 ? ' <span class="pos">▲</span>' : ' <span class="neg">▼</span>'}`);
      }
    }
    lines.push(t.gone ? '<b class="neg">The whale has closed this position.</b>'
      : t.trimmed >= 0.1 ? `<b class="neg">The whale trimmed ${Math.round(t.trimmed * 100)}%</b> of the position`
      : '<b class="pos">The whale is still in the trade</b>');
    if (liveCache) { // otherwise the next render redraws the card from the pre-re-check copy
      const i = liveCache.items.findIndex((x) => x.key === key);
      if (t.gone) { if (i >= 0) liveCache.items.splice(i, 1); }
      else if (i >= 0) liveCache.items[i] = t;
    }
    const expanded = card.classList.contains('expanded');
    const lit = card.classList.contains('spotlight'); // arriving from an alert: keep the "this one" glow
    const wrap = document.createElement('div');
    wrap.innerHTML = liveCard(t);
    const fresh = wrap.firstElementChild;
    card.replaceWith(fresh);
    if (expanded) fresh.classList.add('expanded');
    if (lit) focusCard(fresh); // the element was replaced; keep the spotlight on the new one
    wireLive();
    const nbox = fresh.querySelector('.lc-changed');
    nbox.innerHTML = `<b>Re-checked just now</b>${lines.map((l) => `<span>${l}</span>`).join('')}`;
    nbox.hidden = false;
    fresh.classList.add('rechecked'); setTimeout(() => fresh.classList.remove('rechecked'), 1500);
    sfx.tick();
  } catch (e) {
    toast(e.message);
    if (e.status === 410) { card.classList.add('gone'); setTimeout(() => card.remove(), 450); }
    if (btn) { btn.disabled = false; btn.textContent = '↻ Re-check'; }
  }
}

$('alertClear').onclick = () => {
  store.set('fof_alerts_cleared', String(Date.now()));
  store.set('fof_alerts_seen', String(Date.now()));
  renderAlertList(); updateBadge(); sfx.tick();
};
