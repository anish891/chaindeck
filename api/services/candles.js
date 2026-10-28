const fetch = require('node-fetch');
const calendar = require('./calendar');

// OHLC candles for the Nifty 50 index from Yahoo Finance, with volume borrowed from the Nifty 50 ETF (NIFTYBEES).
// The index itself carries no volume, so the ETF's traded volume on the same candle is used as a proxy. It is a proxy:
// it includes arbitrage and creation/redemption activity, and the UI says so.
//
// Candle shape everywhere: { t: epoch ms (candle open), o, h, l, c, v: number | null }

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const SYMBOLS = { index: '^NSEI', etf: 'NIFTYBEES.NS', vix: '^INDIAVIX' };
const IST_OFFSET_MS = 330 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

// What the chart shows, per timeframe. `minutes` is the candle size (null for daily).
const PRESETS = {
  '5m': { yahooInterval: '5m', range: '5d', minutes: 5 },
  '15m': { yahooInterval: '15m', range: '30d', minutes: 15 },
  '1d': { yahooInterval: '1d', range: '1y', minutes: null }
};

// How much history the backtests learn from (Yahoo limits: intraday 60 sessions, daily years).
const HISTORY_PRESETS = {
  '5m': { yahooInterval: '5m', range: '60d' },
  '15m': { yahooInterval: '15m', range: '60d' },
  '1d': { yahooInterval: '1d', range: '5y' }
};

const TTL_OPEN_MS = 20 * 1000;
const TTL_CLOSED_MS = 15 * 60 * 1000;
const TTL_HISTORY_MS = 6 * 3600 * 1000;
// Longest an old copy may be shown when a refresh fails. Short while the market moves, long when nothing changes anyway.
const STALE_MAX_OPEN_MS = 3 * 60 * 1000;
const STALE_MAX_CLOSED_MS = 6 * 3600 * 1000;

const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinuteOfDay = ms => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** Yahoo chart JSON -> clean, sorted, de-duplicated candles. Candles with any missing OHLC value are dropped. */
function parseYahoo(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !Array.isArray(r.timestamp) || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return [];
  const q = r.indicators.quote[0];
  const out = [];
  const seen = new Set();
  r.timestamp.forEach((ts, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].some(x => x === null || x === undefined || !Number.isFinite(x))) return;
    const t = ts * 1000;
    if (seen.has(t)) return;
    seen.add(t);
    const v = q.volume && Number.isFinite(q.volume[i]) && q.volume[i] > 0 ? q.volume[i] : null;
    out.push({ t, o, h, l, c, v });
  });
  return out.sort((a, b) => a.t - b.t);
}

async function fetchYahooCandles(symbol, interval, range, fetchImpl = fetch) {
  const url = `${YAHOO}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    const json = await res.json();
    if (json && json.chart && json.chart.error) throw new Error(`Yahoo: ${json.chart.error.description || 'error'}`);
    return parseYahoo(json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attach ETF volume to index candles. Intraday candles match on the exact timestamp; daily candles match on the IST date.
 * Returns the merged candles plus how many candles got a volume.
 */
function mergeVolume(indexCandles, etfCandles, daily = false) {
  if (!etfCandles || !etfCandles.length) return { candles: indexCandles.map(c => ({ ...c, v: null })), covered: 0 };
  const key = c => (daily ? istDay(c.t) : String(c.t));
  const vols = new Map(etfCandles.filter(c => c.v).map(c => [key(c), c.v]));
  let covered = 0;
  const candles = indexCandles.map(c => {
    const v = vols.get(key(c)) || null;
    if (v) covered += 1;
    return { ...c, v };
  });
  return { candles, covered };
}

/**
 * Build candles from the per-minute spot values we store ourselves. This is the fallback when Yahoo is unavailable:
 * the open/high/low/close are only as good as the sampling (about one point a minute) and there is no volume.
 */
function candlesFromSpotPoints(points, minutes) {
  const OPEN = 9 * 60 + 15;
  const buckets = new Map();
  (points || []).forEach(p => {
    if (!p || !Number.isFinite(p.spot) || !Number.isFinite(p.t)) return;
    const mod = istMinuteOfDay(p.t);
    if (mod < OPEN || mod > 15 * 60 + 30) return;
    const slot = Math.floor((mod - OPEN) / minutes);
    const startMs = Math.floor((p.t + IST_OFFSET_MS) / 86400000) * 86400000 - IST_OFFSET_MS + (OPEN + slot * minutes) * 60000;
    const b = buckets.get(startMs);
    if (!b) buckets.set(startMs, { t: startMs, o: p.spot, h: p.spot, l: p.spot, c: p.spot, v: null, first: p.t, last: p.t });
    else {
      if (p.t < b.first) { b.o = p.spot; b.first = p.t; }
      if (p.t >= b.last) { b.c = p.spot; b.last = p.t; }
      b.h = Math.max(b.h, p.spot);
      b.l = Math.min(b.l, p.spot);
    }
  });
  return [...buckets.values()].sort((a, b) => a.t - b.t).map(({ first, last, ...c }) => c);
}

// ── caching ──────────────────────────────────────────────────────────────

const cache = new Map(); // key -> { ts, value }
const inflight = new Map();

function marketOpenNow(nowMs = Date.now()) {
  return calendar.isMarketOpenAt(nowMs, { before: 5, after: 10 });
}

// Resolves { value, ts, stale }. On a failed refresh the previous value is served only while it is younger than
// `staleMax`; beyond that the error propagates so callers fall back or show "no data" instead of an old picture.
async function cached(key, ttl, loader, staleMax = ttl * 4) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return { value: hit.value, ts: hit.ts, stale: false };
  if (inflight.has(key)) return inflight.get(key);
  const p = loader()
    .then(value => {
      const ts = Date.now();
      cache.set(key, { ts, value });
      while (cache.size > 40) cache.delete(cache.keys().next().value);
      return { value, ts, stale: false };
    })
    .catch(err => {
      if (hit && Date.now() - hit.ts < staleMax) {
        console.error(`candles: serving stale ${key} (${Math.round((Date.now() - hit.ts) / 1000)}s old):`, err.message);
        return { value: hit.value, ts: hit.ts, stale: true };
      }
      throw err;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Candles for the chart: index OHLC with ETF volume merged in.
 * `fallbackPoints` (optional) are stored { t, spot } values used when Yahoo cannot be reached: either the array itself
 * or an async function returning it, which is only called if Yahoo fails (so storage is not read on every request).
 */
async function getCandles(interval, { fallbackPoints = null, fetchImpl = fetch } = {}) {
  const preset = PRESETS[interval];
  if (!preset) throw new Error(`Unsupported interval ${interval}`);
  const open = marketOpenNow();
  const ttl = open ? TTL_OPEN_MS : TTL_CLOSED_MS;
  const staleMax = open ? STALE_MAX_OPEN_MS : STALE_MAX_CLOSED_MS;
  const daily = interval === '1d';

  try {
    const result = await cached(`chart|${interval}`, ttl, async () => {
      const [idx, etf] = await Promise.all([
        fetchYahooCandles(SYMBOLS.index, preset.yahooInterval, preset.range, fetchImpl),
        fetchYahooCandles(SYMBOLS.etf, preset.yahooInterval, preset.range, fetchImpl).catch(() => [])
      ]);
      if (!idx.length) throw new Error('No index candles returned');
      const merged = mergeVolume(idx, etf, daily);
      return { candles: merged.candles, volumeSource: merged.covered > idx.length * 0.5 ? 'etf' : 'none', source: 'yahoo' };
    }, staleMax);
    return { ...result.value, fetchedAt: result.ts, stale: result.stale, updatedAt: Date.now() };
  } catch (err) {
    console.error('candles: Yahoo unavailable:', err.message);
    const minutes = preset.minutes;
    if (fallbackPoints && minutes) {
      let points = fallbackPoints;
      if (typeof points === 'function') {
        try { points = await points(); } catch (e) { console.error('candles: stored fallback unavailable:', e.message); points = null; }
      }
      const stored = candlesFromSpotPoints(points, minutes);
      if (stored.length) return { candles: stored, volumeSource: 'none', source: 'stored', fetchedAt: Date.now(), stale: false, updatedAt: Date.now() };
    }
    return { candles: [], volumeSource: 'none', source: 'none', fetchedAt: null, stale: false, updatedAt: Date.now() };
  }
}

/** Long history for backtests (index only; volume is not needed to detect patterns). Cached for hours. */
async function getHistoryCandles(interval, { fetchImpl = fetch } = {}) {
  const preset = HISTORY_PRESETS[interval];
  if (!preset) throw new Error(`Unsupported interval ${interval}`);
  const r = await cached(`history|${interval}`, TTL_HISTORY_MS, () => fetchYahooCandles(SYMBOLS.index, preset.yahooInterval, preset.range, fetchImpl), TTL_HISTORY_MS * 4);
  return r.value;
}

/** 60 sessions of 5m index candles with ETF volume merged in, for the level scorecard. Cached for hours. */
async function getHistoryWithVolume({ fetchImpl = fetch } = {}) {
  const preset = HISTORY_PRESETS['5m'];
  const r = await cached('historyv|5m', TTL_HISTORY_MS, async () => {
    const [idx, etf] = await Promise.all([
      fetchYahooCandles(SYMBOLS.index, preset.yahooInterval, preset.range, fetchImpl),
      fetchYahooCandles(SYMBOLS.etf, preset.yahooInterval, preset.range, fetchImpl).catch(() => [])
    ]);
    if (!idx.length) throw new Error('No index candles returned');
    return mergeVolume(idx, etf, false).candles;
  }, TTL_HISTORY_MS * 4);
  return r.value;
}

/**
 * Everything a strategy backtest needs for one interval (5m or 15m): 60 sessions of index candles with the ETF's volume
 * merged in (for VWAP), and India VIX on the same grid (for option prices). Cached for hours.
 */
async function getBacktestData(interval, { fetchImpl = fetch } = {}) {
  const preset = HISTORY_PRESETS[interval];
  if (!preset || interval === '1d') throw new Error(`Unsupported interval ${interval}`);
  const r = await cached(`backtest|${interval}`, TTL_HISTORY_MS, async () => {
    const [idx, etf, vix] = await Promise.all([
      fetchYahooCandles(SYMBOLS.index, preset.yahooInterval, preset.range, fetchImpl),
      fetchYahooCandles(SYMBOLS.etf, preset.yahooInterval, preset.range, fetchImpl).catch(() => []),
      fetchYahooCandles(SYMBOLS.vix, preset.yahooInterval, preset.range, fetchImpl)
    ]);
    if (!idx.length) throw new Error('No index candles returned');
    if (!vix.length) throw new Error('No India VIX candles returned');
    return { candles: mergeVolume(idx, etf, false).candles, vix: vix.map(c => ({ t: c.t, c: c.c })) };
  }, TTL_HISTORY_MS * 4);
  return { ...r.value, fetchedAt: r.ts };
}

function clearCache() {
  cache.clear();
  inflight.clear();
}

module.exports = {
  SYMBOLS,
  PRESETS,
  HISTORY_PRESETS,
  istDay,
  istMinuteOfDay,
  parseYahoo,
  fetchYahooCandles,
  mergeVolume,
  candlesFromSpotPoints,
  getCandles,
  getHistoryCandles,
  getHistoryWithVolume,
  getBacktestData,
  marketOpenNow,
  STALE_MAX_OPEN_MS,
  cached,
  clearCache
};
