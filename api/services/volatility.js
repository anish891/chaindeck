const calendar = require('./calendar');

// Intraday volatility helpers: trading-time IV, realised volatility from the snapshot series,
// and where today's IV sits against stored session closes.
//
// NSE quotes IV on a calendar basis (time to expiry / 365 days). Intraday realised vol only sees
// minutes when the market is open, so the two are compared on one clock: trading minutes
// (09:15-15:30 IST, Mon-Fri excluding NSE holidays, 252 days a year).

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
const TRADING_MIN_PER_YEAR = 252 * (CLOSE_MIN - OPEN_MIN);
const CAL_MIN_PER_YEAR = 365 * 24 * 60;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const RV_WINDOWS_MIN = [15, 30, 60];
const MIN_RETURNS = 5;
const MIN_COVERAGE = 0.6; // a window needs at least 60% of its span covered by snapshots

/** '13-Oct-2026' -> epoch ms of 15:30 IST that day, or null. */
function expiryCloseMs(expiry) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(expiry || ''));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month === -1) return null;
  return Date.UTC(Number(m[3]), month, Number(m[1])) + CLOSE_MIN * 60000 - IST_OFFSET_MS;
}

/** Minutes of regular NSE session between two instants (weekends and NSE holidays skipped; see calendar.js). */
const tradingMinutesBetween = calendar.tradingMinutesBetween;

/**
 * Calendar-basis IV (percent) -> trading-time IV (percent): same total variance to expiry,
 * spread over trading minutes only. Null when there is no time left to spread it over.
 */
function toTradingTimeIv(ivPct, atMs, expiryMs) {
  if (!(ivPct > 0) || !expiryMs || !(expiryMs > atMs)) return null;
  const calYears = (expiryMs - atMs) / 60000 / CAL_MIN_PER_YEAR;
  const tradeYears = tradingMinutesBetween(atMs, expiryMs) / TRADING_MIN_PER_YEAR;
  if (!(tradeYears > 0)) return null;
  return ivPct * Math.sqrt(calYears / tradeYears);
}

/**
 * Annualised realised vol (percent) of spot over the `windowMin` minutes ending at points[endIdx].
 * Uses squared log returns over elapsed trading minutes, so uneven snapshot spacing is fine.
 * Null until the window has enough returns and coverage.
 */
function realisedVol(points, endIdx, windowMin) {
  const end = points[endIdx];
  if (!end || !(end.spot > 0)) return null;
  const from = end.t - windowMin * 60000;
  let start = endIdx;
  while (start > 0 && points[start - 1].t >= from) start--;
  if (start > 0) start--; // the snapshot just before the window anchors the first return
  let sumSq = 0;
  let returns = 0;
  for (let i = start + 1; i <= endIdx; i++) {
    const a = points[i - 1].spot;
    const b = points[i].spot;
    if (!(a > 0) || !(b > 0)) continue;
    const r = Math.log(b / a);
    sumSq += r * r;
    returns++;
  }
  const covered = Math.min(end.t - points[start].t, windowMin * 60000) / (windowMin * 60000);
  const elapsed = tradingMinutesBetween(points[start].t, end.t);
  if (returns < MIN_RETURNS || covered < MIN_COVERAGE || !(elapsed > 0)) return null;
  return Math.sqrt((sumSq / elapsed) * TRADING_MIN_PER_YEAR) * 100;
}

const round2 = v => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(2)));

/** Copies of the day's points (sorted by t) with ivT and rv15 / rv30 / rv60 added. */
function addVolSeries(points, expiry) {
  const expMs = expiryCloseMs(expiry);
  return points.map((p, i) => {
    const out = { ...p, ivT: round2(toTradingTimeIv(p.atmIv, p.t, expMs)) };
    RV_WINDOWS_MIN.forEach(w => { out[`rv${w}`] = round2(realisedVol(points, i, w)); });
    return out;
  });
}

/** Share (0-100) of past session closing IVs at or below today's IV. Null with fewer than 5 sessions. */
function ivPercentile(currentIv, pastIvs) {
  const past = (pastIvs || []).filter(v => v > 0);
  if (!(currentIv > 0) || past.length < 5) return { pct: null, samples: past.length };
  const below = past.filter(v => v <= currentIv).length;
  return { pct: Math.round((below / past.length) * 100), samples: past.length };
}

module.exports = {
  RV_WINDOWS_MIN,
  expiryCloseMs,
  tradingMinutesBetween,
  toTradingTimeIv,
  realisedVol,
  addVolSeries,
  ivPercentile
};
