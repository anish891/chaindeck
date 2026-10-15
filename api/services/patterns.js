// Pattern detection on OHLC candles. Every detector is causal: the result for candle `i` uses only candles 0..i,
// so the same code serves the live chart and the historical backtest without look-ahead.
//
// A pattern is { i, t, name, label, dir: 'bull' | 'bear', kind: 'candle' | 'chart', quality: 0..1, level?: number }.
// Reversal candle patterns only count when the preceding trend gives them something to reverse.

const { atr, swingPoints } = require('./levels');

const SWING_K = 3;

const PATTERN_LABELS = {
  hammer: 'Hammer',
  invertedHammer: 'Inverted hammer',
  shootingStar: 'Shooting star',
  hangingMan: 'Hanging man',
  bullEngulfing: 'Bullish engulfing',
  bearEngulfing: 'Bearish engulfing',
  piercing: 'Piercing line',
  darkCloud: 'Dark cloud cover',
  bullHarami: 'Bullish harami',
  bearHarami: 'Bearish harami',
  morningStar: 'Morning star',
  eveningStar: 'Evening star',
  tweezerBottom: 'Tweezer bottom',
  tweezerTop: 'Tweezer top',
  dojiLow: 'Doji at low',
  dojiHigh: 'Doji at high',
  doubleTop: 'Double top',
  doubleBottom: 'Double bottom',
  headShoulders: 'Head and shoulders',
  inverseHeadShoulders: 'Inverse head and shoulders',
  sweepHigh: 'Failed breakout (liquidity sweep above)',
  sweepLow: 'Failed breakdown (liquidity sweep below)'
};

const DIRECTION = {
  hammer: 'bull', invertedHammer: 'bull', bullEngulfing: 'bull', piercing: 'bull', bullHarami: 'bull', morningStar: 'bull',
  tweezerBottom: 'bull', dojiLow: 'bull', doubleBottom: 'bull', inverseHeadShoulders: 'bull', sweepLow: 'bull',
  shootingStar: 'bear', hangingMan: 'bear', bearEngulfing: 'bear', darkCloud: 'bear', bearHarami: 'bear', eveningStar: 'bear',
  tweezerTop: 'bear', dojiHigh: 'bear', doubleTop: 'bear', headShoulders: 'bear', sweepHigh: 'bear'
};

const body = c => Math.abs(c.c - c.o);
const range = c => c.h - c.l;
const upperShadow = c => c.h - Math.max(c.o, c.c);
const lowerShadow = c => Math.min(c.o, c.c) - c.l;
const isBull = c => c.c > c.o;
const isBear = c => c.c < c.o;
const clamp01 = x => Math.max(0, Math.min(1, x));

/** Trend over the `n` candles before index i, in ATR units (positive = up). */
function trendBefore(candles, i, n, a) {
  if (i < n || !a) return 0;
  return (candles[i - 1].c - candles[i - n].o) / a;
}

function make(candles, i, name, quality, extra = {}) {
  return { i, t: candles[i].t, name, label: PATTERN_LABELS[name], dir: DIRECTION[name], kind: 'candle', quality: Math.round(clamp01(quality) * 100) / 100, ...extra };
}

/** Candlestick patterns that finish on candle `i`. */
function detectCandle(candles, i, ctx = {}) {
  const out = [];
  if (i < 6) return out;
  const c = candles[i], p = candles[i - 1], pp = candles[i - 2];
  const a = ctx.atr || atr(candles.slice(Math.max(0, i - 15), i + 1));
  if (!a || range(c) <= 0) return out;
  const trend = trendBefore(candles, i, 5, a);
  const down = trend <= -0.6, up = trend >= 0.6;
  const trendQ = clamp01(Math.abs(trend) / 2);
  const b = body(c), r = range(c);
  const bigEnough = r >= a * 0.5; // ignore noise candles

  // single-candle shapes
  if (bigEnough && b > 0 && b / r > 0.08) {
    const hammerShape = lowerShadow(c) >= 2 * b && upperShadow(c) <= Math.max(b * 0.5, r * 0.12);
    const starShape = upperShadow(c) >= 2 * b && lowerShadow(c) <= Math.max(b * 0.5, r * 0.12);
    const q = 0.4 + 0.3 * trendQ + 0.3 * clamp01((hammerShape ? lowerShadow(c) : upperShadow(c)) / (3 * b) - 0.3);
    if (hammerShape && down) out.push(make(candles, i, 'hammer', q));
    if (hammerShape && up) out.push(make(candles, i, 'hangingMan', q - 0.1));
    if (starShape && up) out.push(make(candles, i, 'shootingStar', q));
    if (starShape && down) out.push(make(candles, i, 'invertedHammer', q - 0.1));
  }

  // doji at a recent extreme
  if (r >= a * 0.4 && b / r <= 0.1) {
    const look = candles.slice(i - 10, i);
    if (c.l <= Math.min(...look.map(x => x.l)) && down) out.push(make(candles, i, 'dojiLow', 0.35 + 0.35 * trendQ));
    if (c.h >= Math.max(...look.map(x => x.h)) && up) out.push(make(candles, i, 'dojiHigh', 0.35 + 0.35 * trendQ));
  }

  const pb = body(p);
  const pBig = pb >= a * 0.4;
  if (pBig && b >= a * 0.4) {
    // engulfing: current body covers the previous body, opposite colour
    if (isBull(c) && isBear(p) && c.c >= p.o && c.o <= p.c && down) out.push(make(candles, i, 'bullEngulfing', 0.45 + 0.25 * trendQ + 0.3 * clamp01(b / pb - 1)));
    if (isBear(c) && isBull(p) && c.c <= p.o && c.o >= p.c && up) out.push(make(candles, i, 'bearEngulfing', 0.45 + 0.25 * trendQ + 0.3 * clamp01(b / pb - 1)));

    // piercing line / dark cloud cover: gap through the prior body then retrace past its midpoint
    const pMid = (p.o + p.c) / 2;
    if (isBull(c) && isBear(p) && c.o < p.c && c.c > pMid && c.c < p.o && down) out.push(make(candles, i, 'piercing', 0.4 + 0.3 * trendQ + 0.3 * clamp01((c.c - pMid) / pb)));
    if (isBear(c) && isBull(p) && c.o > p.c && c.c < pMid && c.c > p.o && up) out.push(make(candles, i, 'darkCloud', 0.4 + 0.3 * trendQ + 0.3 * clamp01((pMid - c.c) / pb)));

    // harami: current body inside the previous body, opposite colour
    const inside = Math.max(c.o, c.c) < Math.max(p.o, p.c) && Math.min(c.o, c.c) > Math.min(p.o, p.c);
    if (inside && isBull(c) && isBear(p) && down && b < pb * 0.6) out.push(make(candles, i, 'bullHarami', 0.3 + 0.3 * trendQ));
    if (inside && isBear(c) && isBull(p) && up && b < pb * 0.6) out.push(make(candles, i, 'bearHarami', 0.3 + 0.3 * trendQ));
  }

  // tweezers: two candles with (nearly) the same extreme, opposite colours
  const tolT = a * 0.1;
  if (pBig && Math.abs(c.l - p.l) <= tolT && isBear(p) && isBull(c) && down) out.push(make(candles, i, 'tweezerBottom', 0.4 + 0.3 * trendQ + 0.3 * (1 - Math.abs(c.l - p.l) / tolT)));
  if (pBig && Math.abs(c.h - p.h) <= tolT && isBull(p) && isBear(c) && up) out.push(make(candles, i, 'tweezerTop', 0.4 + 0.3 * trendQ + 0.3 * (1 - Math.abs(c.h - p.h) / tolT)));

  // morning / evening star: big candle, small-bodied candle, big candle back past the first one's midpoint
  const ppb = body(pp);
  const prior = trendBefore(candles, i - 1, 5, a);
  if (ppb >= a * 0.5 && pb <= ppb * 0.35 && b >= a * 0.5) {
    const mid = (pp.o + pp.c) / 2;
    if (isBear(pp) && isBull(c) && c.c > mid && prior <= -0.6) out.push(make(candles, i, 'morningStar', 0.5 + 0.25 * clamp01(Math.abs(prior) / 2) + 0.25 * clamp01((c.c - mid) / ppb)));
    if (isBull(pp) && isBear(c) && c.c < mid && prior >= 0.6) out.push(make(candles, i, 'eveningStar', 0.5 + 0.25 * clamp01(Math.abs(prior) / 2) + 0.25 * clamp01((mid - c.c) / ppb)));
  }
  return out;
}

/**
 * Chart patterns built from confirmed swing points. A swing at index j is only known once candle j+SWING_K has closed,
 * so a pattern can only fire on or after that. Each fires once, on the candle that closes through the neckline (or, for
 * sweeps, the candle that pokes past and closes back).
 */
function detectChart(candles, swings = swingPoints(candles, SWING_K)) {
  const out = [];
  const n = candles.length;
  if (n < 30) return out;
  const atrAll = atr(candles, 50);
  const tolPrice = idx => Math.max(candles[idx].c * 0.0015, (atr(candles.slice(Math.max(0, idx - 15), idx + 1)) || atrAll) * 0.6);
  const fired = new Set();
  const push = (i, name, quality, level) => {
    const key = `${name}|${i}`;
    if (fired.has(key)) return;
    fired.add(key);
    out.push({ i, t: candles[i].t, name, label: PATTERN_LABELS[name], dir: DIRECTION[name], kind: 'chart', quality: Math.round(clamp01(quality) * 100) / 100, level });
  };

  const { highs, lows } = swings;
  const lowestBetween = (a, b) => Math.min(...candles.slice(a, b + 1).map(c => c.l));
  const highestBetween = (a, b) => Math.max(...candles.slice(a, b + 1).map(c => c.h));
  const firstClose = (from, to, test) => {
    for (let k = from; k <= Math.min(to, n - 1); k++) if (test(candles[k])) return k;
    return -1;
  };

  // double top / double bottom
  for (let h = 1; h < highs.length; h++) {
    const A = highs[h - 1], B = highs[h];
    const tol = tolPrice(B.i);
    if (B.i - A.i < 6 || B.i - A.i > 80 || Math.abs(A.price - B.price) > tol) continue;
    const neck = lowestBetween(A.i, B.i);
    if (Math.min(A.price, B.price) - neck < tol * 1.2) continue;
    const k = firstClose(B.i + SWING_K, B.i + SWING_K + 12, c => c.c < neck);
    if (k > 0) push(k, 'doubleTop', 0.5 + 0.5 * clamp01(1 - Math.abs(A.price - B.price) / tol), neck);
  }
  for (let h = 1; h < lows.length; h++) {
    const A = lows[h - 1], B = lows[h];
    const tol = tolPrice(B.i);
    if (B.i - A.i < 6 || B.i - A.i > 80 || Math.abs(A.price - B.price) > tol) continue;
    const neck = highestBetween(A.i, B.i);
    if (neck - Math.max(A.price, B.price) < tol * 1.2) continue;
    const k = firstClose(B.i + SWING_K, B.i + SWING_K + 12, c => c.c > neck);
    if (k > 0) push(k, 'doubleBottom', 0.5 + 0.5 * clamp01(1 - Math.abs(A.price - B.price) / tol), neck);
  }

  // head and shoulders (three highs, middle one highest) and the inverse
  for (let h = 2; h < highs.length; h++) {
    const L = highs[h - 2], H = highs[h - 1], R = highs[h];
    const tol = tolPrice(R.i);
    if (R.i - L.i > 120 || H.price - Math.max(L.price, R.price) < tol * 0.8 || Math.abs(L.price - R.price) > tol * 1.8) continue;
    const neck = Math.min(lowestBetween(L.i, H.i), lowestBetween(H.i, R.i));
    const k = firstClose(R.i + SWING_K, R.i + SWING_K + 12, c => c.c < neck);
    if (k > 0) push(k, 'headShoulders', 0.55 + 0.45 * clamp01(1 - Math.abs(L.price - R.price) / (tol * 1.8)), neck);
  }
  for (let h = 2; h < lows.length; h++) {
    const L = lows[h - 2], H = lows[h - 1], R = lows[h];
    const tol = tolPrice(R.i);
    if (R.i - L.i > 120 || Math.min(L.price, R.price) - H.price < tol * 0.8 || Math.abs(L.price - R.price) > tol * 1.8) continue;
    const neck = Math.max(highestBetween(L.i, H.i), highestBetween(H.i, R.i));
    const k = firstClose(R.i + SWING_K, R.i + SWING_K + 12, c => c.c > neck);
    if (k > 0) push(k, 'inverseHeadShoulders', 0.55 + 0.45 * clamp01(1 - Math.abs(L.price - R.price) / (tol * 1.8)), neck);
  }

  // failed breakout / liquidity sweep: a candle takes out a confirmed swing extreme, then closes back inside
  const known = (list, i) => list.filter(s => s.i + SWING_K < i && i - s.i <= 60);
  for (let i = 20; i < n; i++) {
    const c = candles[i];
    const r = range(c);
    if (r <= 0) continue;
    for (const s of known(highs, i)) {
      if (c.h > s.price && c.c < s.price && upperShadow(c) / r >= 0.4) {
        // the swing must still be intact (no earlier candle already took it out)
        if (highestBetween(s.i + 1, i - 1) > s.price) continue;
        push(i, 'sweepHigh', 0.45 + 0.55 * clamp01(upperShadow(c) / r), s.price);
        break;
      }
    }
    for (const s of known(lows, i)) {
      if (c.l < s.price && c.c > s.price && lowerShadow(c) / r >= 0.4) {
        if (lowestBetween(s.i + 1, i - 1) < s.price) continue;
        push(i, 'sweepLow', 0.45 + 0.55 * clamp01(lowerShadow(c) / r), s.price);
        break;
      }
    }
  }
  return out;
}

/** Every pattern in the series, sorted by candle index. Pass a precomputed ATR per index to speed up long runs. */
function detectAll(candles) {
  const out = [];
  const a = atr(candles, 14);
  for (let i = 6; i < candles.length; i++) {
    const local = atr(candles.slice(Math.max(0, i - 15), i + 1)) || a;
    out.push(...detectCandle(candles, i, { atr: local }));
  }
  out.push(...detectChart(candles));
  return out.sort((x, y) => x.i - y.i || y.quality - x.quality);
}

module.exports = { PATTERN_LABELS, DIRECTION, SWING_K, detectCandle, detectChart, detectAll, trendBefore };
