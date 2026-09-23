# FOLLOW or FADE

**Every hand is a real Nansen Smart Money trade on Hyperliquid. You call Follow or Fade, the whale's real exit settles it, and a public proof desk scores every price the table ever quoted.**

[![tests](https://github.com/Tonychdid/follow-or-fade/actions/workflows/test.yml/badge.svg)](https://github.com/Tonychdid/follow-or-fade/actions/workflows/test.yml)

**[Play it](https://follow-or-fade-production.up.railway.app)** · **[Proof desk](https://follow-or-fade-production.up.railway.app/proof.html)** · **[Alert scorecard](https://follow-or-fade-production.up.railway.app/scorecard)** · **[60s demo video](https://x.com/himerosventures/status/2102130395865043397)** · **[Free Telegram alerts](https://t.me/fadefollowbot)** · **[Live Nansen call ledger](https://follow-or-fade-production.up.railway.app/api/usage)**

No signup, no wallet, play chips only. Built for the Nansen Meridian Buildathon.

[![The Training Table](docs/the-table.jpg)](https://follow-or-fade-production.up.railway.app)

## Judging this? Sixty seconds

1. **[Play one hand.](https://follow-or-fade-production.up.railway.app)** A real Smart Money trade from this week, at the whale's exact entry. Open **"Priced by 3 Nansen endpoints"** under the odds bar: it lists each Nansen request behind the hand, whether it was live or cached, and how many points each Nansen number moved the price.
2. **[Open the proof desk.](https://follow-or-fade-production.up.railway.app/proof.html)** Does copying Smart Money *through our filters* beat copying all of it? The answer, with intervals, adjusted p-values and the raw record to recompute it.
3. **[Open the alert scorecard.](https://follow-or-fade-production.up.railway.app/scorecard)** Every whale alert, sent before the outcome, scored from the price a follower could actually have had to the whale's real exit. Early days: it leads with counts until 20 alerts have closed. Every whale has a share page (`/w/<address>`) with its own preview image.
4. **Run it yourself:** `git clone`, then `node server.js`. No install, no build, no API key needed (demo mode). `npm test` runs 98 checks offline.

## What it is

Nansen labels the wallets worth watching. The question nobody answers is whether copying them actually works, and which of them to copy. Follow or Fade turns that into a game you can learn from and a record you can check.

| | What you do | What Nansen does |
|---|---|---|
| **Training Table** | Call a real, already-closed Smart Money trade. The reveal shows the whale's real exit and which signal called it. | Supplies the trade, the whale's 30 days before it, and the Smart Money and crowd flow on the coin. |
| **Live Floor** | Back whales who are in a position right now, ride them to their exit or cash out at fair value. | Supplies the opens, the whale's 7D and 30D record, and Smart Money positioning on the coin. |
| **Telegram alerts** | Get the filtered whale entries on your phone, with the whale's own take-profit and stop-loss orders, and add, trim, exit and moved-exit follow-ups as replies. | Scans Smart Money perp trades every few minutes and grades each whale. |
| **Trader Profile** | Seven reading skills, each scored against what the odds expected of you. | Every skill is measured on hands priced from Nansen data. |
| **Proof desk** | Read whether the odds and the filters hold up. | Every price it scores came from Nansen features. |
| **Alert scorecard** | See what copying every alert at the alert price would have done, alert by alert. | The alerts are Nansen Smart Money opens that cleared the filters. |
| **Whale pages** | Share any whale: record, open position, alert history, a preview image drawn on the server. | 30D and 7D records from `profiler/perp-pnl-summary`. |

## Nansen endpoints used

| Endpoint | What it feeds |
|---|---|
| `smart-money/perp-trades` | The pool of playable hands (7 days), the Live Floor feed, the alert scanner |
| `profiler/perp-pnl-summary` | Each whale's record over the 30 days *before* the trade (odds), and the 7D/30D grade on the floor |
| `perp-screener` (`trader_type: sm` and `all`) | Smart Money net flow vs everyone else, funding, and live long/short positioning |
| `agent/fast`, `agent/expert` (Nansen Agent) | Insider filings on stock perps, and one Stock Pick a day |

Every call is counted, by endpoint and credits, at [`/api/usage`](https://follow-or-fade-production.up.railway.app/api/usage) (over 25,000 calls by Sep 22).

## How Nansen data sets a price

```
smart-money/perp-trades ──► the trade: coin, side, size, entry, time
profiler/perp-pnl-summary ─► whale win rate and PnL, 30 days BEFORE the trade   (no look-ahead)
perp-screener · sm ────────► did Smart Money flow agree with this trade, 24h before?
perp-screener · all ───────► was the crowd already piling in? who was paying funding?
        │
        ▼
logistic model, 5 Nansen features ──► P(follow wins) ──► fair odds (no house edge)
        ▲
        └── refit every hour on trades that have since resolved
Hyperliquid fills ──► the whale's real, size-weighted exit settles the hand
```

Each dealt hand carries its own call rail (`nansen.calls` and `nansen.why` in `/api/round`), so the page can show which requests built it and how far each Nansen number moved its price.

## The proof desk: what holds up, and what does not yet

[`/proof.html`](https://follow-or-fade-production.up.railway.app/proof.html) publishes three kinds of evidence and never mixes them:

- **Held out.** One trade in five is hashed into a permanent holdout the odds model never trains on. Hands dealt from it are the cleanest record here. It started on Sep 22 and is filling; it takes over the headline at 150 assessed hands.
- **Cross-validated** (10 folds, 377 resolved trades on Sep 22). In-sample for the filters, which were tuned on this data, so it is labelled "in-sample only". On Sep 22, filtered whales won about 8 points more often than all Smart Money and returned about 10 percentage points more per hand (Holm-adjusted p below 0.03 for both). Part of that gap comes from wallets that were never assessed. Against the rejected whales alone, the gap is not significant yet.
- **Dealt hands.** Every price the table quoted, logged when dealt, scored against the whale's exit.

What the numbers show today: the model's skill is modest (a few percent better Brier than always guessing the trained base rate, and level with guessing each set's own win rate after the fact), the odds underpriced following on the first 300 dealt hands (Always Follow made about 12% a hand; since Sep 23 a recalibration shift fitted on earlier dealt hands, never the holdout, closes that gap), and the roster was graded on windows that overlap the trades it is scored on. Nothing on the page is labelled proven. Four tests share one set of hands, so every p-value is Holm-adjusted; intervals are cluster-robust by wallet.

**House bots** (Always Follow, Always Fade, Coin Flip) play every hand at a flat stake and sit on the Hall of Fame tagged BOT. *Always Follow* is the benchmark that can embarrass the site.

## Which whales qualify

A whale is dealt, and can fire an alert, only if their Nansen record clears the house rules: realized profit over 30 days and 7 days, enough closed trades, profit spread across several coins, and a grade built from return, win rate and sample size. Two rules worth knowing:

- **Specialists** with proven profit on the exact coin they are opening get through on that coin.
- **Market-maker pattern.** Winning 95% or more of hundreds of closes is quoting both sides of the book, not calling direction. Those wallets are capped at grade C, below the alert bar.
- **Too fast to copy.** A wallet that holds for minutes or a few hours and still wins nearly every close keeps its edge in the minutes a follower spends reading the alert. Capped at C, never alerted.
- **Hedged shorts.** Before a short is alerted, the wallet's Hyperliquid spot balance is checked. A short that is 80% or more covered by spot of the same coin is a hedge, not a call on direction, and is not alerted.

Nansen labels are shown as the whale's name, except labels that are only a Hyperliquid referral code: this site never prints a referral code, so those wallets are named by address. The public alert feed carries the summary a follower reads, not the raw Nansen rows behind it.

The full rules, the EARLY and PRINTER routes and the studies behind them are in [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## Run it

Requirements: [Node.js 18+](https://nodejs.org). No `npm install`, no build step, zero dependencies.

```bash
git clone https://github.com/Tonychdid/follow-or-fade.git
cd follow-or-fade
echo "NANSEN_API_KEY=your_key_here" > .env   # optional: without it the app runs on demo data
npm start                                     # open http://localhost:3000
npm test                                      # 98 checks, no key and no network needed
```

Windows: download the ZIP, unzip, double-click `start.bat`. First hand in about five seconds. The first launch trains the odds in the background (about 450 credits), then about 3 credits per hand; on a small balance add `CALIBRATION_SAMPLE=20`. Hosting: [DEPLOY.md](DEPLOY.md). Every setting: [docs/METHODOLOGY.md](docs/METHODOLOGY.md#configuration-env).

## Architecture

```
server.js            zero-dependency HTTP server: API routes, CSP and security headers, rate limits
lib/nansen.js        Nansen client: cache, retries, credit ledger, and the per-hand call rail
lib/odds.js          Nansen features -> probability -> fair odds; hourly refit; per-feature contributions
lib/game.js          hands, bets, the Live Floor, grades, the whale filters
lib/proof.js         the proof desk: holdout, cross-validation, clustered intervals, Holm adjustment
lib/alerts.js        alert scanner and Telegram delivery
lib/scorecard.js     every alert scored from the price at the alert to the whale's exit
lib/ogimage.js       share images (1200x630 PNG) drawn with a pixel font and zlib, no dependencies
lib/hyperliquid.js   prices, positions and fill history (whale exits and settlement)
lib/coach.js         post-hand lessons and the Trader Profile
public/              vanilla JS, no build: app.js, proof.js, style.css
test/smoke.js        boots the server in demo mode and runs the full loop plus the statistics checks
```

Data is kept in JSON files by a single process. That is deliberate for a demo that anyone can run with one command; nothing needs a database.

## Play money

Play chips only. No real order is ever placed from this site, nothing here is financial advice, and a result in a game does not predict a real trading result. The site earns no commission from any link on it and is not affiliated with Nansen.

## License

Copyright (c) 2026 the Follow or Fade authors. All rights reserved. You may read, download and run this code to evaluate it, including for the Nansen Meridian Buildathon. See [LICENSE](LICENSE).
