const fetch = require('node-fetch');
const calendar = require('./calendar');

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/option-chain',
  'Origin': 'https://www.nseindia.com',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const COOKIE_TTL = 10 * 60 * 1000;

let cookieCache = {
  value: '',
  ts: 0
};

async function fetchNSECookies() {
  const res = await fetch('https://www.nseindia.com/', { headers: NSE_HEADERS });
  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie();
  } else if (typeof res.headers.raw === 'function') {
    cookies = res.headers.raw()['set-cookie'] || [];
  }
  return (cookies || []).map(c => c.split(';')[0]).join('; ');
}

async function getCookies() {
  const now = Date.now();

  if (cookieCache.value && now - cookieCache.ts < COOKIE_TTL) {
    return cookieCache.value;
  }

  const cookies = await fetchNSECookies();
  cookieCache = {
    value: cookies,
    ts: now
  };

  return cookies;
}

async function fetchWithTimeout(url, cookies, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      headers: { ...NSE_HEADERS, Cookie: cookies },
      signal: controller.signal
    });

    // Cookies are only bad on auth failures; don't drop them on a plain timeout.
    if (res.status === 401 || res.status === 403) {
      cookieCache = { value: '', ts: 0 };
      throw new Error(`NSE rejected request (${res.status})`);
    }
    return await res.json();
  } catch (e) {
    if (attempt < 1) {
      const fresh = cookieCache.value ? cookies : await getCookies().catch(() => cookies);
      return fetchWithTimeout(url, fresh, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Expiry list cache -------------------------------------------------
const EXPIRY_TTL = 60 * 60 * 1000;   // expiry list changes ~daily

let expiryCache = { list: null, ts: 0 };

function parseNseDate(str) {
  const d = new Date(`${str.replace(/-/g, ' ')} 23:59:59 GMT+0530`);
  return isNaN(d) ? null : d.getTime();
}

function getCachedExpiries() {
  if (!expiryCache.list || Date.now() - expiryCache.ts > EXPIRY_TTL) return null;
  // Drop the list once its nearest expiry has passed
  const first = parseNseDate(expiryCache.list[0]);
  if (first && first < Date.now()) return null;
  return expiryCache.list;
}

const NSE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Epoch ms -> '24-Oct-2026' (the IST calendar day), the format NSE's expiry parameter uses. */
function formatNseDate(ms) {
  const d = new Date(ms + 330 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${NSE_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function expiryUrl(symbol, expiry) {
  return `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${symbol}&expiry=${encodeURIComponent(expiry)}`;
}

async function loadFromNSE(symbol, expiryDate) {
  let cookies = '';
  try {
    cookies = await getCookies();
  } catch (e) {
    console.error('Cookie fetch failed:', e.message);
  }

  const known = getCachedExpiries();
  // With a cached expiry list the target is known up front -> single NSE call.
  const targetGuess = expiryDate || (known && known[0]) || null;
  // Any well-formed date makes NSE return its list of expiries (checked live: past, today and far-future dates all do),
  // so the probe is today's date instead of a fixed literal that ages into the past.
  const bootstrapExpiry = targetGuess || formatNseDate(Date.now());

  let raw = await fetchWithTimeout(expiryUrl(symbol, bootstrapExpiry), cookies);
  if (!raw?.records?.expiryDates?.length) {
    throw new Error('Unexpected NSE response structure');
  }

  // Only well-formed expiry strings are ever passed on (they end up in URLs, cache keys and the page).
  const allExpiries = raw.records.expiryDates.filter(e => typeof e === 'string' && /^\d{2}-[A-Za-z]{3}-\d{4}$/.test(e));
  if (!allExpiries.length) throw new Error('Unexpected NSE response structure');
  expiryCache = { list: allExpiries, ts: Date.now() };
  const targetExpiry = expiryDate || allExpiries[0];

  if (targetExpiry !== bootstrapExpiry) {
    raw = await fetchWithTimeout(expiryUrl(symbol, targetExpiry), cookies);
    if (!raw?.records?.data) {
      throw new Error('Unexpected NSE response structure');
    }
  }

  return { raw, allExpiries, targetExpiry };
}

const HOLIDAY_TTL_MS = 24 * 3600 * 1000;
let holidayRefresh = { ts: 0, inflight: null };

/**
 * Refresh the NSE trading-holiday list from NSE's own holiday master (at most once a day). Never throws: on any failure
 * the list already in memory (the built-in fallback or the last good fetch) keeps being used.
 */
async function refreshHolidays({ force = false, fetcher = fetchWithTimeout, cookiesFn = getCookies } = {}) {
  if (!force && Date.now() - holidayRefresh.ts < HOLIDAY_TTL_MS) return calendar.snapshot();
  if (holidayRefresh.inflight) return holidayRefresh.inflight;
  holidayRefresh.inflight = (async () => {
    try {
      const cookies = await cookiesFn();
      const json = await fetcher('https://www.nseindia.com/api/holiday-master?type=trading', cookies);
      if (calendar.setHolidaysFromNse(json) > 0) holidayRefresh.ts = Date.now();
      else holidayRefresh.ts = Date.now() - HOLIDAY_TTL_MS + 30 * 60 * 1000; // odd payload: try again in 30 minutes
    } catch (err) {
      console.error('holiday list refresh failed:', err.message);
      holidayRefresh.ts = Date.now() - HOLIDAY_TTL_MS + 30 * 60 * 1000;
    }
    return calendar.snapshot();
  })().finally(() => { holidayRefresh.inflight = null; });
  return holidayRefresh.inflight;
}

module.exports = {
  formatNseDate,
  refreshHolidays,
  NSE_HEADERS,
  getCookies,
  fetchWithTimeout,
  loadFromNSE,
  getCachedExpiries
};

