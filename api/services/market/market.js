const constituents = require('../providers/constituents');
const upstoxCandles = require('../providers/upstoxCandles');

// Market context: India VIX, index day stats, sectors and breadth, read from the Upstox live feed (no HTTP), and the
// previous completed session's OHLC (for real CPR/pivots) from Upstox's daily candles (history has no stream; looked up
// at most twice a day). Every function resolves to null on failure so analytics can degrade gracefully.


const INDICES_TTL = 1000;
const INDICES_MAX_STALE = 10 * 60 * 1000; // older than this, a fallback value would mislead more than help

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
/**
 * Upstox quote -> { last, previousClose, open, high, low, percentChange }, or null.
 * `cp` is the previous close; today's open/high/low come from the feed's day candle (the headline indices only).
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

const HEADLINE_KEYS = [NIFTY_KEY, SENSEX_KEY, VIX_KEY];
const FIRST_TICK_WAIT_MS = 2000;
let liveSubscribed = false;

/** A feed tick in the shape fromUpstoxQuote reads (the REST quote's field names). */
function tickToQuote(t) {
  if (!t) return null;
  return { last_price: t.ltp, cp: t.cp, live_ohlc: t.ohlc ? t.ohlc['1d'] : undefined };
}

/** Subscribe once: the three headline indices in full (day open/high/low), sectors and constituent stocks as last price. */
function subscribeIndices(feed, lists) {
  if (liveSubscribed) return;
  const stockKeys = [...new Set(Object.values(lists || {}).flat())].map(isin => `NSE_EQ|${isin}`);
  feed.subscribe(HEADLINE_KEYS, 'full');
  feed.subscribe([...SECTORS.map(s => s[2]), ...stockKeys], 'ltpc');
  liveSubscribed = true;
}

function waitForTick(feed, key, ms) {
  if (feed.get(key)) return Promise.resolve();
  return new Promise(resolve => {
    let off = () => {};
    const timer = setTimeout(() => { off(); resolve(); }, ms);
    off = feed.on('ticks', () => {
      if (!feed.get(key)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** VIX, NIFTY day stats, sectors and breadth from the live feed's latest ticks. */
async function loadIndicesLive({ feed = require('../stream/upstoxStream').getStream().market, lists = constituents.getConstituents() } = {}) {
  subscribeIndices(feed, lists);
  if (['idle', 'stopped'].includes(feed.getState().status)) throw new Error('live feed is not running'); // started by the server
  await waitForTick(feed, NIFTY_KEY, FIRST_TICK_WAIT_MS);
  if (feed.getState().stale) throw new Error(`live feed is ${feed.getState().status}`); // the caller serves its last snapshot
  const quotes = { get: key => tickToQuote(feed.get(key)) };

  const nifty = fromUpstoxQuote(quotes.get(NIFTY_KEY));
  if (!nifty) throw new Error('NIFTY 50 missing from the live feed');
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

const defaultLoader = () => loadIndicesLive();

let indexLoader = defaultLoader; // swappable in tests

const staleIndices = () => (indicesCache.value && Date.now() - indicesCache.ts < INDICES_MAX_STALE ? indicesCache.value : null);

/**
 * VIX, NIFTY day stats, sectors and breadth, rebuilt from the live feed at most once a second.
 * If the feed is down, or has nothing yet after `timeoutMs`, the last good snapshot (at most 10 minutes old) is returned
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

/** Test hooks: replace the loader and clear the cache. */
function _setIndexLoader(fn) {
  indexLoader = fn || defaultLoader;
  indicesCache = { ts: 0, value: null };
  indicesInflight = null;
}

// Daily bars per index, from Upstox's candle history.
const DAILY_KEYS = { NIFTY: NIFTY_KEY, SENSEX: SENSEX_KEY };

async function loadDailyBars(symbol = 'NIFTY') {
  const candles = await upstoxCandles.fetchUpstoxCandles(DAILY_KEYS[symbol] || NIFTY_KEY, '1d', '10d');
  return candles.map(c => ({ date: new Date(c.t + 330 * 60 * 1000).toISOString().slice(0, 10), open: c.o, high: c.h, low: c.l, close: c.c }));
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
  // One lookup per key: the key changes at midnight and at the close, so history is asked for twice a day at most.
  if (hit.value && hit.key === key) return hit.value;

  try {
    const bars = await loadDailyBars(symbol);
    const todayBar = bars.find(b => b.date === now.ymd);
    const prior = bars.filter(b => b.date < now.ymd).pop();
    const basis = sessionClosed && todayBar ? todayBar : prior;
    if (!basis) return hit.value;
    const value = { ...basis, source: 'upstox' };
    ohlcCache.set(symbol, { ts: Date.now(), value, key });
    return value;
  } catch (err) {
    console.error(`Pivot basis (daily OHLC, ${symbol}) failed:`, err.message);
    return hit.value; // may be null → caller falls back to OI estimate
  }
}

module.exports = { getIndexSnapshot, getPivotBasis, istNow, _setIndexLoader, loadIndicesLive, tickToQuote, fromUpstoxQuote, countBreadth, SECTORS };
