// The alert scorecard page. Reads /api/scorecard and draws it; no state, no storage.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 2) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const cls = (x) => (x == null ? 'dim' : x > 0 ? 'pos' : x < 0 ? 'neg' : 'dim');
const usd = (x) => (x == null ? 'n/a' : '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x));
const px = (x) => (x == null ? 'n/a' : x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 1 }) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));
const gcls = (g) => ({ 'A+': 'ga', A: 'ga', B: 'gb', C: 'gc', D: 'gd', F: 'gf' }[g] || 'gb');
const day = (iso) => { const d = new Date(iso); return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' ' + d.toISOString().slice(11, 16); };
const hrs = (h) => (h == null ? 'n/a' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
const ROUTE = { standard: 'house rules', specialist: 'specialist', leaderboard: 'leaderboard', early: 'early finder', printer: 'printer' };

function groupTable(title, groups, label = (k) => k) {
  const rows = Object.entries(groups || {}).filter(([, g]) => g.closed).sort((a, b) => b[1].closed - a[1].closed);
  if (!rows.length) return '';
  return `<h2>${esc(title)}</h2><div class="tbl-wrap"><table><thead><tr><th>Group</th><th>Closed</th><th>Won</th><th>Average</th><th>Median</th></tr></thead><tbody>
    ${rows.map(([k, g]) => `<tr><td>${esc(label(k))}</td><td>${g.closed}</td><td>${Math.round(g.winRate * 100)}%</td>
      <td class="${cls(g.avgRet)}">${pct(g.avgRet)}</td><td class="${cls(g.medianRet)}">${pct(g.medianRet)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

async function main() {
  let d;
  try { const r = await fetch('/api/scorecard'); d = await r.json(); if (!r.ok) throw new Error(d.error || r.status); }
  catch (e) { $('app').innerHTML = `<p class="err">Could not load the alerts: ${esc(e.message)}</p>`; return; }
  const s = d.summary;
  let h = '';
  if (!s.closed) {
    h += `<div class="card hero"><div class="q">No alert has closed yet.</div><p class="note" style="margin:auto">${s.open} open, marked below as the whale holds.</p></div>`;
  } else {
    const ci = s.lo != null ? `95% interval ${pct(s.lo)} to ${pct(s.hi)}, grouped by wallet` : 'too few wallets for an interval yet';
    h += `<div class="card hero">
      <div class="q">If you had copied every alert the moment it landed</div>
      <div class="big ${s.avgRet >= 0 ? 'pos' : 'neg'}">${pct(s.avgRet)}</div>
      <div class="ci">average per alert at 1x &middot; ${ci}</div>
      <div class="tiles" style="max-width:640px;margin:22px auto 0">
        <div class="tile"><small>Alerts closed</small><b>${s.closed}<span class="u">of ${s.alerts}</span></b></div>
        <div class="tile"><small>Won</small><b>${Math.round(s.winRate * 100)}%</b></div>
        <div class="tile"><small>Median</small><b class="${cls(s.medianRet)}">${pct(s.medianRet)}</b></div>
        <div class="tile"><small>Whale's own, same trades</small><b class="${cls(s.whaleAvgRet)}">${pct(s.whaleAvgRet)}</b></div>
      </div>
      <p class="note" style="margin:14px auto 0">The gap between the last two numbers is the cost of arriving late: the whale
      filled first, and the alert could only offer the price that was left. ${s.untracked ? `${s.untracked} alert${s.untracked === 1 ? '' : 's'} lost tracking before the whale's exit and ${s.untracked === 1 ? 'is' : 'are'} left out.` : ''}</p>
      <div class="share" style="justify-content:center">
        <a class="btn gold" id="shareX" target="_blank" rel="noopener">Share on X</a>
        <a class="btn" href="https://t.me/fadefollowbot" target="_blank" rel="noopener">Get the alerts on Telegram</a>
      </div>
    </div>`;
  }
  h += groupTable('By grade at the time', d.byGrade);
  h += groupTable('By how the whale got in', d.byRoute, (k) => ROUTE[k] || k);
  h += `<h2>Every alert</h2><p class="note">Newest first. Price at alert is the mark when it was sent. Result is yours from there to the whale's exit; open ones are marked to now and do not count yet. A ~ exit is the mark when we saw the position gone, not a matched fill.</p>
  <div class="tbl-wrap"><table class="wide"><thead><tr><th>Sent (UTC)</th><th class="l">Whale</th><th>Call</th><th>Grade</th><th>At alert</th><th>Exit</th><th>Held</th><th>Result</th></tr></thead><tbody>
  ${d.alerts.map((a) => {
    const res = a.status === 'closed' ? `<b class="${cls(a.ret)}">${pct(a.ret)}</b>` : a.status === 'open' ? `<span class="row-tag open">open ${pct(a.openRet)}</span>` : '<span class="row-tag">lost track</span>';
    const exit = a.status === 'closed' ? `${a.exitExact ? '' : '~'}${px(a.exitPx)}` : a.status === 'open' ? `<span class="dim">${px(a.markPx)}</span>` : 'n/a';
    return `<tr><td class="nw">${esc(day(a.at))}</td><td class="l"><a href="/w/${esc(a.address)}">${esc(a.trader)}</a></td>
      <td class="${a.side === 'Short' ? 'neg' : 'pos'}">${esc(a.side === 'Short' ? 'SHORT' : 'LONG')} ${esc(String(a.coin).replace(/^\w+:/, ''))} <span class="dim">${usd(a.valueUsd)}</span></td>
      <td><span class="grade ${gcls(a.grade)}">${esc(a.grade || '?')}</span></td>
      <td>${px(a.priceAtAlert)}</td><td>${exit}</td><td>${hrs(a.heldHours)}</td><td>${res}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="dim">No alerts yet.</td></tr>'}
  </tbody></table></div>
  <p class="note">${esc(d.method)} Raw rows: <a href="/api/scorecard">/api/scorecard</a>.</p>`;
  $('app').innerHTML = h;
  const x = $('shareX');
  if (x) {
    const text = `If you had copied every Smart Money whale alert the moment it landed: ${pct(s.avgRet)} per alert at 1x, ${Math.round(s.winRate * 100)}% won, ${s.closed} closed. Scored in public, play money.`;
    x.href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(location.origin + '/scorecard');
  }
}
main();
