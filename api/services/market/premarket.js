const fetch = require('node-fetch');

// Overnight cues for the pre-market panel (shown 07:15-09:15 IST): US close, US index futures, Asian markets, rupee,
// crude, gold and the US 10-year yield, from Yahoo Finance quote metadata. GIFT Nifty has no free source, so there is
// no opening-gap estimate; the "lean" is just how the overnight markets moved, not a forecast of the NIFTY open.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const FETCH_TIMEOUT_MS = 5000;
const TTL_MS = 2 * 60 * 1000;
const STALE_MAX_MS = 15 * 60 * 1000;
const LEAN_THRESHOLD_PCT = 0.3; // average move of the lean group beyond which the cues "lean" one way

// group: where it shows on the panel. lean: counts toward the overall lean (markets still trading or just closed).
// bps: show the change in basis points (a yield), not percent.
const CUES = [
  { key: 'nifty', symbol: '^NSEI', label: 'NIFTY 50 last close', group: 'nifty' },
  { key: 'spx', symbol: '^GSPC', label: 'S&P 500', group: 'us' },
  { key: 'ndx', symbol: '^IXIC', label: 'Nasdaq', group: 'us' },
  { key: 'es', symbol: 'ES=F', label: 'S&P 500 futures', group: 'usFut', lean: true },
  { key: 'nq', symbol: 'NQ=F', label: 'Nasdaq 100 futures', group: 'usFut', lean: true },
  { key: 'nikkei', symbol: '^N225', label: 'Nikkei 225', group: 'asia', lean: true },
  { key: 'hsi', symbol: '^HSI', label: 'Hang Seng', group: 'asia', lean: true },
  { key: 'kospi', symbol: '^KS11', label: 'Kospi', group: 'asia', lean: true },
  { key: 'usdinr', symbol: 'USDINR=X', label: 'USD/INR', group: 'macro' },
  { key: 'brent', symbol: 'BZ=F', label: 'Brent crude', group: 'macro' },
  { key: 'gold', symbol: 'GC=F', label: 'Gold', group: 'macro' },
  { key: 'us10y', symbol: '^TNX', label: 'US 10-year yield', group: 'macro', bps: true }
];

/** Yahoo chart meta -> { price, prevClose, asOf } (range=1d makes chartPreviousClose the previous session's close). */
function parseQuote(json) {
  const m = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
  if (!m) return null;
  const price = Number(m.regularMarketPrice);
  const prevClose = Number(m.chartPreviousClose ?? m.previousClose);
  if (!(price > 0) || !(prevClose > 0)) return null;
  return { price, prevClose, asOf: Number.isFinite(m.regularMarketTime) ? m.regularMarketTime * 1000 : null };
}

async function fetchQuote(symbol, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${YAHOO}${encodeURIComponent(symbol)}?range=1d&interval=15m`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal
    });
    return parseQuote(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Overall lean from the markets that traded overnight (US futures, Asia). Needs at least 3 of them. */
function cueLean(items) {
  const moves = items.filter(i => i.lean && Number.isFinite(i.changePct)).map(i => i.changePct);
  if (moves.length < 3) return { label: 'unknown', avgPct: null, up: 0, down: 0, count: moves.length };
  const avgPct = moves.reduce((a, b) => a + b, 0) / moves.length;
  return {
    label: avgPct > LEAN_THRESHOLD_PCT ? 'positive' : avgPct < -LEAN_THRESHOLD_PCT ? 'negative' : 'flat',
    avgPct,
    up: moves.filter(m => m > 0).length,
    down: moves.filter(m => m < 0).length,
    count: moves.length
  };
}

async function buildCues(fetchImpl = fetch) {
  const results = await Promise.allSettled(CUES.map(c => fetchQuote(c.symbol, fetchImpl)));
  const items = CUES.map((c, i) => {
    const q = results[i].status === 'fulfilled' ? results[i].value : null;
    const base = { key: c.key, label: c.label, group: c.group, lean: !!c.lean, bps: !!c.bps };
    if (!q) return { ...base, price: null, prevClose: null, change: null, changePct: null, asOf: null };
    const change = q.price - q.prevClose;
    return { ...base, price: q.price, prevClose: q.prevClose, change, changePct: (change / q.prevClose) * 100, asOf: q.asOf };
  });
  if (!items.some(i => i.price !== null)) throw new Error('no pre-market quotes');
  return { fetchedAt: Date.now(), items, lean: cueLean(items) };
}

let cache = null; // { ts, value }
let inflight = null;

/** Cached for 2 minutes; a failed refresh serves the last copy for up to 15 minutes, then the error surfaces. */
async function getPremarket({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (cache && nowMs - cache.ts < TTL_MS) return { ...cache.value, stale: false };
  if (inflight) return inflight;
  inflight = buildCues(fetchImpl)
    .then(value => { cache = { ts: nowMs, value }; return { ...value, stale: false }; })
    .catch(err => {
      if (cache && nowMs - cache.ts < STALE_MAX_MS) return { ...cache.value, stale: true };
      throw err;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

const clearCache = () => { cache = null; };

module.exports = { CUES, parseQuote, cueLean, buildCues, getPremarket, clearCache, LEAN_THRESHOLD_PCT };
