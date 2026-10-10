const express = require('express');
const router = express.Router();
const history = require('../services/history');
const { istNow } = require('../services/market');
const { fetchRawNSEOptionChain } = require('../services/nse');
const { rateLimit, requireSecret, isValidExpiry, isValidDate, sendError } = require('../security');
const {
  processOptionChainData,
  extractFeatureVector,
  computeCosineSimilarity,
  getCacheData
} = require('../services/analytics');

const READ_CACHE = 'public, s-maxage=3, stale-while-revalidate=10';
const HISTORY_CACHE = 'public, s-maxage=10, stale-while-revalidate=20';
const strictLimit = rateLimit({ windowMs: 60 * 1000, max: 20, name: 'sensitive' });

router.get('/option-chain', async (req, res) => {
  const { expiry } = req.query;
  if (expiry !== undefined && !isValidExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 13-Oct-2026.' });
  try {
    const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY', expiry || null);
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
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
  if (!isValidExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry (DD-Mon-YYYY) is required.' });
  if (date !== undefined && !isValidDate(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD.' });
  try {
    const data = await history.getIntraday(expiry, date || null);
    res.set('Cache-Control', HISTORY_CACHE);
    res.json({ ok: true, persistent: history.configured, ...data });
  } catch (err) {
    return sendError(res, 500, 'Error reading intraday history', err);
  }
});

// One strike across the day (sampled)
router.get('/strike-history', async (req, res) => {
  const { expiry, date } = req.query;
  const strike = Number(req.query.strike);
  if (!isValidExpiry(expiry) || !Number.isInteger(strike) || strike <= 0 || strike > 1000000) {
    return res.status(400).json({ ok: false, error: 'expiry (DD-Mon-YYYY) and an integer strike are required.' });
  }
  if (date !== undefined && !isValidDate(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD.' });
  try {
    const data = await history.getStrikeHistory(expiry, strike, date || null);
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

// Records a snapshot even when nobody has the page open. Point an external pinger at it during market hours
// with `Authorization: Bearer <CRON_SECRET>` (the secret is never accepted in the URL).
async function cronSnapshot(req, res) {
  const { expiry } = req.query;
  if (expiry !== undefined && !isValidExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 13-Oct-2026.' });
  try {
    const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY', expiry || null);
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, expiry: data.expiry, dataAsOf: data.dataAsOf, persistent: history.configured });
  } catch (err) {
    if (err.code === 'BAD_EXPIRY') return res.status(400).json({ ok: false, error: 'Unknown expiry.' });
    return sendError(res, 502, 'Cron snapshot failed', err);
  }
}
router.get('/cron/snapshot', strictLimit, requireSecret, cronSnapshot);
router.post('/cron/snapshot', strictLimit, requireSecret, cronSnapshot);

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

    const scored = pastSessions.map(sess => {
      const vec = typeof sess.feature_vector === 'string' ? JSON.parse(sess.feature_vector) : sess.feature_vector;
      const sim = computeCosineSimilarity(currentVector, vec);
      return {
        date: sess.date,
        similarityPct: Number((sim * 100).toFixed(1)),
        closingPcr: sess.closing_pcr,
        gexRegime: sess.gex_regime,
        cprWidthType: sess.cpr_width_type
      };
    });

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
