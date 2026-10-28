// Paper trading: engine rules (fills, charges, margin, brackets, expiry) and the account service with a fake store and feed.
const assert = require('assert');
const E = require('./services/paperEngine');
const { tradeCharges, exerciseCharges } = require('./services/paperCosts');
const { createService } = require('./services/paperAccounts');

const IST = 330 * 60 * 1000;
const at = (d, h, m) => Date.UTC(2026, 10, d, h, m) - IST; // November 2026, IST wall clock
const T0 = at(2, 10, 0);                                    // Monday 2 Nov 2026, 10:00 IST
const EXP = '03-Nov-2026';
const EXPIRIES = ['03-Nov-2026', '17-Nov-2026', '24-Nov-2026', '01-Dec-2026', '29-Dec-2026'];
const LOT = E.DEFAULTS.lotSize;
const K = (strike, type, expiry = EXP) => `NIFTY|${expiry}|${strike}|${type}`;
const nseTs = ms => {
  const d = new Date(ms + IST);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

/** NSE-shaped payload. legs: { 'strike|CE': { ltp, bid, ask } } */
function raw(asOfMs, spot, legs, expiry = EXP) {
  const byStrike = new Map();
  for (const [k, v] of Object.entries(legs)) {
    const [strike, type] = k.split('|');
    const row = byStrike.get(strike) || { expiryDate: expiry, strikePrice: Number(strike) };
    row[type] = { lastPrice: v.ltp || 0, bidprice: v.bid || 0, askPrice: v.ask || 0, impliedVolatility: 12, openInterest: 1000 };
    byStrike.set(strike, row);
  }
  return { records: { timestamp: nseTs(asOfMs), underlyingValue: spot, expiryDates: EXPIRIES, data: [...byStrike.values()] } };
}
const book = (asOfMs, spot, legs, expiry) => E.buildBook(raw(asOfMs, spot, legs, expiry), expiry || EXP);
const LEGS = {
  '25000|CE': { ltp: 100, bid: 99.5, ask: 100.5 },
  '25000|PE': { ltp: 90, bid: 89.5, ask: 90.5 },
  '24900|PE': { ltp: 55, bid: 54.5, ask: 55.5 },
  '25200|CE': { ltp: 20, bid: 0, ask: 0 }
};
const ctx = (b, nowMs = T0, extra = {}) => ({ book: b, nowMs, marketOpen: true, allowedExpiries: EXPIRIES.slice(0, 4), ...extra });
const fresh = (cap = 100000) => E.newAccount({ id: 'main', nowMs: T0 - 3600e3, startingCapital: cap });
const identity = (state, b) => {
  const s = E.summarize(state, b);
  const expect = s.startingCapital + s.realized + s.unrealized - s.charges;
  assert(Math.abs(s.equity - expect) < 0.02, `equity ${s.equity} = start + realized + unrealized - charges (${expect})`);
  return s;
};

// ── charges ──
{
  const buy = tradeCharges('BUY', 100, 65);
  assert.strictEqual(buy.stt, 0, 'no STT on buying an option');
  assert.strictEqual(buy.brokerage, 20);
  assert(buy.stamp > 0);
  const sell = tradeCharges('SELL', 100, 65);
  assert.strictEqual(sell.stt, 9.75, '0.15% of 6500 premium');
  assert.strictEqual(sell.stamp, 0, 'stamp duty is buy side only');
  for (const c of [buy, sell]) assert(Math.abs(c.total - (c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst)) < 0.011);
  assert.strictEqual(exerciseCharges(120, 65).total, 11.7, '0.15% of intrinsic value');
}

// ── instruments and expiries ──
{
  assert.deepStrictEqual(E.parseInstrument(K(25000, 'CE')), { key: K(25000, 'CE'), expiry: EXP, strike: 25000, optionType: 'CE' });
  assert.strictEqual(E.parseInstrument('NIFTY|03-Nov-2026|25000|XX'), null);
  assert.strictEqual(E.parseInstrument('BANKNIFTY|03-Nov-2026|25000|CE'), null);
  assert.strictEqual(E.expiryCloseMs(EXP), at(3, 15, 30));
  assert.deepStrictEqual(E.tradableExpiries(EXPIRIES, T0), EXPIRIES.slice(0, 4), 'nearest four');
  assert.deepStrictEqual(E.tradableExpiries(EXPIRIES, at(3, 15, 31)), EXPIRIES.slice(1, 5), 'an expiry drops out at its close');
  assert.strictEqual(E.toTick(101.01, 1), 101.05);
  assert.strictEqual(E.toTick(98.99, -1), 98.95);
}

// ── market orders ──
{
  const b = book(T0 - 20e3, 25010, LEGS);
  const s0 = fresh();
  const before = JSON.stringify(s0);
  const r = E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1 }, s0, ctx(b));
  assert(r.ok, JSON.stringify(r.error));
  assert.strictEqual(JSON.stringify(s0), before, 'input state is never changed');
  assert.strictEqual(r.trade.price, 100.5, 'a market buy pays the ask');
  assert.strictEqual(r.order.status, 'FILLED');
  const c = tradeCharges('BUY', 100.5, LOT).total;
  assert.strictEqual(r.state.cash, Math.round((100000 - 100.5 * LOT - c) * 100) / 100);
  const s = identity(r.state, b);
  assert.strictEqual(s.unrealized, Math.round((100 - 100.5) * LOT * 100) / 100, 'marked at LTP');

  // empty book: LTP plus 1% slippage, rounded up to the tick
  const e = E.placeOrder({ instrument: K(25200, 'CE'), side: 'BUY', lots: 1 }, fresh(), ctx(b));
  assert.strictEqual(e.trade.price, 20.2);

  // selling back closes the position at the bid and books the loss
  const out = E.placeOrder({ instrument: K(25000, 'CE'), side: 'SELL', lots: 1 }, r.state, ctx(b));
  assert.strictEqual(out.trade.price, 99.5);
  assert.strictEqual(Object.keys(out.state.positions).length, 0);
  assert.strictEqual(out.state.realized, -65, '(99.5 - 100.5) x 65');
  identity(out.state, b);
}

// ── rejections ──
{
  const b = book(T0 - 20e3, 25010, LEGS);
  const code = (input, c, st = fresh()) => E.placeOrder(input, st, c).error?.code;
  const buy = { instrument: K(25000, 'CE'), side: 'BUY', lots: 1 };
  assert.strictEqual(code(buy, ctx(b, T0, { marketOpen: false })), 'MARKET_CLOSED');
  assert.strictEqual(code(buy, ctx({ ...b, stale: true })), 'DATA_STALE');
  assert.strictEqual(code(buy, ctx(b, T0 + 5 * 60e3)), 'DATA_OLD', 'a five-minute-old snapshot is not tradable');
  assert.strictEqual(code({ ...buy, instrument: K(25000, 'CE', '29-Dec-2026') }, ctx(b)), 'EXPIRY_NOT_ALLOWED');
  assert.strictEqual(code({ ...buy, instrument: K(26000, 'CE') }, ctx(b)), 'NO_QUOTE');
  assert.strictEqual(code({ ...buy, lots: 0 }, ctx(b)), 'BAD_LOTS');
  assert.strictEqual(code({ ...buy, lots: 1.5 }, ctx(b)), 'BAD_LOTS');
  assert.strictEqual(code({ ...buy, orderType: 'LIMIT', limitPrice: 100.03 }, ctx(b)), 'BAD_PRICE', 'off the 0.05 grid');
  assert.strictEqual(code({ ...buy, source: 'agent' }, ctx(b)), 'REASON_REQUIRED');
  assert(E.placeOrder({ ...buy, source: 'agent', reason: 'testing' }, fresh(), ctx(b)).ok);
  assert.strictEqual(code({ ...buy, orderType: 'SL-M', triggerPrice: 95 }, ctx(b)), 'TRIGGER_CROSSED', 'buy stop below LTP');
  assert.strictEqual(code({ ...buy, lots: 20 }, ctx(b)), 'INSUFFICIENT_FUNDS', '20 lots x 100 is more than 1 lakh');
  assert.strictEqual(code({ instrument: K(25000, 'PE'), side: 'SELL', lots: 1 }, ctx(b)), 'INSUFFICIENT_FUNDS', 'a naked short lot needs more than 1 lakh of margin');
}

// ── margin: a spread needs only its bounded loss ──
{
  const b = book(T0 - 20e3, 25010, LEGS);
  let r = E.placeOrder({ instrument: K(24900, 'PE'), side: 'BUY', lots: 1 }, fresh(), ctx(b));
  r = E.placeOrder({ instrument: K(25000, 'PE'), side: 'SELL', lots: 1 }, r.state, ctx(b));
  assert(r.ok, `bull put spread is affordable: ${JSON.stringify(r.error)}`);
  assert.strictEqual(E.marginFor(r.state.positions, 25010), 100 * LOT, 'margin = strike width x quantity');
  const naked = E.marginFor({ [K(25000, 'PE')]: { expiry: EXP, strike: 25000, optionType: 'PE', qty: -LOT } }, 25000);
  assert.strictEqual(naked, Math.round(0.09 * 25000 * LOT * 100) / 100, 'ATM naked short: 9% of spot per unit');
  const farOtm = E.marginFor({ [K(22000, 'PE')]: { expiry: EXP, strike: 22000, optionType: 'PE', qty: -LOT } }, 25000);
  assert.strictEqual(farOtm, Math.round(0.035 * 25000 * LOT * 100) / 100, 'never below the floor');
  const ratio = E.marginFor({
    a: { expiry: EXP, strike: 25000, optionType: 'CE', qty: LOT },
    b: { expiry: EXP, strike: 25100, optionType: 'CE', qty: -2 * LOT }
  }, 25000);
  assert(ratio > 0 && ratio === Math.round(2 * LOT * (0.09 * 25000 - 0.5 * 100) * 100) / 100, 'net short calls: unbounded, full naked margin');
  identity(r.state, b);
}

// ── limit orders rest and fill only on a later snapshot ──
{
  const b0 = book(T0 - 20e3, 25010, LEGS);
  let r = E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 95 }, fresh(), ctx(b0));
  assert(r.ok && r.trade === null && r.order.status === 'OPEN', 'below the ask: rests');
  let s = r.state;
  // the same snapshot moving cannot fill it
  const same = { ...b0, quotes: { ...b0.quotes, [K(25000, 'CE')]: { ...b0.quotes[K(25000, 'CE')], ask: 94 } } };
  assert.strictEqual(E.matchOrders(s, same, T0 + 1000, { marketOpen: true }).trades.length, 0, 'no fill against the placement snapshot');
  // later snapshot: ask still above, LTP printed at the limit (not through it): no fill
  let m = E.matchOrders(s, book(T0 + 40e3, 25000, { '25000|CE': { ltp: 95, bid: 94.5, ask: 95.5 } }), T0 + 60e3, { marketOpen: true });
  assert.strictEqual(m.trades.length, 0, 'touching the limit is not a fill');
  // later snapshot: trade printed below the limit -> filled at the limit, not the better print
  m = E.matchOrders(s, book(T0 + 100e3, 24990, { '25000|CE': { ltp: 94.5, bid: 94.5, ask: 96 } }), T0 + 120e3, { marketOpen: true });
  assert.strictEqual(m.trades.length, 1);
  assert.strictEqual(m.trades[0].price, 95);
  // and with the ask through the limit -> filled at the ask
  m = E.matchOrders(s, book(T0 + 100e3, 24980, { '25000|CE': { ltp: 94, bid: 93.5, ask: 94.5 } }), T0 + 120e3, { marketOpen: true });
  assert.strictEqual(m.trades[0].price, 94.5);
  // nothing fills while the market is closed or the data is stale
  assert.strictEqual(E.matchOrders(s, book(T0 + 100e3, 24980, { '25000|CE': { ltp: 94, bid: 93.5, ask: 94.5 } }), T0 + 120e3, { marketOpen: false }).trades.length, 0);
  // a marketable limit fills at once, at the ask (price improvement)
  r = E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 102 }, fresh(), ctx(b0));
  assert.strictEqual(r.trade.price, 100.5);
  // day orders expire after the close
  const ex = E.expireOrders(s, at(2, 15, 31));
  assert.strictEqual(ex.state.orders[0].status, 'EXPIRED');
  assert.strictEqual(E.expireOrders(s, at(2, 15, 0)).changed, false);
}

// ── stop loss and bracket (OCO) ──
{
  const b0 = book(T0 - 20e3, 25010, LEGS);
  let r = E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1, bracket: { target: 120, stop: 90 } }, fresh(), ctx(b0));
  assert(r.ok, JSON.stringify(r.error));
  const kids = r.state.orders.filter(o => o.parentId === r.order.id);
  assert.deepStrictEqual(kids.map(o => [o.orderType, o.side, o.reduceOnly]), [['LIMIT', 'SELL', true], ['SL-M', 'SELL', true]]);
  // price drops through the stop: SL-M triggers and fills at the bid, the target is cancelled
  const m = E.matchOrders(r.state, book(T0 + 60e3, 24950, { '25000|CE': { ltp: 89, bid: 88.5, ask: 89.5 } }), T0 + 70e3, { marketOpen: true });
  assert.strictEqual(m.trades.length, 1);
  assert.strictEqual(m.trades[0].price, 88.5);
  const after = m.state.orders.filter(o => o.parentId === r.order.id);
  assert.deepStrictEqual(after.map(o => o.status), ['CANCELLED', 'FILLED']);
  assert.strictEqual(Object.keys(m.state.positions).length, 0);

  // closing the position by hand cancels the bracket exits instead of letting them open a reverse position
  const closed = E.placeOrder({ instrument: K(25000, 'CE'), side: 'SELL', lots: 1 }, r.state, ctx(b0));
  assert.deepStrictEqual(closed.state.orders.filter(o => o.parentId === r.order.id).map(o => o.statusReason), ['NOTHING_TO_CLOSE', 'NOTHING_TO_CLOSE']);
  // bracket on the wrong side is refused
  assert.strictEqual(E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1, bracket: { stop: 110 } }, fresh(), ctx(b0)).error.code, 'BAD_BRACKET');
  // cancel
  const rest = E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 90 }, fresh(), ctx(b0));
  const c = E.cancelOrder(rest.order.id, rest.state, T0 + 1);
  assert.strictEqual(c.order.status, 'CANCELLED');
  assert.strictEqual(E.cancelOrder(rest.order.id, c.state, T0 + 2).error.code, 'NOT_OPEN');
}

// ── flipping through zero and expiry settlement ──
{
  const b = book(T0 - 20e3, 25010, LEGS);
  let s = fresh(1000000);
  s = E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1 }, s, ctx(b)).state;
  s = E.placeOrder({ instrument: K(25000, 'CE'), side: 'SELL', lots: 2 }, s, ctx(b)).state;
  const pos = s.positions[K(25000, 'CE')];
  assert.strictEqual(pos.qty, -LOT, 'sold through zero: now short one lot');
  assert.strictEqual(pos.avgPrice, 99.5, 'the short opens at the fill price');
  assert.strictEqual(s.realized, -65);
  s = E.placeOrder({ instrument: K(24900, 'PE'), side: 'BUY', lots: 1 }, s, ctx(b)).state;
  identity(s, b);

  // settle at 25120: short 25000 CE pays 120, long 24900 PE expires worthless
  const st = E.settleExpiry(s, EXP, 25120, at(3, 15, 45));
  assert.strictEqual(Object.keys(st.state.positions).length, 0);
  const ce = st.trades.find(t => t.instrument === K(25000, 'CE'));
  assert.deepStrictEqual([ce.side, ce.price, ce.charges], ['BUY', 120, 0], 'short pays intrinsic, no exercise STT on the short side');
  assert.strictEqual(st.trades.find(t => t.instrument === K(24900, 'PE')).price, 0);
  identity(st.state, null);
  assert.strictEqual(E.settleExpiry(st.state, EXP, 25120, at(3, 15, 46)).changed, false, 'settling twice does nothing');

  // a long ITM option pays exercise STT
  let l = E.placeOrder({ instrument: K(25000, 'CE'), side: 'BUY', lots: 1 }, fresh(), ctx(b)).state;
  const lt = E.settleExpiry(l, EXP, 25100, at(3, 15, 45)).trades[0];
  assert.strictEqual(lt.charges, exerciseCharges(100, LOT).total);
}

// ── service: fake store and feed ──
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
    _map: m
  };
}

(async () => {
  const store = fakeStore();
  let clock = T0;
  let feed = raw(T0 - 20e3, 25010, LEGS);
  let settleCalls = 0;
  const svc = createService({
    store,
    now: () => clock,
    isMarketOpen: ms => ms >= at(2, 9, 15) && ms <= at(2, 15, 30) || ms >= at(3, 9, 15) && ms <= at(3, 15, 30),
    loadRaw: async e => ({ raw: feed, allExpiries: EXPIRIES, targetExpiry: e || EXP, stale: false }),
    loadSettle: async () => { settleCalls += 1; return 24800; }
  });

  await assert.rejects(svc.createAccount({ id: 'Bad Id' }), /lowercase/);
  await assert.rejects(svc.createAccount({ id: 'x', startingCapital: 5 }), /between/);
  await svc.createAccount({ id: 'main', name: 'Me' });
  await assert.rejects(svc.createAccount({ id: 'main' }), /taken/);
  assert.strictEqual((await svc.listAccounts())[0].active, false);

  // resting limit, filled by a later tick
  let r = await svc.placeOrder('main', { instrument: K(25000, 'PE'), side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 85 });
  assert(r.ok && r.order.status === 'OPEN');
  assert.strictEqual(store._map.has('pt:lock:main'), false, 'lock released');
  assert.strictEqual((await svc.listAccounts())[0].active, true);
  clock = T0 + 60e3;
  feed = raw(T0 + 50e3, 25060, { ...LEGS, '25000|PE': { ltp: 84, bid: 83.5, ask: 84.5 } });
  let t = await svc.tick();
  assert.deepStrictEqual([t.accounts, t.fills], [1, 1]);
  let { summary } = await svc.getSummary('main');
  assert.strictEqual(summary.positions.length, 1);
  assert.strictEqual(summary.positions[0].avgPrice, 84.5);
  assert.strictEqual(summary.positions[0].mark, 84);

  // errors come back as results and the stored account is unchanged: selling 5 lots closes 1 and opens 4 naked shorts
  const storedBefore = store._map.get('pt:acct:main');
  const bad = await svc.placeOrder('main', { instrument: K(25000, 'PE'), side: 'SELL', lots: 5 });
  assert.strictEqual(bad.error.code, 'INSUFFICIENT_FUNDS');
  assert.strictEqual(store._map.get('pt:acct:main'), storedBefore);
  await assert.rejects(svc.placeOrder('nobody', { instrument: K(25000, 'PE'), side: 'BUY', lots: 1 }), /No such paper account/);

  // a lock held elsewhere makes the call fail as BUSY rather than overwrite
  store._map.set('pt:lock:main', 'someone-else');
  await assert.rejects(svc.cancelOrder('main', 'O1'), e => e.code === 'BUSY');
  store._map.delete('pt:lock:main');

  // after the close: the day's equity point is written once, and a quiet account is not rewritten every minute
  clock = at(2, 15, 35);
  t = await svc.tick();
  let state = JSON.parse(store._map.get('pt:acct:main'));
  assert.deepStrictEqual(state.curve.map(p => p.ymd), ['2026-11-02']);
  const written = store._map.get('pt:acct:main');
  clock = at(2, 15, 36);
  await svc.tick();
  assert.strictEqual(store._map.get('pt:acct:main'), written, 'nothing changed, nothing written');

  // expiry: not settled before 15:45 on expiry day, settled once after, at one shared price
  clock = at(3, 15, 40);
  feed = raw(at(3, 15, 30), 24800, LEGS, '17-Nov-2026');
  t = await svc.tick();
  assert.strictEqual(t.settled, 0);
  clock = at(3, 15, 46);
  t = await svc.tick();
  assert.strictEqual(t.settled, 1);
  state = JSON.parse(store._map.get('pt:acct:main'));
  assert.strictEqual(Object.keys(state.positions).length, 0);
  const settle = state.trades[state.trades.length - 1];
  assert.deepStrictEqual([settle.kind, settle.price], ['settlement', 200], '25000 PE at 24800 is worth 200');
  assert.strictEqual(store._map.get('pt:settle:03-Nov-2026'), '24800');
  assert.strictEqual(settleCalls, 1);
  assert.strictEqual((await svc.listAccounts())[0].active, false, 'flat account is skipped by the tick');
  t = await svc.tick();
  assert.strictEqual(t.accounts, 0);

  // reset keeps the name and capital, wipes the rest; delete removes it
  const reset = await svc.resetAccount('main');
  assert.deepStrictEqual([reset.name, reset.cash, reset.trades.length], ['Me', 100000, 0]);
  await svc.deleteAccount('main');
  assert.deepStrictEqual(await svc.listAccounts(), []);

  console.log('paper trading OK (charges, fills, limits, stops, brackets, margin, settlement, service)');
})().catch(e => { console.error(e); process.exit(1); });
