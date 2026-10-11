# ChainDeck: NIFTY Options Analytics

Formerly Nifty OI Tracker.

A live, auto-refreshing Nifty 50 option chain dashboard showing Change in OI for ±10 strikes around the current ATM strike. Data is pulled directly from NSE India's API.

## Features
- **Real NSE data** — fetches from `nseindia.com` API, same source as Sensibull/NiftyTrader
- **Auto-refresh** — 3s / 5s / 10s / 30s options
- **Change in OI** with inline bar charts for both calls and puts
- **Buildup detection** — Long Buildup, Short Buildup, Long Unwinding, Short Covering
- **PCR bar** — real-time put-call ratio with sentiment indicator
- **Expiry selector** — switch between weekly / monthly expiries
- **All key metrics** — Spot, ATM, PCR, Max Call OI strike (resistance), Max Put OI strike (support)
- **Sortable columns** — click any column header to sort
- **Rolling ATM straddle** — CE + PE premium at each snapshot's ATM strike, against the first value and the running average
- **IV vs realised vol** — ATM IV converted to trading time next to 15 / 30 / 60 minute realised vol from the stored spot series, plus IV percentile against saved session closes (needs 5+ sessions)

---

## Deploy to Vercel (free, takes 3 minutes)

### Step 1 — Push to GitHub
```bash
# If you don't have git initialized:
git init
git add .
git commit -m "initial"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/chaindeck.git
git push -u origin main
```

### Step 2 — Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → Sign up / Log in
2. Click **Add New Project**
3. Import your GitHub repo
4. **No env variables needed** — just click **Deploy**
5. Done! You'll get a URL like `https://chaindeck.vercel.app`

---

## Run locally (for testing)
```bash
npm install
npm start
# Open http://localhost:3000
```

---

## How it works

```
Browser  →  /api/option-chain  →  NSE India API
             (your Vercel backend adds proper headers & cookies)
```

NSE blocks direct browser requests (CORS). The backend proxy:
1. Fetches a session cookie from `nseindia.com`
2. Uses that cookie + browser-like headers to call the NSE option chain API
3. Parses and returns clean JSON to your frontend
4. Caches for 5 seconds to avoid hammering NSE

---

## Notes
- NSE API is only live during market hours (9:15 AM – 3:30 PM IST on weekdays)
- Outside market hours, NSE returns the last EOD snapshot
- If NSE blocks requests temporarily, you may see an error — it auto-retries

---

## History & persistence (optional but recommended)

Each time NSE publishes a new option-chain snapshot (~once a minute) the server stores a compact copy
(series point + per-strike OI/price/IV). That powers the **Intraday Timeline** chart, the 5m/15m rate-of-change
figures (which now survive a page refresh), and end-of-day **session summaries** used by
"Sessions That Looked Like Today" and the IV z-score.

Storage is **Upstash Redis over REST** (no connection pool, no extra dependency):

1. Vercel → your project → **Storage / Marketplace → Upstash Redis → Create** (free tier is plenty:
   ≈1–2 KB per snapshot, ~400 snapshots per trading day).
2. Vercel injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
3. Redeploy. The chip on the timeline card switches from `History: in-memory` to `History: saved`.

Without those variables the app still works; history just lives in memory and disappears on restart / cold start.
Check status any time at `/api/storage-status`.

**Recording while nobody has the page open.** Snapshots are recorded whenever someone's browser polls, and also by
`GET /api/cron/snapshot`. Hit it every minute during market hours (09:15-15:30 IST, Mon-Fri) from an external pinger
(e.g. cron-job.org) or Vercel Cron on a plan that allows per-minute crons (Hobby only allows daily).
The endpoint **requires** `Authorization: Bearer <CRON_SECRET>`. In production it refuses every request (503)
until `CRON_SECRET` is set, and the secret is never accepted in the URL.

Optional env: `NIFTY_LOT_SIZE` (GEX scaling, default 65), `RISK_FREE_RATE` (default 0.065).

---

## Security and privacy

There are no user accounts and no personal data is collected: no cookies, no analytics, no tracking.
What is in place:

- **Nothing third-party loads in the browser.** Fonts (Inter, JetBrains Mono), Chart.js and the PDF/snapshot libraries
  are served from this site (`public/fonts`, `public/vendor`), so visitors' IP addresses are never sent to Google or a CDN.
  Vendored libraries are pinned by hash in `api/verify-security.js`; update them from the official source and re-pin.
- **Strict Content-Security-Policy and friends** (scripts from `'self'` only, no inline scripts, no framing,
  `Referrer-Policy: no-referrer`, `nosniff`, `Permissions-Policy`). The headers live in `api/security.js`;
  `vercel.json` mirrors them for static files and a test fails if the two drift apart.
- **No cross-origin reads.** There is no CORS header; the page and API share one origin.
- **Operational endpoints are authenticated.** `/api/cron/snapshot` and `/api/session-summary` need
  `Authorization: Bearer <CRON_SECRET>`, compared in constant time and failing closed in production.
- **Inputs are validated** (expiry, date, strike) before anything reaches NSE or Redis, and error responses are generic:
  details go to the server log only.
- **Rate limiting** (per IP, in memory per serverless instance) is a speed bump. For a hard limit add a rate-limit
  rule in the Vercel Firewall.
- **Dependencies:** `npm audit` is clean; the app uses `express`, `node-fetch` and `dotenv` only.
- Run `npm test` (includes `verify-security.js`) after any change. If you find a vulnerability, please open a
  private security advisory on GitHub rather than a public issue.

Rotate `CRON_SECRET` (Vercel env var + the pinger's header) if it is ever exposed.

---

## File structure
```
chaindeck/
├── api/
│   └── index.js        ← Backend proxy (runs on Vercel serverless)
├── public/
│   └── index.html      ← Frontend dashboard
├── package.json
├── vercel.json         ← Vercel routing config
└── README.md
```
