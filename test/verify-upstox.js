// Upstox client checks: no network, every reply comes from a fake fetch.
const assert = require('assert');
const upstox = require('../api/services/providers/upstox');
const market = require('../api/services/market/market');
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
  const instruments = require('../api/services/providers/instruments');
  assert.strictEqual(instruments.getIndex('nifty').underlyingKey, 'NSE_INDEX|Nifty 50');
  assert.throws(() => instruments.getIndex('FOO'), e => e.code === 'BAD_SYMBOL');
  assert.deepStrictEqual(instruments.SYMBOLS, ['NIFTY', 'SENSEX']);
  const sx = instruments.getIndex('sensex');
  assert.deepStrictEqual([sx.underlyingKey, sx.lotSize, sx.strikeStep, sx.exchange], ['BSE_INDEX|SENSEX', 20, 100, 'BSE']);
  assert.throws(() => instruments.getIndex('constructor'), e => e.code === 'BAD_SYMBOL', 'no prototype keys');
  assert.throws(() => instruments.getIndex(null), e => e.code === 'BAD_SYMBOL');
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
  // Upstox's instrument data gives expiries as epoch ms at 23:59:59 IST; the contract API as YYYY-MM-DD. Both are read.
  assert.strictEqual(instruments.expiryYmd(Date.parse('2026-11-09T18:29:59Z')), '2026-11-09');
  assert.strictEqual(instruments.expiryYmd('2026-11-10T00:00:00'), '2026-11-10');
  assert.strictEqual(instruments.expiryYmd('soon'), null);
  assert.deepStrictEqual(instruments.parseContracts([{ expiry: Date.parse('2026-11-09T18:29:59Z'), lot_size: 65 }], now).expiries, ['09-Nov-2026']);
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
  const { toChainRaw, formatIstTimestamp } = require('../api/services/providers/upstoxAdapter');
  const integrity = require('../api/services/analytics/integrity');
  const analytics = require('../api/services/analytics/analytics');
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
  const epochRows = JSON.parse(JSON.stringify(upstoxRows)).map(r => ({ ...r, expiry: Date.parse('2026-11-10T18:29:59Z') }));
  assert.strictEqual(toChainRaw(epochRows).records.data[0].expiryDate, EXP, 'epoch expiry on chain rows');

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
  assert.strictEqual(fromUpstox.symbol, 'NIFTY');
  assert.strictEqual(fromUpstox.strikeStep, 50);

  // SENSEX: same maths on a chain around 80,000 with 100-point strikes and lot size 20
  const SX = 80030, SXEXP = '12-Nov-2026';
  const sxRowsA = [];
  for (let k = 77000; k <= 83000; k += 100) {
    const time = 200 * Math.exp(-Math.pow((k - SX) / 900, 2));
    const ce = Math.round((Math.max(0, SX - k) + time) * 100) / 100, pe = Math.round((Math.max(0, k - SX) + time) * 100) / 100;
    const ceOI = Math.round(20000 + 90000 * Math.exp(-Math.pow((k - 81000) / 600, 2)));
    const peOI = Math.round(20000 + 95000 * Math.exp(-Math.pow((k - 79000) / 600, 2)));
    const side = (ltp, oi, iv) => ({ market_data: { ltp, close_price: ltp - 5, volume: 4000 * 20, oi: oi * 20, prev_oi: (oi - 100) * 20, bid_price: ltp - 1, bid_qty: 20, ask_price: ltp + 1, ask_qty: 40 }, option_greeks: { iv } });
    sxRowsA.push({ expiry: '2026-11-12', strike_price: k, underlying_spot_price: SX, call_options: side(ce, ceOI, 13.5), put_options: side(pe, peOI, 14.5) });
  }
  const sxRaw = toChainRaw(sxRowsA, { expiries: [SXEXP], asOfMs: asOf, quantityPerContract: 20 });
  assert.deepStrictEqual(integrity.validateRaw(sxRaw, null, asOf), { ok: true, reasons: [] });
  const sxOut = await analytics.processOptionChainData(sxRaw, [SXEXP], SXEXP, { symbol: 'SENSEX' });
  assert.notStrictEqual(sxOut, fromUpstox, 'the 5 s cache never hands one index the other\'s result');
  assert.strictEqual(sxOut.symbol, 'SENSEX');
  assert.strictEqual(sxOut.indexName, 'SENSEX');
  assert.strictEqual(sxOut.strikeStep, 100);
  assert.strictEqual(sxOut.atm, 80000, 'ATM rounds to 100');
  assert.strictEqual(sxOut.gex.lotSize, 20);
  assert.ok(sxOut.strikes.every(r => Math.abs(r.strike - 80000) <= 1000) && sxOut.strikes.length === 21, '10 strikes either side');
  assert.strictEqual(sxOut.maxCallOIStrike, 81000);
  assert.strictEqual(sxOut.maxPutOIStrike, 79000);
  assert.strictEqual(sxOut.breadth, null, 'NIFTY 50 breadth is not shown as SENSEX breadth');
  assert.ok(sxOut.gex.zeroGammaLevel === null || Math.abs(sxOut.gex.zeroGammaLevel - SX) < 3000, 'zero gamma searched around SENSEX, not NIFTY');
  assert.ok(!integrity.hasFailure(integrity.verifyProcessed(sxRaw, sxOut, SXEXP)), 'independent recomputation agrees for SENSEX');
  await assert.rejects(analytics.processOptionChainData(sxRaw, [SXEXP], SXEXP, { symbol: 'FOO' }), e => e.code === 'BAD_SYMBOL');
  // spot at a midpoint: ATM 80100 vs nearest 80000 is one SENSEX strike apart, which is fine
  const mid = integrity.verifyProcessed(sxRaw, { ...sxOut, spot: 80050, atm: 80100 }, SXEXP).find(c => c.id === 'atm_strike');
  assert.strictEqual(mid.level, 'pass', `one 100-point strike is not an ATM error: ${mid.detail}`);
  const off = integrity.verifyProcessed(sxRaw, { ...sxOut, atm: 80400 }, SXEXP).find(c => c.id === 'atm_strike');
  assert.strictEqual(off.level, 'fail', 'a wrong ATM is still caught');

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

  // ── chain built from the live feed ──────────────────────────────────
  const liveChain = require('../api/services/stream/liveChain');
  {
    // The same synthetic chain as feed ticks (IV as a fraction, depth as levels) plus the contract list that names the keys.
    const ticks = new Map();
    const contractRows = [];
    for (const r of upstoxRows) {
      for (const [type, o] of [['CE', r.call_options], ['PE', r.put_options]]) {
        const md = o.market_data;
        ticks.set(o.instrument_key, { key: o.instrument_key, ltp: md.ltp, cp: md.close_price, oi: md.oi, vtt: md.volume, iv: o.option_greeks.iv / 100, depth: [{ bidP: md.bid_price, bidQ: md.bid_qty, askP: md.ask_price, askQ: md.ask_qty }] });
        contractRows.push({ expiry: EXP_YMD, lot_size: LOT, instrument_type: type, instrument_key: o.instrument_key, strike_price: r.strike_price });
      }
    }
    contractRows.push({ expiry: '2026-11-17', lot_size: LOT, instrument_type: 'CE', instrument_key: 'NSE_FO|far', strike_price: 22700 }, { expiry: '2026-11-03', lot_size: LOT, instrument_type: 'CE', instrument_key: 'NSE_FO|past', strike_price: 22700 }, null);
    const lastTrade = Date.parse('2026-11-05T09:59:58+05:30');
    ticks.set('NSE_INDEX|Nifty 50', { key: 'NSE_INDEX|Nifty 50', ltp: SPOT, ltt: lastTrade });

    let status = 'connected';
    const mkFeed = () => ({
      subs: [], offs: 0,
      subscribe(keys, mode) { this.subs.push(`${mode}:${[].concat(keys).length}`); return () => { this.offs += 1; }; },
      get: k => ticks.get(k) || null,
      on: () => () => {},
      getState: () => ({ status, stale: status !== 'connected' })
    });
    const mkStore = () => { const m = new Map(); return { m, get: async k => m.get(k) || null, set: async (k, v) => { m.set(k, v); } }; };
    const log = [];
    const get = async (path, q) => { log.push(path); assert.strictEqual(path, '/v2/option/contract'); assert.strictEqual(q.instrument_key, 'NSE_INDEX|Nifty 50'); return contractRows; };
    const noTimers = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
    let clock = now;
    const feed = mkFeed();
    const store = mkStore();
    const lc = liveChain.createLiveChain({ feed, get, store, now: () => clock, timers: noTimers, log: () => {} });

    assert.strictEqual(lc.knownExpiries('NIFTY'), null, 'nothing known before the first lookup');
    const loaded = await lc.loadChain('NIFTY', EXP);
    assert.strictEqual(loaded.targetExpiry, EXP);
    assert.deepStrictEqual(loaded.allExpiries, [EXP, '17-Nov-2026'], 'expiries from the contract list, past ones dropped');
    assert.deepStrictEqual(feed.subs, [`full:${upstoxRows.length * 2}`, 'full:1'], 'the expiry\'s contracts and the index, all in full mode');
    assert.strictEqual(loaded.raw.records.timestamp, '05-Nov-2026 09:59:58', 'stamped with the index last trade time');
    assert.strictEqual(loaded.raw.asOfSource, 'last_trade');
    assert.strictEqual(loaded.raw.records.underlyingValue, SPOT);
    // identical to what the REST chain produced, except change in OI (the feed has no previous-day OI and no baseline is saved yet)
    const viaRest = toChainRaw(upstoxRows, { expiries: loaded.allExpiries, asOfMs: lastTrade, quantityPerContract: LOT });
    const noChg = raw => raw.records.data.map(r => { const c = JSON.parse(JSON.stringify(r)); delete c.CE.changeinOpenInterest; delete c.PE.changeinOpenInterest; return c; });
    assert.deepStrictEqual(noChg(loaded.raw), noChg(viaRest));
    assert.ok(loaded.raw.records.data.every(r => !('changeinOpenInterest' in r.CE)), 'no baseline: change in OI is left out, not guessed');
    assert.strictEqual(loaded.raw.oiBaseline, null);
    assert.ok(integrity.validateRaw(loaded.raw).ok, 'still a valid chain without it');
    assert.strictEqual(loaded.raw.records.data[10].CE.impliedVolatility, 14.2, 'feed IV (a fraction) becomes a percentage');

    // the contract list is the only REST lookup: once per IST day
    await lc.loadChain('NIFTY', null);
    assert.deepStrictEqual(log, ['/v2/option/contract']);
    assert.deepStrictEqual(feed.subs.length, 2, 'already subscribed: nothing new is asked of the feed');
    assert.deepStrictEqual(lc.knownExpiries('NIFTY'), [EXP, '17-Nov-2026']);
    assert.strictEqual(lc.lotSizeFor('NIFTY'), 65);
    assert.strictEqual(lc.lotSizeFor('SENSEX'), 20, 'not looked up yet: the configured size');

    // an expiry not on the list is refused; the list is only re-read if it is more than ten minutes old
    await assert.rejects(lc.loadChain('NIFTY', '11-Nov-2026'), e => e.code === 'BAD_EXPIRY');
    assert.strictEqual(log.length, 1);
    clock += 11 * 60 * 1000;
    await assert.rejects(lc.loadChain('NIFTY', '11-Nov-2026'), e => e.code === 'BAD_EXPIRY');
    assert.strictEqual(log.length, 2, 'it may have been listed since: one fresh look');
    clock = now;

    // feed down or not running: an error (the cache in front serves its last copy, flagged stale), never a half-built chain
    status = 'reconnecting';
    await assert.rejects(lc.loadChain('NIFTY', EXP), e => e.code === 'STREAM_DOWN');
    status = 'idle';
    await assert.rejects(lc.loadChain('NIFTY', EXP), e => e.code === 'STREAM_DOWN');
    status = 'auth_failed';
    await assert.rejects(lc.loadChain('NIFTY', EXP), e => e.code === 'UPSTOX_AUTH');
    status = 'connected';
    const idx = ticks.get('NSE_INDEX|Nifty 50');
    ticks.delete('NSE_INDEX|Nifty 50');
    await assert.rejects(lc.loadChain('NIFTY', EXP), e => e.code === 'STREAM_NOT_READY');
    ticks.set('NSE_INDEX|Nifty 50', idx);
    const some = [...ticks.keys()].filter(k => k.startsWith('NSE_FO|')).slice(0, 20);
    const held = some.map(k => [k, ticks.get(k)]);
    some.forEach(k => ticks.delete(k));
    await assert.rejects(lc.loadChain('NIFTY', EXP), e => e.code === 'STREAM_NOT_READY', 'a third of the contracts missing: wait, do not serve');
    held.forEach(([k, v]) => ticks.set(k, v));

    // an expiry nobody asks for is unsubscribed after five minutes; a pinned one (the recorder's) never is
    clock += 6 * 60 * 1000;
    lc.sweep();
    assert.strictEqual(feed.offs, 1);
    assert.deepStrictEqual(lc.subscribed(), []);
    await lc.loadChain('NIFTY', EXP, { pin: true });
    clock += 60 * 60 * 1000;
    lc.sweep();
    assert.strictEqual(lc.subscribed().length, 1);
    clock = now;
    lc.stop();

    // change in OI: measured against the OI noted between sessions
    const clockAt = liveChain.sessionClock;
    assert.deepStrictEqual(clockAt(Date.parse('2026-11-05T10:00:00+05:30')), { session: '2026-11-05', capture: null }, 'during the session nothing is captured');
    assert.deepStrictEqual(clockAt(Date.parse('2026-11-05T08:30:00+05:30')), { session: '2026-11-04', capture: '2026-11-05' }, 'before the open: OI is still yesterday\'s close');
    assert.deepStrictEqual(clockAt(Date.parse('2026-11-05T16:00:00+05:30')), { session: '2026-11-05', capture: '2026-11-06' }, 'after the close: OI is the baseline for tomorrow');
    assert.deepStrictEqual(clockAt(Date.parse('2026-11-05T15:35:00+05:30')), { session: '2026-11-05', capture: null }, 'the exchange is still settling OI just after the close');
    assert.deepStrictEqual(clockAt(Date.parse('2026-11-07T12:00:00+05:30')), { session: '2026-11-06', capture: '2026-11-09' }, 'Saturday');
    assert.deepStrictEqual(clockAt(Date.parse('2026-11-10T12:00:00+05:30')), { session: '2026-11-09', capture: '2026-11-11' }, 'a holiday');

    // a saved baseline for today's session gives the same change in OI the REST chain did
    const prev = {};
    for (const r of upstoxRows) for (const o of [r.call_options, r.put_options]) prev[o.instrument_key] = o.market_data.prev_oi;
    const store2 = mkStore();
    store2.m.set('oibase:NIFTY:2026-11-10', JSON.stringify({ sessions: { '2026-11-05': prev, '2026-11-04': {} } }));
    const lc2 = liveChain.createLiveChain({ feed: mkFeed(), get, store: store2, now: () => clock, timers: noTimers, log: () => {} });
    const withBase = await lc2.loadChain('NIFTY', EXP);
    assert.deepStrictEqual(withBase.raw.records.data, viaRest.records.data, 'now identical to the REST chain, change in OI included');
    assert.strictEqual(withBase.raw.records.data[10].CE.changeinOpenInterest, 500);
    assert.strictEqual(withBase.raw.oiBaseline, '2026-11-05');
    lc2.stop();

    // captured before the open, saved once, used once the session starts
    const store3 = mkStore();
    let writes = 0;
    const counted = { get: store3.get, set: async (k, v, ttl) => { writes += 1; assert.ok(ttl > 0); return store3.set(k, v); } };
    clock = Date.parse('2026-11-05T08:30:00+05:30');
    const lc3 = liveChain.createLiveChain({ feed: mkFeed(), get, store: counted, now: () => clock, timers: noTimers, log: () => {} });
    const early = await lc3.loadChain('NIFTY', EXP);
    assert.strictEqual(early.raw.oiBaseline, null, 'yesterday\'s session has no baseline here');
    await lc3.loadChain('NIFTY', EXP);
    assert.strictEqual(writes, 1, 'unchanged OI is not written again');
    assert.deepStrictEqual(Object.keys(JSON.parse(store3.m.get('oibase:NIFTY:2026-11-10')).sessions), ['2026-11-05']);
    clock = Date.parse('2026-11-05T09:30:00+05:30');
    const opened = await lc3.loadChain('NIFTY', EXP);
    assert.strictEqual(opened.raw.oiBaseline, '2026-11-05');
    assert.strictEqual(opened.raw.records.data[10].CE.changeinOpenInterest, 0, 'OI has not moved since the baseline');
    ticks.get(upstoxRows[10].call_options.instrument_key).oi += 10 * LOT;
    assert.strictEqual((await lc3.loadChain('NIFTY', EXP)).raw.records.data[10].CE.changeinOpenInterest, 10, 'ten contracts added since yesterday\'s close');
    ticks.get(upstoxRows[10].call_options.instrument_key).oi -= 10 * LOT;
    assert.strictEqual(writes, 1, 'nothing is captured while the session runs');
    lc3.stop();
    clock = now;

    // SENSEX: its own key and lot size
    const sxRowsC = contractRows.filter(Boolean).filter(r => r.expiry === EXP_YMD).map(r => ({ ...r, expiry: '2026-11-12', lot_size: 20 }));
    const sxTicks = new Map(ticks);
    sxTicks.set('BSE_INDEX|SENSEX', { key: 'BSE_INDEX|SENSEX', ltp: 80000, ltt: lastTrade });
    const sxFeed = { ...mkFeed(), get: k => sxTicks.get(k) || null };
    const sxAsked = [];
    const lcSx = liveChain.createLiveChain({ feed: sxFeed, get: async (path, q) => { sxAsked.push(q.instrument_key); return sxRowsC; }, store: mkStore(), now: () => clock, timers: noTimers, log: () => {} });
    const sxLoaded = await lcSx.loadChain('SENSEX', null);
    assert.strictEqual(sxLoaded.targetExpiry, '12-Nov-2026');
    assert.deepStrictEqual(sxAsked, ['BSE_INDEX|SENSEX']);
    assert.strictEqual(sxLoaded.raw.records.underlyingValue, 80000);
    assert.strictEqual(sxLoaded.raw.records.data[10].CE.openInterest, Math.round(upstoxRows[10].call_options.market_data.oi / 20), 'converted with lot 20');
    assert.strictEqual(lcSx.lotSizeFor('SENSEX'), 20);
    lcSx.stop();

    // the day's list is dropped at midnight IST and once its nearest expiry has passed
    clock = Date.parse('2026-11-06T09:30:00+05:30');
    assert.strictEqual(lc.knownExpiries('NIFTY'), null);
    clock = now;
  }

  // ── the cache in front of the live chain ────────────────────────────
  const oc = require('../api/services/market/optionChain');
  assert.strictEqual(oc.sourceName(), 'upstox', 'one source: the Upstox live feed');

  let loads = 0, failNext = false;
  oc._setSource({
    name: 'upstox',
    knownExpiries: () => ['10-Nov-2026'],
    load: async (sym, exp) => {
      loads += 1;
      if (failNext) throw Object.assign(new Error('Upstox did not answer within 6000 ms'), { code: 'UPSTOX_TIMEOUT' });
      return { raw: toChainRaw(upstoxRows, { expiries: [EXP], asOfMs: Date.now(), quantityPerContract: LOT }), allExpiries: [EXP], targetExpiry: exp || EXP };
    }
  });
  const [a, b] = await Promise.all([oc.fetchRawOptionChain('NIFTY', null), oc.fetchRawOptionChain('NIFTY', null)]);
  assert.strictEqual(loads, 1, 'concurrent requests share one build');
  assert.strictEqual(a, b);
  assert.strictEqual(a.stale, false);
  await oc.fetchRawOptionChain('NIFTY', null);
  assert.strictEqual(loads, 1, 'served from the one-second cache');
  await assert.rejects(oc.fetchRawOptionChain('NIFTY', '17-Nov-2026'), e => e.code === 'BAD_EXPIRY');
  assert.strictEqual(loads, 1, 'unknown expiry refused without an upstream call');

  // a broken payload is not cached; a failed refresh serves the last copy flagged stale
  oc._setSource({ name: 'upstox', knownExpiries: () => null, load: async () => ({ raw: toChainRaw([]), allExpiries: [EXP], targetExpiry: EXP }) });
  await assert.rejects(oc.fetchRawOptionChain('NIFTY', null), /payload rejected/);
  const realNow = Date.now;
  oc._setSource({ name: 'upstox', knownExpiries: () => ['10-Nov-2026'], load: async () => { loads += 1; if (failNext) throw new Error('Upstox did not answer within 6000 ms'); return { raw: toChainRaw(upstoxRows, { expiries: [EXP], asOfMs: realNow(), quantityPerContract: LOT }), allExpiries: [EXP], targetExpiry: EXP }; } });
  await oc.fetchRawOptionChain('NIFTY', null);
  failNext = true;
  Date.now = () => realNow() + 6000;
  const stale = await oc.fetchRawOptionChain('NIFTY', null);
  Date.now = realNow;
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(oc.staleReasonCode(stale.staleReason), 'timeout');
  assert.strictEqual(oc.staleReasonCode('live feed is reconnecting'), 'feed_down');
  // unknown symbols are refused before the loader is called
  oc._setSource({ name: 'upstox', knownExpiries: () => null, load: async () => { throw new Error('should not be called'); } });
  await assert.rejects(oc.fetchRawOptionChain('BANKNIFTY', null), e => e.code === 'BAD_SYMBOL');
  let sxLoad = null;
  oc._setSource({ name: 'upstox', knownExpiries: () => null, load: async (sym, exp) => { sxLoad = sym; return { raw: toChainRaw(upstoxRows, { expiries: [EXP], asOfMs: Date.now(), quantityPerContract: LOT }), allExpiries: [EXP], targetExpiry: EXP }; } });
  await oc.fetchRawOptionChain('sensex', null);
  assert.strictEqual(sxLoad, 'SENSEX', 'symbol normalised before it reaches the loader and the cache key');
  oc._setSource(null);

  // ── index snapshot from the live feed ───────────────────────────────
  const mkt = require('../api/services/market/market');
  assert.deepStrictEqual(mkt.fromUpstoxQuote(mkt.tickToQuote({ ltp: 22770, cp: 22700, ohlc: { '1d': { open: 22710, high: 22800, low: 22650 } } })),
    { last: 22770, previousClose: 22700, open: 22710, high: 22800, low: 22650, percentChange: 0.31 });
  assert.strictEqual(mkt.fromUpstoxQuote({ last_price: 0 }), null);
  assert.strictEqual(mkt.fromUpstoxQuote(mkt.tickToQuote(null)), null);
  assert.strictEqual(mkt.fromUpstoxQuote(mkt.tickToQuote({ ltp: 10, cp: 0 })).percentChange, null, 'no previous close: no % change, not a fake 0');
  {
    const ISIN = n => `INE${String(n).padStart(8, '0')}0`;
    const lists = { 'NIFTY 50': [ISIN(1), ISIN(2), ISIN(3), ISIN(4)], 'NIFTY BANK': [ISIN(1), ISIN(2)] };
    const px = {
      'NSE_INDEX|Nifty 50': { ltp: 22770, cp: 22700, ohlc: { '1d': { open: 22705, high: 22800, low: 22680 } } },
      'NSE_INDEX|India VIX': { ltp: 13.2, cp: 13.8 }, 'BSE_INDEX|SENSEX': { ltp: 80400, cp: 80000 }, 'NSE_INDEX|Nifty Bank': { ltp: 50100, cp: 50000 },
      [`NSE_EQ|${ISIN(1)}`]: { ltp: 101, cp: 100 }, [`NSE_EQ|${ISIN(2)}`]: { ltp: 99, cp: 100 }, [`NSE_EQ|${ISIN(3)}`]: { ltp: 100, cp: 100 }, [`NSE_EQ|${ISIN(4)}`]: { ltp: 105, cp: 100 }
    };
    let status = 'connected';
    const subs = [];
    const feed = { subscribe: (keys, mode) => { subs.push(`${mode}:${keys.length}`); return () => {}; }, get: k => px[k] || null, on: () => () => {}, getState: () => ({ status, stale: status !== 'connected' }) };
    const snap = await mkt.loadIndicesLive({ feed, lists });
    assert.deepStrictEqual(subs, ['full:3', `ltpc:${mkt.SECTORS.length + 4}`], 'headline indices in full, sectors and stocks as last price');
    assert.strictEqual(snap.source, 'upstox');
    assert.strictEqual(snap.nifty.previousClose, 22700, 'previous close from the tick\'s cp');
    assert.strictEqual(snap.nifty.percentChange, 0.31);
    assert.deepStrictEqual([snap.nifty.open, snap.nifty.high, snap.nifty.low], [22705, 22800, 22680], 'day range from the feed\'s day candle');
    assert.strictEqual(snap.vix.percentChange, -4.35);
    assert.strictEqual(snap.sensex.percentChange, 0.5);
    assert.deepStrictEqual(snap.breadth, { advances: 2, declines: 1, unchanged: 1 });
    assert.strictEqual(snap.sectors.length, 1, 'sectors without a tick are left out');
    assert.deepStrictEqual(snap.sectors[0], { name: 'Bank', index: 'NIFTY BANK', last: 50100, percentChange: 0.2, advances: 1, declines: 1 });
    await mkt.loadIndicesLive({ feed, lists });
    assert.strictEqual(subs.length, 2, 'subscribed once');

    // breadth unknown without constituents; feed down or NIFTY missing is an error (the last snapshot is then served)
    const noLists = await mkt.loadIndicesLive({ feed, lists: {} });
    assert.strictEqual(noLists.breadth, null);
    assert.strictEqual(noLists.sectors[0].advances, null);
    status = 'reconnecting';
    await assert.rejects(mkt.loadIndicesLive({ feed, lists }), /live feed is reconnecting/);
    status = 'idle';
    await assert.rejects(mkt.loadIndicesLive({ feed, lists }), /not running/);
    status = 'connected';
    await assert.rejects(mkt.loadIndicesLive({ feed: { ...feed, get: k => (k === 'NSE_INDEX|Nifty 50' ? { ltp: 0 } : px[k] || null) }, lists }), /NIFTY 50 missing/);
    assert.strictEqual(mkt.countBreadth([], new Map()), null);
  }

  // ── constituent lists (a file in the repo, no download) ─────────────
  const cons = require('../api/services/providers/constituents');
  const consLists = cons.getConstituents();
  assert.strictEqual(consLists['NIFTY 50'].length, 50);
  assert.ok(mkt.SECTORS.every(([, index]) => Array.isArray(consLists[index]) && consLists[index].length >= 10), 'a list for every sector tile');
  assert.ok(Object.values(consLists).flat().every(isin => /^IN[A-Z0-9]{9}\d$/.test(isin)), 'ISIN codes only');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cons.asOf));

  // ── candles from Upstox ─────────────────────────────────────────────
  const uc = require('../api/services/providers/upstoxCandles');
  assert.deepStrictEqual(uc.parseRange('60d'), { sessions: 60, calendarDays: 95 });
  assert.deepStrictEqual(uc.parseRange('5y'), { sessions: null, calendarDays: 1830 });
  assert.throws(() => uc.parseRange('max'), /Unsupported range/);
  const rowsIn = [
    ['2026-11-05T09:20:00+05:30', 22710, 22730, 22700, 22725, 0, 0],
    ['2026-11-05T09:15:00+05:30', 22700, 22715, 22690, 22710, 12000, 0],
    ['2026-11-05T09:15:00+05:30', 22700, 22715, 22690, 22710, 12000, 0],   // duplicate
    ['2026-11-05T09:25:00+05:30', 22725, null, 22720, 22722, 0, 0],         // missing high: dropped
    'junk'
  ];
  const parsedC = uc.parseUpstoxCandles(rowsIn);
  assert.deepStrictEqual(parsedC.map(c => c.t), [Date.parse('2026-11-05T09:15:00+05:30'), Date.parse('2026-11-05T09:20:00+05:30')], 'sorted oldest first, de-duplicated');
  assert.deepStrictEqual(parsedC[0], { t: Date.parse('2026-11-05T09:15:00+05:30'), o: 22700, h: 22715, l: 22690, c: 22710, v: 12000 });
  assert.strictEqual(parsedC[1].v, null, 'index volume 0 means no volume');

  // windows: 60 sessions of 5m candles -> intraday + 4 history windows of <= 28 days, keyed path with the encoded instrument
  const paths = [];
  const nowC = Date.parse('2026-11-05T11:00:00+05:30');
  const dayRows = (ymd) => [[`${ymd}T09:15:00+05:30`, 1, 2, 1, 2, 5, 0], [`${ymd}T15:25:00+05:30`, 2, 3, 2, 3, 5, 0]];
  const histGet = async (path) => {
    paths.push(path);
    if (path.includes('/intraday/')) return { candles: dayRows('2026-11-05') };
    const [toDay, from] = path.split('/').slice(-2);
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += 86400000) {
      const d = new Date(t); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      out.push(...dayRows(d.toISOString().slice(0, 10)));
    }
    return { candles: out };
  };
  const c60 = await uc.fetchUpstoxCandles('NSE_INDEX|Nifty 50', '5m', '60d', { get: histGet, nowMs: nowC });
  assert.ok(paths[0].startsWith('/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/5'));
  assert.strictEqual(paths.length, 5, 'intraday + 4 windows for ~95 calendar days');
  for (const pth of paths.slice(1)) {
    const [toDay, from] = pth.split('/').slice(-2);
    assert.ok((Date.parse(toDay) - Date.parse(from)) / 86400000 <= 27, `window ${from}..${toDay} within a month`);
    assert.ok(toDay < '2026-11-05', 'history stops at yesterday; today comes from the intraday call');
  }
  assert.strictEqual(new Set(c60.map(c => new Date(c.t + 330 * 60000).toISOString().slice(0, 10))).size, 60, 'trimmed to 60 sessions');
  assert.strictEqual(new Date(c60[c60.length - 1].t + 330 * 60000).toISOString().slice(0, 10), '2026-11-05', 'today included');

  // daily: one history request; a failing intraday call (holiday, pre-open) is fine, an auth failure is not
  paths.length = 0;
  const d1 = await uc.fetchUpstoxCandles('NSE_INDEX|Nifty 50', '1d', '1y', { get: async p => { if (p.includes('intraday')) { paths.push(p); throw Object.assign(new Error('no data'), { code: 'UPSTOX_HTTP' }); } return histGet(p); }, nowMs: nowC });
  assert.strictEqual(paths.length, 2);
  assert.ok(paths[1].includes('/days/1/'));
  assert.ok(d1.length > 200);
  await assert.rejects(uc.fetchUpstoxCandles('X|Y', '5m', '5d', { get: async () => { throw Object.assign(new Error('expired'), { code: 'UPSTOX_AUTH' }); }, nowMs: nowC }), e => e.code === 'UPSTOX_AUTH');
  await assert.rejects(uc.fetchUpstoxCandles('X|Y', '2h', '5d', { get: histGet }), /Unsupported interval/);

  // the candle module names its series by Upstox instrument key
  const candlesMod = require('../api/services/market/candles');
  assert.deepStrictEqual(candlesMod.SYMBOLS, { index: 'NSE_INDEX|Nifty 50', etf: 'NSE_EQ|INF204KB14I2', vix: 'NSE_INDEX|India VIX' }, 'NIFTYBEES by ISIN');

  // ── holidays from Upstox ────────────────────────────────────────────
  const cal = require('../api/services/market/calendar');
  const hol = require('../api/services/market/holidays');
  const shut = (date, closed = ['NSE', 'NFO', 'BSE', 'BFO']) => ({ date, description: 'x', holiday_type: 'TRADING_HOLIDAY', closed_exchanges: closed, open_exchanges: [] });
  const upHolidays = [
    shut('2027-01-26'), shut('2027-03-22'), shut('2027-04-14'), shut('2027-05-01'), shut('2027-08-15'), shut('2027-10-02'),
    shut('2027-11-01', ['MCX']),                                                         // NFO open: not a holiday here
    { date: '2027-11-08', holiday_type: 'SETTLEMENT_HOLIDAY', closed_exchanges: ['NFO'] } // settlement only
  ];
  assert.strictEqual(cal.setHolidaysFromUpstox(upHolidays), 6);
  assert.ok(cal.isHoliday('2027-01-26') && !cal.isHoliday('2027-11-01') && !cal.isHoliday('2027-11-08'));
  assert.ok(cal.isHoliday('2026-10-20'), 'other years already known are kept');
  assert.strictEqual(cal.snapshot().source, 'upstox');
  assert.strictEqual(cal.setHolidaysFromUpstox([shut('2027-01-26')]), 0, 'a tiny list is ignored');
  assert.strictEqual(cal.setHolidaysFromUpstox({}), 0);
  cal.setHolidays(cal.FALLBACK_HOLIDAYS);

  hol._reset();
  let holCalls = 0;
  const holGet = async p => { holCalls += 1; assert.strictEqual(p, '/v2/market/holidays'); return upHolidays; };
  assert.strictEqual((await hol.refreshHolidays({ get: holGet })).source, 'upstox');
  await hol.refreshHolidays({ get: holGet });
  assert.strictEqual(holCalls, 1, 'once a day');
  cal.setHolidays(cal.FALLBACK_HOLIDAYS);
  const errLog = console.error; console.error = () => {};
  const kept = await hol.refreshHolidays({ force: true, get: async () => { throw new Error('down'); } });
  console.error = errLog;
  assert.ok(kept.holidays.includes('2026-11-10'), 'a failed refresh keeps the list in memory');
  hol._reset();

  // ── routes: ?symbol= ────────────────────────────────────────────────
  {
    const http = require('http');
    const app = require('../api/index');
    const server = await new Promise(r => { const sv = http.createServer(app).listen(0, () => r(sv)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const getJson = async path => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
    const seen = [];
    oc._setSource({
      name: 'upstox',
      knownExpiries: () => null,
      load: async (sym) => {
        seen.push(sym);
        return sym === 'SENSEX'
          ? { raw: toChainRaw(sxRowsA, { expiries: [SXEXP], asOfMs: Date.now(), quantityPerContract: 20 }), allExpiries: [SXEXP], targetExpiry: SXEXP }
          : { raw: toChainRaw(upstoxRows, { expiries: [EXP], asOfMs: Date.now(), quantityPerContract: LOT }), allExpiries: [EXP], targetExpiry: EXP };
      }
    });
    const sxRes = await getJson('/option-chain?symbol=sensex');
    assert.strictEqual(sxRes.status, 200, JSON.stringify(sxRes.body).slice(0, 200));
    assert.strictEqual(sxRes.body.data.symbol, 'SENSEX');
    assert.strictEqual(sxRes.body.data.strikeStep, 100);
    assert.strictEqual(sxRes.body.data.feed.source, 'upstox');
    const nfRes = await getJson('/option-chain');
    assert.strictEqual(nfRes.body.data.symbol, 'NIFTY', 'NIFTY stays the default');
    assert.deepStrictEqual(seen, ['SENSEX', 'NIFTY']);
    for (const path of ['/option-chain?symbol=banknifty', '/intraday?expiry=12-Nov-2026&symbol=x', '/expiry-replay?symbol=%3Cb%3E', '/similar-sessions?symbol=nifty50', '/strike-history?expiry=12-Nov-2026&strike=80000&symbol=']) {
      const r = await getJson(path);
      assert.strictEqual(r.status, 400, `${path} -> ${r.status}`);
      assert.ok(!/<b>/.test(JSON.stringify(r.body)), 'input never echoed');
    }
    assert.strictEqual((await getJson('/intraday?expiry=12-Nov-2026&symbol=SENSEX')).status, 200);
    // feed down with nothing cached for a symbol: a plain 502, no upstream detail
    oc._setSource({ name: 'upstox', knownExpiries: () => null, load: async () => { throw Object.assign(new Error('live feed is reconnecting'), { code: 'STREAM_DOWN' }); } });
    const errLog2 = console.error; console.error = () => {};
    const down = await getJson('/option-chain?symbol=SENSEX');
    console.error = errLog2;
    assert.strictEqual(down.status, 502);
    assert.ok(!/reconnecting|STREAM/.test(JSON.stringify(down.body)));
    oc._setSource(null);
    await new Promise(r => server.close(r));
  }

  // ── browser: index choice and URLs ──────────────────────────────────
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../public/js/api-client.js'), 'utf8');
    const ac = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
    assert.strictEqual(ac.SYMBOL, 'NIFTY', 'NIFTY without a choice');
    assert.strictEqual(ac.readSymbol('?index=sensex', null), 'SENSEX');
    assert.strictEqual(ac.readSymbol('', 'SENSEX'), 'SENSEX', 'remembered choice');
    assert.strictEqual(ac.readSymbol('?index=nifty', 'SENSEX'), 'NIFTY', 'the address wins over the saved choice');
    assert.strictEqual(ac.readSymbol('?index=<script>', null), 'NIFTY', 'anything else falls back to NIFTY');
    assert.strictEqual(ac.withSymbol('/api/option-chain', 'NIFTY'), '/api/option-chain', 'NIFTY URLs unchanged');
    assert.strictEqual(ac.withSymbol('/api/option-chain', 'SENSEX'), '/api/option-chain?symbol=SENSEX');
    assert.strictEqual(ac.withSymbol('/api/intraday?expiry=12-Nov-2026', 'SENSEX'), '/api/intraday?expiry=12-Nov-2026&symbol=SENSEX');
  }

  console.log('upstox checks passed');
})().catch(e => { console.error(e); process.exit(1); });
