// Strategy format and backtester: validation, the option model, no look-ahead, entry and exit rules, the baseline, the
// saved-strategy service and the backtest endpoints. Synthetic candles only; no network.
const assert = require('assert');
const http = require('http');
const fetch = require('node-fetch');
const { validateStrategy, PRESETS } = require('./services/strategy');
const B = require('./services/strategyBacktest');
const { createStrategyService } = require('./services/paperStrategies');
const calendar = require('./services/calendar');

const IST = 330 * 60 * 1000;
const DAY = 24 * 3600 * 1000;

/** `n` trading sessions of 5m candles from 2026-08-03, with a deterministic walk. shape(day, k) can override a candle. */
function makeCandles(n, { drift = 0, wiggle = 6, shape = null } = {}) {
  const out = [];
  let price = 25000, seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  let d = Date.UTC(2026, 7, 3);
  for (let s = 0; s < n; d += DAY) {
    const ymd = new Date(d).toISOString().slice(0, 10);
    if (!calendar.isTradingDayYmd(ymd)) continue;
    for (let k = 0; k < 75; k++) {
      const t = d - IST + (9 * 60 + 15 + 5 * k) * 60000;
      const o = price;
      const c = o + drift + rnd() * wiggle;
      let candle = { t, o, h: Math.max(o, c) + 2, l: Math.min(o, c) - 2, c, v: 1000 };
      if (shape) candle = shape(s, k, candle) || candle;
      out.push(candle);
      price = candle.c;
    }
    s += 1;
  }
  return out;
}
const vixFor = (candles, level = 14) => candles.map(c => ({ t: c.t, c: level }));
const valid = s => { const v = validateStrategy(s); assert(v.ok, JSON.stringify(v.error)); return v.value; };
const base = over => ({
  name: 't', interval: '5m',
  entry: { window: { from: '09:30', to: '14:00' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [] },
  legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' }],
  exits: { stopLoss: null, target: null, exitAt: '15:15', indexMovePts: null },
  ...over
});

(async () => {
  // ── validation ──
  for (const p of PRESETS) valid(p);
  const err = s => validateStrategy(s).error && validateStrategy(s).error.message;
  assert(/exitAt/.test(err(base({ exits: { exitAt: '09:00' } }))), 'exit before the window');
  assert(/exitAt/.test(err(base({ exits: { exitAt: '15:29' } }))), 'nothing after 15:25');
  assert(/Unknown condition/.test(err(base({ entry: { window: { from: '09:30', to: '10:00' }, conditions: [{ type: 'pcr', op: 'above', value: 1 }] } }))));
  assert(/gap/.test(err(base({ entry: { window: { from: '09:30', to: '10:00' }, conditions: [{ type: 'gap', op: 'above', pct: 50 }] } }))));
  assert(/legs/.test(err(base({ legs: [] }))));
  assert(/legs/.test(err(base({ legs: Array(5).fill(base().legs[0]) }))));
  assert(/strikeOffset/.test(err(base({ legs: [{ ...base().legs[0], strikeOffset: 1.5 }] }))));
  assert(/window/.test(err(base({ entry: { window: { from: '14:00', to: '10:00' } } }))));
  assert.deepStrictEqual(valid(base({ entry: { window: { from: '09:30', to: '10:00' }, weekdays: [3, 1, 1] } })).entry.weekdays, [1, 3]);

  // ── option model ──
  {
    const S = 25000, K = 25000, T = 5 / 365, sig = 0.14;
    const parity = B.bsPrice('CE', S, K, T, sig) - B.bsPrice('PE', S, K, T, sig) - (S - K * Math.exp(-0.06 * T));
    assert(Math.abs(parity) < 0.5, 'near put-call parity (the intrinsic floor only bites deep in the money)');
    assert(B.sigmaFor('PE', 24500, 25000, 14) > B.sigmaFor('PE', 25000, 25000, 14), 'OTM puts carry more vol');
    assert(B.sigmaFor('CE', 25500, 25000, 14) < B.sigmaFor('CE', 25000, 25000, 14), 'OTM calls a little less');
    const t0 = Date.UTC(2026, 9, 26, 3, 50); // Mon 09:20 IST
    const exp = B.weeklyExpiries(t0, t0).find(x => x > t0);
    const leg = { optionType: 'CE', strike: 25000, expiryMs: exp, t0, T0: (exp - t0) / (365 * DAY), tradingMin0: calendar.tradingMinutesBetween(t0, exp) };
    assert.strictEqual(B.effectiveT(leg, t0), leg.T0);
    assert(B.effectiveT(leg, t0 + 355 * 60000) < leg.T0 * 0.6, 'a day before expiry, a session uses up roughly half the remaining variance');
    assert.strictEqual(B.effectiveT(leg, exp), 0);
    const straddle = t => B.modelPrice(leg, 25000, t, 14) + B.modelPrice({ ...leg, optionType: 'PE' }, 25000, t, 14);
    assert(straddle(t0 + 355 * 60000) < straddle(t0) * 0.8, 'an unchanged market still decays the straddle through the day');
  }

  // ── expiries ──
  {
    const tue = B.weeklyExpiries(Date.UTC(2026, 9, 26), Date.UTC(2026, 9, 26)).map(ms => new Date(ms + IST).toISOString().slice(0, 16));
    assert(tue.includes('2026-10-27T15:30'), 'Tuesday 27 Oct, 15:30 IST');
    const nov = B.weeklyExpiries(Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 9)).map(ms => new Date(ms + IST).toISOString().slice(0, 10));
    assert(nov.includes('2026-11-09') && !nov.includes('2026-11-10'), 'Tuesday 10 Nov is a holiday: the expiry moves to Monday 9 Nov');
  }

  // ── no look-ahead: context at candle i is the same whether or not later candles exist ──
  {
    const candles = makeCandles(6);
    const full = B.prepare(candles, vixFor(candles), '5m');
    for (const i of [40, 120, 200, 300]) {
      const cut = B.prepare(candles.slice(0, i + 1), vixFor(candles.slice(0, i + 1)), '5m');
      const pick = x => ({ vwap: x.vwap, orb: x.orb, minsIn: x.minsIn, vix: x.vix, open: x.session.open, prev: x.session.prev && x.session.prev.close });
      assert.deepStrictEqual(pick(cut.ctx[i]), pick(full.ctx[i]), `candle ${i} context uses no later data`);
    }
  }

  // ── entries and exits ──
  {
    const candles = makeCandles(8);
    const data = { candles, vix: vixFor(candles) };
    // no conditions: one trade a day, entering at the first candle of the window, closed at exitAt
    let r = B.runBacktest(valid(base()), data);
    assert.strictEqual(r.trades, 8);
    for (const t of r.tradeList) {
      const inMin = new Date(t.entryT + IST).toISOString().slice(11, 16), outMin = new Date(t.exitT + IST).toISOString().slice(11, 16);
      assert.strictEqual(inMin, '09:30');
      assert.strictEqual(outMin, '15:15');
      assert.strictEqual(t.reason, 'time');
      assert.strictEqual(new Date(t.entryT + IST).toISOString().slice(0, 10), new Date(t.exitT + IST).toISOString().slice(0, 10), 'never overnight');
    }
    assert.strictEqual(r.verdict, 'insufficient');
    assert.strictEqual(r.baseline, null, 'no conditions, no baseline');
    // entry is the OPEN of the candle after the condition: a dayMove condition met on the 10:00 candle enters at 10:05
    const jump = makeCandles(3, { wiggle: 0, shape: (s, k, c) => (k === 9 ? { ...c, c: c.o + 200, h: c.o + 202 } : null) });
    r = B.runBacktest(valid(base({ entry: { window: { from: '09:20', to: '14:00' }, maxTradesPerDay: 1, conditions: [{ type: 'dayMove', op: 'above', pct: 0.5 }] } })), { candles: jump, vix: vixFor(jump) });
    assert.strictEqual(new Date(r.tradeList[0].entryT + IST).toISOString().slice(11, 16), '10:05');
    assert.strictEqual(r.tradeList[0].entryIndex, jump.find(c => c.t === r.tradeList[0].entryT).o);
    // a candle that reaches both the stop and the target is a stop
    const wild = makeCandles(2, { wiggle: 0, shape: (s, k, c) => (k === 5 ? { ...c, h: c.o + 400, l: c.o - 400 } : null) });
    r = B.runBacktest(valid(base({ entry: { window: { from: '09:20', to: '09:20' } }, exits: { stopLoss: { unit: 'pct', value: 20 }, target: { unit: 'pct', value: 20 }, exitAt: '15:15', indexMovePts: null } })), { candles: wild, vix: vixFor(wild) });
    assert.strictEqual(r.tradeList[0].reason, 'stop', 'ambiguous candle counts against us');
    // index-move exit
    r = B.runBacktest(valid(base({ entry: { window: { from: '09:20', to: '09:20' } }, exits: { stopLoss: null, target: null, exitAt: '15:15', indexMovePts: 100 } })), { candles: wild, vix: vixFor(wild) });
    assert.strictEqual(r.tradeList[0].reason, 'index');
    // short premium in a flat market earns the decay; the same trade long loses it
    const flat = makeCandles(3, { wiggle: 0 });
    const shortStraddle = base({ entry: { window: { from: '09:20', to: '09:20' } }, legs: [{ side: 'SELL', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' }, { side: 'SELL', optionType: 'PE', strikeOffset: 0, lots: 1, expiry: 'weekly' }] });
    const sr = B.runBacktest(valid(shortStraddle), { candles: flat, vix: vixFor(flat) });
    assert(sr.tradeList.every(t => t.gross > 0), 'decay pays the seller when nothing moves');
    const longStraddle = { ...shortStraddle, legs: shortStraddle.legs.map(l => ({ ...l, side: 'BUY' })) };
    assert(B.runBacktest(valid(longStraddle), { candles: flat, vix: vixFor(flat) }).tradeList.every(t => t.net < 0));
    assert(sr.capitalNeeded > 100000 && !sr.fitsCapital, 'a naked short straddle needs more than 1 lakh');
    // charges are counted per leg on both sides
    assert(sr.tradeList[0].charges > 4 * 20, 'four fills, at least the brokerage on each');
    // the baseline is reproducible
    const cond = valid(base({ entry: { window: { from: '09:30', to: '14:00' }, maxTradesPerDay: 2, conditions: [{ type: 'vwap', position: 'above' }] } }));
    const a = B.runBacktest(cond, data), b = B.runBacktest(cond, data);
    assert(a.baseline && a.baseline.runs > 0);
    assert.deepStrictEqual(a.baseline, b.baseline, 'seeded random entries');
    assert(a.tradeList.every((t, i, arr) => i === 0 || t.entryT >= arr[i - 1].exitT), 'one position at a time');
  }

  // ── saved strategies and the endpoints ──
  const m = new Map();
  const store = {
    get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, String(v)); return 'OK'; }, del: async k => (m.delete(k) ? 1 : 0),
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, String(v)), true)),
    incr: async k => { const n = Number(m.get(k) || 0) + 1; m.set(k, String(n)); return n; },
    hset: async (k, f, v) => { const h = m.get(k) || {}; h[f] = String(v); m.set(k, h); return 1; },
    hgetall: async k => ({ ...(m.get(k) || {}) }), hdel: async (k, f) => { const h = m.get(k) || {}; delete h[f]; return 1; }
  };
  const candles = makeCandles(10);
  let loads = 0;
  const strategies = createStrategyService({ store, loadData: async () => { loads += 1; return { candles, vix: vixFor(candles), fetchedAt: 1 }; } });
  const row = await strategies.save(PRESETS[1]);
  assert(/^opening-range-breakout-[0-9a-f]{4}$/.test(row.id));
  await assert.rejects(strategies.save({ ...PRESETS[1], interval: '1d' }), e => e.code === 'BAD_STRATEGY');
  const upd = await strategies.save({ ...PRESETS[1], name: 'ORB v2' }, row.id);
  assert.deepStrictEqual([upd.id, upd.strategy.name, (await strategies.list()).length], [row.id, 'ORB v2', 1]);
  await assert.rejects(strategies.save(PRESETS[1], 'nope-0000'), e => e.code === 'NOT_FOUND');
  const rep1 = await strategies.backtest(PRESETS[0]);
  const rep2 = await strategies.backtest(PRESETS[0]);
  assert(!rep1.cached && rep2.cached, 'same strategy on the same data comes from the cache');
  await strategies.remove(row.id);
  assert.strictEqual((await strategies.list()).length, 0);

  // HTTP: owner backtest and save, agent backtest with its own quota
  const app = require('./index');
  const paperRouter = require('./routes/paper');
  const { createService, AGENT } = require('./services/paperAccounts');
  const { formatNseDate } = require('./services/nse');
  const EXPS = [3, 10, 17, 24, 31].map(dd => formatNseDate(Date.now() + dd * DAY));
  paperRouter.setService(createService({ store, isMarketOpen: () => false, loadRaw: async () => ({ raw: { records: { timestamp: null, data: [] } }, allExpiries: EXPS, targetExpiry: EXPS[0], stale: false }), loadSettle: async () => null }));
  paperRouter.setStrategyService(strategies);
  const server = await new Promise(res => { const s = http.createServer(app).listen(0, () => res(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { VERCEL: process.env.VERCEL, PAPER_SECRET: process.env.PAPER_SECRET };
  delete process.env.VERCEL;
  process.env.PAPER_SECRET = 'owner-secret-for-tests';
  const call = async (p, method = 'GET', body, auth = 'Bearer owner-secret-for-tests') => {
    const r = await fetch(url + p, { method, headers: { Authorization: auth, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  try {
    await call('/api/paper/accounts');
    let r = await call('/api/paper/strategies');
    assert.strictEqual(r.json.presets.length, PRESETS.length);
    r = await call('/api/paper/backtest', 'POST', { strategy: PRESETS[2], accountId: 'main' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.report.capital, 100000, 'capital comes from the account');
    assert.strictEqual((await call('/api/paper/backtest', 'POST', { strategy: { name: 'x' } })).status, 400);
    r = await call('/api/paper/strategies', 'POST', { strategy: PRESETS[0] });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await call(`/api/paper/strategies/${r.json.saved.id}`, 'PUT', { strategy: { ...PRESETS[0], name: 'Fly 2' } })).json.saved.strategy.name, 'Fly 2');
    assert.strictEqual((await call(`/api/paper/strategies/${r.json.saved.id}`, 'DELETE')).status, 200);
    assert.strictEqual((await call('/api/paper/strategies/BAD!', 'DELETE')).status, 400);

    const key = await call('/api/paper/accounts/main/keys', 'POST', { label: 'Reader', scope: 'read' });
    const agent = `Bearer ${key.json.token}`;
    assert.strictEqual((await call('/api/paper/v1/strategies/presets', 'GET', undefined, agent)).json.presets.length, PRESETS.length);
    assert(/backtest/.test(JSON.stringify((await call('/api/paper/v1', 'GET', undefined, agent)).json.endpoints)));
    let limited = null;
    for (let i = 0; i < AGENT.backtestsPerMinute + 1; i++) {
      const x = await call('/api/paper/v1/backtest', 'POST', { strategy: PRESETS[0] }, agent);
      if (x.status === 429) limited = x; else assert.strictEqual(x.status, 200, 'read-only keys may backtest');
    }
    assert(limited && limited.json.code === 'RATE_LIMITED', 'backtests have their own per-minute quota');
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.close();
  }
  console.log('strategy and backtest OK (format, option model, expiries, no look-ahead, exits, baseline, saved strategies, endpoints)');
})().catch(e => { console.error(e); process.exit(1); });
