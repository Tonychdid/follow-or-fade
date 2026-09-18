# Put Follow or Fade online (Railway, about 15 minutes)

This gives you a public link like `https://follow-or-fade-production.up.railway.app` that anyone can play. Your Nansen key stays on the server; visitors never see it.

**Cost:** Railway's Hobby plan is $5/month, which includes $5 of usage. This app uses very little.

## 1. Update GitHub first
Upload the latest files to `github.com/tonychdid/follow-or-fade`. Railway builds from the repo and redeploys automatically every time you commit.

## 2. Create the Railway project
1. Go to **https://railway.com** and click **Login → Login with GitHub**.
2. Click **New Project → Deploy from GitHub repo**.
3. If asked, click **Configure GitHub App** and give Railway access to the `follow-or-fade` repository.
4. Select **follow-or-fade**. Railway starts building (it detects Node.js and runs `npm start`).

## 3. Add the settings (Variables)
Click the service → **Variables** tab → **New Variable**, and add each one:

| Name | Value | Why |
|---|---|---|
| `NANSEN_API_KEY` | your Nansen key | live Nansen data |
| `PUBLIC` | `1` | turns on public-site protections |
| `ADMIN_TOKEN` | a long random password you invent (e.g. 30+ letters and numbers) | lets only you change alert rules and Telegram |
| `RIDE_MAX_HOURS` | `48` | optional: longest a Ride the Whale bet can stay open |
| `AGENT_DAILY_CREDITS` | `1600` | optional: daily credits for Nansen Agent research (1 daily Insider Pick + ~4 company checks) |
| `DAILY_CREDIT_CAP` | `5000` | max Nansen credits per day; above it the site uses cached data and demo whales until midnight UTC |
| `DATA_DIR` | `/data` | where bankrolls, bets and the leaderboard are saved |

## 4. Add a volume (so data survives redeploys)
1. In the project canvas, right-click the service (or press **Ctrl+K**) → **Add Volume**.
2. Mount path: **`/data`**.

## 5. Get your public link
1. Service → **Settings → Networking → Generate Domain**.
2. Copy the URL, go back to **Variables** and add `PUBLIC_URL` = that URL (for example `https://follow-or-fade-production.up.railway.app`). This makes the preview card with the image show up when you post the link on X.
3. Railway redeploys automatically. Open `YOUR_URL/health`: it should say `{"ok":true}`.

## 6. Manage your alerts (only you)
Set `ADMIN_TOKEN` to a long random string. With it set, the admin routes are closed to everyone else **even if `PUBLIC` is ever missing** — a redeploy that drops an environment variable can't expose your waitlist.

Open **`YOUR_URL/?admin=YOUR_ADMIN_TOKEN`** once in your browser. The token is saved in that browser and removed from the address bar. The bell now shows the full alert settings and Telegram setup. Visitors only see the alerts.

## 6b. Connect Telegram (optional)
Bell → **Telegram** → paste the bot token from **@BotFather** → **Connect**. The app shows a short **pairing code**. Open your bot in Telegram, press **Start**, send it that code, then press **I sent the code**. The code is what ties the alert stream to *your* chat: without it, anyone who guessed your bot's username and messaged it first could have captured your alerts.

## 7. Download your waitlist
Open `YOUR_URL/admin/waitlist.csv?token=YOUR_ADMIN_TOKEN` in your browser. It downloads a spreadsheet with every email, the plan they picked and the date. Open it with Excel.

## Good to know
- **Logs:** service → **Deployments → View logs**. You'll see "Mode: LIVE Nansen API" and "Public mode".
- **Credits:** with the site open 24/7, background odds training and the whale scanner use roughly 2,000–3,000 credits a day, plus a few credits per training hand played. To leave more of a 5,000 cap for players, set the alert scan to every 10 minutes (bell → Alert rules), which saves about 700 credits a day. Check usage at https://app.nansen.ai/api.
- **Updating:** upload new files to GitHub → Railway redeploys in about a minute.
- **Privacy:** the site sets no cookies, runs no analytics, and loads no third-party resource — typefaces are served from `public/fonts/`, so a visitor's browser never contacts Google or anyone else. Waitlist emails are collected under an explicit unticked consent box, stored with the exact wording agreed and a one-click removal link, and deletable by the person without contacting you.
- **Before you promote the site:** fill in every `[BRACKETED]` placeholder in `public/legal.html` — the data controller's name and the contact address are required before you collect a single email.
- **Security:** in public mode the app rate limits per client IP (using the address your proxy appends, which a visitor can't forge), sends a Content-Security-Policy and HSTS, caps stored players, and keeps alert rules, Telegram and the waitlist behind `ADMIN_TOKEN`.
- **Custom domain (optional):** buy one (e.g. on Namecheap), then Settings → Networking → Custom Domain and follow Railway's DNS instructions. Update `PUBLIC_URL` to match.
