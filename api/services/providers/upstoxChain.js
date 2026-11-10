const upstox = require('./upstox');
const instruments = require('./instruments');
const { toChainRaw } = require('./upstoxAdapter');

// Load one expiry of an index's option chain from Upstox, already in ChainDeck's chain shape.
// Returns the same { raw, allExpiries, targetExpiry } that the old NSE loader returned, so callers are unchanged.
//
// The expiry list (and live lot size) comes from /v2/option/contract and is cached for an hour, or until its nearest
// expiry has passed. With a warm cache a refresh is a single Upstox call.

const CONTRACTS_TTL_MS = 60 * 60 * 1000;

// Upstox reports option open interest and volume in units (lots x lot size); ChainDeck counts contracts.
// Set UPSTOX_OI_IN_UNITS=false if a live comparison ever shows Upstox already reports contracts.
const OI_IN_UNITS = String(process.env.UPSTOX_OI_IN_UNITS || 'true').toLowerCase() !== 'false';

const contractsCache = new Map(); // symbol -> { value: { expiries, lotSize }, ts }

function cachedContracts(symbol, nowMs) {
  const hit = contractsCache.get(symbol);
  if (!hit || nowMs - hit.ts > CONTRACTS_TTL_MS) return null;
  const nearest = instruments.nseDateToYmd(hit.value.expiries[0]);
  if (!nearest || nearest < instruments.istYmd(nowMs)) return null;
  return hit.value;
}

async function getContracts(symbol, { get = upstox.get, nowMs = Date.now(), force = false } = {}) {
  const hit = !force && cachedContracts(symbol, nowMs);
  if (hit) return hit;
  const value = await instruments.fetchContracts(symbol, { get, nowMs });
  contractsCache.set(symbol, { value, ts: nowMs });
  return value;
}

/** Expiries known from the last contract fetch (null when none are cached), for a fast unknown-expiry check. */
function knownExpiries(symbol = 'NIFTY', nowMs = Date.now()) {
  const hit = cachedContracts(symbol, nowMs);
  return hit ? hit.expiries : null;
}

/** The lot size currently in force: Upstox's live value if known, else the configured one. */
function lotSizeFor(symbol = 'NIFTY', nowMs = Date.now()) {
  const hit = cachedContracts(symbol, nowMs);
  return (hit && hit.lotSize) || instruments.getIndex(symbol).lotSize;
}

/** Epoch ms from an Upstox time field: epoch ms as a number or digit string, or an ISO string. null if unreadable. */
function parseUpstoxTime(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 1e12) return v;
  if (typeof v === 'string' && /^\d{13}$/.test(v)) return Number(v);
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** Last trade time of the underlying index from the full market quote; null (never an error) when unavailable. */
async function underlyingLastTrade(key, get) {
  try {
    const data = await get('/v2/market-quote/quotes', { instrument_key: key });
    const q = Object.values(data || {}).find(x => x && x.instrument_token === key) || Object.values(data || {})[0];
    if (!q) return null;
    return parseUpstoxTime(q.last_trade_time) || parseUpstoxTime(q.timestamp);
  } catch (err) {
    if (err && err.code === 'UPSTOX_AUTH') throw err;
    console.error('underlying quote failed:', err.message);
    return null;
  }
}

/**
 * @param symbol      'NIFTY'
 * @param expiryDate  'DD-Mon-YYYY', or null for the nearest expiry
 */
async function loadChain(symbol = 'NIFTY', expiryDate = null, { get = upstox.get, nowMs = Date.now() } = {}) {
  const cfg = instruments.getIndex(symbol);
  let contracts = await getContracts(cfg.symbol, { get, nowMs });
  // A requested expiry missing from a cached list may be a newly listed one: refresh the list once before refusing it.
  if (expiryDate && !contracts.expiries.includes(expiryDate)) contracts = await getContracts(cfg.symbol, { get, nowMs, force: true });
  const targetExpiry = expiryDate || contracts.expiries[0];
  if (!contracts.expiries.includes(targetExpiry)) {
    const err = new Error(`Unknown expiry ${targetExpiry}`);
    err.code = 'BAD_EXPIRY';
    throw err;
  }

  const fetchedAt = Date.now();
  const [rows, lastTradeMs] = await Promise.all([
    get('/v2/option/chain', { instrument_key: cfg.underlyingKey, expiry_date: instruments.nseDateToYmd(targetExpiry) }),
    underlyingLastTrade(cfg.underlyingKey, get)
  ]);
  const lot = contracts.lotSize || cfg.lotSize;
  // The chain carries no exchange time. The index's last trade time plays the role NSE's timestamp did: it stops moving
  // when the feed (or the market) stops, so the freshness checks keep meaning something. Never later than now.
  const asOfMs = lastTradeMs ? Math.min(lastTradeMs, Date.now()) : fetchedAt;
  const raw = toChainRaw(rows, { expiries: contracts.expiries, asOfMs, quantityPerContract: OI_IN_UNITS ? lot : 1 });
  raw.asOfSource = lastTradeMs ? 'last_trade' : 'fetch';
  return { raw, allExpiries: contracts.expiries, targetExpiry };
}

const _clearCache = () => contractsCache.clear();

module.exports = { loadChain, parseUpstoxTime, getContracts, knownExpiries, lotSizeFor, OI_IN_UNITS, _clearCache };
