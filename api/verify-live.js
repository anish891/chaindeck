// Live strategies, analytics and CSV export: the decision rules, a full deploy -> enter -> stop out cycle on a fake
// market, undoing a half-filled entry, attribution of fills, CSV escaping and the endpoints. No network.
const assert = require('assert');
const http = require('http');
const fetch = require('node-fetch');
const L = require('./services/strategyLive');
const A = require('./services/paperAnalytics');
const { validateStrategy } = require('./services/strategy');
const { createService } = require('./services/paperAccounts');
const E = require('./services/paperEngine');

const IST = 330 * 60 * 1000;
const at = (d, h, m, s = 0) => Date.UTC(2026, 10, d, h, m, s) - IST; // November 2026, IST wall clock
const EXPIRIES = ['03-Nov-2026', '17-Nov-2026', '24-Nov-2026', '01-Dec-2026', '29-Dec-2026'];
const LOT = E.DEFAULTS.lotSize;
const nseTs = ms => {
  const d = new Date(ms + IST);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

/** 5m candles: the previous session (Fri 30 Oct) and today from 09:15 up to (not including) `untilMs`. */
function candlesUntil(untilMs, price = 25000) {
  const out = [];
  for (const [y, mo, d] of [[2026, 9, 30], [2026, 10, 2]]) {
    for (let k = 0; k < 75; k++) {
      const t = Date.UTC(y, mo, d, 9, 15 + 5 * k) - IST;
      if (t >= untilMs) break;
      out.push({ t, o: price, h: price + 5, l: price - 5, c: price, v: 1000 });
    }
  }
  return out;
}

function fakeStore() {
  const m = new Map();
  return {
    m,
    get: async k => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, String(v)); return 'OK'; },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, String(v)), true)),
    del: async k => (m.delete(k) ? 1 : 0),
    incr: async k => { const n = Number(m.get(k) || 0) + 1; m.set(k, String(n)); return n; },
    hset: async (k, f, v) => { const h = m.get(k) || {}; h[f] = String(v); m.set(k, h); return 1; },
    hgetall: async k => ({ ...(m.get(k) || {}) }),
    hdel: async (k, f) => { const h = m.get(k) || {}; delete h[f]; return 1; }
  };
}

const strategy = over => validateStrategy({
  name: 'Live test', interval: '5m',
  entry: { window: { from: '09:30', to: '14:00' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [] },
  legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' }],
  exits: { stopLoss: { unit: 'pct', value: 30 }, target: { unit: 'pct', value: 60 }, exitAt: '15:15', indexMovePts: null },
  ...over
}).value;

(async () => {
  // ── pure decisions ──
  {
    const s = strategy();
    const now = at(2, 10, 2, 30);
    const c = candlesUntil(at(2, 10, 5)); // includes the 10:00 candle, still forming at 10:02:30
    assert.strictEqual(L.closedCandles(c, '5m', now).slice(-1)[0].t, at(2, 9, 55), 'the forming candle is ignored');
    const vix = c.map(x => ({ t: x.t, c: 14 }));
    let sig = L.entryDue(s, c, vix, now);
    assert(sig.due && sig.candleT === at(2, 9, 55), JSON.stringify(sig));
    assert.strictEqual(L.entryDue(s, c, vix, at(2, 10, 12)).why, 'candle data is behind', 'a feed two candles behind never triggers a late entry');
    assert.strictEqual(L.entryDue(strategy({ entry: { window: { from: '11:00', to: '14:00' } } }), c, vix, now).why, 'outside the entry window');
    assert.strictEqual(L.entryDue(strategy({ entry: { window: { from: '09:30', to: '14:00' }, weekdays: [2, 3] } }), c, vix, now).why, 'not an entry day', '2 Nov is a Monday');
    sig = L.entryDue(strategy({ entry: { window: { from: '09:30', to: '14:00' }, conditions: [{ type: 'dayMove', op: 'above', pct: 0.5 }] } }), c, vix, now);
    assert.strictEqual(sig.why, 'conditions not met');

    const legs = L.legOrders(strategy({ legs: [{ side: 'SELL', optionType: 'PE', strikeOffset: -2, lots: 2, expiry: 'next' }] }), 25024, EXPIRIES);
    assert.deepStrictEqual(legs[0], { instrument: 'NIFTY|17-Nov-2026|24900|PE', side: 'SELL', lots: 2, optionType: 'PE', strike: 24900, expiry: '17-Nov-2026' });

    const open = { day: '2026-11-02', entrySpot: 25000, legs: [{ instrument: 'X', side: 'BUY', qty: 65, entry: 100 }], ...L.thresholds(s, [{ side: 'BUY', qty: 65, entry: 100 }]) };
    assert.deepStrictEqual([open.stopRs, open.targetRs], [1950, 3900], '30% and 60% of the 6500 premium');
    assert.strictEqual(L.exitReason(s, open, { X: 69 }, 25000, at(2, 11, 0)), 'stop');
    assert.strictEqual(L.exitReason(s, open, { X: 161 }, 25000, at(2, 11, 0)), 'target');
    assert.strictEqual(L.exitReason(s, open, { X: 100 }, 25000, at(2, 15, 15)), 'time');
    assert.strictEqual(L.exitReason(s, open, { X: 100 }, 25000, at(3, 9, 20)), 'late', 'left open overnight by a data outage');
    assert.strictEqual(L.exitReason(s, open, {}, 25000, at(2, 11, 0)), null, 'no price, no decision');
    assert.strictEqual(L.exitReason(strategy({ exits: { stopLoss: null, target: null, exitAt: '15:15', indexMovePts: 50 } }), { ...open, stopRs: null, targetRs: null }, { X: 100 }, 25060, at(2, 11, 0)), 'index');
  }

  // ── full cycle on a fake market ──
  const store = fakeStore();
  let clock = at(2, 10, 2, 30);
  let ceLtp = 100;
  const feed = expiry => {
    const data = [];
    for (let k = 24500; k <= 25500; k += 50) {
      const ce = k === 25000 ? ceLtp : Math.max(5, 25000 - k + 100), pe = Math.max(5, k - 25000 + 90);
      data.push({ expiryDate: expiry, strikePrice: k, CE: { lastPrice: ce, bidprice: ce - 0.5, askPrice: ce + 0.5, impliedVolatility: 12, openInterest: 1000 }, PE: { lastPrice: pe, bidprice: pe - 0.5, askPrice: pe + 0.5, impliedVolatility: 13, openInterest: 1000 } });
    }
    return { records: { timestamp: nseTs(clock - 10000), underlyingValue: 25010, expiryDates: EXPIRIES, data } };
  };
  const accounts = createService({
    store, now: () => clock, isMarketOpen: () => true,
    loadRaw: async e => ({ raw: feed(e || EXPIRIES[0]), allExpiries: EXPIRIES, targetExpiry: e || EXPIRIES[0], stale: false }),
    loadSettle: async () => null
  });
  const loadLive = async () => { const c = candlesUntil(clock + 5 * 60000); return { candles: c, vix: c.map(x => ({ t: x.t, c: 14 })), stale: false }; };
  const live = L.createLiveService({ store, accounts, loadLive, now: () => clock });
  await accounts.createAccount({ id: 'strat', name: 'Strategy account' });
  await accounts.createAccount({ id: 'other', name: 'Other' });

  const d = await live.deploy({ strategy: strategy(), strategyId: 's1', accountId: 'strat' });
  await assert.rejects(live.deploy({ strategy: strategy(), accountId: 'strat' }), e => e.code === 'ACCOUNT_IN_USE');
  await assert.rejects(live.deploy({ strategy: strategy(), accountId: 'ghost' }), /No such paper account/);

  let r = await live.tick();
  assert.deepStrictEqual([r.deployments, r.entered], [1, 1]);
  let dep = await live.get(d.id);
  assert.strictEqual(dep.open.legs[0].instrument, 'NIFTY|03-Nov-2026|25000|CE');
  assert.strictEqual(dep.open.legs[0].entry, 100.5, 'real fill at the ask');
  assert(dep.open.legs[0].modelEntry > 0, 'the model price is recorded next to it');
  let view = await accounts.getSummary('strat');
  assert.strictEqual(view.state.orders[0].source, 'strategy');
  assert.strictEqual(view.state.orders[0].strategy.name, 'Live test');
  assert(/Live test: entry/.test(view.state.orders[0].reason));

  // same candle again: judged once, no second entry; one trade a day
  r = await live.tick();
  assert.strictEqual(r.entered, 0);

  // price falls through the stop: exits at the real bid
  clock = at(2, 10, 7);
  ceLtp = 69;
  r = await live.tick();
  assert.strictEqual(r.exited, 1);
  dep = await live.get(d.id);
  assert.strictEqual(dep.open, null);
  const tr = dep.trades[0];
  assert.deepStrictEqual([tr.reason, tr.legs[0].exit], ['stop', 68.5]);
  assert(Math.abs(tr.net - ((68.5 - 100.5) * LOT - tr.charges)) < 0.01);
  assert(tr.modelNet !== null);
  const rep = live.report(dep, 100000);
  assert.strictEqual(rep.trades, 1);
  assert(rep.model.meanGapPct !== null, 'model vs real gap reported');
  // no more entries today
  clock = at(2, 10, 12, 30);
  ceLtp = 100;
  assert.strictEqual((await live.tick()).entered, 0, 'maxTradesPerDay');

  // stopping with a position open closes it first
  const d2 = await live.deploy({ strategy: strategy({ entry: { window: { from: '09:30', to: '14:00' }, maxTradesPerDay: 1, conditions: [] } }), accountId: 'other' });
  await live.tick();
  assert((await live.get(d2.id)).open);
  const stopped = await live.setStatus(d2.id, 'stopped');
  assert.strictEqual(stopped.status, 'stopped');
  assert.strictEqual(stopped.trades[0].reason, 'stopped');
  await assert.rejects(live.setStatus(d2.id, 'active'), e => e.code === 'STOPPED');
  await assert.rejects(live.remove(d.id), e => e.code === 'NOT_STOPPED');
  await live.remove(d2.id);

  // a half-filled entry is undone: the buy fills, the naked short sell is refused for margin
  await accounts.createAccount({ id: 'half', name: 'Half' });
  const d3 = await live.deploy({ strategy: strategy({ legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' }, { side: 'SELL', optionType: 'PE', strikeOffset: 0, lots: 1, expiry: 'weekly' }] }), accountId: 'half' });
  clock = at(2, 10, 17, 30);
  await live.tick();
  const half = await live.get(d3.id);
  assert.strictEqual(half.open, null);
  assert(half.log.some(l => /refused \(INSUFFICIENT_FUNDS\)/.test(l.text)));
  assert.strictEqual((await accounts.getSummary('half')).summary.positions.length, 0, 'the filled leg was sold back');

  // ── analytics ──
  {
    const { state, summary } = await accounts.getSummary('strat');
    const x = A.accountAnalytics(state, summary);
    assert.deepStrictEqual(x.byWho.map(b => b.label), ['Live test (strategy)']);
    assert.strictEqual(x.byTag[0].label, 'Live test');
    assert.strictEqual(x.closes, 1);
    assert.strictEqual(x.winRate, 0);
    assert(Math.abs(x.equity - (100000 + x.realized - x.charges)) < 0.02);
    assert.deepStrictEqual(A.drawdown(100000, [{ equity: 110000 }, { equity: 99000 }], 105000), { maxDrawdown: 11000, maxDrawdownPct: 10 });
    const who = A.whoOf({ kind: 'trade', orderId: 'O1' }, new Map([['O1', { agent: { keyId: 'k', label: 'Claude' } }]]));
    assert.strictEqual(who.label, 'Claude (agent)');
    assert.strictEqual(A.whoOf({ kind: 'settlement' }, new Map()).key, 'expiry');
    // CSV: quotes, commas, newlines, and spreadsheet formulas are neutralised
    assert.strictEqual(A.cell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.strictEqual(A.cell('+1'), "'+1");
    assert.strictEqual(A.cell('a,b'), '"a,b"');
    assert.strictEqual(A.cell(-12.5), '-12.5', 'numbers stay numbers');
    const csv = A.tradesCsv(state);
    assert.strictEqual(csv.split('\r\n')[0], 'time_utc,trade_id,order_id,kind,instrument,side,qty,price,charges,realized,by,tag,reason');
    assert.strictEqual(csv.trim().split('\r\n').length, 1 + state.trades.length);
  }

  // ── endpoints ──
  const app = require('./index');
  const router = require('./routes/paper');
  router.setService(accounts);
  router.setLiveService(live);
  const strategiesStore = { list: async () => [{ id: 'saved-1', strategy: strategy() }], presets: () => [], backtest: async () => ({}) };
  router.setStrategyService(strategiesStore);
  const server = await new Promise(res => { const s = http.createServer(app).listen(0, () => res(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { VERCEL: process.env.VERCEL, PAPER_SECRET: process.env.PAPER_SECRET, CRON_SECRET: process.env.CRON_SECRET };
  delete process.env.VERCEL;
  process.env.PAPER_SECRET = 'owner-secret-for-tests';
  process.env.CRON_SECRET = 'cron-secret-for-tests';
  const call = async (p, method = 'GET', body, auth = 'Bearer owner-secret-for-tests') => {
    const res = await fetch(url + p, { method, headers: { Authorization: auth, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: res.status, headers: res.headers, text, json };
  };
  try {
    let x = await call('/api/paper/deployments');
    assert(x.json.deployments.some(dd => dd.id === d.id && dd.report.trades === 1 && dd.accountName === 'Strategy account'));
    assert.strictEqual((await call('/api/paper/deployments', 'POST', { strategyId: 'nope', accountId: 'strat' })).status, 404);
    assert.strictEqual((await call('/api/paper/deployments', 'POST', { strategyId: 'saved-1', accountId: 'strat' })).status, 409, 'account already has a strategy running');
    assert.strictEqual((await call(`/api/paper/deployments/${d.id}/status`, 'POST', { status: 'nonsense' })).status, 400);
    assert.strictEqual((await call(`/api/paper/deployments/${d.id}/status`, 'POST', { status: 'paused' })).json.deployment.status, 'paused');
    assert.strictEqual((await call('/api/paper/deployments/../x', 'DELETE')).status, 404);
    x = await call('/api/paper/accounts/strat/analytics');
    assert.strictEqual(x.json.analytics.closes, 1);
    x = await call('/api/paper/compare');
    assert.deepStrictEqual(x.json.accounts.map(a => a.id).sort(), ['half', 'other', 'strat']);
    x = await call('/api/paper/accounts/strat/export?kind=trades');
    assert(/^text\/csv/.test(x.headers.get('content-type')));
    assert(/attachment; filename="chaindeck-paper-strat-trades.csv"/.test(x.headers.get('content-disposition')));
    assert(x.text.startsWith('time_utc,'));
    assert.strictEqual((await call('/api/paper/accounts/strat/export?kind=secrets')).status, 400);
    assert.strictEqual((await call('/api/paper/accounts/strat/export?kind=orders', 'GET', undefined, 'Bearer wrong')).status, 401, 'exports are owner only');
    // the cron tick runs the strategies too
    x = await call('/api/cron/paper', 'GET', undefined, 'Bearer cron-secret-for-tests');
    assert.strictEqual(x.status, 200);
    assert(x.json.strategies && typeof x.json.strategies.deployments === 'number');
    // agents read their own analytics
    const key = await call('/api/paper/accounts/strat/keys', 'POST', { label: 'Reader', scope: 'read' });
    assert.strictEqual((await call('/api/paper/v1/analytics', 'GET', undefined, `Bearer ${key.json.token}`)).json.analytics.id, 'strat');
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.close();
  }
  console.log('live strategies OK (decisions, deploy-enter-stop cycle, model vs real, partial-entry undo, analytics, CSV, endpoints)');
})().catch(e => { console.error(e); process.exit(1); });
