// The proof desk. Split out of proof.html because the site's Content-Security-Policy allows
// scripts only from 'self' - and weakening the policy for one page would be a worse trade than
// a second file.
const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => (x == null ? ', ' : (x * 100).toFixed(d) + '%');
const sgn = (x, d = 1) => (x == null ? ', ' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n) => (n == null ? ', ' : Number(n).toLocaleString('en-US'));
// A gap between two rates is measured in percentage POINTS, not percent: same scaling as sgn(),
// different unit. Scaling again here is how +2.7pp becomes a nonsensical +267.2%pp.
const sgnPP = (x, d = 1) => (x == null ? ', ' : sgn(x, d).replace('%', 'pp'));

const tip = $('tip');
function bindTip(el, html) {
  el.addEventListener('mouseenter', (e) => { tip.innerHTML = html; tip.style.opacity = '1'; move(e); });
  el.addEventListener('mousemove', move);
  el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  function move(e) {
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + pad) + 'px';
    tip.style.top = Math.max(8, e.clientY - h - pad) + 'px';
  }
}

/**
 * The reliability chart. One row per probability bucket: a tick where the model said the side would
 * land, a dot where it actually landed, and the distance between them drawn as the thing you are
 * meant to look at. A whisker on the dot carries the binomial 95% interval, because "actual 77%"
 * off 30 hands and off 3,000 hands are not the same sentence.
 *
 * The connector only takes a colour when the miss is bigger than that interval - i.e. when it is
 * unlikely to be luck. Every row is also labelled in words and numbers, so nothing here is carried
 * by colour alone.
 */
function reliabilityChart(rows) {
  const live = rows.filter((r) => r.n > 0);
  if (!live.length) return '<p class="dim">No scored predictions in this set yet.</p>';
  const L = 66, R = 74, T = 26, rowH = 46, H = T + live.length * rowH + 30, W = 700;
  const x = (p) => L + p * (W - L - R);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted versus actual win rate by probability bucket">`;
  for (let g = 0; g <= 100; g += 25) {
    s += `<line class="gridline" x1="${x(g / 100)}" y1="${T - 8}" x2="${x(g / 100)}" y2="${T + live.length * rowH - 12}"/>`;
    s += `<text class="ax" x="${x(g / 100)}" y="${T - 14}" text-anchor="middle">${g}%</text>`;
  }
  live.forEach((r, i) => {
    const y = T + i * rowH + rowH / 2 - 8;
    const xp = x(r.predicted), xa = x(r.actual);
    const ci = 1.96 * r.se, miss = r.actual - r.predicted, real = Math.abs(miss) > ci;
    const col = real ? 'var(--ruby)' : 'rgba(243,234,215,.3)';
    s += `<rect class="rowhl" x="0" y="${y - rowH / 2 + 4}" width="${W}" height="${rowH - 6}"/>`;
    s += `<text class="rowlbl" x="0" y="${y + 4}">${(r.lo * 100).toFixed(0)}&ndash;${(r.hi * 100).toFixed(0)}%</text>`;
    s += `<line class="whisk" x1="${x(Math.max(0, r.actual - ci))}" y1="${y}" x2="${x(Math.min(1, r.actual + ci))}" y2="${y}"/>`;
    s += `<line class="conn" x1="${xp}" y1="${y}" x2="${xa}" y2="${y}" stroke="${col}"/>`;
    s += `<line class="tickP" x1="${xp}" y1="${y - 8}" x2="${xp}" y2="${y + 8}"/>`;
    s += `<circle class="dotA" cx="${xa}" cy="${y}" r="6"/>`;
    s += `<text class="gaplbl" x="${W - R + 10}" y="${y + 4}" fill="${real ? 'var(--ruby)' : 'var(--muted)'}">${
      real ? (miss >= 0 ? '+' : '') + (miss * 100).toFixed(0) + ' pts' : 'within noise'}</text>`;
    s += `<text class="ax" x="0" y="${y + 17}">n=${r.n}</text>`;
    const hit = `<rect class="hitrow" x="0" y="${y - rowH / 2 + 4}" width="${W}" height="${rowH - 6}" data-i="${i}"/>`;
    s = s.replace(`<rect class="rowhl" x="0" y="${y - rowH / 2 + 4}"`, hit + `<rect class="rowhl" x="0" y="${y - rowH / 2 + 4}"`);
  });
  s += '</svg>';
  return s;
}
function bindReliability(el, rows) {
  const live = rows.filter((r) => r.n > 0);
  el.querySelectorAll('.hitrow').forEach((h) => {
    const r = live[+h.dataset.i]; if (!r) return;
    const ci = 1.96 * r.se, miss = r.actual - r.predicted;
    bindTip(h, `<b>${(r.lo * 100).toFixed(0)}&ndash;${(r.hi * 100).toFixed(0)}% bucket</b><br>` +
      `said &nbsp;&nbsp;${pct(r.predicted)}<br>actual ${pct(r.actual)} &plusmn;${(ci * 100).toFixed(1)}<br>` +
      `over ${r.n} prediction${r.n === 1 ? '' : 's'}<br>` +
      (Math.abs(miss) > ci ? `<span style="color:var(--ruby)">off by ${(miss * 100).toFixed(1)} points, beyond the interval</span>`
                           : `<span style="color:var(--muted)">gap is inside the interval</span>`));
  });
}

/** Returns either side of zero, one bar per row. At fair odds every bar is zero-length. */
function roiBars(items, opts = {}) {
  items = items.filter((it) => it.v && it.v.n);
  if (!items.length) return '<p class="dim">Not enough settled hands yet.</p>';
  const cap = Math.max(0.05, ...items.map((it) => Math.abs(it.v.roi) + 1.96 * it.v.se)) * 1.15;
  const L = opts.labelW || 150, R = 86, W = 700, rowH = 58, T = 22, H = T + items.length * rowH + 22;
  const x = (v) => L + ((v + cap) / (2 * cap)) * (W - L - R);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.alt || 'Return per hand')}">`;
  s += `<line class="zeroline" x1="${x(0)}" y1="${T - 6}" x2="${x(0)}" y2="${T + items.length * rowH - 6}"/>`;
  s += `<text class="ax" x="${x(0)}" y="${T - 12}" text-anchor="middle">0%, fair odds</text>`;
  items.forEach((it, i) => {
    const v = it.v, y = T + i * rowH + 14;
    // Emerald above zero, ruby below - and every bar also carries its signed number and a row label,
    // so nothing here is readable only by colour.
    const col = it.mute ? 'rgba(243,234,215,.32)' : v.roi >= 0 ? 'var(--emerald)' : 'var(--ruby)';
    const x0 = Math.min(x(0), x(v.roi)), w = Math.abs(x(v.roi) - x(0));
    s += `<text class="rowlbl" x="0" y="${y + 13}" ${it.hero ? 'style="fill:var(--gold-l);font-weight:700"' : ''}>${esc(it.label)}</text>`;
    s += `<rect class="bar" x="${x0}" y="${y}" width="${Math.max(2, w)}" height="18" fill="${col}" opacity="${it.mute ? '.6' : '.88'}"/>`;
    s += `<line class="whisk" x1="${x(v.roi - 1.96 * v.se)}" y1="${y + 9}" x2="${x(v.roi + 1.96 * v.se)}" y2="${y + 9}"/>`;
    s += `<text class="gaplbl" x="${W - R + 10}" y="${y + 13}" fill="${col}">${sgn(v.roi, 2)}</text>`;
    s += `<text class="ax" x="0" y="${y + 30}">${esc(it.sub || `${v.n} hands`)}</text>`;
    s += `<rect class="hitrow" x="0" y="${y - 8}" width="${W}" height="${rowH - 6}" data-s="${i}"/>`;
  });
  s += '</svg>';
  return s;
}
function bindBars(el, items) {
  items = items.filter((it) => it.v && it.v.n);
  el.querySelectorAll('.hitrow').forEach((h) => {
    const it = items[+h.dataset.s]; if (!it) return;
    const v = it.v, sig = Math.abs(v.roi) > 1.96 * v.se;
    bindTip(h, `<b>${esc(it.label)}</b><br>${sgn(v.roi, 2)} per hand staked<br>` +
      `95% interval ${sgn(v.roi - 1.96 * v.se, 2)} to ${sgn(v.roi + 1.96 * v.se, 2)}<br>` +
      `over ${num(v.n)} settled hands<br>` +
      (sig ? `<span style="color:var(--gold-l)">clear of zero</span>`
           : `<span style="color:var(--muted)">not distinguishable from fair odds</span>`));
  });
}

const relTable = (rows) => `<table><thead><tr><th>Bucket</th><th>Predictions</th><th>Model said</th><th>Actually won</th><th>Gap</th></tr></thead><tbody>${
  rows.filter((r) => r.n).map((r) => { const m = r.actual - r.predicted, real = Math.abs(m) > 1.96 * r.se;
    return `<tr><td>${(r.lo * 100).toFixed(0)}&ndash;${(r.hi * 100).toFixed(0)}%</td><td>${r.n}</td><td>${pct(r.predicted)}</td><td>${pct(r.actual)} <span class="dim">&plusmn;${(1.96 * r.se * 100).toFixed(1)}</span></td><td class="${real ? 'neg' : 'dim'}">${sgn(m)}</td></tr>`;
  }).join('')}</tbody></table>`;

function brierBlock(b) {
  if (!b) return '<p class="dim">Not enough settled predictions to score yet.</p>';
  const better = b.score < b.reference;
  return `<div class="tiles">
    <div class="tile"><small>Brier score</small><b>${b.score.toFixed(4)}</b></div>
    <div class="tile"><small>Always guess the base rate</small><b class="dim" style="color:var(--muted)">${b.reference.toFixed(4)}</b></div>
    <div class="tile"><small>Verdict</small><b class="${better ? 'pos' : 'neg'}" style="color:${better ? 'var(--emerald)' : 'var(--ruby)'};font-size:15px">${
      better ? 'beats the base rate' : 'loses to the base rate'}</b></div>
    <div class="tile"><small>Scored on</small><b>${num(b.n)}<span class="u">hands</span></b></div>
  </div>
  <p class="note">Brier is the mean squared error of the probabilities, lower is better, zero is perfect.
  On its own it means nothing, so it sits next to the score a model gets for ignoring every Nansen
  feature and always predicting the base rate (${pct(b.baseRate)}). Beating that reference is the
  only thing that shows the features are doing work.</p>`;
}

function panel(tag, tagClass, title, blurb, data, kind) {
  const id = 'p' + Math.random().toString(36).slice(2, 8);
  const rel = data.reliability || [];
  const hasRows = rel.some((r) => r.n > 0);
  return { html: `<div class="card">
    <span class="panel-tag ${tagClass}">${tag}</span>
    <h3 style="font-family:var(--display);font-size:15px;letter-spacing:.05em;margin:4px 0 8px">${title}</h3>
    <p class="note" style="margin-top:0">${blurb}</p>
    ${hasRows ? `<div class="legend">
      <span class="k2"><i></i>what the model said</span>
      <span><i style="background:var(--gold-l)"></i>what actually happened</span>
      <span><i style="background:rgba(243,234,215,.35);border-radius:1px;width:14px;height:3px"></i>95% interval</span>
    </div>
    <figure id="${id}">${reliabilityChart(rel)}<figcaption>Each row is a group of predictions. The tick is the claim; the dot is the outcome.</figcaption></figure>
    <details><summary>Show as a table</summary>${relTable(rel)}</details>` : ''}
    ${brierBlock(data.brier)}
  </div>`, id, rel, kind };
}

async function load() {
  let d;
  try {
    const r = await fetch('/api/proof', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    d = await r.json();
  } catch (e) {
    $('app').innerHTML = `<div class="card"><p class="err">Could not load the record: ${esc(e.message)}</p>
      <p class="note">The raw file is still there: <a href="/api/proof/raw">/api/proof/raw</a></p></div>`;
    return;
  }

  const F = d.forward, C = d.crossValidated;
  // The headline runs on whichever set can actually carry it - the one with more hands whose wallet
  // the roster has assessed, since an unassessed hand cannot take part in the comparison at all.
  // The forward record wins ties, because a forward prediction is worth more than a rotated fold.
  // The two are never averaged together: they are different kinds of evidence.
  const assessed = (x) => x?.populations?.assessed || 0;
  const head = assessed(F) >= assessed(C) && assessed(F) > 0 ? F : C;
  const headLabel = head === F
    ? `${num(assessed(F))} hands quoted live, since ${esc((F.since || '').slice(0, 10))}`
    : `${num(C.n)} resolved Smart Money trades, cross-validated ${C.folds} ways`;

  let h = '';

  const POP = head.populations || {};
  const cmp = POP.all && POP.filtered && POP.filtered.n ? POP : null;
  const d2 = cmp ? cmp.difference : null;

  // ---------- hero: two claims, scored separately, because only one of them is hard
  // The win rate asks whether the filters pick whales that win more often. The return asks whether
  // they beat the PRICE those whales are quoted at, which is a much higher bar and can fail while
  // the first one passes. Collapsing both into one verdict throws away a result that is already in.
  const pstr = (p) => (p == null ? '' : p < 0.001 ? 'p &lt; 0.001' : `p = ${p.toFixed(3)}`);
  const claim = (title, test, fmt, note) => {
    if (!test || test.se == null) return '';
    const cls = !test.significant ? 'wait' : test.diff >= 0 ? 'ok' : 'bad';
    const word = !test.significant ? 'not yet proven' : test.diff >= 0 ? 'proven' : 'refuted';
    return `<div class="claim ${cls}">
      <div class="ct">${title}</div><div class="cv">${word}</div>
      <div class="cd">${fmt(test.diff)} &middot; 95% interval ${fmt(test.lo)} to ${fmt(test.hi)} &middot; ${pstr(test.p)}</div>
      <div class="cn">${note}</div></div>`;
  };

  h += `<div class="card hero">
    <div class="q">Is copying Smart Money better <i>through the filters</i> than copying all of it?</div>
    ${cmp && d2 != null ? `<div class="big ${!cmp.significant ? 'neutral' : d2 >= 0 ? 'pos' : 'neg'}">${sgn(d2, 2)}</div>
    <div class="ci">return per hand, versus copying every whale &middot; 95% interval ${sgn(cmp.tests?.return?.vsAll?.lo ?? d2 - 1.96 * cmp.differenceSe, 2)} to ${sgn(cmp.tests?.return?.vsAll?.hi ?? d2 + 1.96 * cmp.differenceSe, 2)}</div>
    <div class="claims">
      ${claim('The filters pick whales that win more often', cmp.tests?.winRate?.vsAll, (x) => sgnPP(x, 1),
        'The plain question, and the easier one: does backing this population pay off more often than backing everything.')}
      ${claim('The filters beat the price those whales are quoted at', cmp.tests?.return?.vsAll, (x) => sgn(x, 2),
        'The hard one. The odds already price in how good a wallet is, so a better whale is quoted shorter and simply picking better whales should not move the return. Clearing this bar means the house rules see something the pricing does not.')}
    </div>
    <p class="exp">Measured on ${headLabel}. Both intervals are cluster-robust, hands are grouped by
    the wallet that made them, so one busy whale cannot pass itself off as many independent votes.</p>`
    : `<div class="big neutral">not yet</div>
    <p class="exp">Not enough assessed hands to compare the two populations honestly. The record below is filling.</p>`}
  </div>`;

  // ---------- 01 the comparison
  h += `<h2><span class="n">01</span>Blind copying vs copying through the filters</h2>
  <p class="lede">The same hands, the same odds, the same settlement on the whale's real exit. The only
  thing that differs is which wallets were allowed through: <b>every Smart Money whale</b> Nansen
  surfaced in the perp feed, against <b>only the ones that clear the house rules</b>, grade, win
  rate, sample size, coins traded, profitable over both windows, plus the specialist, early, printer
  and whale-board routes. If the filtered set does not beat the raw set, the filters are decoration
  and this page should say so.</p>`;

  if (cmp) {
    const bars = [
      { label: 'Every Smart Money whale', v: cmp.all.follow, mute: true,
        sub: `${num(cmp.all.n)} hands \u00b7 ${cmp.all.wallets ? num(cmp.all.wallets) + ' wallets \u00b7 ' : ''}won ${pct(cmp.all.winRate, 0)}` },
      { label: 'Through the filters', v: cmp.filtered.follow, hero: true,
        sub: `${num(cmp.filtered.n)} hands \u00b7 ${cmp.filtered.wallets ? num(cmp.filtered.wallets) + ' wallets \u00b7 ' : ''}won ${pct(cmp.filtered.winRate, 0)}` },
    ];
    if (cmp.rejected && cmp.rejected.n) bars.push({ label: 'Rejected by the filters', v: cmp.rejected.follow,
      sub: `${num(cmp.rejected.n)} hands \u00b7 ${cmp.rejected.wallets ? num(cmp.rejected.wallets) + ' wallets \u00b7 ' : ''}won ${pct(cmp.rejected.winRate, 0)}` });
    h += `<div class="card">
      <figure id="cmpFig">${roiBars(bars, { alt: 'Return per hand for all Smart Money versus only the filtered whales' })}
        <figcaption>Return per unit staked, backing the whale every time. A whisker crossing the zero line means that row is not yet distinguishable from fair odds.</figcaption></figure>
      <div class="tiles">
        <div class="tile"><small>Return difference</small><b style="color:${cmp.significant ? (d2 >= 0 ? 'var(--emerald)' : 'var(--ruby)') : 'var(--gold-l)'}">${sgn(d2, 2)}</b></div>
        <div class="tile"><small>Win-rate difference</small><b style="color:${cmp.tests?.winRate?.vsAll?.significant ? 'var(--emerald)' : 'var(--gold-l)'}">${
          cmp.tests?.winRate?.vsAll ? sgnPP(cmp.tests.winRate.vsAll.diff, 1) : '\u2014'}</b></div>
        <div class="tile"><small>Assessed hands</small><b>${num(cmp.assessed)}</b></div>
        <div class="tile"><small>Wallet never assessed</small><b>${num(cmp.unknown)}<span class="u">hands</span></b></div>
      </div>
      ${(() => {
        // Both claims against both comparisons. "Versus every whale" is the question a player asks;
        // "versus the rejected" is the cleaner statistic, because those two groups share no wallets.
        const T = cmp.tests; if (!T) return '';
        const cell = (t, fmt) => t && t.se != null
          ? `<td class="${t.significant ? (t.diff >= 0 ? 'y' : 'n') : ''}">${fmt(t.diff)}<span class="pp">${
              t.significant ? pstr(t.p) : 'not yet &middot; ' + pstr(t.p)}</span></td>`
          : '<td class="dim">, </td>';
        const pc = (x) => sgnPP(x, 1), rr = (x) => sgn(x, 2);
        return `<table class="ptab"><thead><tr><th></th>
            <th>vs copying every whale</th><th>vs the whales it rejected</th></tr></thead><tbody>
          <tr><th>Win rate</th>${cell(T.winRate.vsAll, pc)}${cell(T.winRate.vsRejected, pc)}</tr>
          <tr><th>Return per hand</th>${cell(T.return.vsAll, rr)}${cell(T.return.vsRejected, rr)}</tr>
        </tbody></table>`;
      })()}
      <p class="note">The rejected row is shown because it is the other half of the argument: filters that
      help must leave something worse behind. Hands from a wallet the weekly roster has never assessed
      count in the raw population and in neither of the other two, folding them into either would
      flatter whichever side they landed on.</p>
      <p class="note"><b>Read the two numbers separately.</b> The win rate is the plain question: how
      often does backing this population pay off. The return is a harder test, because the odds already
      price in how good the wallet is: a whale with a strong record is quoted at a shorter price,
      so simply picking better whales should <i>not</i> move the return. A gap that survives anyway means
      the house rules are catching something the odds are not, which is the only version of this claim
      worth making.</p>
      <details><summary>Show as a table</summary><table>
        <thead><tr><th>Population</th><th>Hands</th><th>Wallets</th><th>Won</th><th>Return / hand</th><th>95% interval</th></tr></thead><tbody>
        ${[['Every Smart Money whale', cmp.all], ['Through the filters', cmp.filtered], ['Rejected by the filters', cmp.rejected]]
          .filter(([, c]) => c && c.n).map(([nm, c]) => `<tr><td>${nm}</td><td>${num(c.n)}</td><td>${c.wallets ? num(c.wallets) : ', '}</td><td>${pct(c.winRate, 0)}</td>
          <td class="${c.follow.roi >= 0 ? 'pos' : 'neg'}">${sgn(c.follow.roi, 2)}</td>
          <td class="dim">${sgn(c.follow.roi - 1.96 * c.follow.se, 1)} to ${sgn(c.follow.roi + 1.96 * c.follow.se, 1)}</td></tr>`).join('')}
        </tbody></table></details>
    </div>`;
  } else {
    h += `<div class="card"><p class="dim">Not enough assessed hands yet to split the two populations.</p></div>`;
  }

  // ---------- 02 falsification
  h += `<h2><span class="n">02</span>The falsification test</h2>
  <p class="lede">Three strategies play every hand this app deals, at a flat stake, priced by the same
  odds and settled on the same real whale exits. Nobody gets to tune them. If backing every whale
  quietly out-earns every human on the board, the honest read is that the teaching is not working, and the board says so without being asked.</p>
  <div class="card">
    <figure id="stratFig">${roiBars([
      { label: 'Always Follow', v: head.strategies?.follow, sub: head.strategies?.follow?.n ? `${num(head.strategies.follow.n)} hands \u00b7 won ${pct(head.strategies.follow.winRate, 0)}` : '' },
      { label: 'Always Fade', v: head.strategies?.fade, sub: head.strategies?.fade?.n ? `${num(head.strategies.fade.n)} hands \u00b7 won ${pct(head.strategies.fade.winRate, 0)}` : '' },
    ], { labelW: 122, alt: 'Return per hand for always-following and always-fading' })}
      <figcaption>Recomputed from the raw record rather than read off a counter.</figcaption></figure>
    <p class="note">Both strategies are fully determined by a recorded prediction and its outcome,
    which is exactly why they are the right test: there is no parameter to adjust.</p>
  </div>`;

  if (d.bots?.length) {
    h += `<div class="card"><h3 style="font-family:var(--display);font-size:15px;letter-spacing:.05em;margin:0 0 4px">The house bots, live on the leaderboard</h3>
    <p class="note" style="margin-top:0">The same strategies as players see them, playing with chips since the board opened.</p>
    <table><thead><tr><th>Bot</th><th>Hands</th><th>Win rate</th><th>Net</th><th>Return</th></tr></thead><tbody>${
      d.bots.map((b) => `<tr><td>${esc(b.name)}</td><td>${num(b.bets)}</td><td>${pct(b.winRate, 0)}</td>
        <td class="${b.net >= 0 ? 'pos' : 'neg'}">${b.net >= 0 ? '+' : '&minus;'}$${num(Math.abs(b.net))}</td>
        <td class="${b.roi >= 0 ? 'pos' : 'neg'}">${sgn(b.roi, 1)}</td></tr>`).join('')}</tbody></table>
    <p class="note">Coin Flip picks at random, so it cannot be reconstructed from the record and only
    appears here. Beat it and you are reading something; lose to it and you are not.</p></div>`;
  }

  // ---------- calibration
  h += `<h2><span class="n">03</span>Are the odds honest?</h2>
  <p class="lede">Scoring the training set with the model fitted on that same training set produces a
  beautiful curve and proves nothing, so it is not offered here at any size. There are two kinds of
  evidence below and they are never mixed.</p>`;

  const pf = panel('Forward record', 'fwd', 'Every price quoted, before the outcome was known',
    F.n ? `Written down at the moment each hand was built and never edited since.
       ${num(F.n)} predictions, ${num(F.scored)} of them settled${F.pushes ? ` (${num(F.pushes)} pushed: the whale barely moved, so there was no winner)` : ''}${F.since ? `, starting ${esc(F.since.slice(0, 10))}` : ''}.
       Unfakeable by construction, and the only thing that can finally settle the argument.`
      : `The journal starts empty and fills as hands are dealt: it has nothing in it yet.
         Until it does, the cross-validated panel below is the honest answer.`, F, 'F');
  h += pf.html;

  const pc = panel('Cross-validated', '', `${C.folds || 10}-fold on the training pool`,
    C.tooSmall ? `Too few resolved trades to cross-validate yet (${num(C.n)}).`
      : `The ${num(C.n)} resolved Smart Money trades the model learns from, fitted on nine tenths and
         asked about the tenth, rotated so every trade is predicted exactly once by a model that never
         saw it. Folds are assigned by position rather than at random, so anyone re-running this on the
         same data gets the same answer.`, C, 'C');
  h += pc.html;

  // ---------- check it
  h += `<h2 id="check"><span class="n">04</span>Check it yourself</h2>
  <p class="lede">Every number above comes from two files. Both are public, neither is summarised, and
  nothing here asks to be taken on trust.</p>
  <div class="card">
    <div class="dl">
      <a href="/api/proof/raw">&darr; the raw predictions</a>
      <a href="/api/proof">&darr; this page as JSON</a>
      <a href="/api/usage">&darr; the Nansen call ledger</a>
      <a href="/api/bots">&darr; the bot ledger</a>
    </div>
    <p class="note">One JSON object per prediction: the probability quoted, whether following won, and
    whether it pushed. Group by the probability, compare with the outcomes, and you have rebuilt the
    reliability table. The call ledger is every Nansen endpoint this app has ever hit, with the
    credits each one spent.</p>
  </div>`;

  // ---------- limits
  h += `<h2><span class="n">05</span>What this does not prove</h2>
  <div class="card limits"><ul>
    <li><b>These are play chips.</b> No fee, no slippage, no funding cost and no market impact. Real
    copying pays all four, and every one of them takes a bite out of the numbers above.</li>
    <li><b>The sample is small and recent.</b> The training pool reaches back about two weeks. A
    fortnight is a market regime, not a law, and a whisker that crosses zero means exactly what it says.</li>
    <li><b>The roster verdict is today's, applied to older trades.</b> Which population a hand lands in
    comes from the current weekly roster, and that roster was graded partly on the very outcomes being
    scored here: a mild look-ahead that flatters the filtered side. It is the reason the lookback
    is kept to two weeks rather than stretched for a bigger number: the further back it reaches, the
    more the comparison leans on a verdict that already knew the answer. The clean version of this test
    is the forward record, which has no such problem and is the one that will settle it.</li>
    <li><b>Hands from one whale are not independent.</b> The filtered set averages under three hands per
    wallet, so every interval on this page is cluster-robust: hands are grouped by the wallet that made
    them before the error is computed, and where that produces a <i>narrower</i> bar than the naive
    calculation the naive one is kept instead. A busy whale gets one vote, not ten.</li>
    <li><b>Every hand is selected.</b> Trades reach this deck through the Nansen Smart Money screener
    and a set of house filters. The rates here are conditional on that selection, not on all trading.</li>
    <li><b>A hand settles on the whale's own exit.</b> That is the bet being priced. It is not a
    forecast of the price in an hour, and it should not be read as one.</li>
    <li><b>None of it is advice.</b> This is an educational game played with valueless chips. Nothing
    here is a signal, and anything done outside it is the reader's own decision.</li>
  </ul></div>`;

  h += `<footer>The forward record is recomputed on every load; the cross-validated half is rebuilt
    when the odds recalibrate, because ten fits over the whole pool is real work and a visitor
    should not be the one who waits for it.
    Generated ${esc((d.generatedAt || '').replace('T', ' ').slice(0, 16))} UTC${
    d.model?.n ? ` &middot; odds model last refit on ${num(d.model.n)} resolved trades` : ''}.
    <a href="/">Back to the table</a></footer>`;

  $('app').innerHTML = h;
  if (pf.rel?.some((r) => r.n)) bindReliability($(pf.id), pf.rel);
  if (pc.rel?.some((r) => r.n)) bindReliability($(pc.id), pc.rel);
  if ($('stratFig')) bindBars($('stratFig'), [
    { label: 'Always Follow', v: head.strategies?.follow },
    { label: 'Always Fade', v: head.strategies?.fade }]);
  if ($('cmpFig') && cmp) bindBars($('cmpFig'), [
    { label: 'Every Smart Money whale', v: cmp.all.follow },
    { label: 'Through the filters', v: cmp.filtered.follow },
    ...(cmp.rejected && cmp.rejected.n ? [{ label: 'Rejected by the filters', v: cmp.rejected.follow }] : [])]);
}
load();
