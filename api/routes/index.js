const express = require('express');
const router = express.Router();
const history = require('../services/storage/history');
const chartAnalysis = require('../services/analytics/chartAnalysis');
const forwardLog = require('../services/analytics/forwardlog');
const { istNow } = require('../services/market/market');
const { refreshHolidays } = require('../services/market/holidays');
const { fetchRawOptionChain, sourceName } = require('../services/market/optionChain');
const { chainView, chartView, CHART_INTERVALS } = require('../services/market/chainView');
const calendar = require('../services/market/calendar');
const instruments = require('../services/providers/instruments');
const paperRoutes = require('./paper');
const { rateLimit, requireSecret, isValidExpiry, isPlausibleExpiry, isRecentDate, sendError } = require('../middleware/security');
const {
  processOptionChainData,
  extractFeatureVector,
  computeSessionSimilarities,
  readableSessions,
  getCacheData
} = require('../services/analytics/analytics');

const READ_CACHE = 'public, s-maxage=3, stale-while-revalidate=10';
const HISTORY_CACHE = 'public, s-maxage=10, stale-while-revalidate=20';
const strictLimit = rateLimit({ windowMs: 60 * 1000, max: 20, name: 'sensitive' });

/** ?symbol=NIFTY|SENSEX (case-insensitive, NIFTY when absent). null for anything else, which the caller turns into a 400. */
function symbolOf(req) {
  const v = req.query.symbol;
  if (v === undefined) return 'NIFTY';
  return instruments.isSymbol(v) ? String(v).toUpperCase() : null;
}
const BAD_SYMBOL = { ok: false, error: `symbol must be one of ${instruments.SYMBOLS.join(', ')}.` };

router.get('/option-chain', async (req, res) => {
  const { expiry } = req.query;
  const symbol = symbolOf(req);
  if (!symbol) return res.status(400).json(BAD_SYMBOL);
  if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 13-Oct-2026.' });
  try {
    const data = await chainView(symbol, expiry || null);
    res.set('Cache-Control', READ_CACHE);
    res.json({ ok: true, data });
  } catch (err) {
    if (err.code === 'BAD_EXPIRY') return res.status(400).json({ ok: false, error: 'Unknown expiry.' });
    return sendError(res, 502, 'Error fetching option chain', err);
  }
});

// Intraday series + baseline strike snapshots (5m / 15m / 30m earlier, and the open)
router.get('/intraday', async (req, res) => {
  const { expiry, date } = req.query;
  const symbol = symbolOf(req);
  if (!symbol) return res.status(400).json(BAD_SYMBOL);
  if (!isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry (DD-Mon-YYYY) is required.' });
  if (date !== undefined && !isRecentDate(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD.' });
  try {
    const data = await history.getIntraday(expiry, date || null, symbol);
    res.set('Cache-Control', HISTORY_CACHE);
    res.json({ ok: true, persistent: history.configured, ...data });
  } catch (err) {
    return sendError(res, 500, 'Error reading intraday history', err);
  }
});

// Past expiry days still in storage, and one of them as a replay (series + 10-minute strike frames). A past day never
// changes, so the replay is cached for a day at the edge; the list changes once a day.
router.get('/expiry-replay', async (req, res) => {
  const { expiry } = req.query;
  const symbol = symbolOf(req);
  if (!symbol) return res.status(400).json(BAD_SYMBOL);
  if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 27-Oct-2026.' });
  try {
    if (expiry === undefined) {
      const days = await history.listExpiryReplays(Date.now(), symbol);
      res.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
      return res.json({ ok: true, persistent: history.configured, days });
    }
    const data = await history.getExpiryReplay(expiry, symbol);
    const today = istNow().ymd;
    if (data.date && data.date >= today) return res.status(400).json({ ok: false, error: 'Only past expiry days can be replayed.' });
    res.set('Cache-Control', data.points.length ? 'public, s-maxage=86400' : HISTORY_CACHE);
    res.json({ ok: true, ...data });
  } catch (err) {
    return sendError(res, 500, 'Error reading expiry replay', err);
  }
});

// Candles + support/resistance zones + patterns + signals for the price chart. Intervals are whitelisted.
router.get('/chart-analysis', async (req, res) => {
  const interval = req.query.interval || '5m';
  const { expiry } = req.query;
  if (!CHART_INTERVALS.has(interval)) return res.status(400).json({ ok: false, error: 'interval must be 5m, 15m or 1d.' });
  if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 13-Oct-2026.' });
  try {
    const data = await chartView(interval, expiry);
    res.set('Cache-Control', HISTORY_CACHE);
    res.json({ ok: true, ...data });
  } catch (err) {
    return sendError(res, 502, 'Error building chart analysis', err);
  }
});

// Live track record of the chart's signals and zones (recorded each minute by the scheduler, scored against later candles).
router.get('/forward-log', async (req, res) => {
  try {
    if (!forwardLog.configured) return res.json({ ok: true, persistent: false });
    const log = await forwardLog.getLog();
    res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    res.json({ ok: true, persistent: true, ...log });
  } catch (err) {
    return sendError(res, 500, 'Error reading forward log', err);
  }
});

// How each kind of support / resistance level actually behaved over the stored history (see services/analytics/scorecard.js).
router.get('/level-scorecard', async (req, res) => {
  try {
    const card = await chartAnalysis.getScorecard(require('../services/market/candles'));
    if (!card) return res.status(503).json({ ok: false, error: 'Scorecard is not available yet.' });
    res.set('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    res.json({ ok: true, ...card });
  } catch (err) {
    return sendError(res, 502, 'Error building level scorecard', err);
  }
});

// NSE trading holidays, so the page and the server agree on when the market is closed. Refreshed from NSE at most daily.
router.get('/calendar', async (req, res) => {
  try {
    await refreshHolidays();
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.json({ ok: true, ...calendar.snapshot() });
  } catch (err) {
    return sendError(res, 500, 'Error reading calendar', err);
  }
});

// For an uptime monitor: HTTP 503 when the per-minute recorder has stopped during market hours, so a stuck scheduler
// or a dead feed raises an alert instead of waiting to be noticed. Reveals only the age of the last snapshot, nothing else.
router.get('/snapshot-age', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!history.configured) return res.json({ ok: true, persistent: false });
  try {
    const health = history.snapshotHealth(await history.getLastSnapshotMs());
    return res.status(health.healthy ? 200 : 503).json({ ok: health.healthy, persistent: true, ...health });
  } catch (err) {
    return sendError(res, 500, 'Error reading snapshot age', err);
  }
});

// One strike across the day (sampled)
router.get('/strike-history', async (req, res) => {
  const { expiry, date } = req.query;
  const symbol = symbolOf(req);
  if (!symbol) return res.status(400).json(BAD_SYMBOL);
  const strike = Number(req.query.strike);
  if (!isPlausibleExpiry(expiry) || !Number.isInteger(strike) || strike <= 0 || strike > 1000000) {
    return res.status(400).json({ ok: false, error: 'expiry (DD-Mon-YYYY) and an integer strike are required.' });
  }
  if (date !== undefined && !isRecentDate(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD.' });
  try {
    const data = await history.getStrikeHistory(expiry, strike, date || null, 60, symbol);
    res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.json({ ok: true, ...data });
  } catch (err) {
    return sendError(res, 500, 'Error reading strike history', err);
  }
});

// Deliberately minimal: no backend names, hostnames or environment variable names.
router.get('/storage-status', (req, res) => {
  res.json({ ok: true, persistent: history.configured });
});

// Paper trading API (owner only, see routes/paper.js)
router.use('/paper', paperRoutes);

// Writes to storage, so it needs the admin secret (CRON_SECRET; it used to be open to anyone). A manual action:
// the per-minute recorder saves the session summary by itself after 15:20.
router.post('/session-summary', strictLimit, requireSecret, async (req, res) => {
  try {
    const { raw, allExpiries, targetExpiry } = await fetchRawOptionChain('NIFTY');
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
    const vector = extractFeatureVector(data);
    const date = istNow(new Date(data.dataAsOf || Date.now())).ymd;
    await history.saveSession(history.buildSessionRecord(data, vector, date));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, message: 'Session summary saved successfully', date, persistent: history.configured });
  } catch (err) {
    return sendError(res, 500, 'Error saving session summary', err);
  }
});

router.get('/similar-sessions', async (req, res) => {
  const symbol = symbolOf(req);
  if (!symbol) return res.status(400).json(BAD_SYMBOL);
  try {
    let liveData = getCacheData(symbol);
    if (!liveData) {
      const { raw, allExpiries, targetExpiry } = await fetchRawOptionChain(symbol);
      liveData = await processOptionChainData(raw, allExpiries, targetExpiry, { symbol });
    }
    const currentVector = extractFeatureVector(liveData);

    // Exclude today's own (possibly just-written) record so a session can't match itself at 100%
    const today = istNow().ymd;
    const pastSessions = (await history.getSessions(100, symbol)).filter(x => x.date !== today);

    if (pastSessions.length === 0) {
      // No stored sessions (DB disabled/empty): say so instead of inventing history.
      return res.json({
        ok: true,
        currentVector,
        topMatches: [],
        reason: history.configured
          ? 'No saved sessions yet. One is stored automatically after each close'
          : 'Session history needs storage (set UPSTASH_REDIS_REST_URL / TOKEN)'
      });
    }

    // BUG-004: one corrupt stored record must not take the whole endpoint down, so unreadable vectors are skipped.
    const readable = readableSessions(pastSessions);
    const sims = computeSessionSimilarities(currentVector, readable.map(r => r.vec));
    const scored = readable.map(({ sess }, i) => ({
      date: sess.date,
      similarityPct: Number(sims[i].toFixed(1)),
      closingPcr: sess.closing_pcr,
      gexRegime: sess.gex_regime,
      cprWidthType: sess.cpr_width_type
    }));

    scored.sort((a, b) => b.similarityPct - a.similarityPct);

    res.set('Cache-Control', HISTORY_CACHE);
    res.json({
      ok: true,
      currentVector,
      topMatches: scored.slice(0, 3)
    });
  } catch (err) {
    return sendError(res, 500, 'Error matching similar sessions', err);
  }
});

router.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), source: sourceName() });
});

module.exports = router;
