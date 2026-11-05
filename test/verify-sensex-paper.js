// SENSEX paper trading: instruments, lot size 20, 100-point strikes, orders, fills, settlement, the account service, the
// owner and agent market endpoints, backtests and live strategies. Fake store, feeds and candles only; no network.
// NIFTY accounts (including ones stored before SENSEX existed, with no symbol) must behave exactly as before.
const assert = require('assert');
const E = require('../api/services/paperEngine');
const { createService } = require('../api/services/paperAccounts');
const { validateStrategy, strikeStepFor } = require('../api/services/strategy');
const B = require('../api/services/strategyBacktest');
const L = require('../api/services/strategyLive');
const C = require('../api/services/market/candles');
const upstoxCandles = require('../api/services/providers/upstoxCandles');
const optionChain = require('../api/services/market/optionChain');
const calendar = require('../api/services/market/calendar');

const IST = 330 * 60 * 1000;
const at = (d, h, m, s = 0) => Date.UTC(2026, 10, d, h, m, s) - IST; // November 2026, IST wall clock
const T0 = at(2, 10, 0);                                               // Monday 2 Nov 2026, 10:00 IST
const SX_EXPIRIES = ['05-Nov-2026', '12-Nov-2026', '19-Nov-2026', '26-Nov-2026', '03-Dec-2026']; // Thursdays
const NF_EXPIRIES = ['03-Nov-2026', '10-Nov-2026', '17-Nov-2026', '24-Nov-2026', '01-Dec-2026']; // Tuesdays
const SX = (strike, type, expiry = SX_EXPIRIES[0]) => `SENSEX|${expiry}|${strike}|${type}`;
const NF = (strike, type, expiry = NF_EXPIRIES[0]) => `NIFTY|${expiry}|${strike}|${type}`;
const nseTs = ms => {
  const d = new Date(ms + IST);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

/** An option chain in the shape fetchRawOptionChain returns: strikes `step` apart around `atm`, CE `ceAtm` at the money. */
function chain(asOfMs, spot, { expiry, expiries, atm, step, ceAtm = 300 }) {
  const data = [];
  for (let k = atm - 5 * step; k <= atm + 5 * step; k += step) {
    const ce = k === atm ? ceAtm : Math.max(5, atm - k + ceAtm);
    const pe = Math.max(5, k - atm + ceAtm - 20);
    data.push({
      expiryDate: expiry, strikePrice: k,
      CE: { lastPrice: ce, bidprice: ce - 0.5, askPrice: ce + 0.5, impliedVolatility: 12, openInterest: 1000 },
      PE: { lastPrice: pe, bidprice: pe - 0.5, askPrice: pe + 0.5, impliedVolatility: 13, openInterest: 1000 }
    });
  }
  return { records: { timestamp: nseTs(asOfMs), underlyingValue: spot, expiryDates: expiries, data } };
}
const sxChain = (asOfMs, spot = 82040, opts = {}) => chain(asOfMs, spot, { expiry: SX_EXPIRIES[0], expiries: SX_EXPIRIES, atm: 82000, step: 100, ...opts });
const nfChain = (asOfMs, spot = 25010, opts = {}) => chain(asOfMs, spot, { expiry: NF_EXPIRIES[0], expiries: NF_EXPIRIES, atm: 25000, step: 50, ceAtm: 100, ...opts });

function fakeStore() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, String(v)); return 'OK'; },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, String(v)), true)),
    del: async k => (m.delete(k) ? 1 : 0),
    hset: async (k, f, v) => { const h = m.get(k) || {}; h[f] = String(v); m.set(k, h); return 1; },
    hgetall: async k => ({ ...(m.get(k) || {}) }),
    hdel: async (k, f) => { const h = m.get(k) || {}; delete h[f]; return 1; },
    incr: async k => { const n = Number(m.get(k) || 0) + 1; m.set(k, String(n)); return n; },
    _map: m
  };
}

(async () => {
  // ── engine: instruments and config ──
  {
    assert.deepStrictEqual(E.parseInstrument(SX(82000, 'CE')), { key: SX(82000, 'CE'), symbol: 'SENSEX', expiry: '05-Nov-2026', strike: 82000, optionType: 'CE' });
    assert.strictEqual(E.parseInstrument(NF(25000, 'PE')).symbol, 'NIFTY');
    assert.strictEqual(E.parseInstrument('BANKEX|05-Nov-2026|60000|CE'), null);
    assert.strictEqual(E.instrumentKey({ symbol: 'SENSEX', expiry: '05-Nov-2026', strike: 82100, optionType: 'PE' }), SX(82100, 'PE'));
    assert.strictEqual(E.instrumentKey({ expiry: '03-Nov-2026', strike: 25000, optionType: 'CE' }), NF(25000, 'CE'), 'NIFTY is the default prefix');
    assert.strictEqual(E.configFor('NIFTY'), E.DEFAULTS, 'NIFTY keeps the original config object');
    assert.strictEqual(E.DEFAULTS.lotSize, 65);
    const sxCfg = E.configFor('SENSEX');
    assert.deepStrictEqual([sxCfg.symbol, sxCfg.lotSize, sxCfg.tick, sxCfg.maxExpiries], ['SENSEX', 20, 0.05, 4]);
    assert.strictEqual(E.configFor('SENSEX', E.DEFAULTS, 25).lotSize, 25, 'a live lot size from Upstox wins');
    assert.throws(() => E.configFor('BANKNIFTY'), e => e.code === 'BAD_SYMBOL');
    assert.strictEqual(strikeStepFor('SENSEX'), 100);
    assert.strictEqual(strikeStepFor('NIFTY'), 50);
  }

  // ── engine: orders on a SENSEX account ──
  {
    const cfg = E.configFor('SENSEX');
    const book = E.buildBook(sxChain(T0 - 20e3), SX_EXPIRIES[0], { symbol: 'SENSEX' });
    assert.strictEqual(book.symbol, 'SENSEX');
    assert(book.quotes[SX(82000, 'CE')] && book.quotes[SX(82100, 'CE')], 'quotes keyed SENSEX|..., 100 points apart');
    assert(!book.quotes[SX(82050, 'CE')]);
    const acct = E.newAccount({ id: 'sx', nowMs: T0 - 3600e3, symbol: 'SENSEX' });
    assert.strictEqual(acct.symbol, 'SENSEX');
    const ctx = { book, nowMs: T0, marketOpen: true, allowedExpiries: SX_EXPIRIES.slice(0, 4), cfg };

    const r = E.placeOrder({ instrument: SX(82000, 'CE'), side: 'BUY', lots: 2 }, acct, ctx);
    assert(r.ok, JSON.stringify(r.error));
    assert.deepStrictEqual([r.order.qty, r.order.lotSize, r.trade.price, r.trade.qty], [40, 20, 300.5, 40], '2 lots of 20 at the ask');
    const s = E.summarize(r.state, book, cfg);
    assert.deepStrictEqual([s.symbol, s.lotSize, s.spot], ['SENSEX', 20, 82040]);
    assert(Math.abs(s.equity - (s.startingCapital + s.realized + s.unrealized - s.charges)) < 0.02);

    // the other index's instruments and books are refused
    const wrong = E.placeOrder({ instrument: NF(25000, 'CE'), side: 'BUY', lots: 1 }, acct, ctx);
    assert.deepStrictEqual([wrong.ok, wrong.error.code], [false, 'WRONG_INDEX']);
    assert.strictEqual(wrong.state, acct, 'state unchanged');
    assert(/SENSEX\|/.test(E.placeOrder({ instrument: 'junk', side: 'BUY', lots: 1 }, acct, ctx).error.message), 'the error example matches the index');
    const niftyBook = E.buildBook(nfChain(T0 - 20e3), NF_EXPIRIES[0]);
    assert.strictEqual(E.bookHealth(niftyBook, T0, { marketOpen: true, cfg }).reason, 'NO_DATA', 'a NIFTY book is no use to a SENSEX account');
    const nifty = E.newAccount({ id: 'n', nowMs: T0 - 3600e3 });
    const nr = E.placeOrder({ instrument: SX(82000, 'CE'), side: 'BUY', lots: 1 }, nifty, { ...ctx, cfg: E.DEFAULTS });
    assert.strictEqual(nr.error.code, 'WRONG_INDEX', 'a NIFTY account cannot buy SENSEX');

    // a resting limit fills on a later snapshot, then the position settles at intrinsic value
    const lim = E.placeOrder({ instrument: SX(82100, 'PE'), side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 365 }, r.state, ctx);
    assert(lim.ok && !lim.trade, 'rests below the ask');
    const later = E.buildBook(sxChain(T0 + 50e3, 82000, { ceAtm: 280 }), SX_EXPIRIES[0], { symbol: 'SENSEX' });
    const m = E.matchOrders(lim.state, later, T0 + 60e3, { marketOpen: true, cfg });
    assert.strictEqual(m.trades.length, 1);
    assert.deepStrictEqual([m.trades[0].qty, m.trades[0].price], [20, 360.5]);
    const st = E.settleExpiry(m.state, SX_EXPIRIES[0], 82300, E.expiryCloseMs(SX_EXPIRIES[0]) + 20 * 60000, { cfg });
    assert.strictEqual(st.trades.length, 2);
    const ce = st.trades.find(t => t.instrument === SX(82000, 'CE'));
    const pe = st.trades.find(t => t.instrument === SX(82100, 'PE'));
    assert.deepStrictEqual([ce.kind, ce.price, ce.qty, pe.price], ['settlement', 300, 40, 0], '82000 CE at 82300 is worth 300; 82100 PE expires worthless');
    assert.strictEqual(Object.keys(st.state.positions).length, 0);

    // brackets size their exits by the SENSEX lot
    const br = E.placeOrder({ instrument: SX(82000, 'CE'), side: 'BUY', lots: 3, bracket: { target: 400, stop: 250 } }, acct, ctx);
    const exits = br.state.orders.filter(o => o.parentId === br.order.id);
    assert.deepStrictEqual(exits.map(o => [o.qty, o.lots, o.lotSize]), [[60, 3, 20], [60, 3, 20]]);

    // a NIFTY account stored before SENSEX existed (no symbol field) still summarises as NIFTY at lot 65
    const legacy = E.newAccount({ id: 'old', nowMs: T0 });
    delete legacy.symbol;
    const ls = E.summarize(legacy, null);
    assert.deepStrictEqual([ls.symbol, ls.lotSize], ['NIFTY', 65]);
  }

  // ── account service: NIFTY and SENSEX accounts side by side ──
  const store = fakeStore();
  let clock = T0;
  let feeds = { NIFTY: nfChain(T0 - 20e3), SENSEX: sxChain(T0 - 20e3) };
  const rawCalls = [];
  const settleCalls = [];
  const svc = createService({
    store,
    now: () => clock,
    isMarketOpen: ms => (ms >= at(2, 9, 15) && ms <= at(2, 15, 30)) || (ms >= at(5, 9, 15) && ms <= at(5, 15, 30)),
    loadRaw: async (e, symbol = 'NIFTY') => {
      rawCalls.push(symbol);
      const expiries = symbol === 'SENSEX' ? SX_EXPIRIES : NF_EXPIRIES;
      return { raw: feeds[symbol], allExpiries: expiries, targetExpiry: e || expiries[0], stale: false };
    },
    loadSettle: async (expiry, symbol) => { settleCalls.push(`${symbol}:${expiry}`); return symbol === 'SENSEX' ? 82300 : 25100; },
    lotSizeFor: sym => (sym === 'SENSEX' ? 20 : null)
  });

  await assert.rejects(svc.createAccount({ id: 'x', symbol: 'BANKNIFTY' }), e => e.code === 'BAD_SYMBOL');
  await svc.createAccount({ id: 'sx', name: 'Sensex', symbol: 'SENSEX' });
  await svc.createAccount({ id: 'nf', name: 'Nifty' });
  // an account saved before SENSEX: no symbol in the state or in the index row
  const legacy = E.newAccount({ id: 'legacy', name: 'Old', nowMs: T0 - 86400e3 });
  delete legacy.symbol;
  await store.set('pt:acct:legacy', JSON.stringify(legacy));
  await store.hset('pt:index', 'legacy', JSON.stringify({ id: 'legacy', name: 'Old', kind: 'human', createdAt: legacy.createdAt, active: false }));

  const listed = Object.fromEntries((await svc.listAccounts()).map(a => [a.id, a.symbol]));
  assert.deepStrictEqual(listed, { sx: 'SENSEX', nf: 'NIFTY', legacy: undefined }, 'the index row names the index (legacy rows have none until saved)');
  assert.strictEqual(await svc.accountSymbol('legacy'), 'NIFTY');
  assert.strictEqual(await svc.accountSymbol('sx'), 'SENSEX');

  // the order ticket market for SENSEX
  const mkt = await svc.market(null, { symbol: 'SENSEX' });
  assert.deepStrictEqual([mkt.symbol, mkt.lotSize, mkt.expiry, mkt.spot, mkt.atmStrike], ['SENSEX', 20, '05-Nov-2026', 82040, 82000]);
  assert.deepStrictEqual(mkt.expiries, SX_EXPIRIES.slice(0, 4));
  assert(mkt.strikes.every((s, i, a) => i === 0 || s.strike - a[i - 1].strike === 100), '100-point strikes');
  assert.strictEqual(mkt.health.ok, true);
  const nmkt = await svc.market(null);
  assert.deepStrictEqual([nmkt.symbol, nmkt.lotSize, nmkt.atmStrike], ['NIFTY', 65, 25000], 'NIFTY by default, unchanged');
  await assert.rejects(svc.market(null, { symbol: 'FINNIFTY' }), e => e.code === 'BAD_SYMBOL');

  // preview and place on SENSEX
  const pv = await svc.previewOrder('sx', { instrument: SX(82000, 'CE'), side: 'BUY', lots: 1 });
  assert(pv.ok && pv.fill.qty === 20 && pv.fill.price === 300.5, JSON.stringify(pv));
  const pvWrong = await svc.previewOrder('sx', { instrument: NF(25000, 'CE'), side: 'BUY', lots: 1 });
  assert.strictEqual(pvWrong.error.code, 'WRONG_INDEX');
  let r = await svc.placeOrder('sx', { instrument: SX(82000, 'CE'), side: 'BUY', lots: 1 });
  assert(r.ok && r.trade.qty === 20, JSON.stringify(r.error));
  r = await svc.placeOrder('sx', { instrument: SX(82100, 'PE'), side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 365 });
  assert(r.ok && r.order.status === 'OPEN');
  r = await svc.placeOrder('sx', { instrument: NF(25000, 'CE'), side: 'BUY', lots: 1 });
  assert.strictEqual(r.error.code, 'WRONG_INDEX');
  // NIFTY accounts, new and legacy, still trade NIFTY at 65 a lot
  r = await svc.placeOrder('nf', { instrument: NF(25000, 'CE'), side: 'BUY', lots: 1 });
  assert(r.ok && r.trade.qty === 65 && r.trade.price === 100.5, JSON.stringify(r.error));
  r = await svc.placeOrder('legacy', { instrument: NF(25000, 'PE'), side: 'BUY', lots: 1 });
  assert(r.ok && r.trade.qty === 65, JSON.stringify(r.error));
  r = await svc.placeOrder('legacy', { instrument: SX(82000, 'CE'), side: 'BUY', lots: 1 });
  assert.strictEqual(r.error.code, 'WRONG_INDEX', 'a legacy account is a NIFTY account');
  const legacyState = JSON.parse(store._map.get('pt:acct:legacy'));
  assert.strictEqual(legacyState.symbol, undefined, 'trading does not rewrite the stored shape of a legacy account');
  assert.strictEqual(Object.keys(legacyState.positions)[0], NF(25000, 'PE'), 'NIFTY instrument keys unchanged');

  const { summary } = await svc.getSummary('sx');
  assert.deepStrictEqual([summary.symbol, summary.lotSize, summary.spot, summary.positions.length], ['SENSEX', 20, 82040, 1]);

  // the tick loads each index's own chain and fills the resting SENSEX limit on a newer snapshot
  clock = T0 + 60e3;
  feeds = { NIFTY: nfChain(T0 + 50e3), SENSEX: sxChain(T0 + 50e3, 82000, { ceAtm: 280 }) };
  rawCalls.length = 0;
  let t = await svc.tick();
  assert.deepStrictEqual([t.accounts, t.fills, t.dataOk], [3, 1, true]);
  assert(rawCalls.includes('SENSEX') && rawCalls.includes('NIFTY'), 'one book per index');
  const sxState = JSON.parse(store._map.get('pt:acct:sx'));
  assert.deepStrictEqual(Object.keys(sxState.positions).sort(), [SX(82000, 'CE'), SX(82100, 'PE')]);

  // SENSEX expiry (Thursday 5 Nov): settles after 15:45 at the SENSEX close, under its own storage key; NIFTY untouched
  clock = at(5, 15, 46);
  feeds = { NIFTY: nfChain(at(5, 15, 30), 25100, { expiry: NF_EXPIRIES[1] }), SENSEX: sxChain(at(5, 15, 30), 82300, { expiry: SX_EXPIRIES[1] }) };
  t = await svc.tick();
  assert.strictEqual(t.settled, 2 + 2, 'two SENSEX legs, plus the two NIFTY 03-Nov legs whose expiry has also passed');
  assert.strictEqual(store._map.get('pt:settle:SENSEX:05-Nov-2026'), '82300');
  assert.strictEqual(store._map.get('pt:settle:03-Nov-2026'), '25100', 'NIFTY keeps its original key');
  assert(settleCalls.includes('SENSEX:05-Nov-2026') && settleCalls.includes('NIFTY:03-Nov-2026'));
  assert(!store._map.has('pt:settle:05-Nov-2026'), 'no SENSEX price under a NIFTY key');
  const settled = JSON.parse(store._map.get('pt:acct:sx'));
  const ceSettle = settled.trades.find(x => x.kind === 'settlement' && x.instrument === SX(82000, 'CE'));
  assert.deepStrictEqual([ceSettle.price, ceSettle.qty], [300, 20]);
  assert.strictEqual(Object.keys(settled.positions).length, 0);
  assert.deepStrictEqual(settled.settlements.map(x => [x.expiry, x.spot]), [['05-Nov-2026', 82300]]);

  // reset keeps the index
  const reset = await svc.resetAccount('sx');
  assert.deepStrictEqual([reset.symbol, reset.cash, reset.trades.length], ['SENSEX', 100000, 0]);

  // ── strategies and backtests ──
  {
    const base = over => ({
      name: 'sx', interval: '5m',
      entry: { window: { from: '09:30', to: '14:00' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [] },
      legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 1, lots: 2, expiry: 'weekly' }],
      exits: { stopLoss: null, target: null, exitAt: '15:15', indexMovePts: null },
      ...over
    });
    assert.strictEqual(validateStrategy(base()).value.symbol, 'NIFTY', 'NIFTY by default');
    assert.strictEqual(validateStrategy(base({ symbol: 'SENSEX' })).value.symbol, 'SENSEX');
    assert(/symbol/.test(validateStrategy(base({ symbol: 'BANKNIFTY' })).error.message));
    assert(/100 points each/.test(validateStrategy(base({ symbol: 'SENSEX', legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 30, lots: 1 }] })).error.message));

    // SENSEX weekly expiries are Thursdays (Wednesday when Thursday is a holiday)
    const exp = B.weeklyExpiries(at(2, 9, 15), at(20, 15, 30), 'SENSEX');
    assert(exp.length >= 3);
    for (const ms of exp) {
      const ymd = new Date(ms + IST).toISOString().slice(0, 10);
      assert(calendar.isTradingDayYmd(ymd));
      assert([3, 4].includes(new Date(ms + IST).getUTCDay()), `${ymd} is a Thursday (or the Wednesday before)`);
    }
    assert(B.weeklyExpiries(at(2, 9, 15), at(20, 15, 30)).every(ms => [1, 2].includes(new Date(ms + IST).getUTCDay())), 'NIFTY still Tuesdays');

    // synthetic SENSEX candles: 20 sessions of 5m bars around 82000
    const candles = [];
    let price = 82000, seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let d = Date.UTC(2026, 8, 1), n = 0; n < 20; d += 86400e3) {
      if (!calendar.isTradingDayYmd(new Date(d).toISOString().slice(0, 10))) continue;
      for (let k = 0; k < 75; k++) {
        const t0 = d - IST + (9 * 60 + 15 + 5 * k) * 60000;
        const o = price, c = o + rnd() * 30;
        candles.push({ t: t0, o, h: Math.max(o, c) + 8, l: Math.min(o, c) - 8, c, v: null });
        price = c;
      }
      n += 1;
    }
    const rep = B.runBacktest(validateStrategy(base({ symbol: 'SENSEX' })).value, { candles, vix: candles.map(c => ({ t: c.t, c: 13 })) }, { capital: 100000, baselineRuns: 5 });
    assert(rep.trades > 0);
    assert.deepStrictEqual([rep.data.symbol, rep.data.lotSize], ['SENSEX', 20]);
    for (const tr of rep.tradeList) {
      const leg = tr.legs[0];
      assert.strictEqual(leg.strike % 100, 0, 'strikes on the 100-point grid');
      assert.strictEqual(leg.strike, Math.round(tr.entryIndex / 100) * 100 + 100, 'strikeOffset 1 = one 100-point strike above ATM');
      assert.strictEqual(leg.qty, 40, '2 lots of 20');
    }
    assert(rep.assumptions.some(a => /Thursdays/.test(a)));

    // the strategy service loads the strategy's own index's data
    const { createStrategyService } = require('../api/services/paperStrategies');
    const asked = [];
    const strategies = createStrategyService({ store: fakeStore(), loadData: async (interval, symbol) => { asked.push(symbol); return { candles, vix: candles.map(c => ({ t: c.t, c: 13 })), fetchedAt: 1 }; } });
    await strategies.backtest(base({ symbol: 'SENSEX' }));
    await strategies.backtest(base());
    assert.deepStrictEqual(asked, ['SENSEX', 'NIFTY']);
  }

  // ── live strategies on a SENSEX account ──
  {
    const lstore = fakeStore();
    let lclock = at(2, 10, 2, 30);
    const accounts = createService({
      store: lstore, now: () => lclock, isMarketOpen: () => true,
      loadRaw: async (e, symbol = 'NIFTY') => {
        const expiries = symbol === 'SENSEX' ? SX_EXPIRIES : NF_EXPIRIES;
        const raw = symbol === 'SENSEX' ? sxChain(lclock - 10e3, 82040, { expiry: e || expiries[0] }) : nfChain(lclock - 10e3, 25010, { expiry: e || expiries[0] });
        return { raw, allExpiries: expiries, targetExpiry: e || expiries[0], stale: false };
      },
      loadSettle: async () => null,
      lotSizeFor: () => 20
    });
    const liveAsked = [];
    const loadLive = async (interval, symbol) => {
      liveAsked.push(symbol);
      const c = [];
      for (let k = 0; k < 9; k++) c.push({ t: at(2, 9, 15) + k * 5 * 60000, o: 82000, h: 82050, l: 81950, c: 82020, v: null });
      return { candles: c, vix: c.map(x => ({ t: x.t, c: 13 })), stale: false };
    };
    const live = L.createLiveService({ store: lstore, accounts, loadLive, now: () => lclock });
    await accounts.createAccount({ id: 'sxs', name: 'Sensex strategy', symbol: 'SENSEX' });
    await accounts.createAccount({ id: 'nfs', name: 'Nifty strategy' });
    const strat = validateStrategy({
      name: 'SX live', symbol: 'SENSEX', interval: '5m',
      entry: { window: { from: '09:30', to: '14:00' }, conditions: [] },
      legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1 }],
      exits: { stopLoss: null, target: null, exitAt: '15:15', indexMovePts: null }
    }).value;
    await assert.rejects(live.deploy({ strategy: strat, accountId: 'nfs' }), e => e.code === 'WRONG_INDEX');
    const niftyStrat = { ...strat, symbol: 'NIFTY' };
    await assert.rejects(live.deploy({ strategy: niftyStrat, accountId: 'sxs' }), e => e.code === 'WRONG_INDEX');

    const legs = L.legOrders(strat, 82040, SX_EXPIRIES.slice(0, 4));
    assert.deepStrictEqual(legs[0], { instrument: SX(82000, 'CE'), side: 'BUY', lots: 1, optionType: 'CE', strike: 82000, expiry: '05-Nov-2026' });
    assert.strictEqual(L.legOrders({ ...strat, symbol: undefined }, 25010, NF_EXPIRIES)[0].instrument, NF(25000, 'CE'), 'NIFTY legs unchanged');

    const d = await live.deploy({ strategy: strat, accountId: 'sxs' });
    const res = await live.tick();
    assert.deepStrictEqual([res.deployments, res.entered], [1, 1]);
    assert.deepStrictEqual(liveAsked, ['SENSEX']);
    const dep = await live.get(d.id);
    assert.deepStrictEqual([dep.open.legs[0].instrument, dep.open.legs[0].qty, dep.open.legs[0].entry], [SX(82000, 'CE'), 20, 300.5]);
    assert(dep.log.some(x => /at SENSEX 82040/.test(x.text)));
    lclock = at(2, 15, 16);
    const ex = await live.tick();
    assert.strictEqual(ex.exited, 1, 'closed at the exit time');
    assert.strictEqual((await live.get(d.id)).trades[0].legs[0].exit, 299.5);
  }

  // ── candles: SENSEX series ──
  {
    const realSource = optionChain.sourceName();
    optionChain._setSource(optionChain.SOURCES.nse); // NSE as the chain source means Yahoo candles
    C.clearCache();
    const urls = [];
    const mk = n => ({ chart: { result: [{ timestamp: Array.from({ length: n }, (_, i) => (at(2, 9, 15) + i * 300e3) / 1000), indicators: { quote: [{ open: Array(n).fill(82000), high: Array(n).fill(82100), low: Array(n).fill(81900), close: Array(n).fill(82050), volume: Array(n).fill(0) }] } }] } });
    const fetchImpl = async url => { urls.push(decodeURIComponent(url)); return { json: async () => mk(60) }; };
    const data = await C.getBacktestData('5m', { symbol: 'SENSEX', fetchImpl });
    assert.strictEqual(data.candles.length, 60);
    assert(urls.some(u => u.includes('^BSESN')), 'SENSEX index from Yahoo');
    assert(urls.some(u => u.includes('^INDIAVIX')), 'India VIX for volatility');
    assert(!urls.some(u => u.includes('^NSEI') || u.includes('NIFTYBEES')), 'no NIFTY series');
    urls.length = 0;
    await C.getBacktestData('5m', { fetchImpl });
    assert(urls.some(u => u.includes('^NSEI')), 'NIFTY has its own cache entry');
    assert.throws(() => C.seriesFor('BANKNIFTY'), e => e.code === 'BAD_SYMBOL');

    // on Upstox, SENSEX candles come from BSE_INDEX|SENSEX
    const realFetch = upstoxCandles.fetchUpstoxCandles;
    const keys = [];
    upstoxCandles.fetchUpstoxCandles = async key => { keys.push(key); return [{ t: at(2, 9, 15), o: 1, h: 1, l: 1, c: 1, v: null }]; };
    optionChain._setSource({ name: 'upstox', load: async () => { throw new Error('unused'); }, knownExpiries: () => [] });
    C.clearCache();
    await C.getCandles('1d', { symbol: 'SENSEX' });
    assert.deepStrictEqual(keys, ['BSE_INDEX|SENSEX']);
    upstoxCandles.fetchUpstoxCandles = realFetch;
    optionChain._setSource(realSource === 'upstox' ? optionChain.SOURCES.upstox : optionChain.SOURCES.nse);
    C.clearCache();
  }

  console.log('SENSEX paper trading OK (instruments, lot 20, 100-point strikes, orders, settlement, service, backtest, live, candles)');
})().catch(e => { console.error(e); process.exit(1); });
