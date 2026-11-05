const fetch = require('node-fetch');
const { getCookies, fetchWithTimeout } = require('./nse');
const upstox = require('./upstox');
const constituents = require('./constituents');
const upstoxCandles = require('./upstoxCandles');

// Cached market-context lookups: India VIX, index day stats, sectors and breadth (Upstox quotes, or NSE when DATA_SOURCE=nse),
// and the previous completed session's OHLC (for real CPR/pivots) from the same provider's daily candles.
// Every function resolves to null on failure so analytics can degrade gracefully.


const INDICES_TTL = 15 * 1000;
const INDICES_MAX_STALE = 10 * 60 * 1000; // older than this, a fallback value would mislead more than help
const OHLC_TTL = 30 * 60 * 1000;

let indicesCache = { ts: 0, value: null };
const ohlcCache = new Map(); // symbol -> { ts, value, key }
let indicesInflight = null;

function istNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    mins: (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10),
    isWeekday: !['Sat', 'Sun'].includes(parts.weekday)
  };
}

function pick(row) {
  return {
    last: row.last,
    previousClose: row.previousClose,
    open: row.open,
    high: row.high,
    low: row.low,
    percentChange: row.percentChange
  };
}

// Sector tiles: [short label, exact NSE index name, Upstox instrument key]
const SECTORS = [
  ['Bank', 'NIFTY BANK', 'NSE_INDEX|Nifty Bank'], ['Private Bank', 'NIFTY PRIVATE BANK', 'NSE_INDEX|Nifty Pvt Bank'],
  ['PSU Bank', 'NIFTY PSU BANK', 'NSE_INDEX|Nifty PSU Bank'], ['Financial Services', 'NIFTY FINANCIAL SERVICES', 'NSE_INDEX|Nifty Fin Service'],
  ['IT', 'NIFTY IT', 'NSE_INDEX|Nifty IT'], ['Auto', 'NIFTY AUTO', 'NSE_INDEX|Nifty Auto'], ['FMCG', 'NIFTY FMCG', 'NSE_INDEX|Nifty FMCG'],
  ['Pharma', 'NIFTY PHARMA', 'NSE_INDEX|Nifty Pharma'], ['Healthcare', 'NIFTY HEALTHCARE INDEX', 'NSE_INDEX|NIFTY HEALTHCARE'],
  ['Metal', 'NIFTY METAL', 'NSE_INDEX|Nifty Metal'], ['Energy', 'NIFTY ENERGY', 'NSE_INDEX|Nifty Energy'],
  ['Oil & Gas', 'NIFTY OIL & GAS', 'NSE_INDEX|NIFTY OIL AND GAS'], ['Realty', 'NIFTY REALTY', 'NSE_INDEX|Nifty Realty'],
  ['Media', 'NIFTY MEDIA', 'NSE_INDEX|Nifty Media'], ['Consumer Durables', 'NIFTY CONSUMER DURABLES', 'NSE_INDEX|NIFTY CONSR DURBL'],
  ['Infrastructure', 'NIFTY INFRASTRUCTURE', 'NSE_INDEX|Nifty Infra']
];
const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
const VIX_KEY = 'NSE_INDEX|India VIX';
const SENSEX_KEY = 'BSE_INDEX|SENSEX';
const QUOTE_BATCH = 200; // instrument keys per Upstox quote call

async function loadIndices() {
  const cookies = await getCookies();
  const json = await fetchWithTimeout('https://www.nseindia.com/api/allIndices', cookies);
  const rows = json?.data || [];
  const nifty = rows.find(r => r.index === 'NIFTY 50');
  const vix = rows.find(r => r.index === 'INDIA VIX');
  if (!nifty) throw new Error('NIFTY 50 missing from allIndices');
  const sectors = SECTORS.map(([name, index]) => {
    const r = rows.find(x => x.index === index);
    return r ? { name, index, last: r.last, percentChange: r.percentChange, advances: Number(r.advances) || 0, declines: Number(r.declines) || 0 } : null;
  }).filter(Boolean);
  const breadth = { advances: Number(nifty.advances) || 0, declines: Number(nifty.declines) || 0, unchanged: Number(nifty.unchanged) || 0 };
  return { nifty: pick(nifty), vix: vix ? pick(vix) : null, sectors, breadth };
}

/**
 * Upstox quote -> { last, previousClose, open, high, low, percentChange }, or null.
 * The previous close is `cp` from the v3 LTP reply (checked live: the v3 OHLC reply's prev_ohlc comes back null);
 * today's open/high/low come from the v3 OHLC reply's live_ohlc when it was fetched (indices only).
 */
function fromUpstoxQuote(q) {
  if (!q) return null;
  const last = Number(q.last_price);
  const prev = Number(q.cp ?? (q.prev_ohlc && q.prev_ohlc.close));
  const live = q.live_ohlc || {};
  if (!(last > 0)) return null;
  const pct = prev > 0 ? Number((((last - prev) / prev) * 100).toFixed(2)) : null;
  const n = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return { last, previousClose: prev > 0 ? prev : null, open: n(live.open), high: n(live.high), low: n(live.low), percentChange: pct };
}

/** Count stocks up / down / flat against their previous close. Unknown stocks are skipped; null if none are known. */
function countBreadth(isins, quotes) {
  if (!Array.isArray(isins) || !isins.length) return null;
  let advances = 0, declines = 0, unchanged = 0, known = 0;
  for (const isin of isins) {
    const q = fromUpstoxQuote(quotes.get(`NSE_EQ|${isin}`));
    if (!q || q.previousClose === null) continue;
    known += 1;
    if (q.last > q.previousClose) advances += 1;
    else if (q.last < q.previousClose) declines += 1;
    else unchanged += 1;
  }
  return known ? { advances, declines, unchanged } : null;
}

/** VIX, NIFTY day stats, sectors and breadth from one batch of Upstox quotes (same shape as the NSE loader). */
async function loadIndicesUpstox({ get = upstox.get, getLists = () => constituents.getConstituents() } = {}) {
  const lists = await getLists().catch(err => { console.error('constituents failed:', err.message); return {}; });
  const stockKeys = [...new Set(Object.values(lists || {}).flat())].map(isin => `NSE_EQ|${isin}`);
  const keys = [NIFTY_KEY, SENSEX_KEY, VIX_KEY, ...SECTORS.map(s => s[2]), ...stockKeys];
  const batches = [];
  for (let i = 0; i < keys.length; i += QUOTE_BATCH) batches.push(keys.slice(i, i + QUOTE_BATCH));
  // Last price and previous close for everything (light LTP calls), plus today's open/high/low for the headline indices.
  const [ohlc, ...replies] = await Promise.all([
    get('/v3/market-quote/ohlc', { instrument_key: [NIFTY_KEY, SENSEX_KEY, VIX_KEY], interval: '1d' })
      .catch(err => { console.error('index OHLC failed:', err.message); return {}; }),
    ...batches.map((b, i) => {
      const call = get('/v3/market-quote/ltp', { instrument_key: b });
      // Only the first batch (indices) is essential; a failed stock batch just leaves breadth unknown.
      return i === 0 ? call : call.catch(err => { console.error('stock quotes failed:', err.message); return {}; });
    })
  ]);
  // Replies are keyed 'NSE_INDEX:Nifty 50'; instrument_token carries the 'NSE_INDEX|Nifty 50' form we asked with.
  const quotes = new Map();
  for (const data of replies) for (const q of Object.values(data || {})) if (q && q.instrument_token) quotes.set(q.instrument_token, q);
  for (const q of Object.values(ohlc || {})) {
    if (q && q.instrument_token && quotes.has(q.instrument_token)) quotes.set(q.instrument_token, { ...quotes.get(q.instrument_token), live_ohlc: q.live_ohlc });
  }

  const nifty = fromUpstoxQuote(quotes.get(NIFTY_KEY));
  if (!nifty) throw new Error('NIFTY 50 missing from Upstox quotes');
  const vix = fromUpstoxQuote(quotes.get(VIX_KEY));
  const sensex = fromUpstoxQuote(quotes.get(SENSEX_KEY));
  const sectors = SECTORS.map(([name, index, key]) => {
    const q = fromUpstoxQuote(quotes.get(key));
    if (!q) return null;
    const b = countBreadth(lists && lists[index], quotes);
    return { name, index, last: q.last, percentChange: q.percentChange, advances: b ? b.advances : null, declines: b ? b.declines : null };
  }).filter(Boolean);
  const breadth = countBreadth(lists && lists['NIFTY 50'], quotes);
  return { nifty, sensex, vix, sectors, breadth, source: 'upstox' };
}

const defaultLoader = () => (optionChainSource() === 'upstox' ? loadIndicesUpstox() : loadIndices());
// Lazy: optionChain.js decides the source; requiring it here at load time would be needlessly early.
const optionChainSource = () => require('./optionChain').sourceName();

let indexLoader = defaultLoader; // swappable in tests

const staleIndices = () => (indicesCache.value && Date.now() - indicesCache.ts < INDICES_MAX_STALE ? indicesCache.value : null);

/**
 * VIX, NIFTY day stats, sectors and breadth. Fresh data within 15 s is served from cache; otherwise NSE is asked.
 * If NSE fails, or does not answer within `timeoutMs`, the last good snapshot (at most 10 minutes old) is returned
 * instead of nothing, so one slow reply does not blank VIX and the sector tiles.
 */
async function getIndexSnapshot({ timeoutMs = 0 } = {}) {
  if (indicesCache.value && Date.now() - indicesCache.ts < INDICES_TTL) return indicesCache.value;
  if (!indicesInflight) {
    indicesInflight = indexLoader()
      .then(v => { indicesCache = { ts: Date.now(), value: v }; return v; })
      .catch(err => {
        console.error('index snapshot failed:', err.message);
        return staleIndices();
      })
      .finally(() => { indicesInflight = null; });
  }
  if (!timeoutMs) return indicesInflight;
  let timer;
  const fallback = new Promise(resolve => { timer = setTimeout(() => resolve(staleIndices()), timeoutMs); });
  try {
    return await Promise.race([indicesInflight, fallback]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test hooks: replace the NSE loader and clear the cache. */
function _setIndexLoader(fn) {
  indexLoader = fn || defaultLoader;
  indicesCache = { ts: 0, value: null };
  indicesInflight = null;
}

// Daily bars per index: Upstox instrument key, and the Yahoo symbol for the fallback path.
const DAILY_SOURCES = { NIFTY: { upstox: NIFTY_KEY, yahoo: '%5ENSEI' }, SENSEX: { upstox: SENSEX_KEY, yahoo: '%5EBSESN' } };

async function loadDailyBars(symbol = 'NIFTY') {
  const src = DAILY_SOURCES[symbol] || DAILY_SOURCES.NIFTY;
  if (optionChainSource() === 'upstox') {
    const candles = await upstoxCandles.fetchUpstoxCandles(src.upstox, '1d', '10d');
    return candles.map(c => ({ date: new Date(c.t + 330 * 60 * 1000).toISOString().slice(0, 10), open: c.o, high: c.h, low: c.l, close: c.c }));
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${src.yahoo}?range=10d&interval=1d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    const json = await res.json();
    const r = json.chart.result[0];
    const q = r.indicators.quote[0];
    const offset = r.meta.gmtoffset || 0;
    const bars = [];
    r.timestamp.forEach((t, i) => {
      if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return;
      bars.push({
        date: new Date((t + offset) * 1000).toISOString().slice(0, 10),
        open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i]
      });
    });
    return bars;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OHLC of the session pivots should be built from: the previous completed
 * session intraday, or today's once the cash market has closed (next day's CPR).
 */
async function getPivotBasis(symbol = 'NIFTY') {
  const now = istNow();
  const sessionClosed = now.isWeekday && now.mins >= 15 * 60 + 35;
  const key = `${now.ymd}|${sessionClosed}`;
  const hit = ohlcCache.get(symbol) || { ts: 0, value: null, key: null };
  if (hit.value && hit.key === key && Date.now() - hit.ts < OHLC_TTL) return hit.value;

  try {
    const bars = await loadDailyBars(symbol);
    const todayBar = bars.find(b => b.date === now.ymd);
    const prior = bars.filter(b => b.date < now.ymd).pop();
    const basis = sessionClosed && todayBar ? todayBar : prior;
    if (!basis) return hit.value;
    const value = { ...basis, source: optionChainSource() === 'upstox' ? 'upstox' : 'yahoo' };
    ohlcCache.set(symbol, { ts: Date.now(), value, key });
    return value;
  } catch (err) {
    console.error(`Pivot basis (daily OHLC, ${symbol}) failed:`, err.message);
    return hit.value; // may be null → caller falls back to OI estimate
  }
}

module.exports = { getIndexSnapshot, getPivotBasis, istNow, _setIndexLoader, loadIndicesUpstox, fromUpstoxQuote, countBreadth, SECTORS };
