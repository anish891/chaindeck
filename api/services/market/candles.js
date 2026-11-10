const calendar = require('./calendar');
const upstoxCandles = require('../providers/upstoxCandles');

// OHLC candles for the Nifty 50 index (and SENSEX, see seriesFor), with volume borrowed from the Nifty 50 ETF (NIFTYBEES).
// The index itself carries no volume, so the ETF's traded volume on the same candle is used as a proxy. It is a proxy:
// it includes arbitrage and creation/redemption activity, and the UI says so.
//
// Where the candles come from:
//   history   Upstox's candle history (REST: there is no stream for the past). Each series is looked up once per IST
//             day, the first time it is needed, and kept in memory. Nothing is re-fetched on a timer.
//   today     the live feed. Every tick of an instrument subscribed in `full` mode carries its current one-minute
//             candle; those are collected here and laid over the history, so the chart moves without any HTTP call.
//
// Candle shape everywhere: { t: epoch ms (candle open), o, h, l, c, v: number | null }

// Upstox instrument keys (NIFTYBEES is keyed by its ISIN).
const SYMBOLS = { index: 'NSE_INDEX|Nifty 50', etf: 'NSE_EQ|INF204KB14I2', vix: 'NSE_INDEX|India VIX' };
// SENSEX: the index only. There is no volume proxy (so VWAP conditions never hold), and India VIX stands in for its
// volatility (there is no SENSEX VIX); the two indices move closely together.
const SENSEX_SERIES = { index: 'BSE_INDEX|SENSEX' };

/** The instrument keys of an index's series: { index, etf (null when there is none), vix }. */
function seriesFor(symbol = 'NIFTY') {
  const sym = String(symbol || 'NIFTY').toUpperCase();
  if (sym === 'NIFTY') return SYMBOLS;
  if (sym === 'SENSEX') return { index: SENSEX_SERIES.index, etf: null, vix: SYMBOLS.vix };
  throw Object.assign(new Error(`No candles for ${symbol}`), { code: 'BAD_SYMBOL' });
}

/** Cache keys: NIFTY keeps its original ones. */
const ck = (symbol, key) => (String(symbol || 'NIFTY').toUpperCase() === 'NIFTY' ? key : `${String(symbol).toUpperCase()}|${key}`);
const noEtf = () => Promise.resolve([]);

const IST_OFFSET_MS = 330 * 60 * 1000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;

// What the chart shows, per timeframe. `minutes` is the candle size (null for daily).
const PRESETS = {
  '5m': { range: '5d', minutes: 5 },
  '15m': { range: '30d', minutes: 15 },
  '1d': { range: '1y', minutes: null }
};

// How much history the backtests learn from.
const HISTORY_PRESETS = {
  '5m': { range: '60d' },
  '15m': { range: '60d' },
  '1d': { range: '5y' }
};

const DAY_TTL_MS = 24 * 3600 * 1000; // a history series is keyed by IST day, so this only bounds memory
// Longest an old copy may be shown when a lookup fails. Short while the market moves, long when nothing changes anyway.
const STALE_MAX_OPEN_MS = 3 * 60 * 1000;
const STALE_MAX_CLOSED_MS = 6 * 3600 * 1000;

const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinuteOfDay = ms => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** One candle series from Upstox's history, by instrument key. */
const fetchSeries = (key, interval, range) => upstoxCandles.fetchUpstoxCandles(key, interval, range);

// ── today's candles from the live feed ────────────────────────────────────────

const LIVE_KEYS = [SYMBOLS.index, SYMBOLS.etf, SYMBOLS.vix, SENSEX_SERIES.index];
const LIVE_KEEP_MS = 2 * 24 * 3600 * 1000;
const liveMinutes = new Map(); // instrument key -> Map(t -> one-minute candle)
const liveDay = new Map();     // instrument key -> today's daily candle so far
let liveOff = null;

const positive = v => (Number.isFinite(v) && v > 0 ? v : null);

/** Feed ticks -> the one-minute and day candles they carry. Exported for tests; the feed calls it for every batch. */
function collectTicks(ticks) {
  for (const tick of ticks) {
    if (!tick.ohlc || !liveMinutes.has(tick.key)) continue;
    const m = tick.ohlc.I1;
    if (m && m.ts > 0 && m.open > 0 && m.close > 0) {
      const minutes = liveMinutes.get(tick.key);
      minutes.set(m.ts, { t: m.ts, o: m.open, h: m.high, l: m.low, c: m.close, v: positive(m.vol) });
      if (minutes.size > 3000) for (const t of minutes.keys()) { if (t < m.ts - LIVE_KEEP_MS) minutes.delete(t); else break; }
    }
    const d = tick.ohlc['1d'];
    if (d && d.ts > 0 && d.open > 0 && d.close > 0) liveDay.set(tick.key, { t: d.ts, o: d.open, h: d.high, l: d.low, c: d.close, v: positive(d.vol) });
  }
}

/** Subscribe the chart's instruments (once) so their candles are collected whenever the feed is running. */
function startLive(feed = require('../stream/upstoxStream').getStream().market) {
  if (liveOff) return;
  for (const key of LIVE_KEYS) if (!liveMinutes.has(key)) liveMinutes.set(key, new Map());
  const offSub = feed.subscribe(LIVE_KEYS, 'full');
  const offTicks = feed.on('ticks', collectTicks);
  liveOff = () => { offSub(); offTicks(); };
}

/** One-minute candles -> `minutes`-sized candles on the session grid (first candle opens 09:15 IST). */
function aggregateMinutes(candles, minutes) {
  const buckets = new Map();
  for (const c of candles) {
    const mod = istMinuteOfDay(c.t);
    if (mod < OPEN_MIN || mod >= CLOSE_MIN) continue;
    const start = c.t - ((mod - OPEN_MIN) % minutes) * 60000;
    const b = buckets.get(start);
    if (!b) buckets.set(start, { t: start, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    else {
      b.h = Math.max(b.h, c.h);
      b.l = Math.min(b.l, c.l);
      b.c = c.c;
      b.v = c.v === null && b.v === null ? null : (b.v || 0) + (c.v || 0);
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/**
 * History candles with the live feed's candles laid over them.
 * Only live minutes from the minute the history was fetched in are used (history already has everything before it).
 * A candle the history holds in part (the one being formed at fetch time) is completed; later candles are added.
 */
function withLive(key, candles, interval, fetchedAt) {
  const minutes = PRESETS[interval] ? PRESETS[interval].minutes : null;
  const out = new Map(candles.map(c => [c.t, c]));
  if (!minutes) {
    const today = liveDay.get(key);
    if (today && (!candles.length || today.t >= candles[candles.length - 1].t)) out.set(today.t, { ...today, v: out.has(today.t) ? out.get(today.t).v : today.v });
    return [...out.values()].sort((a, b) => a.t - b.t);
  }
  const from = Math.floor(fetchedAt / 60000) * 60000;
  const fresh = [...(liveMinutes.get(key) || new Map()).values()].filter(c => c.t >= from).sort((a, b) => a.t - b.t);
  for (const b of aggregateMinutes(fresh, minutes)) {
    const base = out.get(b.t);
    if (!base) out.set(b.t, b);
    else out.set(b.t, { t: b.t, o: base.o, h: Math.max(base.h, b.h), l: Math.min(base.l, b.l), c: b.c, v: base.v === null && b.v === null ? null : (base.v || 0) + (b.v || 0) });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
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
 * Build candles from the per-minute spot values we store ourselves. This is the fallback when the candle history is unavailable:
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

// ── history: one lookup per series per IST day ────────────────────────────────

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

/** A history series for today (IST), looked up at most once: { value, ts (when it was fetched), stale }. */
function daily(key, loader, staleMax = DAY_TTL_MS) {
  return cached(`${key}|${istDay(Date.now())}`, DAY_TTL_MS, loader, staleMax);
}

/**
 * Candles for the chart: index OHLC with ETF volume merged in, history plus today's candles from the live feed.
 * `fallbackPoints` (optional) are stored { t, spot } values used when the history cannot be read: either the array itself
 * or an async function returning it, which is only called on failure (so storage is not read on every request).
 * `load` (series loader) and `feed` are replaceable in tests.
 */
async function getCandles(interval, { fallbackPoints = null, load = fetchSeries, symbol = 'NIFTY', feed } = {}) {
  const S = seriesFor(symbol);
  const preset = PRESETS[interval];
  if (!preset) throw new Error(`Unsupported interval ${interval}`);
  const isDaily = interval === '1d';
  try {
    startLive(feed);
    const result = await daily(ck(symbol, `chart|${interval}`), async () => {
      const [idx, etf] = await Promise.all([
        load(S.index, interval, preset.range),
        S.etf ? load(S.etf, interval, preset.range).catch(() => []) : noEtf()
      ]);
      if (!idx.length) throw new Error('No index candles returned');
      return { idx, etf };
    }, marketOpenNow() ? STALE_MAX_OPEN_MS : STALE_MAX_CLOSED_MS);
    const idx = withLive(S.index, result.value.idx, interval, result.ts);
    const etf = S.etf ? withLive(S.etf, result.value.etf, interval, result.ts) : [];
    const merged = mergeVolume(idx, etf, isDaily);
    return {
      candles: merged.candles, volumeSource: merged.covered > idx.length * 0.5 ? 'etf' : 'none', source: 'upstox',
      fetchedAt: result.ts, stale: result.stale, updatedAt: Date.now()
    };
  } catch (err) {
    console.error('candles: history unavailable:', err.message);
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

/** Long history for backtests (index only; volume is not needed to detect patterns). One lookup a day. */
async function getHistoryCandles(interval, { load = fetchSeries, symbol = 'NIFTY' } = {}) {
  const S = seriesFor(symbol);
  const preset = HISTORY_PRESETS[interval];
  if (!preset) throw new Error(`Unsupported interval ${interval}`);
  const r = await daily(ck(symbol, `history|${interval}`), () => load(S.index, interval, preset.range));
  return r.value;
}

/** 60 sessions of 5m index candles with ETF volume merged in, for the level scorecard. One lookup a day. */
async function getHistoryWithVolume({ load = fetchSeries } = {}) {
  const preset = HISTORY_PRESETS['5m'];
  const r = await daily('historyv|5m', async () => {
    const [idx, etf] = await Promise.all([
      load(SYMBOLS.index, '5m', preset.range),
      load(SYMBOLS.etf, '5m', preset.range).catch(() => [])
    ]);
    if (!idx.length) throw new Error('No index candles returned');
    return mergeVolume(idx, etf, false).candles;
  });
  return r.value;
}

/**
 * Everything a strategy backtest needs for one interval (5m or 15m): 60 sessions of index candles with the ETF's volume
 * merged in (for VWAP), and India VIX on the same grid (for option prices). One lookup a day.
 */
async function getBacktestData(interval, { load = fetchSeries, symbol = 'NIFTY' } = {}) {
  const S = seriesFor(symbol);
  const preset = HISTORY_PRESETS[interval];
  if (!preset || interval === '1d') throw new Error(`Unsupported interval ${interval}`);
  const r = await daily(ck(symbol, `backtest|${interval}`), async () => {
    const [idx, etf, vix] = await Promise.all([
      load(S.index, interval, preset.range),
      S.etf ? load(S.etf, interval, preset.range).catch(() => []) : noEtf(),
      load(S.vix, interval, preset.range)
    ]);
    if (!idx.length) throw new Error('No index candles returned');
    if (!vix.length) throw new Error('No India VIX candles returned');
    return { candles: mergeVolume(idx, etf, false).candles, vix: vix.map(c => ({ t: c.t, c: c.c })) };
  });
  return { ...r.value, fetchedAt: r.ts };
}

/**
 * What a live (deployed) strategy needs right now: the chart's recent candles for the interval (with ETF volume) and
 * India VIX on the same grid. History once a day, today's candles from the live feed.
 */
async function getLiveData(interval, { load = fetchSeries, symbol = 'NIFTY', feed } = {}) {
  seriesFor(symbol);
  const preset = PRESETS[interval];
  if (!preset || interval === '1d') throw new Error(`Unsupported interval ${interval}`);
  const [chart, vix] = await Promise.all([
    getCandles(interval, { load, symbol, feed }),
    daily(`livevix|${interval}`, () => load(SYMBOLS.vix, interval, '5d'), STALE_MAX_OPEN_MS)
  ]);
  const vixCandles = withLive(SYMBOLS.vix, vix.value, interval, vix.ts);
  return { candles: chart.candles, vix: vixCandles.map(c => ({ t: c.t, c: c.c })), stale: !!(chart.stale || vix.stale), source: chart.source };
}

function clearCache() {
  cache.clear();
  inflight.clear();
  for (const m of liveMinutes.values()) m.clear();
  liveDay.clear();
}

/** Stop collecting live candles (shutdown, tests). */
function stopLive() {
  if (liveOff) liveOff();
  liveOff = null;
}

module.exports = {
  SYMBOLS,
  SENSEX_SERIES,
  seriesFor,
  PRESETS,
  HISTORY_PRESETS,
  istDay,
  istMinuteOfDay,
  fetchSeries,
  mergeVolume,
  candlesFromSpotPoints,
  collectTicks,
  aggregateMinutes,
  withLive,
  startLive,
  stopLive,
  getCandles,
  getHistoryCandles,
  getHistoryWithVolume,
  getBacktestData,
  getLiveData,
  marketOpenNow,
  STALE_MAX_OPEN_MS,
  cached,
  clearCache
};
