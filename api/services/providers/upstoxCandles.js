const upstox = require('./upstox');

// OHLC candles from Upstox's v3 historical candle API, in ChainDeck's candle shape { t, o, h, l, c, v }.
//
//   past sessions:  GET /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}
//   today:          GET /v3/historical-candle/intraday/{key}/{unit}/{interval}
//
// Upstox returns [timestamp ISO, open, high, low, close, volume, oi] newest first; the timestamp is the candle's start,
// the same convention the rest of ChainDeck uses. Minute candles are limited to about a month per request, so longer
// ranges are fetched in windows. `range` uses the same words as before ('5d', '30d', '60d' = trading sessions; '1y', '5y').

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86400000;
const MINUTE_WINDOW_DAYS = 28;

const INTERVALS = {
  '1m': { unit: 'minutes', n: 1 },
  '5m': { unit: 'minutes', n: 5 },
  '15m': { unit: 'minutes', n: 15 },
  '1d': { unit: 'days', n: 1 }
};

const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** '60d' -> { sessions: 60, calendarDays: 95 }; '1y' -> { sessions: null, calendarDays: 366 }. */
function parseRange(range) {
  const m = /^(\d+)([dy])$/.exec(String(range || ''));
  if (!m) throw new Error(`Unsupported range ${range}`);
  const n = Number(m[1]);
  // sessions -> calendar days: weekends and holidays add roughly half again, plus a margin for long holiday weeks
  return m[2] === 'd' ? { sessions: n, calendarDays: Math.ceil(n * 1.5) + 5 } : { sessions: null, calendarDays: n * 366 };
}

/** Upstox candle rows -> sorted, de-duplicated candles; rows with a missing or non-finite OHLC value are dropped. */
function parseUpstoxCandles(rows) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(r)) continue;
    const t = Date.parse(r[0]);
    const [o, h, l, c] = r.slice(1, 5).map(Number);
    if (!Number.isFinite(t) || [o, h, l, c].some(x => !Number.isFinite(x) || x <= 0)) continue;
    const v = Number(r[5]);
    out.set(t, { t, o, h, l, c, v: Number.isFinite(v) && v > 0 ? v : null });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** Keep the last `n` IST trading days of intraday candles. */
function lastSessions(candles, n) {
  if (!n) return candles;
  const days = [...new Set(candles.map(c => istYmd(c.t)))];
  const keep = new Set(days.slice(-n));
  return candles.filter(c => keep.has(istYmd(c.t)));
}

const keyPath = key => encodeURIComponent(key);

async function fetchUpstoxCandles(instrumentKey, interval, range, { get = upstox.get, nowMs = Date.now() } = {}) {
  const iv = INTERVALS[interval];
  if (!iv) throw new Error(`Unsupported interval ${interval}`);
  const { sessions, calendarDays } = parseRange(range);
  const today = istYmd(nowMs);
  const windowDays = iv.unit === 'minutes' ? MINUTE_WINDOW_DAYS : calendarDays;

  // Past sessions, newest window first: [from, to] with to = yesterday.
  const windows = [];
  let to = nowMs - DAY_MS;
  const earliest = nowMs - calendarDays * DAY_MS;
  while (to > earliest) {
    const from = Math.max(earliest, to - (windowDays - 1) * DAY_MS);
    windows.push([istYmd(from), istYmd(to)]);
    to = from - DAY_MS;
  }

  const base = `/v3/historical-candle/${keyPath(instrumentKey)}/${iv.unit}/${iv.n}`;
  const [today_, ...past] = await Promise.all([
    // Today's candles: missing before the open or on a holiday, which is fine.
    get(`/v3/historical-candle/intraday/${keyPath(instrumentKey)}/${iv.unit}/${iv.n}`).catch(err => {
      if (err && err.code === 'UPSTOX_AUTH') throw err;
      return { candles: [] };
    }),
    ...windows.map(([from, toDay]) => get(`${base}/${toDay}/${from}`))
  ]);
  const rows = [today_, ...past].flatMap(d => (d && Array.isArray(d.candles) ? d.candles : []));
  let candles = parseUpstoxCandles(rows).filter(c => istYmd(c.t) <= today);
  if (iv.unit === 'minutes') candles = lastSessions(candles, sessions);
  return candles;
}

module.exports = { fetchUpstoxCandles, parseUpstoxCandles, parseRange, lastSessions, INTERVALS };
