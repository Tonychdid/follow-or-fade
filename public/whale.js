// One whale's share page. Reads /api/whale and draws it; no state, no storage.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const cls = (x) => (x == null ? 'dim' : x > 0 ? 'pos' : x < 0 ? 'neg' : 'dim');
const usd = (x) => (x == null ? 'n/a' : (x < 0 ? '-$' : '$') + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(x)));
const px = (x) => (x == null ? 'n/a' : x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 1 }) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));
const gcls = (g) => ({ 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[g] || 'gb');
const day = (iso) => { const d = new Date(iso); return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' ' + d.toISOString().slice(11, 16); };
const coinName = (c) => String(c || '').replace(/^\w+:/, '');

function recordTiles(title, r) {
  if (!r || r.closed == null) return '';
  if (!r.closed) return `<div class="card"><h2 style="margin-top:0">${esc(title)}</h2><p class="note">No closed trades in this window.</p></div>`;
  return `<div class="card"><h2 style="margin-top:0">${esc(title)}</h2><div class="tiles">
    <div class="tile"><small>Return</small><b class="${cls(r.roi)}">${pct(r.roi)}</b></div>
    <div class="tile"><small>Realized PnL</small><b class="${cls(r.pnl)}">${usd(r.pnl)}</b></div>
    <div class="tile"><small>Won</small><b>${r.winRate == null ? 'n/a' : Math.round(r.winRate * 100) + '%'}</b></div>
    <div class="tile"><small>Closes</small><b>${r.closed}</b></div>
    <div class="tile"><small>Coins</small><b>${r.coins ?? 'n/a'}</b></div>
  </div></div>`;
}

async function main() {
  const address = document.body.dataset.address;
  let w;
  try { const r = await fetch('/api/whale?address=' + encodeURIComponent(address)); w = await r.json(); if (!r.ok) throw new Error(w.error || r.status); }
  catch (e) {
    $('app').innerHTML = `<h1>Smart Money wallet</h1><p class="addr">${esc(address)}</p><p class="err">${esc(e.message)}</p>
      <p class="lede">This page shows a wallet once it has been on the Live Floor, the whale board or an alert. <a href="/">Play a hand instead &rarr;</a></p>`;
    return;
  }
  const tags = Object.entries(w.tags || {}).filter(([, v]) => v).map(([k]) => `<span class="row-tag">${esc(k.toUpperCase())}</span>`).join(' ');
  let h = `<div class="who"><h1 style="margin:0">${esc(w.trader)}</h1>${w.grade ? `<span class="grade ${gcls(w.grade)}" title="${esc(w.label || '')}">${esc(w.grade)}</span>` : ''} ${tags}</div>
    <p class="addr">${esc(w.address)}</p>
    <p class="sub" style="margin-bottom:10px">${esc(w.marketMaker ? 'Trades like a market maker: winning almost every close is spread, not direction.' : w.label || 'A Nansen Smart Money wallet on Hyperliquid.')}</p>`;
  for (const p of w.live || []) {
    h += `<div class="card pos-card">
      <div><div class="side ${esc(p.side)}">${p.side === 'Short' ? 'SHORT' : 'LONG'} ${esc(coinName(p.coin))} <span class="dim" style="font-family:var(--mono);font-weight:400">${usd(p.valueUsd)}</span></div>
        <div class="note" style="margin-top:4px">Open now · entry ${px(p.entryPrice)} · price now ${px(p.mid)} · <span class="${cls(p.moveSinceEntry)}">${pct(p.moveSinceEntry, 2)}</span> for the whale</div></div>
      <a class="btn gold" href="/?view=live&trade=${encodeURIComponent(p.key)}">Follow or fade it</a>
    </div>`;
  }
  h += `<div class="split">${recordTiles('Last 30 days', w.d30)}${recordTiles('Last 7 days', w.d7)}</div>`;
  const s = w.scorecard?.summary;
  const al = w.scorecard?.alerts || [];
  if (al.length) {
    h += `<h2>Alerts on this whale</h2>
      <p class="note">${s.closed ? `${s.wins} of ${s.closed} closed alerts won for someone who copied at the alert price.` : 'None of them has closed yet.'} <a href="/scorecard">Every alert &rarr;</a></p>
      <div class="tbl-wrap"><table><thead><tr><th>Sent (UTC)</th><th>Call</th><th>Grade</th><th>At alert</th><th>Result</th></tr></thead><tbody>
      ${al.map((a) => `<tr><td class="nw">${esc(day(a.at))}</td><td class="${a.side === 'Short' ? 'neg' : 'pos'}">${a.side === 'Short' ? 'SHORT' : 'LONG'} ${esc(coinName(a.coin))}</td>
        <td><span class="grade ${gcls(a.grade)}">${esc(a.grade || '?')}</span></td><td>${px(a.priceAtAlert)}</td>
        <td>${a.status === 'closed' ? `<b class="${cls(a.ret)}">${pct(a.ret, 2)}</b>` : a.status === 'open' ? `<span class="row-tag open">open ${pct(a.openRet, 2)}</span>` : '<span class="row-tag">lost track</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  h += `<div class="share">
      <a class="btn gold" id="shareX" target="_blank" rel="noopener">Share this whale on X</a>
      <button class="btn" id="copyLink" type="button">Copy link</button>
      <a class="btn" href="${esc(w.nansenUrl)}" target="_blank" rel="noopener">Open on Nansen &#8599;</a>
    </div>`;
  $('app').innerHTML = h;
  const link = location.origin + '/w/' + w.address;
  const now = (w.live || [])[0];
  const text = now
    ? `A Nansen Smart Money whale${w.grade ? ` (grade ${w.grade})` : ''} is ${now.side === 'Short' ? 'short' : 'long'} ${coinName(now.coin)} ${usd(now.valueUsd)} right now. Would you follow or fade?`
    : `A Nansen Smart Money whale${w.grade ? `, grade ${w.grade}` : ''}${w.d30?.roi != null ? `, ${pct(w.d30.roi)} over 30 days` : ''}. Would you follow or fade?`;
  $('shareX').href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(link);
  $('copyLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); $('copyLink').textContent = 'Copied'; } catch { $('copyLink').textContent = link; }
  });
}
main();
