// Honest backtest of the pattern detectors on stored history.
//
// Rules, so the numbers can be trusted:
//  - Entry is the OPEN of the candle after the pattern completes (no look-ahead).
//  - A "hit" is the price closing beyond the entry, in the pattern's direction, `horizon` candles later.
//  - Intraday trades must finish inside the same session; overnight gaps are not counted.
//  - The hit rate is compared with a baseline: how often ANY candle in the same history moved that way over the same
//    horizon. A pattern is only called an edge when its confidence interval clears that baseline with enough samples.

const { detectAll } = require('./patterns');
const { atr } = require('./levels');

const IST_OFFSET_MS = 330 * 60 * 1000;
const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

const HORIZONS = { '5m': 12, '15m': 8, '1d': 5 };
const MIN_SAMPLES = 30;

/** Wilson score interval for a proportion. */
function wilson(hits, n, z = 1.96) {
  if (!n) return { low: 0, high: 1 };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function verdict(n, ci, baseline) {
  if (n < MIN_SAMPLES) return 'insufficient';
  if (ci.low > baseline) return 'edge';
  if (ci.high < baseline) return 'negative';
  return 'none';
}

/** Does the trade starting at candle `i + 1` stay inside one session for `horizon` candles? */
function fits(candles, i, horizon, intraday) {
  const end = i + 1 + horizon;
  if (end >= candles.length) return false;
  return !intraday || istDay(candles[i + 1].t) === istDay(candles[end].t);
}

/** Fraction of all valid candles after which price closed higher / lower `horizon` candles later. */
function baselineRates(candles, horizon, intraday) {
  let up = 0, down = 0, n = 0;
  for (let i = 0; i + 1 + horizon < candles.length; i++) {
    if (!fits(candles, i, horizon, intraday)) continue;
    const entry = candles[i + 1].o;
    const exit = candles[i + 1 + horizon].c;
    n += 1;
    if (exit > entry) up += 1;
    else if (exit < entry) down += 1;
  }
  return { n, bull: n ? up / n : 0.5, bear: n ? down / n : 0.5 };
}

/**
 * Run all detectors over `candles` and score each pattern name.
 * Returns { interval, horizon, sessions, candles, patterns: { name: stats }, baseline }.
 * stats: { name, dir, n, hits, hitRate, baseline, ci, avgMoveAtr, verdict }
 */
function backtest(candles, interval, patternsOverride = null) {
  const horizon = HORIZONS[interval];
  if (!horizon) throw new Error(`Unsupported interval ${interval}`);
  const intraday = interval !== '1d';
  const found = patternsOverride || detectAll(candles);
  const base = baselineRates(candles, horizon, intraday);
  const buckets = new Map();

  for (const p of found) {
    if (!fits(candles, p.i, horizon, intraday)) continue;
    const entry = candles[p.i + 1].o;
    const exit = candles[p.i + 1 + horizon].c;
    const a = atr(candles.slice(Math.max(0, p.i - 14), p.i + 1)) || 1;
    const signed = ((p.dir === 'bull' ? 1 : -1) * (exit - entry)) / a;
    const b = buckets.get(p.name) || { name: p.name, dir: p.dir, n: 0, hits: 0, moveSum: 0 };
    b.n += 1;
    if (signed > 0) b.hits += 1;
    b.moveSum += signed;
    buckets.set(p.name, b);
  }

  const patterns = {};
  for (const b of buckets.values()) {
    const ci = wilson(b.hits, b.n);
    const baseline = b.dir === 'bull' ? base.bull : base.bear;
    patterns[b.name] = {
      name: b.name,
      dir: b.dir,
      n: b.n,
      hits: b.hits,
      hitRate: b.hits / b.n,
      baseline,
      ci,
      avgMoveAtr: b.moveSum / b.n,
      verdict: verdict(b.n, ci, baseline)
    };
  }
  const sessions = new Set(candles.map(c => istDay(c.t))).size;
  return { interval, horizon, sessions, candles: candles.length, minSamples: MIN_SAMPLES, baseline: base, patterns };
}

module.exports = { HORIZONS, MIN_SAMPLES, wilson, verdict, baselineRates, backtest };
