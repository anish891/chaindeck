# ChainDeck: NIFTY and SENSEX Options Analytics

A live NIFTY 50 options dashboard. ChainDeck reads the NIFTY option chain from the Upstox API during market hours and turns it into
open interest structure, gamma exposure, volatility, positioning and intraday history in one page, with alerts and
a plain-language explanation for every number.

ChainDeck is for information and education only. It does not give investment advice, tips or recommendations.

---

## At a glance

- **Key numbers strip** (stays on screen while you scroll): spot, ATM strike, day change, PCR, India VIX, max pain,
  implied future, market regime and the age of the data.
- **Index picker:** NIFTY 50 or SENSEX (also `?index=sensex` in the address; the choice is remembered in this browser).
- **Expiry selector** for every open weekly and monthly expiry.
- **Live over a WebSocket:** prices tick as they change (cells flash green or red), the full analytics refresh about
  every 5 seconds, and nothing on the page polls. A status light shows connected, reconnecting or offline, with the time
  of the last tick; while the connection is down the last values stay on screen, marked stale.
- **Light, dark or system theme.**

---

## Market reading

### Composite Market Regime
A single label for the kind of day it looks like (for example rangebound or trending), built from gamma exposure,
PCR, CPR width, IV skew and where spot sits against max pain. A "signal agreement" score shows how many of those
readings point the same way, and a bias badge summarises the direction.

### Live Trade Setup
An automatic summary of today's bias, key target, invalidation level and the strategy type that suits current
conditions, derived from CPR, the zero-gamma level, PCR rate of change and the straddle range.

### Smart Money Flow
A ticker of strikes where volume or open interest jumped far above that strike's own recent pace (scored as a
z-score). Only back-to-back snapshots are compared, so gaps in the data do not raise false alarms.

---

## Metric cards

| Card | What it shows |
|---|---|
| **Price & Range** | Spot, ATM strike, expected range to expiry and the ATM straddle price |
| **Sentiment & Bias** | PCR by OI, near-the-money PCR, volume PCR, PCR rate of change over 5 and 15 minutes, 25-delta IV skew and a volatility regime badge (ATM IV against recent sessions, or India VIX when there is not enough history) |
| **Open Interest & Velocity** | Total call and put OI, change on the day, and OI rate of change over 5 and 15 minutes |
| **Key Levels** | Max pain, the largest call and put OI strikes with their share of total OI, and the top three call and put walls |
| **Central Pivot Range** | Pivot, top and bottom CPR, CPR width and type (narrow, normal or wide), and R1, R2, S1, S2 from the previous session's real high, low and close |
| **Gamma Exposure (GEX)** | Net dealer gamma exposure in crores per 1% move, call and put GEX, the gamma regime and the zero-gamma level with its distance from spot |
| **Sessions That Looked Like Today** | The closest past sessions by PCR, gamma regime, CPR width, IV skew and OI change, with a similarity score (each difference is measured in units of that feature's typical spread, so a large PCR change really lowers the match) |

---

## Charts and panels

### OI Structure by Strike
Call and put open interest at every strike, with markers for spot, max pain and the main call and put walls.
Switch the view to see:
- open interest
- change in OI against the previous close
- OI change over the last 5, 15 or 30 minutes
- OI change since the first snapshot of the day

Click any bar to open that strike's drill-down.

### Rolling ATM Straddle
The ATM call plus put premium at every snapshot, always at whichever strike is at the money at that moment,
against the day's first value and the running average. The summary shows the current straddle, ATM strike,
change against the open and the day average, and the day's range.

### IV vs Realised Volatility
ATM implied volatility next to realised volatility over the last 15, 30 and 60 minutes. The summary shows ATM IV,
the calendar-basis ATM IV, each realised vol window, the gap between IV and 30-minute realised vol, and an IV percentile
against saved session closes.

### Intraday Timeline
Spot through the day with one overlay on a second axis: PCR, volume PCR, ATM straddle, ATM IV, IV skew, India VIX,
net GEX, total call OI or total put OI.

### Sector Heatmap
Today's percentage move for 16 NSE sector indices (Bank, Private Bank, PSU Bank, Financial Services, IT, Auto,
FMCG, Pharma, Healthcare, Metal, Energy, Oil & Gas, Realty, Media, Consumer Durables and Infrastructure), sorted
from strongest to weakest, with how many stocks in each are up and down. NIFTY 50 breadth (stocks up against down)
sits above the tiles. It updates live while the page is open.

### Price, Levels and Patterns
A candlestick chart of NIFTY (5 minute, 15 minute or daily) with the following layers, each switchable:
- **Support and resistance zones** drawn as shaded bands, darker when stronger.
- **VWAP**, restarting each session.
- **Volume** and a **volume profile** (point of control and value area).
- **Pattern markers** for candlestick and chart patterns.

NIFTY itself has no volume, so volume comes from the Nifty 50 ETF (NIFTYBEES) as a proxy. That is a proxy: it also
includes arbitrage and creation or redemption activity.

### Support and Resistance Ladder
Every level the app can justify is collected with a weight and merged into zones. A zone is stronger when different
kinds of evidence land on the same price:

| Family | Levels |
|---|---|
| Options | Largest call and put OI walls, max pain, zero-gamma level |
| Prior sessions | Previous day high, low and close, previous week high and low, CPR and pivots |
| Chart structure | Day high and low, recent swing highs and lows |
| Volume | VWAP, volume point of control, value area edges, high volume nodes |
| Round numbers | Multiples of 500 and 100 |

Strength is a score out of 100, not a probability. Each zone also tracks today's behaviour: untested, held (touched,
with closes staying on its side, shown as "Held 3/4"), tested but not held (touched, closes went into it without
breaking it) or broken (closed through). Only a zone that actually held counts as price evidence for a buying or
selling interest zone.

### Reversal Signals and buying / selling interest zones
- **Patterns detected:** hammer, inverted hammer, shooting star, hanging man, bullish and bearish engulfing, piercing
  line, dark cloud cover, bullish and bearish harami, morning and evening star, tweezer tops and bottoms, doji at an
  extreme, double top and bottom, head and shoulders (and inverse), and failed breakouts (liquidity sweeps). A reversal
  pattern only counts when there was a trend to reverse.
- **Confluence score (0 to 100)** from four families of evidence: the pattern, whether it formed at a strong zone,
  volume expansion on the ETF proxy, and option evidence (put writing or call unwinding for bullish; call writing or put
  unwinding for bearish). A signal is only called confirmed when at least two families agree.
- **Each signal shows** the trigger, the invalidation level, the nearest opposing zone as a target, the evidence and
  the pattern's own history.
- **Buying and selling interest zones** are support and resistance zones where at least two families of evidence agree.
  This is evidence consistent with buying or selling pressure. No data source says who actually bought or sold.

### Level scorecard (measured weights)
Each kind of level is tested on the last 60 sessions of 5 minute candles. A touch is price reaching a level after being
clearly on one side. A bounce is moving half an ATR away before closing a quarter ATR through it. Arbitrary price points
are put through the identical test as a baseline, and a level type is only called "respected" when its bounce rate and
95 percent range clearly beat that baseline with at least 30 touches. Types that beat it get up to 50 percent more weight
in the ladder, types that do worse get 40 percent less, and everything else keeps its default weight. Option OI walls,
max pain and zero gamma cannot be measured this way (no historical option chains) and are tracked in the live record.

### Pattern reliability (backtest)
Every detector is run over the last 60 sessions of 5 and 15 minute candles, and five years of daily candles. Entry is the
open of the candle after the pattern, and a hit means the close, a fixed number of candles later, is beyond the entry in
the pattern's direction. Intraday trades must finish inside the session. Results are compared with a **baseline** (how
often any candle moved that way), with a 95 percent Wilson confidence interval. A pattern is labelled "edge" only with
at least 30 samples and a lower bound above the baseline. Most patterns show no clear edge, and the panel says so.

### When do patterns work? (conditional backtest)
The same pattern history is split by conditions known at the moment the pattern completed: time of day (first hour,
midday, last hour), the kind of day so far (trending or ranging, judged only from the session up to that candle), and
level context (stacked levels, one level, open space, using levels that can be rebuilt for any past day). Each
condition is judged on its own, to avoid false positives from slicing 60 sessions many ways, and is compared with how
often ANY candle in the same condition moved the same way, so time-of-day drift cannot pass for skill. A condition only
changes a signal's score (+6 if clearly better than usual, -10 if clearly worse) with at least 30 samples. When nothing
stands out, which is the current result, no condition changes anything.

### Advanced analytics (collapsible)
- **ATM Straddle and Expected Move:** call and put legs, total straddle, change against the previous session,
  decay status, expected move to expiry and per day, and the upper and lower range bounds.
- **Market-Implied Expiry Probability:** the probability distribution of the expiry close implied by option prices
  across strikes, with the most likely level.
- **Intraday Trend and Breakout Scoring:** a 15 to 30 minute directional score and the balance between breakout and
  rangebound conditions.

---

## Data trust

A light in the top bar (Verified, warnings or failing) opens a drawer listing every data check. Nothing here can prove
the data provider itself is right; it shows the numbers are fresh, agree with a second feed and are internally consistent.

| Check | What it does |
|---|---|
| Option chain current | Age of the snapshot (the index's last trade time on Upstox): amber after 90 seconds, red after 3 minutes (while the market is open) |
| Leftover copy | Red while trading if Upstox did not answer and the last good copy is being shown, with the reason; a warning only after the close |
| Snapshots changing | Warns if 3 consecutive new option chain snapshots carry identical contents, fails at 5 (a feed that is "refreshing" but frozen) |
| Candles current, saved snapshots current | Latest candle lag and the per-minute recorder, as in the Feeds chips |
| Saved history complete | Minutes saved today against minutes since the open (a warning at most; skipped without storage) |
| Chain spot vs candles | The option chain's spot and the latest candle (a separate feed) agree within 0.15 percent (warn) or 0.4 percent (fail) |
| Totals, PCR, max pain, ATM | Recomputed straight from the raw option chain payload with separate code and compared with what the page shows |
| Put-call parity | Strikes near the money should imply the same forward; outliers point to stale quotes |
| Basis, IV, day range | Implied future near spot, ATM IV in a plausible band, spot inside the day range |

Before anything is cached, each option chain payload is validated (plausible spot, no negative or non-numeric values, enough rows, no
jump of more than 8 percent between snapshots, not older than the copy already held). A payload that fails is rejected
and the last good copy is kept and flagged.

When a blocking check fails, the top bar turns red, a banner explains why, affected cards are outlined as unverified,
and signals, browser alerts and the live track record all pause until the check clears. Warnings are shown but do not pause anything.

## Option chain

- ±10 strikes around the ATM strike, with the ATM row highlighted.
- Change in OI, OI, IV, LTP and bid/ask for calls and puts, with inline bars.
- Buildup colouring for every leg: long buildup, short buildup, long unwinding and short covering, from the last few
  snapshots of that contract (or the day's change when nothing has moved yet). Put labels are read from NIFTY's side
  (put writing shows as long buildup), so green is bullish and red bearish on both sides.
- Optional Delta and Theta columns.
- Sort by any column; an arrow marks the sorted column and direction.
- Click a strike to open its drill-down.

### Strike drill-down
A side drawer with one strike's call and put open interest, premium and IV across the day. On phones it can be
swiped closed.

---

## Alerts

Alerts fire only when something changes, not while a condition simply holds, and every alert type has a buffer
so a value hovering around a threshold does not fire repeatedly.

| Alert | Fires when |
|---|---|
| PCR zones | PCR moves above 1.2 or below 0.8 (both adjustable) |
| Key levels | Spot crosses the CPR top or bottom, the zero-gamma level, or the main call or put wall |
| Wall shifts | The largest call or put OI strike moves to a new strike |
| Gamma flip | Net GEX changes sign |
| Regime change | The composite regime label changes (off by default) |
| Unusual flow | A strike shows a volume or OI spike |
| Momentum | Spot moves 0.3% or more within 5 minutes (adjustable) |
| VIX spike | India VIX is up 5% or more on the day (adjustable) |
| Reversal signal | A new strong, confirmed pattern signal appears on the chart (once per signal) |
| Nearing a level | Price itself moves to within about half an ATR of a zone with strength 70 or more (adjustable). Zones appearing, shifting or re-clustering around a price that has not moved do not count, nothing fires after the close, and it re-arms after price moves well away |

Each alert type can be switched on or off. Alerts are kept in a log behind the bell icon and can also appear as an
on-page pop-up, a sound or a desktop notification. You can choose the lowest severity that interrupts you, set a
cooldown and snooze everything. Settings and the log are stored only in your browser.

---

## Explanations in English and Hindi

Every panel and key metric has a small help button. It opens a short explanation of what the number means and how
traders read it, with an English and हिन्दी toggle. The language choice is remembered.

---

## Export

- **Option chain (CSV)**
- **Analytics summary (PDF)**: the full dashboard as multi-page A4 landscape (every panel, chart and the option chain, light theme), the same information as the Snapshot
- **Dashboard snapshot (PNG)**

---

## Paper trading

A separate app (`/paper`) for practising NIFTY and SENSEX option trades with simulated money on real market prices from Upstox, testing
strategies, and letting AI agents trade. It is owner only: sign in once with `PAPER_SECRET`. The dashboard shows a
"Paper trading" button only while that owner session is active; the server enforces the same rule on every route.

It is a React + TypeScript app built with Vite. Source is in `paper-app/`, the built output is committed to
`public/paper/` (the site is served as static files, with no build step on deploy). After changing anything in
`paper-app/`, run `npm run build:paper` and commit the result; `npm test` and CI fail if the bundle is stale.
`npm run dev:paper` starts the Vite dev server (proxying `/api` to a local `node api/index.js` on port 3000) and
`npm run typecheck:paper` checks the types.

### Trade
- **Accounts:** up to 20, each with its own cash (₹1,00,000 by default), history and equity curve. Reset or delete any time.
  Each account trades one index, picked when it is created: NIFTY (the default, and every account made before SENSEX
  existed) or SENSEX. Margin, spot and settlement always refer to that one index.
- **Instruments:** options in the nearest four expiries. NIFTY: lot size 65, strikes 50 points apart, instrument ids like
  `NIFTY|03-Nov-2026|25000|CE`. SENSEX: lot size 20 (or Upstox's live value), strikes 100 points apart, ids like
  `SENSEX|05-Nov-2026|82000|CE`. An order for the other index is refused (`WRONG_INDEX`).
- **Orders:** market, limit, stop limit (SL) and stop market (SL-M), with an optional target and stop that become
  exits cancelling each other once the entry fills. A preview shows the fill price, charges and free cash before you place it.
- **Fills:** market buys pay the ask and sells receive the bid (last price plus or minus 1% when the book is empty).
  Waiting orders fill only on a newer option chain snapshot than the one they were placed against, never on the quote just seen.
  Stops trigger on the last traded price. All orders are day orders, cancelled at 15:30; positions carry overnight.
- **Charges:** brokerage ₹20 an order, STT 0.15% of premium on sells and of intrinsic value on exercise, NSE
  transaction charge, SEBI fee, stamp duty and GST (rates as of 2026, in `api/services/paper/paperCosts.js`). SENSEX trades
  use the same rates; BSE's own transaction charge differs slightly.
- **Margin:** an estimate, not SPAN. A naked short option needs about 9% of spot (less for out of the money), and a
  spread needs only its maximum loss. With ₹1,00,000 you can buy options and trade spreads, not sell naked.
- **Expiry:** open options cash-settle at intrinsic value against the index's close (NIFTY or SENSEX), 15 minutes after
  the expiry close.
- **Paused trading:** orders are refused outside 09:15 to 15:30 IST, when the server is showing a leftover copy, or when the
  latest snapshot is more than 3 minutes old.
- **Views:** positions, open orders, order history (with who placed each order and why), trades, a payoff chart (at
  expiry and today) and the equity curve.

### Strategy lab
- **Rules, not code:** the index (NIFTY or SENSEX), an entry window, weekdays, trades a day, conditions (gap, move since the open, opening range
  breakout, price against VWAP or the previous day, India VIX, reversal signals), up to four legs set as strikes from
  ATM, and exits (stop and target as a share of premium or in rupees, an exit time, an index move).
- **Backtest:** about 60 sessions of 5 or 15 minute candles of the strategy's index. Weekly expiries are taken as
  Tuesdays for NIFTY and Thursdays for SENSEX. SENSEX has no volume proxy, so VWAP conditions never hold on it, and
  India VIX stands in for its volatility. Option prices are **modelled** (Black-Scholes with India
  VIX, a simple skew, and time decay counted in trading minutes), because no historical option quotes are available.
  Conditions are judged on a candle's close and the trade enters at the next open; a stop and a target hit in the same
  candle count as a stop; nothing is held overnight; fills pay a modelled spread plus the real charges.
- **Honest verdict:** "looks like an edge" needs 30 trades, a positive average trade with 95% confidence, and beating
  95% of runs that use the same legs and exits from random entry times. Most strategies show "not enough trades" or
  "no clear edge", and the page says so.
- **Live:** deploy a saved strategy to an account of the same index (one strategy per account). Each minute the server's scheduler checks
  it against the latest closed candle and trades through the same engine at real prices. Each live fill also records
  what the backtest model would have priced it at, so you can see how far backtests are from reality.

### Performance
Every account side by side (return, drawdown, win rate, profit factor, charges), and one account split by who traded
(you, each agent, each strategy, expiry settlement) and by tag. Trades and orders download as CSV (cells that a
spreadsheet would treat as formulas are neutralised).

### AI agents
- Create a key for one account under Accounts. It is shown once (only a SHA-256 fingerprint is stored), can be read
  only or allowed to trade, and can be revoked. The page gives instructions to paste into Claude or any other agent.
- The API lives at `/api/paper/v1` with `Authorization: Bearer cdp_...`. `GET /api/paper/v1` describes the rules,
  endpoints, order format and strategy format. Agents can read the account, the option chain, the dashboard's market
  readings (`/v1/context`), positions, orders, trades and analytics, place and cancel orders, and run backtests.
- Every agent order must carry a reason, shown in the order history. Limits per key: 10 order requests a minute and
  300 a day, 5 backtests a minute, 120 requests a minute overall. An `Idempotency-Key` header makes a retried order
  safe. You can pause agent trading on an account at any time; you can still trade it yourself.

---

## Operations

- **Requirements:** Node 22 or newer. `npm test` runs the paper app's type check and then every `test/verify-*.js` (no network or storage needed); CI runs it on every push (`.github/workflows/ci.yml`). A new test file is picked up automatically.
- **Live data check:** `node scripts/check-upstox-stream.js [NIFTY|SENSEX]` authorizes, opens the live feed, subscribes to the index, India VIX and one option, and prints what arrives (needs `UPSTOX_ACCESS_TOKEN` and network).
- **Project layout:**

  ```
  api/index.js            Express app; `npm start` also starts the Upstox stream, the browser socket and the scheduler
  api/middleware/         security headers, rate limits, secret and owner checks, input validators
  api/routes/             dashboard API, paper trading API, agent API
  api/services/providers/ Upstox REST client (authorize, contract list, candle history, holidays), index config, constituent lists
  api/services/stream/    upstoxStream (the only code that opens Upstox sockets), live option chain, browser gateway
  api/services/scheduler.js  per-minute recorder and paper engine tick (what an outside cron job used to trigger)
  api/services/market/    option chain cache, index quotes, candles, calendar, holidays
  api/services/analytics/ chain analytics, integrity checks, volatility, levels, patterns, signals, backtests
  api/services/paper/     paper trading engine, accounts, costs, strategies (backtest and live)
  api/services/storage/   Upstash / in-memory store, intraday history
  api/services/util/      retry helper
  public/                 dashboard (served as is) and the built paper app (public/paper)
  paper-app/              paper app source (React + TypeScript), built with npm run build:paper
  test/                   test files and helpers; test/run.js runs them all
  scripts/                developer tools (not deployed)
  ```
- **Per-minute recorder:** runs inside the server (`api/services/scheduler.js`): every minute from 09:00 to 15:59 IST on trading days it saves a snapshot of NIFTY's and SENSEX's nearest expiry. There is no cron job to set up and no endpoint to call; the server just has to be running.
- **Is the recorder alive?** `GET /api/snapshot-age` returns HTTP 503 when the last saved snapshot is more than 5 minutes old during market hours, and 200 otherwise. Point an uptime monitor at it to be alerted when the server or its feed has stopped. It reveals only that age.
- **Trading holidays:** the list comes from Upstox's market holidays, counting days the F&O segment is shut (refreshed at most daily, falling back to a built-in 2026 list), so holidays are treated as closed everywhere: the market-hours checks, time to expiry and the trust light.
- **Storage:** with Upstash configured, history uses roughly 5 to 7 commands a minute from the recorder, plus about 6 per open dashboard per minute. The free plan allows 500K commands a month, so check usage in the Upstash dashboard if you leave several tabs open all day.
- **Paper trading setup:** set `PAPER_SECRET` (a long random value, e.g. `openssl rand -hex 32`) and `NODE_ENV=production`
  in the server's environment; without the secret the paper pages and agent API answer 503 in production. The same
  scheduler runs the paper engine each minute: it fills waiting orders, cancels day orders at the close, settles
  expiries, records each day's closing equity and runs deployed strategies.
- **Paper trading storage:** each scheduler minute costs about 3 Upstash commands with nothing active, plus about 6 for each
  account with waiting orders and 4 for each running strategy (a typical setup of two accounts and one strategy is about
  100K commands a month). A paper page left open adds about 5 a minute. Accounts that only hold positions are not
  rewritten during the session.
- **Upstox token:** create a read-only Analytics Token (Upstox Developer Apps, Analytics tab, Generate Token; valid one year, no daily login) and set it as `UPSTOX_ACCESS_TOKEN` in `.env.local` and in the server's environment. See `.env.example` and "Live data over WebSockets" below.
- **Data sources and use:** option chain, quotes, candles and holidays come from Upstox under your own account; index constituents (for breadth) from the index provider's public lists, kept as a file in the repo. All are subject to the providers' terms; this project is for personal analysis, is not investment advice, and should not be offered as a paid or public service without licensed data and the appropriate registrations.

---

### SENSEX

SENSEX (BSE, options on BSE's F&O segment) is read from Upstox exactly like NIFTY and goes through the same analytics,
with its own strike step (100 points), lot size (20, or Upstox's live value) and history. What differs:

- The price chart, support and resistance ladder, reversal signals, level scorecard and live track record are built
  from NIFTY candles, so they are hidden on the SENSEX view. Alerts run on the NIFTY view only.
- Breadth is counted for NIFTY 50 only; the sector heatmap shows NSE sector indices on both views.
- India VIX is NSE's volatility index; it is shown on the SENSEX view as general market context.
- Paper trading and the strategy lab support SENSEX through SENSEX accounts and strategies (see Paper trading above).

---

## Live data over WebSockets

All live data reaches the server, and then the browser, over WebSockets. Nothing polls, there is no HTTP fallback, and
no outside cron job or webhook is involved.

```
Upstox Market Data Feed (wss, protobuf)
        |   one connection, owned by api/services/stream/upstoxStream.js
        v
  ChainDeck server  -- latest tick per instrument in memory; option chain, quotes and candles are built from it
        |   one WebSocket per page (/ws, same origin), api/services/stream/gateway.js
        v
  Browser  -- public/js/stream.js (dashboard and paper app share it)
```

### Environment variables

| Name | Needed | What it is |
|---|---|---|
| `UPSTOX_ACCESS_TOKEN` | Yes | Upstox Analytics Token (read-only, valid one year). Server only: it is never sent to the browser. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | For history | Without them history lives in memory and is lost on restart. |
| `PAPER_SECRET` | In production | Owner sign-in for paper trading. |
| `NODE_ENV=production` | In production | Makes the secrets mandatory. |
| `CRON_SECRET` | Optional | Only guards the manual `POST /api/session-summary`. |
| `UPSTOX_PORTFOLIO_STREAM=true` | Optional | Also opens Upstox's Portfolio Stream (order, position and holding updates). Off by default: ChainDeck's paper trading is simulated and reads no real orders. Upstox requires a whitelisted static IP for portfolio access. |
| `PORT` | Optional | Port to listen on (default 3000). |

Secrets live in environment variables only (`.env.local` locally, never committed).

### How auth and the connection work

1. The server calls Upstox's authorize endpoint (`GET /v3/feed/market-data-feed/authorize`) with the token. This is an
   HTTP call because Upstox issues the socket address that way; the reply is a single-use `wss://` URL.
2. It opens that URL and subscribes by instrument key: option contracts and the headline indices in `full` mode (price,
   OI, IV, depth, candles), sector indices and constituent stocks in `ltpc` (last price and previous close). Upstox
   allows 1500 `full` and 2000 `ltpc` keys on one connection when modes are mixed; the module refuses to go over.
   Only the expiries someone is looking at, plus the recorder's nearest expiries, are subscribed.
3. If the socket drops it waits (exponential backoff with jitter, 1 to 30 seconds), authorizes again for a new URL,
   reconnects and resubscribes everything. A connection that goes quiet is pinged after 20 seconds and dropped after 45.
4. If Upstox rejects the token the feed goes to `auth_failed`: both pages show a banner asking for a new token, and the
   server retries every 5 minutes. The Analytics Token lasts a year, so there is no daily login; to renew, generate a
   new token, set `UPSTOX_ACCESS_TOKEN` and restart the server.
5. Each page opens one WebSocket to the server (`/ws`; `/api/paper/ws` for the paper app, where its session cookie is
   sent). The server pushes the option chain about every 5 seconds, changed prices at most every 250 ms, the price
   chart every 15 seconds, and the paper market and account. The page reconnects by itself and asks again for what it
   was watching.
6. While either link is down, pages show "Reconnecting" (or "Offline"), keep the last values and mark them stale.

### Hosting

The server must be a process that stays running (`npm start`): it holds the Upstox socket and runs the per-minute
recorder. A serverless platform that starts a function per request cannot do that. The `vercel.json` in the repo is
from the earlier REST version and will serve pages without live data.

### Testing locally

```
npm install
cp .env.example .env.local      # then set UPSTOX_ACCESS_TOKEN
node scripts/check-upstox-stream.js   # authorize, connect, decode a few messages
npm start                       # http://localhost:3000 and http://localhost:3000/paper
npm test                        # every test/verify-*.js; no network needed
```

Outside market hours the feed still connects and sends the last session's values once, so the pages fill in but do not
tick. To see the reconnecting state, stop the server with the page open.

### Data with no WebSocket source

Upstox has no stream for these, so each is one REST lookup, never a polling loop:

| Data | What is done |
|---|---|
| Option contract list (expiries, strikes, instrument keys, lot size) | Looked up once per day. Nothing can be subscribed without it. |
| Candle history | Looked up once per series per day; today's candles are built from the feed. |
| Trading holidays | Looked up once per day; a built-in 2026 list is the fallback. Open/closed right now comes from the feed. |
| Previous-day open interest | Not in the feed. Derived: OI is noted between sessions and saved, and change in OI is measured against it. |
| Index constituents | A file in the repo (`api/services/providers/constituents.json`); refresh it with `node scripts/refresh-constituents.js` when an index is rebalanced. |
| Overnight cues (US, Asia, commodities) and FII/DII positions | Not Upstox data. Both panels were removed. |
| Funds, profile, real orders | Not used: paper trading is simulated. |

The browser still makes a few one-off requests to its own server: saved history (intraday series, strike history,
expiry replay), and actions such as signing in or placing a paper order. Saved history is re-read only when the server
says its recorder has saved a new point.

---

## Data and how it is calculated

### Sources

| Data | Source | Freshness |
|---|---|---|
| Option chain (price, OI, IV, volume, bid/ask) | Upstox Market Data Feed (WebSocket), `full` mode | Live; analytics rebuilt about every 5 seconds, prices pushed as they change |
| Change in OI | The feed's OI against the OI noted between sessions (the feed carries no previous-day OI) | Blank until the first session after the server has run overnight |
| India VIX, sector indices, NIFTY 50 breadth | Upstox Market Data Feed (breadth counted from each index's constituent stocks) | Live; if the feed is down the last values are kept for up to 10 minutes |
| Previous session high, low and close for CPR | Upstox daily candles (REST) | Twice a day at most |
| NIFTY candles and ETF volume | History: Upstox candle API (REST), once per day. Today: the feed's one-minute candles | Chart pushed every 15 seconds; only if the history lookup fails are candles built from saved spot values |
| Expiries, strikes, lot size | Upstox option contract list (REST) | Once per day |
| Trading holidays | Upstox market holidays (REST) | Once per day |

Outside market hours the dashboard shows the last session's values.

### Intraday history
A compact copy of each new option chain snapshot (series values and per-strike OI, premium and IV) is saved about once a
minute. This powers the Intraday Timeline, the Rolling ATM Straddle, IV vs Realised Volatility, the 5, 15 and 30
minute OI views, rate-of-change figures that survive a page refresh, and the strike drill-down. A summary of each
session is saved after the close for "Sessions That Looked Like Today", the volatility regime and the IV percentile.

### Methods
- **Expected move:** 0.85 times the ATM straddle (the common broker rule of thumb), scaled by the square root of
  trading days for a per-day figure. That is about 0.68 standard deviations, so price stays inside it only about half
  the time. The true one-standard-deviation range is the straddle divided by sqrt(2/pi), about 1.25 times the straddle,
  and is shown separately as the 1σ range (about two times out of three).
- **Time to expiry:** measured from when the prices were quoted to 15:30 IST on expiry day, so Greeks, GEX, the
  zero-gamma level and the implied distribution stay consistent with the quotes after hours and over weekends.
- **Implied future:** put-call parity at the ATM strike.
- **Max pain:** the expiry level at which option holders collectively lose the most.
- **IV skew:** 25-delta risk reversal (put IV minus call IV at the strikes nearest 25 delta), falling back to the
  ATM put-call IV gap.
- **GEX:** Black-Scholes gamma for every strike multiplied by open interest, lot size and spot squared, scaled to a
  1% move, with call and put exposure netted against each other. The zero-gamma level is where net GEX changes sign.
- **Implied probability:** a smoothed volatility smile turned into a distribution of expiry prices
  (Breeden-Litzenberger), with a lognormal fallback.
- **Realised volatility:** squared log returns of spot between snapshots, divided by the trading minutes they cover
  and annualised over 252 trading days of 375 minutes.
- **Trading-time IV:** option IV is quoted on a 365-day calendar. It is converted so the same variance is spread over
  trading hours only (09:15 to 15:30 IST, weekdays), which makes it directly comparable with intraday realised
  volatility. Exchange holidays are not modelled.
- **IV percentile:** the share of saved session closing IVs at or below today's IV (shown once 5 sessions exist).
- **Buildup:** price change and OI change taken together for each contract (expiry and strike), over distinct
  snapshots only, with put labels read from NIFTY's side.

### Limitations
- Upstox can occasionally time out or reject a request (for example an expired token). When that happens the dashboard keeps the
  last good values on screen (for the index list, at most 10 minutes old).
- Realised volatility needs about 15 minutes of snapshots each morning and reads high in the first half hour.
- Intraday realised volatility leaves out overnight gaps, so implied volatility usually sits above it.
- If the candle feed is unavailable, the chart says when it is using saved spot values instead, whose highs and lows are only as good as the once-a-minute sampling.
- Pattern signals are weak evidence. The backtest usually shows hit rates close to chance, and the panel reports that
  rather than hiding it.
- Scores, regimes and probabilities describe current conditions and how option prices are set. They are not
  forecasts.

## Author

Built by [Anish Tejwani](https://anishtejwani.dev).
