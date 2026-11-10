const integrity = require('../analytics/integrity');
const calendar = require('./calendar');
const liveChain = require('../stream/liveChain');
const instruments = require('../providers/instruments');

// The option chain every route reads, with the caching around it:
//   - a copy younger than a second is served from memory
//   - concurrent requests for the same expiry share one build
//   - a payload that fails integrity.validateRaw is never cached
//   - when a build fails (the live feed is down or has not caught up), the last good copy is served, flagged stale,
//     for a limited time. There is no HTTP fallback.
//
// The chain is built from the Upstox live feed (services/stream/liveChain.js). The loader stays swappable for tests; it
// resolves to { raw, allExpiries, targetExpiry } with `raw` in ChainDeck's chain shape.

const RAW_TTL = 1000;
const STALE_MAX_OPEN = 2 * 60 * 1000;      // while the market moves: a leftover copy lives 2 min at most (flagged stale), then fail loudly
const STALE_MAX_CLOSED = 6 * 3600 * 1000; // nothing changes after the close, so an old copy is still the right picture

const STREAM = { name: 'upstox', load: (symbol, expiry) => liveChain.loadChain(symbol, expiry), knownExpiries: symbol => liveChain.knownExpiries(symbol) };

let source = STREAM;
const sourceName = () => source.name;
/** Test hook: swap the loader ({ name, load, knownExpiries }) and clear the cache. */
function _setSource(s) {
  source = s || STREAM;
  rawCache.clear();
  inflight.clear();
}

/** How long a leftover copy may be served after a failed refresh, depending on whether the market is trading. */
function staleLimitMs(nowMs = Date.now()) {
  return calendar.isMarketOpenAt(nowMs, { before: 5, after: 10 }) ? STALE_MAX_OPEN : STALE_MAX_CLOSED;
}

const rawCache = new Map();          // `${symbol}|${expiry}` -> { value, ts }
const inflight = new Map();          // key -> Promise

async function fetchRawOptionChain(symbol = 'NIFTY', expiryDate = null) {
  symbol = instruments.getIndex(symbol).symbol; // throws BAD_SYMBOL for anything unknown
  const known = source.knownExpiries(symbol);
  if (expiryDate && known && !known.includes(expiryDate)) {
    // Stale / mistyped expiry (e.g. from an old shared link): fail fast instead of burning upstream timeouts.
    const err = new Error(`Unknown expiry ${expiryDate}`);
    err.code = 'BAD_EXPIRY';
    throw err;
  }
  const resolved = expiryDate || (known && known[0]) || null;
  const key = `${symbol}|${resolved || 'nearest'}`;

  const hit = rawCache.get(key);
  if (hit && Date.now() - hit.ts < RAW_TTL) return hit.value;

  // Coalesce concurrent requests into one upstream call
  if (inflight.has(key)) return inflight.get(key);

  const p = source.load(symbol, expiryDate)
    .then(value => {
      // Reject a structurally broken or non-sensical payload BEFORE it is cached: the last good copy is kept (and flagged).
      const verdict = integrity.validateRaw(value.raw, hit ? hit.value : null);
      if (!verdict.ok) throw new Error(`Option chain payload rejected: ${verdict.reasons.join('; ')}`);
      const ts = Date.now();
      const stamped = { ...value, fetchedMs: ts, stale: false };
      rawCache.set(key, { value: stamped, ts });
      while (rawCache.size > 20) rawCache.delete(rawCache.keys().next().value); // bounded: keys come from callers
      return stamped;
    })
    .catch(err => {
      if (err.code === 'BAD_EXPIRY') throw err;
      // Stale-on-error: the last known values, marked stale, while the feed reconnects
      if (hit && Date.now() - hit.ts < staleLimitMs()) {
        console.error('Option chain fetch failed, serving stale data:', err.message);
        return { ...hit.value, stale: true, staleReason: err.message };
      }
      throw err;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

/** Short public reason for a leftover copy: the real error text stays in the server log, never in the response. */
function staleReasonCode(message) {
  const m = String(message || '');
  if (/payload rejected/i.test(m)) return 'payload_rejected';
  if (/live feed/i.test(m)) return 'feed_down';
  if (/abort|timeout|timed out|did not answer/i.test(m)) return 'timeout';
  return 'fetch_failed';
}

module.exports = { fetchRawOptionChain, staleReasonCode, staleLimitMs, sourceName, _setSource };
