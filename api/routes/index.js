const express = require('express');
const router = express.Router();
const history = require('../services/history');
const { getParticipantHistory } = require('../services/participants');
const chartAnalysis = require('../services/chartAnalysis');
const forwardLog = require('../services/forwardlog');
const { withRetry } = require('../services/retry');
const integrity = require('../services/integrity');
const { istNow } = require('../services/market');
const { fetchRawNSEOptionChain, refreshHolidays, staleReasonCode } = require('../services/nse');
const calendar = require('../services/calendar');
const paperRoutes = require('./paper');
const { rateLimit, requireSecret, isValidExpiry, isPlausibleExpiry, isRecentDate, sendError } = require('../security');
const {
  processOptionChainData,
  extractFeatureVector,
  computeSessionSimilarities,
  readableSessions,
  getCacheData
} = require('../services/analytics');

const READ_CACHE = 'public, s-maxage=3, stale-while-revalidate=10';
const HISTORY_CACHE = 'public, s-maxage=10, stale-while-revalidate=20';
const strictLimit = rateLimit({ windowMs: 60 * 1000, max: 20, name: 'sensitive' });

router.get('/option-chain', async (req, res) => {
  refreshHolidays().catch(() => {}); // cheap: at most one NSE call a day, never blocks or throws
  const { expiry } = req.query;
  if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 13-Oct-2026.' });
  try {
    const { raw, allExpiries, targetExpiry, fetchedMs, stale, staleReason } = await fetchRawNSEOptionChain('NIFTY', expiry || null);
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
    res.set('Cache-Control', READ_CACHE);
    // Recompute the headline numbers from the raw payload with separate code and compare (see services/integrity.js).
    let checks;
    try {
      checks = integrity.verifyProcessed(raw, data, targetExpiry);
    } catch (e) {
      console.error('integrity verification failed:', e.message);
      checks = [{ id: 'integrity_engine', group: 'Option chain', label: 'Integrity checks ran', level: 'fail', detail: 'the verification step itself errored' }];
    }
    // feed: when we last got this from NSE, whether it is a leftover copy served after a failed refresh, and why
    res.json({ ok: true, data: { ...data, feed: { fetchedAt: fetchedMs || null, stale: !!stale, reason: stale ? staleReasonCode(staleReason) : null }, integrity: { checks } } });
  } catch (err) {
    if (err.code === 'BAD_EXPIRY') return res.status(400).json({ ok: false, error: 'Unknown expiry.' });
    return sendError(res, 502, 'Error fetching option chain', err);
  }
});

// Intraday series + baseline strike snapshots (5m / 15m / 30m earlier, and the open)
router.get('/intraday', async (req, res) => {
  const { expiry, date } = req.query;
  if (!isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry (DD-Mon-YYYY) is required.' });
  if (date !== undefined && !isRecentDate(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD.' });
  try {
    const data = await history.getIntraday(expiry, date || null);
    res.set('Cache-Control', HISTORY_CACHE);
    res.json({ ok: true, persistent: history.configured, ...data });
  } catch (err) {
    return sendError(res, 500, 'Error reading intraday history', err);
  }
});

// Candles + support/resistance zones + patterns + signals for the price chart. Intervals are whitelisted.
const CHART_INTERVALS = new Set(['5m', '15m', '1d']);
router.get('/chart-analysis', async (req, res) => {
  const interval = req.query.interval || '5m';
  const { expiry } = req.query;
  if (!CHART_INTERVALS.has(interval)) return res.status(400).json({ ok: false, error: 'interval must be 5m, 15m or 1d.' });
  if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 13-Oct-2026.' });
  try {
    // Stored spot history is only read if Yahoo is down (it is a fallback; reading it every time cost a storage round trip).
    const fallbackPoints = expiry && interval !== '1d' ? async () => (await history.getIntraday(expiry)).points : null;
    const data = await chartAnalysis.analyze(interval, { d: getCacheData(), fallbackPoints });
    res.set('Cache-Control', HISTORY_CACHE);
    res.json({ ok: true, ...data });
  } catch (err) {
    return sendError(res, 502, 'Error building chart analysis', err);
  }
});

// Live track record of the chart's signals and zones (recorded by the cron job, scored against later candles).
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

// How each kind of support / resistance level actually behaved over the stored history (see services/scorecard.js).
router.get('/level-scorecard', async (req, res) => {
  try {
    const card = await chartAnalysis.getScorecard(require('../services/candles'));
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

// For an uptime monitor: HTTP 503 when the per-minute recorder has stopped during market hours, so a failing cron job
// raises an alert instead of waiting to be noticed. Reveals only the age of the last snapshot, nothing else.
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
  const strike = Number(req.query.strike);
  if (!isPlausibleExpiry(expiry) || !Number.isInteger(strike) || strike <= 0 || strike > 1000000) {
    return res.status(400).json({ ok: false, error: 'expiry (DD-Mon-YYYY) and an integer strike are required.' });
  }
  if (date !== undefined && !isRecentDate(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD.' });
  try {
    const data = await history.getStrikeHistory(expiry, strike, date || null);
    res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.json({ ok: true, ...data });
  } catch (err) {
    return sendError(res, 500, 'Error reading strike history', err);
  }
});

// FII / DII / Pro / Client index positions from NSE's end-of-day file (last 10 trading days, newest first).
router.get('/participants', async (req, res) => {
  try {
    const days = await getParticipantHistory(10);
    res.set('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    res.json({ ok: true, days });
  } catch (err) {
    return sendError(res, 502, 'Error reading participant OI', err);
  }
});

// Deliberately minimal: no backend names, hostnames or environment variable names.
router.get('/storage-status', (req, res) => {
  res.json({ ok: true, persistent: history.configured });
});

// Records a snapshot even when nobody has the page open. Point an external pinger at it during market hours
// with `Authorization: Bearer <CRON_SECRET>` (the secret is never accepted in the URL).
async function cronSnapshot(req, res) {
  await refreshHolidays(); // keep the holiday list current even when nobody has the page open
  const { expiry } = req.query;
  if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 13-Oct-2026.' });
  try {
    // NSE sometimes rejects a cold request (fast 401/403 or a timeout) and answers a moment later, so try a few times.
    const { raw, allExpiries, targetExpiry, stale: cronStale } = await withRetry(
      attempt => {
        if (attempt > 1) console.error(`cron snapshot: retrying NSE fetch (attempt ${attempt})`);
        return fetchRawNSEOptionChain('NIFTY', expiry || null);
      },
      { attempts: 3, delayMs: 900, budgetMs: 6500, shouldRetry: e => e.code !== 'BAD_EXPIRY' }
    );
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
    // Score the chart's signals and zones against what price did next. Best effort: the snapshot above is already saved.
    // Never record signals from data that is stale or fails its own consistency checks.
    let healthy = !cronStale;
    try { healthy = healthy && !integrity.hasFailure(integrity.verifyProcessed(raw, data, targetExpiry)); } catch (e) { healthy = false; }
    const forward = healthy ? await forwardLog.run(data) : { skipped: 'unhealthy-data' };
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, expiry: data.expiry, dataAsOf: data.dataAsOf, persistent: history.configured, forward });
  } catch (err) {
    if (err.code === 'BAD_EXPIRY') return res.status(400).json({ ok: false, error: 'Unknown expiry.' });
    return sendError(res, 502, 'Cron snapshot failed', err);
  }
}
router.get('/cron/snapshot', strictLimit, requireSecret, cronSnapshot);
router.post('/cron/snapshot', strictLimit, requireSecret, cronSnapshot);

// Paper trading: fill resting orders, expire day orders, settle expiries and record each day's equity. A separate job from
// the snapshot so a slow paper tick can never cost a saved snapshot. Same secret, same schedule (every minute, 09-15 IST).
async function cronPaper(req, res) {
  await refreshHolidays();
  try {
    const result = await paperRoutes.service().tick();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, 502, 'Paper tick failed', err);
  }
}
router.get('/cron/paper', strictLimit, requireSecret, cronPaper);
router.post('/cron/paper', strictLimit, requireSecret, cronPaper);

// Paper trading API (owner only, see routes/paper.js)
router.use('/paper', paperRoutes);

// Writes to storage, so it needs the same secret as the cron endpoint (it used to be open to anyone).
router.post('/session-summary', strictLimit, requireSecret, async (req, res) => {
  try {
    const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY');
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
  try {
    let liveData = getCacheData();
    if (!liveData) {
      const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY');
      liveData = await processOptionChainData(raw, allExpiries, targetExpiry);
    }
    const currentVector = extractFeatureVector(liveData);

    // Exclude today's own (possibly just-written) record so a session can't match itself at 100%
    const today = istNow().ymd;
    const pastSessions = (await history.getSessions(100)).filter(x => x.date !== today);

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
  res.json({ ok: true, ts: new Date().toISOString() });
});

module.exports = router;
