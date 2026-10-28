// Backtest a strategy (strategy.js) on NIFTY candles with modelled option prices. Pure: data in, report out.
//
// There is no history of NIFTY option prices here, so premiums are MODELLED:
//   Black-Scholes on the candle's index level, with India VIX at that candle as the volatility, a simple skew (out of the
//   money puts a little dearer, calls a little cheaper) and a 6% rate.
//   Time: at entry the option carries the market's usual total variance (VIX squared times calendar time to the expiry
//   close), and that variance is used up in proportion to TRADING minutes, because prices move (and options decay) while
//   the market is open, not overnight. Pure calendar time would barely decay a weekly option between 09:20 and 15:15.
//   Weekly expiries are Tuesdays (NSE's NIFTY weekly expiry day since September 2025), moved to the previous trading
//   day for a holiday.
// Fills: buys pay the model price plus a half spread, sells receive the model price less it (0.05 or 0.3% of the price,
// whichever is more), rounded to the tick. Charges are the live engine's (paperCosts.js), per leg, on entry and exit.
//
// Rules that keep it honest:
//  - Conditions are judged on the close of a candle; entry is the OPEN of the next candle. Nothing later is used.
//  - Inside a candle the index is walked open -> low -> high -> close (rising candle) or open -> high -> low -> close;
//    stops, targets and the index-move exit are checked along that path, and a candle that reaches both the stop and the
//    target counts as a stop.
//  - Every trade is closed by exitAt or the session's last candle: nothing is held overnight.
//  - A random-entry baseline runs the same legs and exits from random times inside the same window, so time-of-day drift
//    or a lucky market cannot pass for an edge.

const { tradeCharges } = require('./paperCosts');
const { wilson } = require('./backtest');
const { detectAll } = require('./patterns');
const { NOTABLE_TYPES, MARKER_MIN_QUALITY } = require('./signals');
const calendar = require('./calendar');
const engine = require('./paperEngine');
const { STRIKE_STEP, toMins } = require('./strategy');

const IST_OFFSET_MS = 330 * 60 * 1000;
const YEAR_MS = 365 * 24 * 3600 * 1000;
const RATE = 0.06;
const MIN_SAMPLES = 30;
const BASELINE_RUNS = 50;
const BAR_MIN = { '5m': 5, '15m': 15 };

const r2 = x => Math.round(x * 100) / 100;
const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMins = ms => { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istDow = ms => new Date(ms + IST_OFFSET_MS).getUTCDay();
const closeMsOf = ymd => Date.parse(`${ymd}T00:00:00Z`) - IST_OFFSET_MS + calendar.CLOSE_MIN * 60000;

// ── option model ─────────────────────────────────────────────────────────

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function bsPrice(optionType, S, K, T, sigma) {
  const intrinsic = Math.max(0, optionType === 'CE' ? S - K : K - S);
  if (!(T > 0) || !(sigma > 0)) return intrinsic;
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (RATE + sigma * sigma / 2) * T) / sd;
  const d2 = d1 - sd;
  const v = optionType === 'CE'
    ? S * normCdf(d1) - K * Math.exp(-RATE * T) * normCdf(d2)
    : K * Math.exp(-RATE * T) * normCdf(-d2) - S * normCdf(-d1);
  return Math.max(intrinsic * Math.exp(-RATE * T), v);
}

/** Volatility for a strike: VIX with a simple skew (OTM puts dearer, OTM calls slightly cheaper), floored at half of VIX. */
function sigmaFor(optionType, K, S, vix) {
  const m = (K - S) / S; // > 0 above spot
  const skew = optionType === 'PE' ? 1 + 2.5 * Math.max(0, -m) : 1 - 1.0 * Math.max(0, m);
  return Math.max(0.5, skew) * vix / 100;
}

/** Time to expiry for pricing at tMs: the entry's calendar time scaled by the share of trading minutes still left. */
function effectiveT(leg, tMs) {
  if (!(leg.tradingMin0 > 0)) return 0;
  const used = Math.max(0, (Math.min(tMs, leg.expiryMs) - leg.t0) / 60000); // trades are intraday: elapsed = trading minutes
  return leg.T0 * Math.max(0, leg.tradingMin0 - used) / leg.tradingMin0;
}

function modelPrice(leg, S, tMs, vix) {
  return bsPrice(leg.optionType, S, leg.strike, effectiveT(leg, tMs), sigmaFor(leg.optionType, leg.strike, S, vix));
}

const halfSpread = p => Math.max(0.05, p * 0.003);
const fillPrice = (side, p) => (side === 'BUY' ? engine.toTick(p + halfSpread(p), +1) : Math.max(0.05, engine.toTick(p - halfSpread(p), -1)));

/** Weekly expiry closes (epoch ms) covering the data: Tuesdays, or the trading day before when Tuesday is a holiday. */
function weeklyExpiries(firstMs, lastMs) {
  const out = [];
  const day = 24 * 3600 * 1000;
  let t = Date.parse(`${istYmd(firstMs)}T00:00:00Z`);
  const end = Date.parse(`${istYmd(lastMs)}T00:00:00Z`) + 21 * day;
  for (; t <= end; t += day) {
    if (new Date(t).getUTCDay() !== 2) continue;
    let ymd = new Date(t).toISOString().slice(0, 10);
    for (let back = 0; back < 5 && !calendar.isTradingDayYmd(ymd); back++) ymd = new Date(Date.parse(`${ymd}T00:00:00Z`) - day).toISOString().slice(0, 10);
    out.push(closeMsOf(ymd));
  }
  return out;
}

// ── data preparation ─────────────────────────────────────────────────────

/**
 * Per-candle context known at each candle's close: session, previous session levels, opening range, VWAP, VIX, signals.
 * candles: [{ t, o, h, l, c, v }] (v may be null), vix: [{ t, c }]
 */
function prepare(candles, vix, interval) {
  const bar = BAR_MIN[interval];
  const vixAt = [];
  let k = 0, lastVix = null;
  const vixSorted = (vix || []).filter(x => x && x.c > 0).sort((a, b) => a.t - b.t);
  for (const c of candles) {
    while (k < vixSorted.length && vixSorted[k].t <= c.t) { lastVix = vixSorted[k].c; k += 1; }
    vixAt.push(lastVix);
  }
  const notable = new Map();
  for (const p of detectAll(candles)) {
    if (NOTABLE_TYPES.has(p.name) && p.quality >= MARKER_MIN_QUALITY) notable.set(p.i, notable.has(p.i) && notable.get(p.i) !== p.dir ? 'mixed' : p.dir);
  }

  const ctx = [];
  const sessions = [];
  let cur = null, prev = null;
  let pv = 0, vol = 0;
  candles.forEach((c, i) => {
    const ymd = istYmd(c.t);
    if (!cur || cur.ymd !== ymd) {
      if (cur) prev = cur;
      cur = { ymd, start: i, end: i, open: c.o, high: c.h, low: c.l, close: c.c, prev, orb: {} };
      sessions.push(cur);
      pv = 0; vol = 0;
    }
    cur.end = i;
    cur.high = Math.max(cur.high, c.h);
    cur.low = Math.min(cur.low, c.l);
    cur.close = c.c;
    const minsIn = istMins(c.t) - calendar.OPEN_MIN;
    for (const m of [15, 30, 60]) {
      if (minsIn + bar <= m) { // candle lies inside the first m minutes
        const r = cur.orb[m] || { high: -Infinity, low: Infinity, done: false };
        r.high = Math.max(r.high, c.h); r.low = Math.min(r.low, c.l);
        cur.orb[m] = r;
      }
    }
    if (c.v) { pv += ((c.h + c.l + c.c) / 3) * c.v; vol += c.v; }
    ctx.push({
      i,
      session: cur,
      minsIn,
      vwap: vol ? pv / vol : null,
      orbDone: { 15: minsIn + bar > 15, 30: minsIn + bar > 30, 60: minsIn + bar > 60 },
      orb: { 15: cur.orb[15] && { ...cur.orb[15] }, 30: cur.orb[30] && { ...cur.orb[30] }, 60: cur.orb[60] && { ...cur.orb[60] } },
      vix: vixAt[i],
      signal: notable.get(i) || null
    });
  });
  return { ctx, sessions };
}

const cmp = (op, a, b) => (op === 'above' ? a > b : a < b);

/** Do all conditions hold on candle i (judged at its close)? */
function conditionsHold(conditions, candles, x) {
  const c = candles[x.i];
  const s = x.session;
  for (const cond of conditions) {
    switch (cond.type) {
      case 'gap': {
        if (!s.prev) return false;
        if (!cmp(cond.op, ((s.open - s.prev.close) / s.prev.close) * 100, cond.pct)) return false;
        break;
      }
      case 'dayMove':
        if (!cmp(cond.op, ((c.c - s.open) / s.open) * 100, cond.pct)) return false;
        break;
      case 'orb': {
        const r = x.orb[cond.minutes];
        if (!x.orbDone[cond.minutes] || !r || x.minsIn < cond.minutes) return false; // the range must be complete before this candle
        if (cond.direction === 'up' ? !(c.c > r.high) : !(c.c < r.low)) return false;
        break;
      }
      case 'vwap':
        if (x.vwap === null || !cmp(cond.position, c.c, x.vwap)) return false;
        break;
      case 'prevDay': {
        if (!s.prev) return false;
        if (!cmp(cond.position, c.c, s.prev[cond.level])) return false;
        break;
      }
      case 'vix':
        if (x.vix === null || !cmp(cond.op, x.vix, cond.value)) return false;
        break;
      case 'signal':
        if (x.signal !== cond.direction) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

// ── one trade ────────────────────────────────────────────────────────────

/** Points the index passes through inside a candle (open, extremes in the likely order, close), interpolated. */
function pathOf(c) {
  const [a, b] = c.c >= c.o ? [c.l, c.h] : [c.h, c.l];
  const pts = [c.o];
  for (const [from, to] of [[c.o, a], [a, b], [b, c.c]]) for (const f of [0.5, 1]) pts.push(from + (to - from) * f);
  return pts;
}

/**
 * Simulate one trade entering at the open of candle `e`. Returns the trade, or null when it cannot be priced.
 * legsSpec: strategy legs; expiries: weekly expiry closes; lotSize from the engine.
 */
function simulateTrade(strategy, candles, prep, e, expiries, lotSize) {
  const entryC = candles[e];
  const vix = prep.ctx[e - 1] && prep.ctx[e - 1].vix;
  if (!vix) return null;
  const S0 = entryC.o;
  const t0 = entryC.t;
  const atm = Math.round(S0 / STRIKE_STEP) * STRIKE_STEP;
  const upcoming = expiries.filter(x => x > t0);
  if (upcoming.length < 2) return null;
  const legs = strategy.legs.map(l => {
    const expiryMs = l.expiry === 'next' ? upcoming[1] : upcoming[0];
    const leg = {
      ...l, strike: atm + l.strikeOffset * STRIKE_STEP, expiryMs, qty: l.lots * lotSize, sgn: l.side === 'BUY' ? 1 : -1,
      t0, T0: Math.max(0, (expiryMs - t0) / YEAR_MS), tradingMin0: calendar.tradingMinutesBetween(t0, expiryMs)
    };
    const model = modelPrice(leg, S0, t0, vix);
    leg.entry = fillPrice(l.side, model);
    return leg;
  });
  const netPremium = Math.abs(legs.reduce((a, l) => a + l.sgn * l.entry * l.qty, 0));
  const ruleRs = r => (!r ? null : r.unit === 'rupees' ? r.value : (r.value / 100) * netPremium);
  const stopRs = ruleRs(strategy.exits.stopLoss);
  const targetRs = ruleRs(strategy.exits.target);
  const exitAtMin = toMins(strategy.exits.exitAt);
  const movePts = strategy.exits.indexMovePts;
  const session = prep.ctx[e].session;

  const mtm = (S, t, v) => legs.reduce((a, l) => a + l.sgn * l.qty * (modelPrice(l, S, t, v) - l.entry), 0);
  let exit = null;
  for (let j = e; j <= session.end && !exit; j++) {
    const c = candles[j];
    const v = (prep.ctx[j - 1] && prep.ctx[j - 1].vix) || vix; // VIX known at the start of the candle
    if (j > e && istMins(c.t) >= exitAtMin) { exit = { j, S: c.o, t: c.t, reason: 'time' }; break; }
    const pts = j === e ? pathOf(c).slice(1) : pathOf(c);
    let stopHit = null, targetHit = null, moveHit = null;
    for (const S of pts) {
      const pnl = mtm(S, c.t, v);
      if (stopHit === null && stopRs !== null && pnl <= -stopRs) stopHit = S;
      if (targetHit === null && targetRs !== null && pnl >= targetRs) targetHit = S;
      if (moveHit === null && movePts && Math.abs(S - S0) >= movePts) moveHit = S;
    }
    // a candle that reaches both the stop and the target is a stop: we cannot know the order, so assume the worst
    if (stopHit !== null) exit = { j, S: stopHit, t: c.t, reason: 'stop' };
    else if (moveHit !== null) exit = { j, S: moveHit, t: c.t, reason: 'index' };
    else if (targetHit !== null) exit = { j, S: targetHit, t: c.t, reason: 'target' };
  }
  if (!exit) {
    const last = candles[session.end];
    exit = { j: session.end, S: last.c, t: last.t + BAR_MIN[strategy.interval] * 60000 - 1, reason: 'close' };
  }
  const vExit = (prep.ctx[exit.j - 1] && prep.ctx[exit.j - 1].vix) || vix;
  let gross = 0, charges = 0;
  const legOut = legs.map(l => {
    const out = fillPrice(l.side === 'BUY' ? 'SELL' : 'BUY', modelPrice(l, exit.S, exit.t, vExit));
    gross += l.sgn * l.qty * (out - l.entry);
    charges += tradeCharges(l.side, l.entry, l.qty).total + tradeCharges(l.side === 'BUY' ? 'SELL' : 'BUY', out, l.qty).total;
    return { label: `${l.side} ${l.strike} ${l.optionType}`, strike: l.strike, optionType: l.optionType, side: l.side, qty: l.qty, entry: l.entry, exit: out };
  });
  const positions = Object.fromEntries(legs.map((l, n) => [n, { expiry: String(l.expiryMs), strike: l.strike, optionType: l.optionType, qty: l.sgn * l.qty }]));
  const debit = Math.max(0, legs.reduce((a, l) => a + l.sgn * l.entry * l.qty, 0));
  return {
    day: session.ymd,
    entryT: t0,
    exitT: exit.t,
    entryIndex: r2(S0),
    exitIndex: r2(exit.S),
    vix: r2(vix),
    legs: legOut,
    gross: r2(gross),
    charges: r2(charges),
    net: r2(gross - charges),
    reason: exit.reason,
    minutes: Math.max(0, Math.round((exit.t - t0) / 60000)),
    capital: r2(engine.marginFor(positions, S0) + debit),
    nextE: exit.j + 1
  };
}

// ── whole backtest ───────────────────────────────────────────────────────

/** Candle indexes where an entry may happen (start time inside the window, allowed weekday, prior candle same session). */
function entryCandidates(strategy, candles, prep) {
  const from = toMins(strategy.entry.window.from), to = toMins(strategy.entry.window.to);
  const days = new Set(strategy.entry.weekdays);
  const out = [];
  for (let e = 1; e < candles.length; e++) {
    const m = istMins(candles[e].t);
    if (m < from || m > to) continue;
    if (!days.has(istDow(candles[e].t))) continue;
    if (prep.ctx[e - 1].session !== prep.ctx[e].session) continue;
    out.push(e);
  }
  return out;
}

/** Seeded PRNG (mulberry32), so the baseline is the same on every run of the same data. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stats(trades, capitalBase) {
  const n = trades.length;
  const nets = trades.map(t => t.net);
  const wins = nets.filter(x => x > 0);
  const losses = nets.filter(x => x <= 0);
  const total = nets.reduce((a, b) => a + b, 0);
  const mean = n ? total / n : 0;
  const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? 1.96 * sd / Math.sqrt(n) : null;
  let peak = 0, cum = 0, maxDd = 0;
  const curve = [];
  for (const t of trades) {
    cum += t.net;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    curve.push({ t: t.exitT, day: t.day, equity: r2(capitalBase + cum) });
  }
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
  const ci = wilson(wins.length, n);
  return {
    trades: n,
    wins: wins.length,
    winRate: n ? wins.length / n : 0,
    winRateCi: ci,
    avgWin: wins.length ? r2(grossWin / wins.length) : 0,
    avgLoss: losses.length ? r2(-grossLoss / losses.length) : 0,
    expectancy: r2(mean),
    expectancyCi: half === null ? null : { low: r2(mean - half), high: r2(mean + half) },
    totalNet: r2(total),
    totalCharges: r2(trades.reduce((a, t) => a + t.charges, 0)),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    maxDrawdown: r2(maxDd),
    best: n ? r2(Math.max(...nets)) : 0,
    worst: n ? r2(Math.min(...nets)) : 0,
    avgMinutes: n ? Math.round(trades.reduce((a, t) => a + t.minutes, 0) / n) : 0,
    exits: trades.reduce((a, t) => ({ ...a, [t.reason]: (a[t.reason] || 0) + 1 }), {}),
    curve
  };
}

/**
 * Run a validated strategy over `candles` (one interval) and `vix`. Returns the report.
 * opts: { capital, lotSize, baselineRuns }
 */
function runBacktest(strategy, { candles, vix }, opts = {}) {
  const lotSize = opts.lotSize || engine.DEFAULTS.lotSize;
  const capital = opts.capital || engine.DEFAULTS.startingCapital;
  if (!candles || candles.length < 50) throw Object.assign(new Error('Not enough candles to backtest.'), { code: 'NO_DATA' });
  const prep = prepare(candles, vix, strategy.interval);
  const expiries = weeklyExpiries(candles[0].t, candles[candles.length - 1].t);
  const candidates = entryCandidates(strategy, candles, prep);
  const candidateSet = new Set(candidates);

  const trades = [];
  const perDay = new Map();
  let e = 1;
  for (; e < candles.length; e++) {
    if (!candidateSet.has(e)) continue;
    const day = prep.ctx[e].session.ymd;
    if ((perDay.get(day) || 0) >= strategy.entry.maxTradesPerDay) continue;
    if (!conditionsHold(strategy.entry.conditions, candles, prep.ctx[e - 1])) continue;
    const t = simulateTrade(strategy, candles, prep, e, expiries, lotSize);
    if (!t) continue;
    trades.push(t);
    perDay.set(day, (perDay.get(day) || 0) + 1);
    e = t.nextE - 1; // one position at a time: resume after the exit
  }
  const result = stats(trades, capital);

  // Random-entry baseline: same legs and exits, entries at random candles inside the same window, as many trades as the
  // strategy made. Skipped when the strategy has no conditions (then it already IS the time-only version).
  let baseline = null;
  if (strategy.entry.conditions.length && trades.length && candidates.length) {
    const runs = opts.baselineRuns || BASELINE_RUNS;
    const rand = rng(candles.length * 7919 + trades.length);
    const means = [];
    for (let r = 0; r < runs; r++) {
      let sum = 0, n = 0;
      for (let k = 0; k < trades.length; k++) {
        const t = simulateTrade(strategy, candles, prep, candidates[Math.floor(rand() * candidates.length)], expiries, lotSize);
        if (t) { sum += t.net; n += 1; }
      }
      if (n) means.push(sum / n);
    }
    means.sort((a, b) => a - b);
    const beaten = means.filter(m => m < result.expectancy).length;
    baseline = { runs: means.length, expectancy: r2(means.reduce((a, b) => a + b, 0) / Math.max(1, means.length)), percentile: means.length ? Math.round((beaten / means.length) * 100) : null };
  }

  let verdict = 'none';
  if (result.trades < MIN_SAMPLES) verdict = 'insufficient';
  else if (result.expectancyCi && result.expectancyCi.high < 0) verdict = 'negative';
  else if (result.expectancyCi && result.expectancyCi.low > 0 && (!baseline || baseline.percentile >= 95)) verdict = 'edge';

  const capitalNeeded = trades.length ? Math.max(...trades.map(t => t.capital)) : 0;
  return {
    strategy,
    data: {
      interval: strategy.interval,
      sessions: prep.sessions.length,
      from: prep.sessions.length ? prep.sessions[0].ymd : null,
      to: prep.sessions.length ? prep.sessions[prep.sessions.length - 1].ymd : null,
      candles: candles.length,
      volume: candles.some(c => c.v) ? 'Nifty ETF volume as a proxy' : 'none (VWAP conditions never hold)'
    },
    ...result,
    baseline,
    verdict,
    minSamples: MIN_SAMPLES,
    capital,
    capitalNeeded: r2(capitalNeeded),
    fitsCapital: capitalNeeded <= capital,
    tradeList: trades.map(({ nextE, capital: cap, ...t }) => ({ ...t, capital: cap })),
    assumptions: [
      'Option prices are modelled (Black-Scholes with India VIX, a simple skew, and time decay counted in trading minutes), not real quotes. Real premiums, especially near expiry and far from the money, can differ a lot.',
      'Fills pay a modelled half spread on top of the model price, plus the same charges as live paper trading.',
      'Entries happen at the open of the candle after the conditions are met. Inside a candle, a stop and a target in the same candle count as a stop.',
      'Weekly expiries are taken as Tuesdays (moved earlier for holidays). Every trade is closed the same day.',
      `About ${prep.sessions.length} sessions of history: most strategies will not reach ${MIN_SAMPLES} trades, and a short history can flatter or punish any rule.`
    ]
  };
}

module.exports = { stats, istMins, istDow, BAR_MIN, bsPrice, sigmaFor, effectiveT, modelPrice, weeklyExpiries, prepare, conditionsHold, simulateTrade, entryCandidates, runBacktest, MIN_SAMPLES };
