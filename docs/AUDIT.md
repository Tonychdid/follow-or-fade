# Follow or Fade — pre-recording security & bug audit

**Date:** 19 Sep 2026 · **Method:** code review of every finding, plus live attack tests against a running server in both local and `PUBLIC=1` configurations. Nothing below is taken on trust from a report — each item was reproduced or disproved directly.

---

## Fixed

### 1. Watches died permanently after a restart — HIGH
`w.busy` is an in-flight guard set inside `checkOne()`. But `pushExitAlert()` calls `save('alertwatch', watches)` from *inside* that function, so any watch that had just fired an alert was written to disk with `busy: true`. On the next boot it loaded back as `true` and `checkOne()` returned immediately — **for ever**.

The watches this hit were precisely the ones that had sent a signal, i.e. the ones players hold bets on. Their whale could close the position and no exit alert would ever fire.

**Fix:** `busy` is stripped on load, next to the existing `pending` cleanup. It is in-flight state, never persisted state.

### 2. A failed Hyperliquid call could mis-resolve BTC for 10 minutes — HIGH
`symbolMap()` walks the main dex first so a builder-dex listing can never shadow real `BTC` or `ETH`. But if the **main** `allMids` call failed while a builder dex answered, the resulting partial map was still cached for 10 minutes — and in that map a builder-dex `xyz:BTC` *does* shadow real BTC. Every price, position read and exit check for that symbol would use the wrong market until the cache expired.

**Fix:** only cache a map the main dex contributed to. If the main dex is down, prefer the previous (main-built) map over a fresh builder-only one.

### 3. One lucky all-in could own the Hall of Fame — MEDIUM
The board ranked on net profit with no minimum. A single all-in win pays ~+$16,000 net on one hand, and `POST /api/player` is free — so a few hundred throwaway identities shoving once each would fill all 25 slots with coin flips. That matters because board position is what gates Premium testing access.

**Fix:** a player qualifies after **3 settled hands** (`BOARD_MIN_BETS`, configurable). Raises the sybil cost ~8× and, more usefully, makes the board reward reading the tells rather than sample size. Verified: 0 rows after 1 and 2 bets, 1 row after the 3rd.

### 4. Stale comment and stale docs
The cash-out quote comment still named the old 48h backstop (it is 72h), and the README still described "the live tables are 4 hours or Ride the Whale" after the fixed tables were removed. Both corrected.

---

## Checked and found **not** to be problems

| Claim | Verdict |
| --- | --- |
| Ride cash-out is priced against a 6h horizon while the bet settles at 72h | **Correct as designed.** A ride ends when the whale closes, not at the backstop. Pricing it against 72h would drag every quote toward the prior — losers buying back above fair value, winners below. The code says so and the reasoning holds. |
| `X-Forwarded-For` lets a client forge its rate-limit bucket | **No.** The code takes the **last** hop, which is the only one the proxy writes, and deliberately ignores `x-real-ip`. Correct for the Railway deployment. (It would be forgeable if `PUBLIC=1` ran with no proxy in front — not the deployed configuration.) |
| `unverifiedOnSend` is written but never read | **True but harmless.** A dead field in the JSON, no behavioural effect. Left in place as forensic data. |

---

## Verified clean

**Game integrity — the outcome never reaches the client before the call.** This is the one that would break everything: every training hand is a *finished* trade, so the answer exists server-side the moment it is dealt.
- `/api/round` sends coin, side, size, entry, tells and odds. The outcome (`exit`, `ret`, hold time) stays in the server's `rounds` map.
- The whale's **wallet address is withheld** — no `0x…` anywhere in the payload, so it can't be looked up on Hyperliquid either.
- The landing teaser and challenge links send the **day only**, never the exact timestamp: coin + side + size + a to-the-second time would be enough to find that fill and read the ending.
- Replaying your own challenge link back at yourself is blocked.

**Money paths** — every one rejected:

| Attack | Result |
| --- | --- |
| Negative stake | `Invalid stake`, bankroll unchanged |
| Stake above bankroll | `Invalid stake` |
| `"1e999"` / non-numeric stake | `Invalid stake` |
| Betting on another player's round | `Round expired` |
| Betting the same round twice | `Round expired` |
| Both FOLLOW and FADE on one round | `Round expired` |

**Access control** (`PUBLIC=1`, `ADMIN_TOKEN` set): `/api/usage` 403 · `/api/alerts/scan` 403 without a token, 200 with · `/admin/usage.json` 403 on a wrong token. Token comparison is `timingSafeEqual` over SHA-256 of both sides, so it is constant-time and immune to the length-mismatch throw.

**Path traversal:** `/../server.js`, `/..%2fserver.js`, `/%2e%2e/server.js`, `/../../etc/passwd`, `/../.env`, `/data/players.json` — all 404. `legal-full.html` correctly 404s while `SHOW_LEGAL` is off.

**Rate limiting:** `POST /api/player` (cost 20, 240/min) allowed 9 then returned 429 for the rest, per IP, with the one-minute debt floor working as intended.

**Headers:** CSP (`script-src 'self'`, no `unsafe-inline`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin` — all present.

**XSS:** player names are sanitised server-side to `[A-Za-z0-9_ .-]{0,18}`, so no user-supplied string can carry markup. Coin symbols come from Nansen/Hyperliquid and are escaped at most interpolation sites; the few that aren't are inert under the CSP, since it blocks inline event handlers. Worth tidying for consistency after the buildathon, not a live hole.

**Front end:** desktop / tablet / mobile — a full training hand played, all views opened, **no page errors, no console errors, no horizontal overflow** at 360 / 390 / 430 / 768 / 1100 / 1440px. (Premium is reached from the footer on tablet and mobile by design; the bottom nav's five slots are the game itself.)

---

## Measurement: the 45-minute alert gate was costing signals

`scan()` dropped any trade older than 45 minutes. It was never the dedupe (`seen`, persisted in `alertseen.json`, handles that across restarts) — it was a proxy for "is this still actionable?", written before `stillOpen()` existed.

**Measured against 137 resolved $50k+ trades from one week**, entering late does not hurt the player:

| Entry delay after the whale's open | Mean player return | Win rate | Median drift from entry |
| --- | --- | --- | --- |
| 0 min (the whale's exact price) | 2.38% | 55% | 0% |
| 45 min | 2.69% | 55% | +0.01% |
| 2 h | 2.94% | 56% | −0.06% |
| 4 h | 3.16% | 54% | −0.18% |

Return *rises* slightly with delay and the median price is still within 0.2% of the whale's entry four hours later — "the price ran away" essentially does not happen. Measured holds are p50 17.2h, so a 45-minute-old open has used ~4% of a typical hold.

A price-drift gate was considered and **rejected on this evidence**: bucketing by how far a trade had already run showed higher returns at higher drift, not lower, and the odds engine already prices lateness through `oddsEngine.lateFeature`. Adding a hard gate would have blocked trades with no evidence of harm.

**Changed:** lookback 1h → 6h (`ALERT_LOOKBACK_HOURS`), age cap 45min → 4h (`ALERT_MAX_AGE_MIN`), plus a per-scan cap (`ALERT_MAX_PER_SCAN`, default 5) and a warm start that adopts the window without alerting on a first boot with empty `seen`. Measured live at the moment of the change: the old settings would have sent **1** alert, the new ones **7**, for the same 5-credit scan.

## Second pass — re-run against the final build (20 Sep)

The audit above was written before the alert-gate change, the `openDialog` fix and the four mobile
fixes. Everything below was re-run against the code as shipped.

**Server:** every `.js` file parses. Money paths all rejected — negative stake, stake above bankroll,
`"1e999"`, betting on another player's round, replaying a round, taking both sides. Path traversal
(`/../server.js`, `/..%2fserver.js`, `/%2e%2e/server.js`, `/../../etc/passwd`, `/../.env`,
`/data/players.json`) all 404, and `legal-full.html` still 404s with `SHOW_LEGAL` off. Under
`PUBLIC=1`: `/api/usage` 403, `/api/alerts/scan` 403 without a token and 200 with, `/admin/usage.json`
403 on a wrong token. Rate limiter allowed 8 then returned 429. All four security headers present.

**Front end**, at 360 / 390 / 412 / 768 / 1100 / 1440 px — a full training hand played and settled at
every width, every view opened, and:

| | result |
| --- | --- |
| page errors | **0** |
| console errors | **0** |
| horizontal overflow (all views) | **0 px** |
| grade dialog scroll position on open | **0** (top) |
| plans order | PREMIUM → PLUS |

**The new alert-scan code**, exercised end to end:
- Warm start: first scan on an empty `seen` adopted 5 trades and sent **0** alerts, persisting
  `alertseen.json` with 5 entries.
- Per-scan cap: with `ALERT_MAX_PER_SCAN=2` the scans produced **2 → 2 → 0**; with `5` they produced
  **4 → 0 → 0**. Four alerts either way, so the cap throttles delivery without dropping anything —
  the overflow stays unseen and goes out on the next scan.

## Known, deliberately not fixed before recording

`public/style.css` has **90 duplicated (media-query, selector) keys** out of 1,064. Only **8** are
byte-identical dead weight; the other **82 have different bodies**, so the rendered result depends on
their cascade order — a later block partially overriding an earlier one. Two of those overlaps caused
real bugs (the mobile chip row spilling onto the stake input, and a duplicated `.grade-chip::after`),
and both are fixed at source. Merging the remaining 82 is a refactor whose only honest validation is
re-checking every affected component at every width, so it belongs after the deadline, not the night
before it.

## Gotcha worth knowing

`server.js` calls `loadEnv(ROOT)` **before** it imports `lib/nansen.js`. Any standalone script that imports `lib/nansen.js` directly without calling `loadEnv` first will find `NANSEN_API_KEY` unset, so `isDemo()` returns **true** and the script silently measures the demo generator while looking exactly like a live run. Every analysis script must start with:

```js
import { loadEnv } from './lib/env.js';
loadEnv(process.cwd());
const nansen = await import('./lib/nansen.js');   // dynamic: must evaluate AFTER loadEnv
if (nansen.isDemo()) throw new Error('not live');
```

The demo data is realistic enough to fool a reader — its tell is evenly spaced timestamps sharing an identical millisecond.

## Open, not blocking the recording

- **`legal-full.html` still contains a `[LEGAL NAME]` placeholder.** It 404s while `SHOW_LEGAL=0`, so nothing leaks — but fill it before ever setting `SHOW_LEGAL=1`.
- **Coin-symbol escaping** is inconsistent across ~15 interpolation sites. Inert under the current CSP; tidy later.
- **`PUBLIC=1` with no reverse proxy** would make the rate-limit bucket client-controllable. Not the Railway setup; worth a line in DEPLOY.md if anyone else self-hosts publicly.
