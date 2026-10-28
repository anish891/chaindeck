// Payoff of a set of option positions in one expiry: profit or loss at expiry, and today (Black-Scholes with each leg's IV).
// Pure, so the server-side test can load it. Positions: { strike, optionType: 'CE' | 'PE', qty (units, negative = short),
// avgPrice, iv (percent) }.

const RATE = 0.06;          // risk-free rate for the "today" curve; it barely matters over days to expiry
const YEAR_MS = 365 * 24 * 3600 * 1000;

/** Standard normal CDF (Abramowitz and Stegun 26.2.17, error below 1e-7). */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export const intrinsic = (optionType, strike, spot) => Math.max(0, optionType === 'CE' ? spot - strike : strike - spot);

/** Black-Scholes price. T in years, sigma as a fraction. Falls back to intrinsic at or after expiry. */
export function bsPrice(optionType, S, K, T, sigma, r = RATE) {
  if (!(T > 0) || !(sigma > 0)) return intrinsic(optionType, K, S);
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / sd;
  const d2 = d1 - sd;
  return optionType === 'CE'
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * P&L curves over a spot range around `spot` (plus or minus `rangePct`).
 * Returns { xs, atExpiry, today, breakevens, maxProfit, maxLoss } where max values are over the range shown, and
 * maxLoss / maxProfit are null when they keep growing past the edge of the range (unbounded).
 */
export function payoffSeries(positions, { spot, expiryMs, nowMs, rangePct = 0.06, steps = 120 }) {
  const legs = positions.filter(p => p.qty);
  if (!legs.length || !(spot > 0)) return null;
  const lo = spot * (1 - rangePct), hi = spot * (1 + rangePct);
  const xs = [];
  for (let i = 0; i <= steps; i++) xs.push(Math.round(lo + ((hi - lo) * i) / steps));
  for (const p of legs) if (p.strike > lo && p.strike < hi) xs.push(p.strike); // exact kinks
  xs.sort((a, b) => a - b);
  const T = Math.max(0, (expiryMs - nowMs) / YEAR_MS);
  const at = S => legs.reduce((a, p) => a + p.qty * (intrinsic(p.optionType, p.strike, S) - p.avgPrice), 0);
  const now = S => legs.reduce((a, p) => a + p.qty * (bsPrice(p.optionType, S, p.strike, T, (p.iv || 15) / 100) - p.avgPrice), 0);
  const atExpiry = xs.map(at);
  const today = xs.map(now);

  const breakevens = [];
  for (let i = 1; i < xs.length; i++) {
    const a = atExpiry[i - 1], b = atExpiry[i];
    if (a === 0 && i === 1) breakevens.push(xs[0]);
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) breakevens.push(Math.round(xs[i - 1] + ((xs[i] - xs[i - 1]) * -a) / (b - a)));
  }
  // slope past the right edge is the net call quantity; past the left edge it is minus the net put quantity
  const callSlope = legs.filter(p => p.optionType === 'CE').reduce((a, p) => a + p.qty, 0);
  const putSlope = legs.filter(p => p.optionType === 'PE').reduce((a, p) => a + p.qty, 0);
  const grows = (slopeRight, slopeLeft) => slopeRight > 0 || slopeLeft > 0;
  return {
    xs,
    atExpiry,
    today,
    breakevens: [...new Set(breakevens)],
    maxProfit: grows(callSlope, putSlope) ? null : Math.max(...atExpiry),
    maxLoss: grows(-callSlope, -putSlope) ? null : Math.min(...atExpiry)
  };
}
