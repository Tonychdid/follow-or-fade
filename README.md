# FOLLOW or FADE

**Bet on Smart Money.** Real Hyperliquid trades opened by Nansen's Smart Money. You get $10,000 in play money. Follow the whale or fade it. **Nansen data sets the odds. The market settles the bet.**

Built for the Nansen Meridian Buildathon.

---

## Run it in under 5 minutes

Requirements: [Node.js 18+](https://nodejs.org). No `npm install`, no build step, zero dependencies.

```bash
git clone https://github.com/tonychdid/follow-or-fade.git
cd follow-or-fade
cp .env.example .env        # then paste your key: NANSEN_API_KEY=...
npm start                   # opens on http://localhost:3000
```

Windows: double-click `start.bat`. On first run it asks for your key and writes `.env`.

No key yet? Leave `NANSEN_API_KEY` empty and the app runs in **demo mode**: Nansen-shaped sample wallets on top of real Hyperliquid prices, with a `DEMO DATA` badge.

---

## How it plays

| Mode | What happens |
|---|---|
| **Replay** | You're dealt a real Smart Money position open from the last 7 days (coin, side, size, entry). The wallet is hidden. You see the Nansen intel, the model's probability and the odds. Stake, pick **Follow** or **Fade**, and the app reveals the next 4 hours of price, the wallet and your payout. |
| **Live** | Smart Money opens from the last 6 hours, with where Smart Money is positioned on that coin right now. Bet on what happens next over 15m, 1h or 4h. The bet settles on the Hyperliquid mid price. One click opens the market on Hyperliquid if you want to take the trade for real. |
| **Leaderboard** | Bankroll ranking, win rate, best streak, **whales slain** (correct fades of trades the model favored). |
| **Share card** | One-click PNG plus a prefilled X post. |

Go below $10 and you're **REKT**: the bankroll resets and a bust is recorded.

---

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
        └─ self-calibrates hourly on this week's resolved Smart Money trades
Hyperliquid candles (public API) ──► settles every bet, fairly, after the horizon
```

- **Point-in-time, no look-ahead:** every feature uses only data from *before* the trade was opened.
- **Server-side outcomes:** the result is computed on the server and only revealed after the bet, so you can't peek in the network tab.
- **Self-calibrating odds:** each hour the app resolves a sample of this week's Smart Money opens and refits the model, with an L2 pull toward a sensible prior so small samples stay stable. The sidebar shows how many trades the odds were trained on and what share of Smart Money opens were actually in profit after 4h.

### Nansen endpoints used

| Endpoint | Credits | Used for |
|---|---|---|
| `POST /api/v1/smart-money/perp-trades` | 5 | Round pool (7d) and live feed (2h) |
| `POST /api/v1/profiler/perp-pnl-summary` | 1 | Wallet track record before the trade |
| `POST /api/v1/perp-screener` (`trader_type: sm` and `all`) | 1 | Smart Money vs crowd net flow, funding, and current Smart Money long/short positioning (live) |

Credit use is kept low with caching: history windows are cached, and the live feed is cached for 2 minutes. The sidebar shows real API calls and credits used.

---

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `NANSEN_API_KEY` | – | Your key from https://app.nansen.ai/api |
| `PORT` | 3000 | Web port |
| `HORIZON_HOURS` | 4 | How long after entry replay bets settle |
| `CALIBRATION_SAMPLE` | 60 | Trades resolved per hourly calibration run |
| `DEMO` | 0 | `1` forces demo data |

## Project layout

```
server.js            zero-dependency HTTP server and API routes
lib/nansen.js        Nansen client: cache, retry and Retry-After handling, call and credit accounting
lib/odds.js          features -> probability -> odds, plus calibration
lib/game.js          rounds, bets, bankroll, live bets, leaderboard
lib/hyperliquid.js   public price and candle API used for settlement
lib/demo.js          demo data in Nansen response shapes
public/              the game UI (vanilla JS, no build)
```

## Disclaimer

Play money only. Nothing here is financial advice.
