# ChainDeck: NIFTY Options Analytics

A live NIFTY 50 options dashboard. ChainDeck reads the NSE option chain during market hours and turns it into
open interest structure, gamma exposure, volatility, positioning and intraday history in one page, with alerts and
a plain-language explanation for every number.

ChainDeck is for information and education only. It does not give investment advice, tips or recommendations.

---

## At a glance

- **Key numbers strip** (stays on screen while you scroll): spot, ATM strike, day change, PCR, India VIX, max pain,
  implied future, market regime and the age of the data.
- **Expiry selector** for every weekly and monthly expiry NSE lists.
- **Auto-refresh** every 3, 5, 10 or 30 seconds while the market is open (every 60 seconds once it closes),
  plus a manual refresh button.
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
NSE's calendar IV, each realised vol window, the gap between IV and 30-minute realised vol, and an IV percentile
against saved session closes.

### Intraday Timeline
Spot through the day with one overlay on a second axis: PCR, volume PCR, ATM straddle, ATM IV, IV skew, India VIX,
net GEX, total call OI or total put OI.

### Sector Heatmap
Today's percentage move for 16 NSE sector indices (Bank, Private Bank, PSU Bank, Financial Services, IT, Auto,
FMCG, Pharma, Healthcare, Metal, Energy, Oil & Gas, Realty, Media, Consumer Durables and Infrastructure), sorted
from strongest to weakest, with how many stocks in each are up and down. NIFTY 50 breadth (stocks up against down)
sits above the tiles. It updates live while the page is open.

### FII / DII Positions
Participant-wise open interest from NSE's end-of-day file for FIIs, DIIs, Pro traders and Clients:
- **Index futures view:** long, short and net contracts, long percentage, and the change in net position against
  the previous trading day.
- **Index options view:** net calls and net puts, and their change against the previous trading day.
- A chart of the last 10 trading days (FII, DII, Pro and Client long percentage, or FII and Client net options).

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
NSE itself is right; it shows the numbers are fresh, agree with a second source and are internally consistent.

| Check | What it does |
|---|---|
| NSE option chain current | Age of the NSE timestamp: amber after 90 seconds, red after 3 minutes (while the market is open) |
| Leftover copy | Red while trading if NSE did not answer and the last good copy is being shown, with the reason; a warning only after the close |
| Snapshots changing | Warns if 3 consecutive new NSE snapshots carry identical contents, fails at 5 (a feed that is "refreshing" but frozen) |
| Candles current, saved snapshots current | Latest candle lag and the per-minute cron job, as in the Feeds chips |
| Saved history complete | Minutes saved today against minutes since the open (a warning at most; skipped without storage) |
| NSE spot vs Yahoo | Two independent sources agree within 0.15 percent (warn) or 0.4 percent (fail) |
| Totals, PCR, max pain, ATM | Recomputed straight from the raw NSE payload with separate code and compared with what the page shows |
| Put-call parity | Strikes near the money should imply the same forward; outliers point to stale quotes |
| Basis, IV, day range | Implied future near spot, ATM IV in a plausible band, spot inside the day range |

Before anything is cached, each NSE payload is validated (plausible spot, no negative or non-numeric values, enough rows, no
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
| Nearing a level | Spot comes within about half an ATR of a zone with strength 70 or more (adjustable), then re-arms after moving away |

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

## Operations

- **Requirements:** Node 22 or newer. `npm test` runs the whole suite (no network or storage needed) and CI runs it on every push (`.github/workflows/ci.yml`).
- **Per-minute recorder:** point cron-job.org (or similar) at `/api/cron/snapshot` with `Authorization: Bearer <CRON_SECRET>` during market hours.
- **Is the recorder alive?** `GET /api/snapshot-age` returns HTTP 503 when the last saved snapshot is more than 5 minutes old during market hours, and 200 otherwise. Point an uptime monitor at it to be alerted when the cron job stops. It reveals only that age.
- **NSE holidays:** the list comes from NSE's holiday master (refreshed at most daily, falling back to a built-in 2026 list), so holidays are treated as closed everywhere: the market-hours checks, time to expiry and the trust light.
- **Storage:** with Upstash configured, history uses roughly 5 to 7 commands a minute from the recorder, plus about 6 per open dashboard per minute. The free plan allows 500K commands a month, so check usage in the Upstash dashboard if you leave several tabs open all day.
- **Data sources and use:** option data comes from NSE's public website API and candles from Yahoo Finance's chart endpoint. Both are unofficial and subject to the providers' terms; this project is for personal analysis, is not investment advice, and should not be offered as a paid or public service without licensed data and the appropriate registrations.

---

## Data and how it is calculated

### Sources

| Data | Source | Freshness |
|---|---|---|
| Option chain | NSE option chain | NSE updates about once a minute during market hours |
| India VIX, sector indices, NIFTY 50 breadth | NSE index list | Live while the page is open, reused for up to 15 seconds; if NSE is slow (over 2.5 seconds) or fails, the last good values are kept for up to 10 minutes |
| Previous session high, low and close for CPR | Daily NIFTY bars | Once per session |
| FII / DII / Pro / Client positions | NSE end-of-day participant-wise OI file | Published each evening after the close |
| NIFTY candles and ETF volume | Yahoo Finance chart data (unofficial, delayed) | 20 seconds while the market is open; only if Yahoo fails are candles built from saved spot values |

Outside market hours the dashboard shows the last session's values.

### Intraday history
A compact copy of each new NSE snapshot (series values and per-strike OI, premium and IV) is saved about once a
minute. This powers the Intraday Timeline, the Rolling ATM Straddle, IV vs Realised Volatility, the 5, 15 and 30
minute OI views, rate-of-change figures that survive a page refresh, and the strike drill-down. A summary of each
session is saved after the close for "Sessions That Looked Like Today", the volatility regime and the IV percentile.

### Methods
- **Expected move:** 0.85 times the ATM straddle (the common broker rule of thumb), scaled by the square root of
  trading days for a per-day figure. That is about 0.68 standard deviations, so price stays inside it only about half
  the time. The true one-standard-deviation range is the straddle divided by sqrt(2/pi), about 1.25 times the straddle,
  and is shown separately as the 1σ range (about two times out of three).
- **Time to expiry:** measured from when NSE quoted the prices to 15:30 IST on expiry day, so Greeks, GEX, the
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
- **Trading-time IV:** NSE quotes IV on a 365-day calendar. It is converted so the same variance is spread over
  trading hours only (09:15 to 15:30 IST, weekdays), which makes it directly comparable with intraday realised
  volatility. Exchange holidays are not modelled.
- **IV percentile:** the share of saved session closing IVs at or below today's IV (shown once 5 sessions exist).
- **Buildup:** price change and OI change taken together for each contract (expiry and strike), over distinct
  snapshots only, with put labels read from NIFTY's side.

### Limitations
- NSE's data can lag by a minute or more, and NSE sometimes times out. When that happens the dashboard keeps the
  last good values on screen (for the index list, at most 10 minutes old).
- Realised volatility needs about 15 minutes of snapshots each morning and reads high in the first half hour.
- Intraday realised volatility leaves out overnight gaps, so implied volatility usually sits above it.
- Candle data comes from an unofficial Yahoo Finance endpoint and can be delayed or unavailable. The chart says when it
  is using saved spot values instead, whose highs and lows are only as good as the once-a-minute sampling.
- Pattern signals are weak evidence. The backtest usually shows hit rates close to chance, and the panel reports that
  rather than hiding it.
- Scores, regimes and probabilities describe current conditions and how option prices are set. They are not
  forecasts.
