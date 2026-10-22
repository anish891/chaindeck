// Integrity layer: payload validation before caching, and independent recomputation after analytics.
const assert = require('assert');
const market = require('./services/market');
market.getIndexSnapshot = async () => null; // offline
market.getPivotBasis = async () => null;
const analytics = require('./services/analytics');
const I = require('./services/integrity');

const EXPIRY = '29-Oct-2026';
const SPOT = 22700;
// A consistent chain: call - put = spot - strike (parity holds), OI peaks at different strikes so max pain is well defined.
function mkRaw({ spot = SPOT, stamp = '22-Oct-2026 11:30:00', mutate = null } = {}) {
  const data = [];
  for (let k = 22000; k <= 23400; k += 50) {
    const intrinsicC = Math.max(0, spot - k), intrinsicP = Math.max(0, k - spot);
    const time = 60 * Math.exp(-Math.pow((k - spot) / 250, 2));
    const ce = intrinsicC + time, pe = intrinsicP + time;
    const ceOI = Math.round(40000 + 200000 * Math.exp(-Math.pow((k - 23000) / 200, 2)));
    const peOI = Math.round(40000 + 220000 * Math.exp(-Math.pow((k - 22400) / 200, 2)));
    const leg = (ltp, oi) => ({ openInterest: oi, changeinOpenInterest: 500, lastPrice: Math.round(ltp * 100) / 100, change: 0, impliedVolatility: 14, totalTradedVolume: 90000, underlyingValue: spot });
    data.push({ strikePrice: k, expiryDate: EXPIRY, CE: leg(ce, ceOI), PE: leg(pe, peOI) });
  }
  const raw = { records: { underlyingValue: spot, timestamp: stamp, data, expiryDates: [EXPIRY] } };
  if (mutate) mutate(raw);
  return raw;
}
const byId = checks => Object.fromEntries(checks.map(c => [c.id, c]));

(async () => {
  // ── validateRaw ──
  assert.deepStrictEqual(I.validateRaw(mkRaw()), { ok: true, reasons: [] });
  assert.strictEqual(I.validateRaw(null).ok, false);
  assert.strictEqual(I.validateRaw({ records: { data: [] } }).ok, false, 'no rows');
  assert.ok(I.validateRaw(mkRaw({ spot: 0 })).reasons.some(r => /spot/.test(r)), 'zero spot rejected');
  assert.ok(I.validateRaw(mkRaw({ mutate: r => { r.records.data[5].CE.openInterest = -1; } })).reasons.some(r => /negative/.test(r)), 'negative OI rejected');
  assert.ok(I.validateRaw(mkRaw({ mutate: r => { r.records.data[5].PE.openInterest = 'x'; } })).reasons.some(r => /non-numeric/.test(r)));
  assert.ok(I.validateRaw(mkRaw({ mutate: r => { r.records.data.length = 10; } })).reasons.some(r => /rows/.test(r)), 'too few rows');
  const prev = { raw: mkRaw() };
  assert.ok(I.validateRaw(mkRaw({ spot: SPOT * 1.12, stamp: '22-Oct-2026 11:31:00' }), prev).reasons.some(r => /jumped/.test(r)), 'a 12% jump in a minute is rejected');
  assert.ok(I.validateRaw(mkRaw({ spot: SPOT * 1.01, stamp: '22-Oct-2026 11:31:00' }), prev).ok, 'a normal move passes');
  assert.ok(I.validateRaw(mkRaw({ stamp: '22-Oct-2026 11:00:00' }), prev).reasons.some(r => /older/.test(r)), 'an older snapshot cannot replace a newer one');
  assert.ok(I.validateRaw(mkRaw({ spot: SPOT * 1.12, stamp: '25-Oct-2026 11:31:00' }), prev, Date.UTC(2026, 9, 30)).ok, 'a big gap after days off is allowed (weekend moves)');
  assert.ok(I.validateRaw(mkRaw({ stamp: '22-Oct-2099 11:00:00' })).reasons.some(r => /future/.test(r)));
  assert.strictEqual(I.parseNseTs('22-Oct-2026 11:30:00'), Date.UTC(2026, 9, 22, 6, 0));

  // ── verifyProcessed on clean, processed data: everything passes ──
  const raw = mkRaw();
  const data = await analytics.processOptionChainData(raw, [EXPIRY], EXPIRY);
  let checks = I.verifyProcessed(raw, data, EXPIRY);
  const ok = byId(checks);
  for (const id of ['chain_rows', 'oi_totals', 'pcr_recompute', 'max_pain', 'atm_strike', 'parity', 'basis']) assert.strictEqual(ok[id].level, 'pass', `${id}: ${ok[id].level} ${ok[id].detail}`);
  assert.ok(!I.hasFailure(checks));
  assert.ok(checks.every(c => c.id && c.group && c.label && ['pass', 'warn', 'fail', 'skip'].includes(c.level)));

  // ── each corruption is caught by the right check ──
  const tamper = (patch) => byId(I.verifyProcessed(raw, { ...data, ...patch }, EXPIRY));
  assert.strictEqual(tamper({ pcr: data.pcr + 0.2 }).pcr_recompute.level, 'fail', 'wrong PCR');
  assert.strictEqual(tamper({ totalPutOI: data.totalPutOI * 1.02 }).oi_totals.level, 'fail', 'wrong OI total');
  assert.strictEqual(tamper({ maxPain: data.maxPain + 300 }).max_pain.level, 'fail', 'wrong max pain');
  assert.strictEqual(tamper({ atm: data.atm + 400 }).atm_strike.level, 'fail', 'wrong ATM');
  assert.strictEqual(tamper({ impliedFuture: SPOT * 1.04 }).basis.level, 'fail');
  assert.strictEqual(tamper({ impliedFuture: SPOT * 1.015 }).basis.level, 'warn');
  assert.strictEqual(tamper({ atmIv: 400 }).iv_range.level, 'fail');
  assert.strictEqual(tamper({ day: { high: SPOT - 300, low: SPOT - 500 } }).day_range.level, 'fail', 'spot outside the day range');
  assert.strictEqual(tamper({ day: null }).day_range.level, 'skip', 'missing data is a skip, never a pass');

  // stale quotes break put-call parity: one stale strike warns, many fail
  const stale1 = mkRaw({ mutate: r => { const row = r.records.data.find(x => x.strikePrice === 22700); row.CE.lastPrice += 60; } });
  assert.strictEqual(byId(I.verifyProcessed(stale1, data, EXPIRY)).parity.level, 'warn');
  const staleMany = mkRaw({ mutate: r => r.records.data.filter(x => Math.abs(x.strikePrice - SPOT) <= 250).forEach((row, i) => { if (i % 2 === 0) row.PE.lastPrice += 70; }) });
  assert.strictEqual(byId(I.verifyProcessed(staleMany, data, EXPIRY)).parity.level, 'fail');
  // no live quotes: skipped, not passed
  const noQuotes = mkRaw({ mutate: r => r.records.data.forEach(row => { row.CE.lastPrice = 0; row.PE.lastPrice = 0; }) });
  assert.strictEqual(byId(I.verifyProcessed(noQuotes, data, EXPIRY)).parity.level, 'skip');

  // too little data
  assert.strictEqual(I.verifyProcessed({ records: { data: [] } }, data, EXPIRY)[0].level, 'fail');
  assert.strictEqual(I.verifyProcessed(raw, null, EXPIRY)[0].level, 'fail');

  // brute-force max pain agrees with a hand-worked case: 20 calls at 100, 10 puts at 200
  const mini = [{ strike: 100, CE: { openInterest: 20 }, PE: { openInterest: 0 } }, { strike: 150, CE: { openInterest: 0 }, PE: { openInterest: 0 } }, { strike: 200, CE: { openInterest: 0 }, PE: { openInterest: 10 } }];
  const mp = I.maxPainBruteForce(mini);
  assert.strictEqual(mp.strike, 100); assert.strictEqual(mp.min, 1000);
  assert.strictEqual(mp.pain.get(150), 1500); assert.strictEqual(mp.pain.get(200), 2000);
  console.log('integrity checks passed');
})().catch(e => { console.error(e); process.exit(1); });
