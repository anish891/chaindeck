const { ymdToNseDate, expiryYmd } = require('./instruments');

// Upstox option chain -> the chain shape the rest of ChainDeck reads.
//
// Analytics, integrity checks, history, alerts and paper trading were all written against one payload shape
// ({ records: { expiryDates, underlyingValue, timestamp, data: [{ strikePrice, expiryDate, CE, PE }] } }). Converting
// Upstox's reply into that shape here keeps every one of those modules, and their tests, unchanged.
//
// Field mapping per leg (Upstox market_data / option_greeks -> leg):
//   oi                 -> openInterest           (divided by quantityPerContract, see below)
//   oi - prev_oi       -> changeinOpenInterest   (change against the previous session's close)
//   volume             -> totalTradedVolume      (divided by quantityPerContract)
//   ltp                -> lastPrice
//   ltp - close_price  -> change                 (vs previous close; omitted when there is no close)
//   iv                 -> impliedVolatility      (percent, e.g. 13.4)
//   bid/ask price, qty -> bidprice, bidQty, askPrice, askQty
//
// quantityPerContract: ChainDeck counts open interest and volume in contracts (GEX multiplies by the lot size, and saved
// history is in contracts). If Upstox reports them in units, pass the lot size and they are converted; pass 1 if Upstox
// already reports contracts.
//
// A value that is present but not a finite number becomes NaN, never 0, so integrity.validateRaw rejects the payload
// instead of the dashboard silently showing a zero.

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Epoch ms -> '05-Nov-2026 10:15:30' in IST (the timestamp format integrity and analytics parse). */
function formatIstTimestamp(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** undefined/null stay undefined (missing); a finite number passes; anything else is NaN (rejected downstream). */
function num(v) {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

function perContract(v, q) {
  const n = num(v);
  if (n === undefined || Number.isNaN(n)) return n;
  return q === 1 ? n : Math.round(n / q);
}

function toLeg(side, { strike, expiry, spot, q }) {
  if (!side || !side.market_data) return null;
  const md = side.market_data;
  const g = side.option_greeks || {};
  const ltp = num(md.ltp);
  const close = num(md.close_price);
  const oi = num(md.oi);
  const prevOi = num(md.prev_oi);

  const leg = {
    strikePrice: strike,
    expiryDate: expiry,
    identifier: typeof side.instrument_key === 'string' ? side.instrument_key : undefined,
    openInterest: perContract(oi, q),
    changeinOpenInterest: oi !== undefined && prevOi !== undefined ? perContract(oi - prevOi, q) : undefined,
    totalTradedVolume: perContract(md.volume, q),
    impliedVolatility: num(g.iv),
    lastPrice: ltp,
    change: ltp !== undefined && close !== undefined && close > 0 ? Number((ltp - close).toFixed(2)) : undefined,
    bidprice: num(md.bid_price),
    bidQty: num(md.bid_qty),
    askPrice: num(md.ask_price),
    askQty: num(md.ask_qty),
    underlyingValue: spot
  };
  for (const k of Object.keys(leg)) if (leg[k] === undefined) delete leg[k];
  return leg;
}

/**
 * @param rows      `data` of GET /v2/option/chain (one expiry)
 * @param expiries  open expiries in DD-Mon-YYYY, nearest first (from instruments.fetchContracts)
 * @param asOfMs    when this snapshot was taken (Upstox sends no exchange timestamp with the chain)
 * @param quantityPerContract  see the header comment
 */
function toChainRaw(rows, { expiries = [], asOfMs = Date.now(), quantityPerContract = 1 } = {}) {
  if (!Array.isArray(rows)) throw new Error('Upstox option chain: data is not a list');
  const q = Number.isInteger(quantityPerContract) && quantityPerContract > 0 ? quantityPerContract : 1;
  const first = rows.find(r => r && Number.isFinite(r.underlying_spot_price));
  const spot = first ? first.underlying_spot_price : NaN;

  const data = [];
  for (const r of rows) {
    if (!r) continue;
    const expiry = ymdToNseDate(expiryYmd(r.expiry)) || String(r.expiry);
    const strike = num(r.strike_price);
    const ctx = { strike, expiry, spot, q };
    const row = { strikePrice: strike, expiryDate: expiry };
    const ce = toLeg(r.call_options, ctx);
    const pe = toLeg(r.put_options, ctx);
    if (ce) row.CE = ce;
    if (pe) row.PE = pe;
    data.push(row);
  }
  data.sort((a, b) => a.strikePrice - b.strikePrice);

  return {
    records: {
      expiryDates: expiries.slice(),
      underlyingValue: spot,
      timestamp: formatIstTimestamp(asOfMs),
      data
    },
    source: 'upstox'
  };
}

module.exports = { toChainRaw, formatIstTimestamp };
