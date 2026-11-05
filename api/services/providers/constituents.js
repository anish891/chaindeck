const fetch = require('node-fetch');
const store = require('../storage');

// Index constituents (ISIN codes) for breadth: how many stocks in NIFTY 50, and in each sector index, are up or down.
// Upstox quotes stocks by ISIN (NSE_EQ|<ISIN>) but has no "advances/declines" for an index, so ChainDeck counts them itself.
//
// The lists come from the index provider's public CSV files. They change twice a year, so they are fetched at most once
// a day, kept in storage, and the last good copy is used when a download fails.

const BASE = 'https://www.niftyindices.com/IndexConstituent/';
const FETCH_TIMEOUT_MS = 6000;
const TTL_MS = 24 * 3600 * 1000;
const STORE_KEY = 'idx:constituents';

// index name (as used in market.js) -> CSV file
const FILES = {
  'NIFTY 50': 'ind_nifty50list.csv',
  'NIFTY BANK': 'ind_niftybanklist.csv',
  'NIFTY PRIVATE BANK': 'ind_nifty_privatebanklist.csv',
  'NIFTY PSU BANK': 'ind_niftypsubanklist.csv',
  'NIFTY FINANCIAL SERVICES': 'ind_niftyfinancelist.csv',
  'NIFTY IT': 'ind_niftyitlist.csv',
  'NIFTY AUTO': 'ind_niftyautolist.csv',
  'NIFTY FMCG': 'ind_niftyfmcglist.csv',
  'NIFTY PHARMA': 'ind_niftypharmalist.csv',
  'NIFTY HEALTHCARE INDEX': 'ind_niftyhealthcarelist.csv',
  'NIFTY METAL': 'ind_niftymetallist.csv',
  'NIFTY ENERGY': 'ind_niftyenergylist.csv',
  'NIFTY OIL & GAS': 'ind_niftyoilgaslist.csv',
  'NIFTY REALTY': 'ind_niftyrealtylist.csv',
  'NIFTY MEDIA': 'ind_niftymedialist.csv',
  'NIFTY CONSUMER DURABLES': 'ind_niftyconsumerdurableslist.csv',
  'NIFTY INFRASTRUCTURE': 'ind_niftyinfralist.csv'
};

const ISIN_RE = /^IN[A-Z0-9]{9}\d$/;

/** CSV text -> list of ISINs, or null if the file does not look like a constituent list. */
function parseConstituentCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const col = header.findIndex(h => h.startsWith('isin'));
  if (col === -1) return null;
  const isins = [];
  for (const line of lines.slice(1)) {
    const v = (line.split(',')[col] || '').trim().toUpperCase();
    if (ISIN_RE.test(v) && !isins.includes(v)) isins.push(v);
  }
  return isins.length ? isins : null;
}

async function downloadOne(file, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(BASE + file, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (!res.ok) return null;
    return parseConstituentCsv(await res.text());
  } catch (err) {
    console.error('constituent list download failed:', file, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let memo = null;     // { ts, lists: { indexName: [isin] } }
let inflight = null;

/**
 * { 'NIFTY 50': [isin, ...], 'NIFTY BANK': [...], ... }. Lists that fail to download keep their last stored copy; an
 * index with no list at all is simply missing (its breadth shows as unknown).
 */
async function getConstituents({ fetchImpl = fetch, storeImpl = store, nowMs = Date.now() } = {}) {
  if (memo && nowMs - memo.ts < TTL_MS) return memo.lists;
  if (inflight) return inflight;
  inflight = (async () => {
    let stored = null;
    try { stored = JSON.parse((await storeImpl.get(STORE_KEY)) || 'null'); } catch (e) { stored = null; }
    if (stored && stored.lists && nowMs - stored.ts < TTL_MS) {
      memo = stored;
      return stored.lists;
    }
    const names = Object.keys(FILES);
    const fresh = await Promise.all(names.map(n => downloadOne(FILES[n], fetchImpl)));
    const lists = {};
    let got = 0;
    names.forEach((n, i) => {
      if (fresh[i]) { lists[n] = fresh[i]; got += 1; }
      else if (stored && stored.lists && stored.lists[n]) lists[n] = stored.lists[n];
    });
    // Only a mostly complete refresh resets the clock; otherwise try again in an hour.
    const ts = got >= names.length - 2 ? nowMs : nowMs - TTL_MS + 3600 * 1000;
    memo = { ts, lists };
    if (got) await storeImpl.set(STORE_KEY, JSON.stringify({ ts, lists })).catch(err => console.error('constituent cache write failed:', err.message));
    return lists;
  })().finally(() => { inflight = null; });
  return inflight;
}

const _clear = () => { memo = null; inflight = null; };

module.exports = { FILES, parseConstituentCsv, getConstituents, _clear };
