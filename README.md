# FOLLOW or FADE

### The Smart Money Academy, disguised as a casino.

**Learn to read Smart Money before you risk real money.** Every hand is a real Hyperliquid trade opened by a Nansen Smart Money whale. You get $10,000 in play chips: follow the whale or fade it. **Nansen data sets the odds, the market settles the bet**, and after every hand the coach tells you which Nansen signal called it. Your Skill Report tracks which reads you're good at, and when you consistently beat the odds, you take those reads to real trades on Nansen.

**Train → Practice live → Trade for real on Nansen**

| 1. Training Table | 2. Live Floor | 3. Nansen |
|---|---|---|
| Replay this week's real whale trades, bet play money, and get a lesson on every hand | Bet on whales opening positions right now, with track records, trust grades and alerts | When your Skill Report says *Ready for real trades*, one click opens the market in Nansen's trading app |

Built for the Nansen Meridian Buildathon.

---

![Training Table](docs/the-table.jpg)

## Run it in under 5 minutes

Requirements: [Node.js 18+](https://nodejs.org). No `npm install`, no build step, zero dependencies.

**macOS / Linux**

```bash
git clone https://github.com/tonychdid/follow-or-fade.git
cd follow-or-fade
echo "NANSEN_API_KEY=your_key_here" > .env
npm start                   # then open http://localhost:3000
```

**Windows:** download the repo (Code → Download ZIP), unzip it and double-click `start.bat`. On first run it asks for your key and opens the browser.

**Time to first hand:** about 5 seconds after `npm start` (tested on a fresh copy with Node 18 and Node 22). Open http://localhost:3000, pick a nickname, and the Training Table deals a live Smart Money trade.

**Credits:** the first launch trains the odds on this week's trades in the background (about 450 Nansen credits over 5 minutes), then roughly 3 credits per training hand. On a small credit balance, add `CALIBRATION_SAMPLE=20` to `.env`.

**Troubleshooting:** port 3000 busy → add `PORT=3001` to `.env`. "No Smart Money trades available" → check the key and your credit balance at https://app.nansen.ai/api.

No key yet? Skip the `.env` step and the app runs in **demo mode**: Nansen-shaped sample wallets on top of real Hyperliquid prices, with a `DEMO DATA` badge.

**Host it for everyone:** see [DEPLOY.md](DEPLOY.md) (Railway, about 15 minutes, with a daily credit cap and admin-only alert settings).

## How it plays

The app opens on the **Training Table**.

| Mode | What happens |
|---|---|
| **Training Table** (replay) | You're dealt a real Smart Money position open from the last 7 days (coin, side, size, entry). The wallet is hidden. You see the Nansen intel, the model's probability and the odds. Stake, pick **Follow** or **Fade**, and the hand is **judged on the whale's real exit**: the app follows the whale's own position until it's fully closed (size-weighted exit of every reduction), capped at 48h and marked to market if they're still holding. The reveal shows the price path up to the exit, how long the whale held, the wallet and your payout. **What the data said:** after every hand the coach names *the tell* (the Nansen signal that called it) and *the trap* (the one that misled), with how reliable each signal was this week across hundreds of resolved Smart Money trades. |
| **Skill Report** | Every bet stores the Nansen signals you acted on. Only decisions that match how whales actually trade count: training hands, 4-hour and Ride the Whale bets (15-minute bets are just for fun). The report shows your win rate against what the odds expected (your **edge**), your **strengths** and **leaks** across 10 tracked patterns (following A/B-grade whales, fading crowded trades, siding with Smart Money flow, taking underdogs…), coach advice, and a level ladder: *Rookie → Learning the tells → Sharp reader → Ready for real trades*. |
| **Live Floor** | Smart Money opens from the last 6 hours whose whale **still holds the position** (checked on Hyperliquid every minute, with "trimmed X%" when they have cut size), with where Smart Money is positioned on that coin right now. Pick a table: **Espresso Shot (15 min, just for fun)**, **Cigar Lounge (4 hours)** or **Ride the Whale**, where your bet ends **when that whale closes the position** (max 48h, `RIDE_MAX_HOURS`), tracked live from their Hyperliquid fills. Timed bets settle on the price at the exact bell (1-minute candle), so they settle correctly even if the app was closed. Each whale shows a **7D and 30D track record** from Nansen (realized PnL, return, win rate, best and worst coin) and a **trust grade** (A+ to F). One click opens the market in **Nansen's trading app** if you want to take the trade for real. |
| **Your Table** (always on screen) | Only your open live bets, grouped by table, with countdown rings and a live meme face: a money-printing face when you are winning and a crying face when you are losing, getting more intense as the bet moves. Settled bets move to Recent hands. |
| **Cash Out** | End a live bet early. The offer is the bet's fair value: stake × odds × the probability you are still winning at the bell, starting from the probability the odds were priced at and updated with how far price has moved, the time left and the coin's current 1-minute volatility on Hyperliquid, with no extra fee beyond the 3% house edge built into the odds. Cashing out the second you bet returns about 97% of your stake. Cash out in profit: *"The whale is my exit liquidity."* Cash out at a loss: *"Cashing out before the whale gets rekt."* |
| **Whale Alerts** (bell icon) | A background scanner checks Nansen Smart Money perp opens every few minutes, grades each whale's 7D and 30D track record, and alerts you when a top whale opens a trade. Default rules: grade A or better, 55%+ win rate, profitable over 30D, $50K+ position, and **3+ coins traded in 7D and 5+ in 30D** so win rates can't be inflated by one-coin wallets. **Specialists** are the exception: a whale trading only 1–2 coins still gets through, tagged SPECIALIST, if the coin they're opening is one of their main coins (40%+ of their closes) with $25K+ realized profit and a 3%+ return on it over 30D, and no losing week on it. You get a sound, an on-screen alert, optional desktop notifications and optional **Telegram** messages. Each alert has **Open full card** (jumps to that whale's card, pinned at the top of the Live Floor) and **Join on Nansen** (opens the market in Nansen's trading app). After an alert, the app keeps reading that whale's Hyperliquid position and sends an **add alert** when they grow the position by 50%+ (conviction rising), a **trim alert** when they cut 25%, 50% or 75% and an **exit alert** when they fully close (with exit price and the whale's return), so nobody following them gets left in the trade. Telegram alerts link straight to that whale's full card on the Live Floor (position, 7D/30D track record, the dealer's tells, Smart Money positioning and, for stocks, the Nansen Agent insider brief). |
| **Hall of Fame** | Bankroll ranking, win rate, best streak, **whales slain** (correct fades of trades the model favored). |
| **Share card** | One-click PNG plus a prefilled X post. |

| | |
|---|---|
| ![Skill Report](docs/skill-report.jpg) | ![Whale alert](docs/whale-alert.jpg) |
| ![Cash out](docs/cash-out.jpg) | ![Your Table](docs/your-table.jpg) |
| ![Live Floor](docs/live-floor.jpg) | ![Lesson](docs/lesson.jpg) |

Go below $10 and you're **REKT**: the bankroll resets and a bust is recorded.

The theme is a luxury casino, with sound effects synthesized in the browser (Web Audio, no audio files) and a mute button in the header.

---

## Why bets are judged on the whale's exit

We measured it. Of 150 recent Smart Money position opens, **only 11% were fully closed within an hour**. Among the positions that did close, the typical hold was about 13 hours, and half were still open when we checked (typically 1.8 days after opening). Judging a whale's call on a 15-minute price move mostly measures noise. So training hands are judged on the whale's real exit, the live tables are 4 hours or Ride the Whale, and the odds engine is calibrated on the same target. The sidebar shows the live median hold across this week's resolved trades.

## How Nansen data drives the game

Nansen data decides the odds and the pool of trades.

```
Smart Money perp trades ──► the pool of playable trades (HIP-3 markets too: GOLD, NVDA…) (who opened what, when, at what price)
        │
        ├─ Wallet perp PnL summary (30 days BEFORE the trade) ─► win rate, closed trades, realized PnL
        ├─ Perp screener, Smart Money cohort (24h before)     ─► did Smart Money flow agree?
        ├─ Perp screener, all traders (24h before)            ─► was the trade already crowded? funding?
        ▼
  Odds engine (logistic model)  ──► P(follow wins) ──► decimal odds (3% house edge)
        ▲
        └─ self-calibrates hourly on this week's resolved Smart Money trades (judged on the whale's exit)
Hyperliquid public fills + candles ──► follow each whale's position to its real exit and settle every bet
```

- **Two questions, two entries:** the Training Table asks *was the whale right?* and deals the trade at the whale's own entry. The Live Floor asks *is it still worth following now?* and uses today's price (betting from the whale's old entry would let players bet on a result that is already partly known). Live odds include how far the whale has already moved (a late-entry weight that starts at zero and is learned from settled live bets), and settled bets show your result next to the whale's.
- **Point-in-time, no look-ahead:** every feature uses only data from *before* the trade was opened.
- **Server-side outcomes:** the result is computed on the server and only revealed after the bet, so you can't peek in the network tab.
- **Self-calibrating odds:** each hour the app resolves a sample of this week's Smart Money opens (on the whale's real exit, max 48h) and refits the model, with an L2 pull toward a sensible prior so small samples stay stable. The sidebar shows how many trades the odds were trained on and what share of Smart Money opens were actually in profit when the whale exited.

### Nansen endpoints used

| Endpoint | Credits | Used for |
|---|---|---|
| `POST /api/v1/smart-money/perp-trades` | 5 | Round pool (7d), Live Floor feed (6h) |
| `POST /api/v1/profiler/perp-pnl-summary` | 1 | Wallet track record before the trade (odds), plus 7D and 30D whale track record and trust grade (live) |
| `POST /api/v1/smart-money/perp-trades` (1h lookback) | 5 | Whale Alerts scanner (every 2–30 min, configurable) |
| `POST /api/v1/perp-screener` (`trader_type: sm` and `all`) | 1 | Smart Money vs crowd net flow, funding, and current Smart Money long/short positioning (live) |
| `POST /api/v1/agent/expert` (Nansen Agent) | 750 | **Insider Pick of the Day:** once per UTC day, screens every stock listed on Hyperliquid for insider buying and picks the best setup |
| `POST /api/v1/agent/fast` (Nansen Agent) | 200 | **Insider check** on stock whale cards and in Telegram alerts: insider trades, ownership, earnings, valuation |

Credit use is kept low with caching: whale and market data are cached per hour, and the Live Floor feed for 15 minutes. The sidebar shows real API calls and credits used.

---

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `NANSEN_API_KEY` | – | Your key from https://app.nansen.ai/api |
| `PORT` | 3000 | Web port |
| `MAX_HOLD_HOURS` | 48 | Training hands are judged on the whale's real exit, capped at this many hours |
| `MIN_HOLD_MINUTES` | 60 | Training hands and odds training skip scalps: whales who fully closed faster than this |
| `PUSH_BAND_PCT` | 0.2 | Whale results smaller than ±this % are a push (stake back) on training hands, Ride the Whale and the Insider Pick, and are left out of odds training |
| `RIDE_MAX_HOURS` | 48 | Ride the Whale bets end when the whale closes, capped at this many hours |
| `CALIBRATION_SAMPLE` | 60 | Trades resolved per hourly calibration run |
| `DEMO` | 0 | `1` forces demo data |
| `NANSEN_REF_URL` | `https://nsn.ai/avyrion` | Nansen referral link used for every "New to Nansen? Sign up" link and in Telegram alerts |
| `NANSEN_PROMO_CODE` | `AVYRION` | Code shown next to the referral link |
| `AGENT_DAILY_CREDITS` | `1600` | Daily Nansen credits for the Research Desk (Nansen Agent). `0` turns it off |
| `DAILY_CREDIT_CAP` | none | Max Nansen credits per UTC day. Above it the app serves cached data and demo whales, and pauses odds training and alerts |
| `PUBLIC` | 0 | `1` for a public deployment: per-IP rate limits, alert rules and Telegram become admin-only |
| `ADMIN_TOKEN` | none | With `PUBLIC=1`, open `/?admin=TOKEN` once to manage alerts |
| `DATA_DIR` | `data` | Where bankrolls, bets and the leaderboard are stored (mount a volume here when hosting) |
| `PUBLIC_URL` | none | Your public URL, used for X / social preview cards |

## Research Desk (Nansen Agent)

Hyperliquid lists stock perps (NVDA, INTC, SNDK…), and Smart Money whales trade them. The Research Desk adds Nansen Agent on top of the whale data:

- **Insider Pick of the Day** (top of the Live Floor): once a day, Nansen Agent in Expert mode screens every company ticker listed on Hyperliquid's builder markets for open-market insider buying, preferring filings reported in the last few business days, cross-checked with earnings and valuation. The card shows **where insiders got in** (average filing price, or an estimate from the Hyperliquid daily chart on the report dates), the price now versus the insiders, and how fresh the filings are. Players Follow or Fade over **1 week, 1 month or 6 months**: insiders can't sell for a profit within 6 months (SEC short-swing rule, Section 16(b)), and research on insider purchases finds most of the abnormal return builds over months, not hours.
- **Insider check** on every stock whale card: one tap shows what the company's insiders are doing and whether they point the same way as the whale.
- **Telegram alerts**: when a whale opens a stock perp, the alert includes the insider summary.

Answers are cached and shared by every player (12h per company, one screen per day), so the cost does not grow with traffic. `AGENT_DAILY_CREDITS` (default 1600) caps Agent spend separately from the game's `DAILY_CREDIT_CAP`, and always keeps room for the daily screen. All Agent output is labelled as AI research. Without an API key the desk shows sample research so the layout is still visible.

## Free beta and plans

Everything is free during the beta, with paid plans coming soon. The **Plans** page shows where the Academy is heading, and players can join a waitlist (no payment is taken):

| Plan | What it unlocks |
|---|---|
| Basic (free) | Training Table, dealer's tells, Live Floor bets on all three tables, cash out, whale track records and trust grades, Skill Report, Hall of Fame, Trade on Nansen |
| Premium (paid, price announced at launch) | Everything in Basic plus real-time Telegram whale alerts, add / trim / exit position updates, graded-whale filters, the Insider Pick of the Day and Nansen Agent insider research |

The alert scanner runs once for everyone, so Premium alerts cost the same in Nansen credits whether 10 or 1,000 people receive them.

Download the waitlist as a spreadsheet: open `/admin/waitlist.csv?token=YOUR_ADMIN_TOKEN` in a browser.

## Project layout

```
server.js            zero-dependency HTTP server and API routes
lib/nansen.js        Nansen client: cache, retry and Retry-After handling, call and credit accounting
lib/odds.js          features -> probability -> odds, plus calibration
lib/game.js          rounds, bets, bankroll, live bets, cash out, leaderboard
lib/alerts.js        Whale Alerts scanner, trust-grade rules, Telegram
lib/coach.js         post-hand lessons (tell and trap with weekly signal reliability) and the Skill Report
lib/hyperliquid.js   public prices, candles, positions and fill history (whale exits, Ride the Whale, settlement)
lib/demo.js          demo data in Nansen response shapes
public/              the game UI (vanilla JS, no build): app.js, sfx.js (Web Audio), fx.js (particles)
```

## Disclaimer

Play money only. Results in a game do not guarantee real trading results. Nothing here is financial advice.

## Telegram alerts (optional)

1. In Telegram, message **@BotFather**, send `/newbot` and follow the steps. Copy the token.
2. In the app, open the bell, then **Alert rules & channels → Telegram**. Paste the token and click **Connect**.
3. Open your new bot in Telegram, press **Start**, then click **I pressed Start** in the app. You'll get a test message.

The token is stored only on your machine in `data/alertcfg.json`, which is ignored by git.

## License

Copyright (c) 2026 Avyrion Capital. All rights reserved. You can read, download and run this code to evaluate it (including for the Nansen Meridian Buildathon), but you may not copy, redistribute, host or sell it without written permission. See [LICENSE](LICENSE).
