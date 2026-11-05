const upstox = require('./upstox');
const calendar = require('./calendar');

// The indices ChainDeck can read, and how Upstox names them.
//
//   underlyingKey  Upstox instrument key of the index (used for the option chain, contracts and quotes)
//   lotSize        contract multiplier; the live value from the option-contract list wins when Upstox returns one
//   strikeStep     gap between listed strikes (ATM rounding)

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const INDICES = {
  NIFTY: {
    symbol: 'NIFTY',
    name: 'NIFTY 50',
    underlyingKey: 'NSE_INDEX|Nifty 50',
    lotSize: parseInt(process.env.NIFTY_LOT_SIZE, 10) || 65,
    strikeStep: 50
  }
};

function getIndex(symbol = 'NIFTY') {
  const cfg = INDICES[String(symbol || '').toUpperCase()];
  if (!cfg) {
    const err = new Error(`Unknown index ${symbol}`);
    err.code = 'BAD_SYMBOL';
    throw err;
  }
  return cfg;
}

/** '2026-11-10' -> '10-Nov-2026' (the expiry format used everywhere inside ChainDeck), or null. */
function ymdToNseDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

/** '10-Nov-2026' -> '2026-11-10' (the format Upstox wants), or null. */
const nseDateToYmd = calendar.nseDateToYmd;

const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** An Upstox expiry ('2026-11-10', '2026-11-10T...' or epoch ms such as 1794767399000) -> IST 'YYYY-MM-DD', or null. */
function expiryYmd(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return istYmd(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

/**
 * Upstox option-contract rows -> { expiries: ['10-Nov-2026', ...] (nearest first, today's included), lotSize | null }.
 * Expiries already past (IST calendar day) are dropped; malformed rows are ignored.
 */
function parseContracts(rows, nowMs = Date.now()) {
  const today = istYmd(nowMs);
  const ymds = new Set();
  const lots = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const ymd = r ? expiryYmd(r.expiry) : null;
    if (!ymd) continue;
    if (!ymdToNseDate(ymd) || ymd < today) continue;
    ymds.add(ymd);
    const lot = Number(r.lot_size);
    if (Number.isInteger(lot) && lot > 0) lots.set(lot, (lots.get(lot) || 0) + 1);
  }
  const expiries = [...ymds].sort().map(ymdToNseDate);
  // The most common lot size across contracts (a revision can briefly leave far expiries on the old size).
  const lotSize = lots.size ? [...lots.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  return { expiries, lotSize };
}

/** Live expiry list (and lot size) for an index from Upstox's option-contract endpoint. */
async function fetchContracts(symbol = 'NIFTY', { get = upstox.get, nowMs = Date.now() } = {}) {
  const cfg = getIndex(symbol);
  const rows = await get('/v2/option/contract', { instrument_key: cfg.underlyingKey });
  const out = parseContracts(rows, nowMs);
  if (!out.expiries.length) throw new Error(`Upstox listed no open expiries for ${cfg.symbol}`);
  return out;
}

module.exports = { INDICES, getIndex, expiryYmd, ymdToNseDate, nseDateToYmd, parseContracts, fetchContracts, istYmd };
