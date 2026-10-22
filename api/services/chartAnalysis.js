// Orchestrates the chart payload: candles + levels + patterns + backtest + signals, in one response.
const candlesSvc = require('./candles');
const levels = require('./levels');
const patternsSvc = require('./patterns');
const backtestSvc = require('./backtest');
const signalsSvc = require('./signals');
const scorecardSvc = require('./scorecard');

const BACKTEST_TTL_MS = 6 * 3600 * 1000;
const btCache = new Map(); // interval -> { ts, value }
const btInflight = new Map();

async function getBacktest(interval, deps) {
  const hit = btCache.get(interval);
  if (hit && Date.now() - hit.ts < BACKTEST_TTL_MS) return hit.value;
  if (btInflight.has(interval)) return btInflight.get(interval);
  const p = (async () => {
    try {
      const hist = await deps.getHistoryCandles(interval);
      if (!hist || hist.length < 100) return hit ? hit.value : null;
      const value = backtestSvc.backtest(hist, interval);
      btCache.set(interval, { ts: Date.now(), value });
      return value;
    } catch (err) {
      console.error(`backtest ${interval} failed:`, err.message);
      return hit ? hit.value : null;
    }
  })().finally(() => btInflight.delete(interval));
  btInflight.set(interval, p);
  return p;
}

/** Freshness facts the page turns into a badge: when we last got data, whether it is a leftover copy, how current the last bar is. */
function feedOf(base, candles) {
  const last = candles.length ? candles[candles.length - 1].t : null;
  return { fetchedAt: base.fetchedAt || null, stale: !!base.stale, lastBarT: last, source: base.source };
}

const SCORECARD_TTL_MS = 6 * 3600 * 1000;
let scCache = null;
let scInflight = null;

/** Measured scorecard of level types (cached for hours). null when history is unavailable; callers then use default weights. */
async function getScorecard(deps) {
  if (typeof deps.getHistoryWithVolume !== 'function') return null;
  if (scCache && Date.now() - scCache.ts < SCORECARD_TTL_MS) return scCache.value;
  if (scInflight) return scInflight;
  scInflight = (async () => {
    try {
      const [c5, daily] = await Promise.all([deps.getHistoryWithVolume(), deps.getHistoryCandles('1d')]);
      if (!c5 || c5.length < 500) return scCache ? scCache.value : null;
      const value = scorecardSvc.buildScorecard(c5, daily);
      value.multipliers = scorecardSvc.weightMultipliers(value);
      scCache = { ts: Date.now(), value };
      return value;
    } catch (err) {
      console.error('level scorecard failed:', err.message);
      return scCache ? scCache.value : null;
    }
  })().finally(() => { scInflight = null; });
  return scInflight;
}

const round1 = n => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/**
 * @param interval '5m' | '15m' | '1d'
 * @param opts.d latest processed option chain (may be null before the first fetch)
 * @param opts.fallbackPoints stored per-minute spot points (or an async loader for them) used if Yahoo is unreachable
 * @param opts.deps injectable data sources for tests
 */
async function analyze(interval, { d = null, fallbackPoints = null, deps = candlesSvc } = {}) {
  const base = await deps.getCandles(interval, { fallbackPoints });
  const candles = base.candles;
  if (!candles.length) {
    return { interval, source: base.source, volumeSource: base.volumeSource, feed: feedOf(base, []), candles: [], vwap: [], zones: [], patterns: [], signals: [], actionZones: [], profile: null, backtest: null, spot: d ? d.spot : null, updatedAt: Date.now() };
  }

  const daily = interval === '1d' ? base : await deps.getCandles('1d', {}).catch(() => ({ candles: [] }));
  const lastDay = candlesSvc.istDay(candles[candles.length - 1].t);
  const prior = levels.priorRanges(daily.candles, lastDay);

  const intraday = interval !== '1d';
  const sessionCandles = intraday ? candles.filter(c => candlesSvc.istDay(c.t) === lastDay) : candles.slice(-20);
  const profileCandles = intraday ? candles : candles.slice(-60);
  const profile = levels.volumeProfile(profileCandles, intraday ? 10 : 25);
  const vwap = intraday ? levels.vwapSeries(candles) : [];
  const lastVwap = vwap.length && candlesSvc.istDay(vwap[vwap.length - 1].t) === lastDay ? vwap[vwap.length - 1].value : null;
  const spot = d && Number.isFinite(d.spot) ? d.spot : candles[candles.length - 1].c;

  const card = await getScorecard(deps);
  const ladder = levels.buildLadder({
    spot,
    weightAdjust: card ? card.multipliers : null,
    walls: d && d.walls,
    maxPain: d && d.maxPain,
    zeroGamma: d && d.gex && d.gex.zeroGammaLevel,
    cpr: d && d.cpr,
    prior,
    candles,
    profile,
    vwap: lastVwap
  }, { tracking: sessionCandles });

  const patterns = patternsSvc.detectAll(candles);
  const backtest = await getBacktest(interval, deps);
  const strikes = d && d.strikes ? d.strikes : [];
  const signals = signalsSvc.buildSignals({ candles, patterns, ladder, strikes, backtest, interval });
  const actionZones = signalsSvc.buildActionZones({ candles, ladder, strikes, profile, patterns, interval });

  const notable = signalsSvc.selectNotable(patterns, { interval, backtest, signals });
  const visibleFrom = candles[Math.max(0, candles.length - (intraday ? 400 : 260))].t;
  return {
    interval,
    source: base.source,
    volumeSource: base.volumeSource,
    feed: feedOf(base, candles),
    spot,
    atr: round1(ladder.atr),
    tolerance: round1(ladder.tolerance),
    candles,
    vwap: vwap.map(v => ({ t: v.t, value: round1(v.value) })),
    zones: ladder.zones.map(z => ({ ...z, low: round1(z.low), high: round1(z.high), mid: round1(z.mid), distancePct: Math.round(z.distancePct * 100) / 100 })),
    profile: profile ? { binSize: profile.binSize, poc: profile.poc, vah: profile.vah, val: profile.val, bins: profile.bins.map(b => ({ price: b.price, volume: Math.round(b.volume) })) } : null,
    patterns: patterns.filter(p => p.t >= visibleFrom).map(p => ({ t: p.t, i: p.i, name: p.name, label: p.label, dir: p.dir, kind: p.kind, quality: p.quality, level: p.level ?? null, notable: notable.has(`${p.name}|${p.t}`) })),
    signals,
    actionZones,
    backtest: backtest ? { interval: backtest.interval, horizon: backtest.horizon, sessions: backtest.sessions, candles: backtest.candles, minSamples: backtest.minSamples, baseline: backtest.baseline, patterns: backtest.patterns } : null,
    updatedAt: Date.now()
  };
}

function clearCache() { btCache.clear(); btInflight.clear(); scCache = null; scInflight = null; }

module.exports = { analyze, getScorecard, clearCache };
