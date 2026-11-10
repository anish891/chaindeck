const integrity = require('../analytics/integrity');
const { fetchRawOptionChain, staleReasonCode, sourceName } = require('./optionChain');
const { processOptionChainData } = require('../analytics/analytics');

// The processed option chain as the dashboard receives it: analytics, the feed's freshness and the integrity checks.
// One builder for both ways it leaves the server (pushed over the browser socket, and GET /api/option-chain).

async function chainView(symbol, expiry = null) {
  const { raw, allExpiries, targetExpiry, fetchedMs, stale, staleReason } = await fetchRawOptionChain(symbol, expiry || null);
  const data = await processOptionChainData(raw, allExpiries, targetExpiry, { symbol });
  // Recompute the headline numbers from the raw payload with separate code and compare (see services/analytics/integrity.js).
  let checks;
  try {
    checks = integrity.verifyProcessed(raw, data, targetExpiry);
  } catch (e) {
    console.error('integrity verification failed:', e.message);
    checks = [{ id: 'integrity_engine', group: 'Option chain', label: 'Integrity checks ran', level: 'fail', detail: 'the verification step itself errored' }];
  }
  // feed: when this was last built from the live feed, whether it is a leftover copy served while the feed is down, and why
  return { ...data, feed: { fetchedAt: fetchedMs || null, stale: !!stale, reason: stale ? staleReasonCode(staleReason) : null, source: sourceName() }, integrity: { checks } };
}

const CHART_INTERVALS = new Set(['5m', '15m', '1d']);

/** Candles + support/resistance zones + patterns + signals for the price chart (NIFTY's). */
async function chartView(interval, expiry = null) {
  const history = require('../storage/history');
  const chartAnalysis = require('../analytics/chartAnalysis');
  const { getCacheData } = require('../analytics/analytics');
  // Stored spot history is only read if the candle history is unavailable (reading it every time cost a storage round trip).
  const fallbackPoints = expiry && interval !== '1d' ? async () => (await history.getIntraday(expiry)).points : null;
  return chartAnalysis.analyze(interval, { d: getCacheData('NIFTY'), fallbackPoints });
}

module.exports = { chainView, chartView, CHART_INTERVALS };
