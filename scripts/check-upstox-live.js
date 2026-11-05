// Manual live check (needs network and UPSTOX_ACCESS_TOKEN; not part of `npm test`):
//
//   node scripts/check-upstox-live.js [SYMBOL]
//
// Loads the nearest expiry from Upstox and, for NIFTY, the same expiry from NSE; runs both through the same analytics;
// prints the headline numbers side by side. The per-strike OI ratio settles whether Upstox reports open interest in units
// (ratio ~1 after the adapter divides by the lot size) or in contracts (ratio ~1/lot size, set UPSTOX_OI_IN_UNITS=false).
// Run it during market hours for a fair comparison: NSE lags by up to a minute, so small differences are expected.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local'), quiet: true });
const market = require('../api/services/market');
market.getIndexSnapshot = async () => null; // compare the chain maths only
market.getPivotBasis = async () => null;
const analytics = require('../api/services/analytics');
const integrity = require('../api/services/integrity');
const upstoxChain = require('../api/services/providers/upstoxChain');
const nse = require('../api/services/providers/nse');

const SYMBOL = (process.argv[2] || 'NIFTY').toUpperCase();
const KEYS = ['spot', 'atm', 'pcr', 'volPcr', 'maxPain', 'totalCallOI', 'totalPutOI', 'totalCallChgOI', 'totalPutChgOI', 'straddlePrice', 'atmIv', 'ivSkew', 'maxCallOIStrike', 'maxPutOIStrike'];
const fmt = v => (v === null || v === undefined ? 'n/a' : typeof v === 'number' ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-IN') : String(Number(v.toFixed(3)))) : JSON.stringify(v));

(async () => {
  const up = await upstoxChain.loadChain(SYMBOL, null);
  console.log(`Upstox: ${SYMBOL} ${up.targetExpiry}, ${up.raw.records.data.length} strikes, stamped ${up.raw.records.timestamp} (${up.raw.asOfSource}), lot ${upstoxChain.lotSizeFor(SYMBOL)}, OI in units: ${upstoxChain.OI_IN_UNITS}`);
  const v = integrity.validateRaw(up.raw);
  console.log(`validateRaw: ${v.ok ? 'ok' : v.reasons.join('; ')}`);
  const a = await analytics.processOptionChainData(up.raw, up.allExpiries, up.targetExpiry);
  const failed = integrity.verifyProcessed(up.raw, a, up.targetExpiry).filter(c => c.level === 'fail');
  console.log(`verifyProcessed: ${failed.length ? failed.map(c => `${c.id} (${c.detail})`).join(', ') : 'no failures'}`);

  let b = null, n = null;
  if (SYMBOL === 'NIFTY') {
    try {
      n = await nse.loadFromNSE('NIFTY', up.targetExpiry);
      b = await analytics.processOptionChainData(n.raw, n.allExpiries, n.targetExpiry);
      console.log(`NSE:    ${n.targetExpiry}, ${n.raw.records.data.length} strikes, stamped ${n.raw.records.timestamp}`);
    } catch (e) {
      console.log(`NSE comparison unavailable: ${e.message}`);
    }
  }

  console.log('\n' + ['metric'.padEnd(16), 'upstox'.padStart(16), 'nse'.padStart(16), 'diff %'.padStart(8)].join(''));
  for (const k of KEYS) {
    const x = a[k], y = b ? b[k] : null;
    const d = typeof x === 'number' && typeof y === 'number' && y !== 0 ? (((x - y) / Math.abs(y)) * 100).toFixed(2) : '';
    console.log([k.padEnd(16), fmt(x).padStart(16), fmt(y).padStart(16), d.padStart(8)].join(''));
  }

  if (n) {
    const nseOi = new Map(n.raw.records.data.filter(r => (r.expiryDate || r.expiryDates) === up.targetExpiry && r.CE).map(r => [r.strikePrice, r.CE.openInterest]));
    const ratios = up.raw.records.data.filter(r => r.CE && nseOi.get(r.strikePrice) > 1000).map(r => r.CE.openInterest / nseOi.get(r.strikePrice)).sort((p, q) => p - q);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : NaN;
    console.log(`\nper-strike call OI, Upstox / NSE (median of ${ratios.length}): ${med.toFixed(3)}  -> ${Math.abs(med - 1) < 0.1 ? 'units match' : 'UNITS DIFFER: check UPSTOX_OI_IN_UNITS'}`);
  }
})().catch(e => { console.error(`failed: ${e.code || ''} ${e.message}`); process.exit(1); });
