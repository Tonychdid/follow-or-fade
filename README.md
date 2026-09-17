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
| **Training Table** (replay) | You're dealt a real Smart Money position open from the last 7 days (coin, side, size, entry). The wallet is hidden. You see the Nansen intel, the model's probability and the odds. Stake, pick **Follow** or **Fade**, and the hand is **judged on the whale's real exit**: the app follows the whale's own position until it's fully closed (size-weighted exit of every reduction), capped at 24h and marked to market if they're still holding. The reveal shows the price path up to the exit, how long the whale held, the wallet and your payout. **What the data said:** after every hand the coach names *the tell* (the Nansen signal that called it) and *the trap* (the one that misled), with how reliable each signal was this week across hundreds of resolved Smart Money trades. |
| **Skill Report** | Every bet stores the Nansen signals you acted on. Only decisions that match how whales actually trade count: training hands, 4-hour and Ride the Whale bets (15-minute bets are just for fun). The report shows your win rate against what the odds expected (your **edge**), your **strengths** and **leaks** across 10 tracked patterns (following A/B-grade whales, fading crowded trades, siding with Smart Money flow, taking underdogs…), coach advice, and a level ladder: *Rookie → Learning the tells → Sharp reader → Ready for real trades*. |
| **Live Floor** | Smart Money opens from the last 6 hours, with where Smart Money is positioned on that coin right now. Pick a table: **Espresso Shot (15 min, just for fun)**, **Cigar Lounge (4 hours)** or **Ride the Whale**, where your bet ends **when that whale closes the position** (max 24h), tracked live from their Hyperliquid fills. Timed bets settle on the price at the exact bell (1-minute candle), so they settle correctly even if the app was closed. Each whale shows a **7D and 30D track record** from Nansen (realized PnL, return, win rate, best and worst coin) and a **trust grade** (A+ to F). One click opens the market in **Nansen's trading app** if you want to take the trade for real. |
| **Your Table** (always on screen) | Only your open live bets, grouped by table, with countdown rings and a live meme face: a money-printing face when you are winning and a crying face when you are losing, getting more intense as the bet moves. Settled bets move to Recent hands. |
| **Cash Out** | End a live bet early. The offer is the bet's fair value: stake × odds × the probability you are still winning at the bell, starting from the probability the odds were priced at and updated with how far price has moved, the time left and the coin's current 1-minute volatility on Hyperliquid, with no extra fee beyond the 3% house edge built into the odds. Cashing out the second you bet returns about 97% of your stake. Cash out in profit: *"The whale is my exit liquidity."* Cash out at a loss: *"Cashing out before the whale gets rekt."* |
| **Whale Alerts** (bell icon) | A background scanner checks Nansen Smart Money perp opens every few minutes, grades each whale's 7D and 30D track record, and alerts you when a top whale opens a trade. Default rules: grade A or better, 55%+ win rate, profitable over 30D, $50K+ position, and **3+ coins traded in 7D and 5+ in 30D** so win rates can't be inflated by one-coin wallets. **Specialists** are the exception: a whale trading only 1–2 coins still gets through, tagged SPECIALIST, if the coin they're opening is one of their main coins (40%+ of their closes) with $25K+ realized profit and a 3%+ return on it over 30D, and no losing week on it. You get a sound, an on-screen alert, optional desktop notifications and optional **Telegram** messages. Each alert has **Bet on it** (jumps to the trade, pinned at the top of the Live Floor) and **Join on Nansen** (opens the market in Nansen's trading app). |
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

- **Point-in-time, no look-ahead:** every feature uses only data from *before* the trade was opened.
- **Server-side outcomes:** the result is computed on the server and only revealed after the bet, so you can't peek in the network tab.
- **Self-calibrating odds:** each hour the app resolves a sample of this week's Smart Money opens (on the whale's real exit, max 24h) and refits the model, with an L2 pull toward a sensible prior so small samples stay stable. The sidebar shows how many trades the odds were trained on and what share of Smart Money opens were actually in profit when the whale exited.

### Nansen endpoints used

| Endpoint | Credits | Used for |
|---|---|---|
| `POST /api/v1/smart-money/perp-trades` | 5 | Round pool (7d), Live Floor feed (6h) |
| `POST /api/v1/profiler/perp-pnl-summary` | 1 | Wallet track record before the trade (odds), plus 7D and 30D whale track record and trust grade (live) |
| `POST /api/v1/smart-money/perp-trades` (1h lookback) | 5 | Whale Alerts scanner (every 2–30 min, configurable) |
| `POST /api/v1/perp-screener` (`trader_type: sm` and `all`) | 1 | Smart Money vs crowd net flow, funding, and current Smart Money long/short positioning (live) |

Credit use is kept low with caching: whale and market data are cached per hour, and the Live Floor feed for 15 minutes. The sidebar shows real API calls and credits used.

---

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `NANSEN_API_KEY` | – | Your key from https://app.nansen.ai/api |
| `PORT` | 3000 | Web port |
| `MAX_HOLD_HOURS` | 24 | Training hands are judged on the whale's real exit, capped at this many hours |
| `CALIBRATION_SAMPLE` | 60 | Trades resolved per hourly calibration run |
| `DEMO` | 0 | `1` forces demo data |
| `DAILY_CREDIT_CAP` | none | Max Nansen credits per UTC day. Above it the app serves cached data and demo whales, and pauses odds training and alerts |
| `PUBLIC` | 0 | `1` for a public deployment: per-IP rate limits, alert rules and Telegram become admin-only |
| `ADMIN_TOKEN` | none | With `PUBLIC=1`, open `/?admin=TOKEN` once to manage alerts |
| `DATA_DIR` | `data` | Where bankrolls, bets and the leaderboard are stored (mount a volume here when hosting) |
| `PUBLIC_URL` | none | Your public URL, used for X / social preview cards |

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
