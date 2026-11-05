// Upstox client checks: no network, every reply comes from a fake fetch.
const assert = require('assert');
const upstox = require('./services/upstox');
const market = require('./services/market');
market.getIndexSnapshot = async () => null; // offline
market.getPivotBasis = async () => null;

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const sleep = async () => {};

(async () => {
  // ── client ──────────────────────────────────────────────────────────
  assert.strictEqual(
    upstox.buildUrl('/v2/option/chain', { instrument_key: 'NSE_INDEX|Nifty 50', expiry_date: '2026-11-10', empty: '' }),
    'https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=2026-11-10',
    'query values are encoded and empty ones dropped'
  );
  assert.strictEqual(upstox.buildUrl('/v2/market-quote/quotes', { instrument_key: ['A|1', 'B|2'] }),
    'https://api.upstox.com/v2/market-quote/quotes?instrument_key=A%7C1%2CB%7C2', 'arrays are comma-joined');

  // success returns data, and sends the bearer token
  let seen = null;
  const ok = async (url, opts) => { seen = { url, opts }; return { status: 200, ok: true, json: async () => ({ status: 'success', data: [1, 2] }) }; };
  assert.deepStrictEqual(await upstox.get('/x', {}, { fetchImpl: ok, accessToken: 'tok', sleep }), [1, 2]);
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok');

  // no token: fail before any request
  let called = false;
  await assert.rejects(upstox.get('/x', {}, { fetchImpl: async () => { called = true; }, accessToken: '', sleep }), e => e.code === 'UPSTOX_NO_TOKEN');
  assert.strictEqual(called, false);

  // auth errors are not retried
  let calls = 0;
  const auth = async () => { calls += 1; return reply(401, { status: 'error', errors: [{ message: 'Invalid token used to access API' }] })(); };
  await assert.rejects(upstox.get('/x', {}, { fetchImpl: auth, accessToken: 't', sleep }), e => e.code === 'UPSTOX_AUTH' && /Invalid token/.test(e.message));
  assert.strictEqual(calls, 1, 'a rejected token never gets better on retry');

  // transient failures are retried once, then succeed
  calls = 0;
  const flaky = async () => { calls += 1; return calls === 1 ? reply(503, {})() : reply(200, { status: 'success', data: 'ok' })(); };
  assert.strictEqual(await upstox.get('/x', {}, { fetchImpl: flaky, accessToken: 't', sleep }), 'ok');
  assert.strictEqual(calls, 2);

  // ...and fail with the second error if the retry fails too
  calls = 0;
  const rate = async () => { calls += 1; return reply(429, {})(); };
  await assert.rejects(upstox.get('/x', {}, { fetchImpl: rate, accessToken: 't', sleep }), e => e.code === 'UPSTOX_RATE');
  assert.strictEqual(calls, 2);

  // a timeout is reported as such
  const hang = async (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(upstox.get('/x', {}, { fetchImpl: hang, accessToken: 't', timeoutMs: 10, sleep }), e => e.code === 'UPSTOX_TIMEOUT');

  // a 200 that is not a success envelope is rejected, not passed on
  await assert.rejects(upstox.get('/x', {}, { fetchImpl: reply(200, { status: 'error', errors: [{ message: 'nope' }] }), accessToken: 't', sleep }), e => e.code === 'UPSTOX_BAD_REPLY');
  await assert.rejects(upstox.get('/x', {}, { fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new Error('html'); } }), accessToken: 't', sleep }), e => e.code === 'UPSTOX_BAD_REPLY');

  // ── index config and expiries ───────────────────────────────────────
  const instruments = require('./services/instruments');
  assert.strictEqual(instruments.getIndex('nifty').underlyingKey, 'NSE_INDEX|Nifty 50');
  assert.throws(() => instruments.getIndex('FOO'), e => e.code === 'BAD_SYMBOL');
  assert.strictEqual(instruments.ymdToNseDate('2026-11-10'), '10-Nov-2026');
  assert.strictEqual(instruments.ymdToNseDate('2026-13-10'), null);
  assert.strictEqual(instruments.ymdToNseDate('10-Nov-2026'), null);
  assert.strictEqual(instruments.nseDateToYmd('10-Nov-2026'), '2026-11-10');
  for (const ymd of ['2026-01-06', '2026-12-29', '2027-03-30']) {
    assert.strictEqual(instruments.nseDateToYmd(instruments.ymdToNseDate(ymd)), ymd, 'date formats round-trip');
  }

  // 2026-11-05 10:00 IST
  const now = Date.parse('2026-11-05T10:00:00+05:30');
  const contracts = [
    { expiry: '2026-11-17', lot_size: 65, instrument_type: 'CE' },
    { expiry: '2026-11-10', lot_size: 65, instrument_type: 'PE' },
    { expiry: '2026-11-10', lot_size: 65, instrument_type: 'CE' },
    { expiry: '2026-11-05', lot_size: 65, instrument_type: 'CE' },   // today: still tradeable
    { expiry: '2026-11-03', lot_size: 65, instrument_type: 'CE' },   // past: dropped
    { expiry: '2026-12-29', lot_size: 75, instrument_type: 'CE' },   // odd lot on one far contract: outvoted
    { expiry: 'garbage', lot_size: 65 }, null
  ];
  const parsed = instruments.parseContracts(contracts, now);
  assert.deepStrictEqual(parsed.expiries, ['05-Nov-2026', '10-Nov-2026', '17-Nov-2026', '29-Dec-2026'], 'unique, sorted, past dropped');
  assert.strictEqual(parsed.lotSize, 65);
  assert.deepStrictEqual(instruments.parseContracts(null, now), { expiries: [], lotSize: null });

  let asked = null;
  const fc = await instruments.fetchContracts('NIFTY', { get: async (p, q) => { asked = { p, q }; return contracts; }, nowMs: now });
  assert.strictEqual(asked.p, '/v2/option/contract');
  assert.strictEqual(asked.q.instrument_key, 'NSE_INDEX|Nifty 50');
  assert.strictEqual(fc.expiries[0], '05-Nov-2026');
  await assert.rejects(instruments.fetchContracts('NIFTY', { get: async () => [], nowMs: now }), /no open expiries/);

  // ── adapter: Upstox chain -> ChainDeck chain ────────────────────────
  const { toChainRaw, formatIstTimestamp } = require('./services/upstoxAdapter');
  const integrity = require('./services/integrity');
  const analytics = require('./services/analytics');
  assert.strictEqual(formatIstTimestamp(Date.parse('2026-11-05T04:45:07Z')), '05-Nov-2026 10:15:07');

  // One synthetic chain, written twice: in ChainDeck's own shape (contracts) and as Upstox would send it (units).
  const LOT = 65, SPOT = 22700, EXP_YMD = '2026-11-10', EXP = '10-Nov-2026';
  const asOf = Date.parse('2026-11-05T11:30:00+05:30');
  const nativeRows = [], upstoxRows = [];
  for (let k = 22000; k <= 23400; k += 50) {
    const time = 60 * Math.exp(-Math.pow((k - SPOT) / 250, 2));
    const ce = Math.round((Math.max(0, SPOT - k) + time) * 100) / 100, pe = Math.round((Math.max(0, k - SPOT) + time) * 100) / 100;
    const ceOI = Math.round(40000 + 200000 * Math.exp(-Math.pow((k - 23000) / 200, 2)));
    const peOI = Math.round(40000 + 220000 * Math.exp(-Math.pow((k - 22400) / 200, 2)));
    const chg = 500, vol = 90000, ivC = 14.2, ivP = 15.1, prevClose = 3;
    const native = (ltp, oi, iv) => ({ strikePrice: k, expiryDate: EXP, openInterest: oi, changeinOpenInterest: chg, totalTradedVolume: vol, impliedVolatility: iv, lastPrice: ltp, change: Number((ltp - (ltp - prevClose)).toFixed(2)), bidprice: ltp - 0.5, bidQty: 650, askPrice: ltp + 0.5, askQty: 1300, underlyingValue: SPOT });
    nativeRows.push({ strikePrice: k, expiryDate: EXP, CE: native(ce, ceOI, ivC), PE: native(pe, peOI, ivP) });
    const side = (ltp, oi, iv, type) => ({
      instrument_key: `NSE_FO|${k}${type}`,
      market_data: { ltp, close_price: ltp - prevClose, volume: vol * LOT, oi: oi * LOT, prev_oi: (oi - chg) * LOT, bid_price: ltp - 0.5, bid_qty: 650, ask_price: ltp + 0.5, ask_qty: 1300 },
      option_greeks: { vega: 1, theta: -1, gamma: 0.001, delta: 0.5, iv, pop: 50 }
    });
    upstoxRows.push({ expiry: EXP_YMD, pcr: 1, strike_price: k, underlying_key: 'NSE_INDEX|Nifty 50', underlying_spot_price: SPOT, call_options: side(ce, ceOI, ivC, 'CE'), put_options: side(pe, peOI, ivP, 'PE') });
  }
  const nativeRaw = { records: { expiryDates: [EXP, '17-Nov-2026'], underlyingValue: SPOT, timestamp: formatIstTimestamp(asOf), data: nativeRows } };
  const adapted = toChainRaw(upstoxRows.slice().reverse(), { expiries: [EXP, '17-Nov-2026'], asOfMs: asOf, quantityPerContract: LOT });

  assert.strictEqual(adapted.source, 'upstox');
  assert.deepStrictEqual(adapted.records.expiryDates, [EXP, '17-Nov-2026']);
  assert.strictEqual(adapted.records.underlyingValue, SPOT);
  assert.strictEqual(adapted.records.timestamp, '05-Nov-2026 11:30:00');
  assert.deepStrictEqual(adapted.records.data.map(r => r.strikePrice), nativeRows.map(r => r.strikePrice), 'rows sorted by strike');
  const leg = adapted.records.data[10].CE, want = nativeRows[10].CE;
  for (const f of ['strikePrice', 'expiryDate', 'openInterest', 'changeinOpenInterest', 'totalTradedVolume', 'impliedVolatility', 'lastPrice', 'change', 'bidprice', 'bidQty', 'askPrice', 'askQty', 'underlyingValue']) {
    assert.strictEqual(leg[f], want[f], `leg field ${f}`);
  }
  assert.strictEqual(leg.identifier, 'NSE_FO|22500CE');

  // With quantityPerContract 1, numbers pass through untouched.
  assert.strictEqual(toChainRaw(upstoxRows, { quantityPerContract: 1 }).records.data[0].CE.openInterest, upstoxRows[0].call_options.market_data.oi);

  // The adapted payload passes the same checks as before, and every headline number comes out identical.
  assert.deepStrictEqual(integrity.validateRaw(adapted, null, asOf), { ok: true, reasons: [] });
  const fromNative = await analytics.processOptionChainData(nativeRaw, [EXP], EXP);
  const fromUpstox = await analytics.processOptionChainData(adapted, [EXP], EXP);
  for (const k of ['spot', 'atm', 'dteDays', 'pcr', 'ntmPcr', 'volPcr', 'straddlePrice', 'upperRange', 'lowerRange', 'impliedFuture', 'ivSkew', 'atmIv', 'maxPain', 'walls', 'gex', 'totalCallOI', 'totalPutOI', 'totalCallChgOI', 'totalPutChgOI', 'maxCallOIStrike', 'maxPutOIStrike']) {
    assert.ok(fromNative[k] !== undefined, `analytics returns ${k}`);
    assert.deepStrictEqual(fromUpstox[k], fromNative[k], `analytics ${k}`);
  }
  assert.ok(Number.isFinite(fromUpstox.pcr) && fromUpstox.totalCallOI > 0, 'analytics produced real numbers');
  const checks = integrity.verifyProcessed(adapted, fromUpstox, EXP);
  assert.ok(!integrity.hasFailure(checks), `integrity: ${checks.filter(c => c.level === 'fail').map(c => c.id).join(',')}`);

  // Bad values are surfaced, never turned into zeros.
  const broken = JSON.parse(JSON.stringify(upstoxRows));
  broken[3].call_options.market_data.oi = '1200';
  broken[4].put_options.option_greeks.iv = null;      // missing is fine
  const br = toChainRaw(broken, { expiries: [EXP], asOfMs: asOf, quantityPerContract: LOT });
  assert.ok(Number.isNaN(br.records.data[3].CE.openInterest));
  assert.ok(Number.isNaN(br.records.data[3].CE.changeinOpenInterest));
  assert.ok(!('impliedVolatility' in br.records.data[4].PE));
  assert.ok(integrity.validateRaw(br, null, asOf).reasons.some(r => /non-numeric/.test(r)), 'a string OI is rejected');

  // Missing legs and an empty chain
  const oneSided = JSON.parse(JSON.stringify(upstoxRows));
  delete oneSided[0].put_options;
  assert.ok(!('PE' in toChainRaw(oneSided).records.data[0]));
  assert.ok(Number.isNaN(toChainRaw([]).records.underlyingValue));
  assert.ok(!integrity.validateRaw(toChainRaw([])).ok, 'an empty chain is rejected before caching');
  assert.throws(() => toChainRaw(null), /not a list/);

  // ── chain loader ────────────────────────────────────────────────────
  const chain = require('./services/upstoxChain');
  chain._clearCache();
  const log = [];
  const fakeGet = async (path, q) => {
    log.push(path);
    if (path === '/v2/option/contract') return contracts;
    if (path === '/v2/option/chain') { assert.strictEqual(q.expiry_date, '2026-11-10'); return upstoxRows; }
    throw new Error(`unexpected ${path}`);
  };
  const loaded = await chain.loadChain('NIFTY', '10-Nov-2026', { get: fakeGet, nowMs: now });
  assert.strictEqual(loaded.targetExpiry, '10-Nov-2026');
  assert.deepStrictEqual(loaded.allExpiries, parsed.expiries);
  assert.strictEqual(loaded.raw.records.data.length, upstoxRows.length);
  assert.strictEqual(loaded.raw.records.data[10].CE.openInterest, nativeRows[10].CE.openInterest, 'units converted with the live lot size');
  assert.deepStrictEqual(log, ['/v2/option/contract', '/v2/option/chain']);

  // warm cache: one call per refresh
  log.length = 0;
  await chain.loadChain('NIFTY', '10-Nov-2026', { get: fakeGet, nowMs: now + 60000 });
  assert.deepStrictEqual(log, ['/v2/option/chain']);
  assert.deepStrictEqual(chain.knownExpiries('NIFTY', now), parsed.expiries);
  assert.strictEqual(chain.lotSizeFor('NIFTY', now), 65);

  // an expiry not on the list: the list is re-fetched once, then the request is refused without asking for a chain
  log.length = 0;
  await assert.rejects(chain.loadChain('NIFTY', '11-Nov-2026', { get: fakeGet, nowMs: now }), e => e.code === 'BAD_EXPIRY');
  assert.deepStrictEqual(log, ['/v2/option/contract']);

  // the cached list is dropped once its nearest expiry has passed
  assert.strictEqual(chain.knownExpiries('NIFTY', Date.parse('2026-11-06T09:30:00+05:30')), null);

  console.log('upstox checks passed');
})().catch(e => { console.error(e); process.exit(1); });
