// Agent API (/api/paper/v1): keys, scopes, required reasons, idempotency, quotas, the pause switch and isolation between
// accounts. Real Express app, paper service on a fake store and NSE feed; no network.
const assert = require('assert');
const http = require('http');
const fetch = require('node-fetch');

const app = require('./index');
const paperRouter = require('./routes/paper');
const { createService, AGENT } = require('./services/paperAccounts');
const { formatNseDate } = require('./services/nse');
const storage = require('./services/storage');

const DAY = 24 * 3600 * 1000;
const EXPIRIES = [3, 10, 17, 24, 31].map(d => formatNseDate(Date.now() + d * DAY));
const EXP = EXPIRIES[0];
const listen = a => new Promise(res => { const s = http.createServer(a).listen(0, () => res(s)); });

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

function feed(expiry) {
  const ts = ms => { const d = new Date(ms + 330 * 60000); const p = n => String(n).padStart(2, '0'); return `${formatNseDate(ms)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
  const data = [];
  for (let k = 24500; k <= 25500; k += 50) {
    const ce = Math.max(5, 25000 - k + 120), pe = Math.max(5, k - 25000 + 110);
    data.push({ expiryDate: expiry, strikePrice: k, CE: { lastPrice: ce, bidprice: ce - 0.5, askPrice: ce + 0.5, impliedVolatility: 12, openInterest: 1000 }, PE: { lastPrice: pe, bidprice: pe - 0.5, askPrice: pe + 0.5, impliedVolatility: 13, openInterest: 1000 } });
  }
  return { records: { timestamp: ts(Date.now() - 10000), underlyingValue: 25010, expiryDates: EXPIRIES, data } };
}

(async () => {
  // storage INCR (memory backend) counts and keeps a fixed window
  if (!storage.configured) {
    assert.strictEqual(await storage.incr('t:incr', 60), 1);
    assert.strictEqual(await storage.incr('t:incr', 60), 2);
    await storage.del('t:incr');
  }

  const store = fakeStore();
  paperRouter.setService(createService({
    store,
    isMarketOpen: () => true,
    loadRaw: async e => ({ raw: feed(e || EXP), allExpiries: EXPIRIES, targetExpiry: e || EXP, stale: false }),
    loadSettle: async () => null
  }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { VERCEL: process.env.VERCEL, PAPER_SECRET: process.env.PAPER_SECRET };
  delete process.env.VERCEL;
  process.env.PAPER_SECRET = 'owner-secret-for-tests';
  const OWNER = 'Bearer owner-secret-for-tests';
  const call = async (p, { method = 'GET', body, auth, headers = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(auth && { Authorization: auth }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    return { status: r.status, headers: r.headers, json };
  };

  try {
    // owner sets up two accounts and keys
    await call('/api/paper/accounts', { auth: OWNER });
    assert.strictEqual((await call('/api/paper/accounts', { method: 'POST', auth: OWNER, body: { id: 'claude', name: 'Claude' } })).status, 201);
    assert.strictEqual((await call('/api/paper/accounts/claude/keys', { method: 'POST', body: { label: 'x' } })).status, 401, 'keys are owner only');
    assert.strictEqual((await call('/api/paper/accounts/claude/keys', { method: 'POST', auth: OWNER, body: { label: '' } })).status, 400);
    assert.strictEqual((await call('/api/paper/accounts/claude/keys', { method: 'POST', auth: OWNER, body: { label: 'x', scope: 'admin' } })).status, 400);
    const made = await call('/api/paper/accounts/claude/keys', { method: 'POST', auth: OWNER, body: { label: 'Claude' } });
    assert.strictEqual(made.status, 201);
    const TRADE = `Bearer ${made.json.token}`;
    assert(/^cdp_[0-9a-f]{8}_[0-9a-f]{48}$/.test(made.json.token));
    const ro = await call('/api/paper/accounts/claude/keys', { method: 'POST', auth: OWNER, body: { label: 'Watcher', scope: 'read' } });
    const READ = `Bearer ${ro.json.token}`;
    const listed = await call('/api/paper/accounts/claude/keys', { auth: OWNER });
    assert.strictEqual(listed.json.keys.length, 2);
    assert(!JSON.stringify(listed.json).includes(made.json.token.slice(14)), 'the key itself is never listed');
    assert(!JSON.stringify(listed.json).includes('hash'), 'nor its hash');
    assert(!JSON.stringify([...store.m.values()]).includes(made.json.token), 'storage holds a hash, not the key');

    // authentication
    assert.strictEqual((await call('/api/paper/v1/account')).status, 401);
    assert.strictEqual((await call('/api/paper/v1/account', { auth: OWNER })).status, 401, 'the owner secret is not an agent key');
    assert.strictEqual((await call('/api/paper/v1/account', { auth: TRADE.slice(0, -1) + (TRADE.endsWith('0') ? '1' : '0') })).status, 401, 'one changed character');
    const docs = await call('/api/paper/v1', { auth: TRADE });
    assert.strictEqual(docs.json.you.account, 'claude');
    assert(docs.json.endpoints['POST /api/paper/v1/orders']);
    const acct = await call('/api/paper/v1/account', { auth: TRADE });
    assert.strictEqual(acct.json.account.id, 'claude');
    assert.strictEqual(acct.json.account.cash, 100000);
    assert.strictEqual((await call('/api/paper/v1/market', { auth: READ })).json.expiry, EXP);

    // scopes and the reason rule
    const order = { instrument: `NIFTY|${EXP}|25000|CE`, side: 'BUY', lots: 1 };
    assert.strictEqual((await call('/api/paper/v1/orders', { method: 'POST', auth: READ, body: { ...order, reason: 'r' } })).status, 403);
    let r = await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, body: order });
    assert.deepStrictEqual([r.status, r.json.code], [422, 'REASON_REQUIRED']);
    r = await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, body: { ...order, reason: '   ' } });
    assert.strictEqual(r.json.code, 'REASON_REQUIRED', 'whitespace is not a reason');

    // idempotency: the retry replays, nothing is placed twice
    const idem = { 'Idempotency-Key': 'buy-ce-1' };
    r = await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, headers: idem, body: { ...order, reason: 'Testing a long call', tag: 'test' } });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([r.json.order.source, r.json.order.agent.label, r.json.order.reason], ['agent', 'Claude', 'Testing a long call']);
    const again = await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, headers: idem, body: { ...order, reason: 'Testing a long call', tag: 'test' } });
    assert.strictEqual(again.status, 201);
    assert.strictEqual(again.headers.get('idempotent-replayed'), 'true');
    assert.strictEqual(again.json.order.id, r.json.order.id);
    assert.strictEqual((await call('/api/paper/v1/orders', { auth: TRADE })).json.orders.filter(o => o.reason === 'Testing a long call').length, 1, 'one order, not two');
    assert.strictEqual((await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, headers: { 'Idempotency-Key': 'bad key with spaces' }, body: { ...order, reason: 'x' } })).status, 400);
    // a refused order does not burn its idempotency key: the corrected retry goes through
    const fix = { 'Idempotency-Key': 'fix-me' };
    assert.strictEqual((await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, headers: fix, body: { ...order, lots: 99, reason: 'too many lots' } })).json.code, 'BAD_LOTS');
    const fixed = await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, headers: fix, body: { ...order, orderType: 'LIMIT', limitPrice: 20, reason: 'corrected' } });
    assert.strictEqual(fixed.status, 201);
    assert.strictEqual(fixed.headers.get('idempotent-replayed'), null);
    await call(`/api/paper/v1/orders/${fixed.json.order.id}`, { method: 'DELETE', auth: TRADE });
    const pos = await call('/api/paper/v1/positions', { auth: TRADE });
    assert.strictEqual(pos.json.positions[0].qty, 65);
    assert.strictEqual((await call('/api/paper/v1/trades', { auth: TRADE })).json.trades.length, 1);
    assert.strictEqual((await call(`/api/paper/v1/orders/${r.json.order.id}`, { auth: READ })).json.order.id, r.json.order.id);
    assert.strictEqual((await call('/api/paper/v1/orders/O999', { auth: READ })).status, 404);

    // the owner sees who placed it
    const view = await call('/api/paper/accounts/claude', { auth: OWNER });
    assert.strictEqual(view.json.orders[0].agent.label, 'Claude');

    // pause switch
    assert.strictEqual((await call('/api/paper/accounts/claude/agents', { method: 'POST', auth: OWNER, body: { paused: 'yes' } })).status, 400);
    await call('/api/paper/accounts/claude/agents', { method: 'POST', auth: OWNER, body: { paused: true } });
    r = await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, body: { ...order, reason: 'more' } });
    assert.deepStrictEqual([r.status, r.json.code], [422, 'AGENTS_PAUSED']);
    assert.strictEqual((await call('/api/paper/v1/account', { auth: TRADE })).json.account.agentsPaused, true);
    assert.strictEqual((await call('/api/paper/accounts/claude/orders', { method: 'POST', auth: OWNER, body: { ...order } })).status, 201, 'the owner can still trade a paused account');
    await call('/api/paper/accounts/claude/agents', { method: 'POST', auth: OWNER, body: { paused: false } });

    // isolation: a key only ever sees its own account
    const mainOrder = await call('/api/paper/accounts/main/orders', { method: 'POST', auth: OWNER, body: { ...order, orderType: 'LIMIT', limitPrice: 50 } });
    assert.strictEqual(mainOrder.status, 201);
    const theirs = mainOrder.json.order.id;
    // order ids are numbered per account, so the same id may exist on the agent's own account: whatever the agent's key
    // reaches is its own account's order, never main's
    await call(`/api/paper/v1/orders/${theirs}`, { method: 'DELETE', auth: TRADE });
    assert(!(await call('/api/paper/v1/orders?status=all&limit=200', { auth: TRADE })).json.orders.some(o => o.limitPrice === 50), "main's order is not visible to the agent");
    const mainAfter = await call('/api/paper/accounts/main', { auth: OWNER });
    assert.strictEqual(mainAfter.json.summary.openOrders.length, 1, 'the main account is untouched by the agent');

    // quota: order requests per minute per key (the ones above count too)
    let limited = null;
    for (let i = 0; i < AGENT.ordersPerMinute + 2 && !limited; i++) {
      const x = await call('/api/paper/v1/orders', { method: 'POST', auth: TRADE, body: { ...order, orderType: 'LIMIT', limitPrice: 10, reason: `quota ${i}` } });
      if (x.status === 429) limited = x;
    }
    assert(limited, 'the per-minute order quota kicks in');
    assert.strictEqual(limited.json.code, 'RATE_LIMITED');

    // revoke: the key stops working at once
    const keyId = made.json.key.keyId;
    assert.strictEqual((await call(`/api/paper/accounts/claude/keys/${keyId}`, { method: 'DELETE', auth: OWNER })).status, 200);
    assert.strictEqual((await call('/api/paper/v1/account', { auth: TRADE })).status, 401);
    // deleting the account revokes the rest
    await call('/api/paper/accounts/claude', { method: 'DELETE', auth: OWNER });
    assert.strictEqual((await call('/api/paper/v1/account', { auth: READ })).status, 401);
    assert((await call('/api/paper/accounts/claude/keys', { auth: OWNER })).json.keys.every(k => k.revokedAt), 'no live key outlives its account');

    // production without PAPER_SECRET: the agent API is off too
    process.env.VERCEL = '1';
    delete process.env.PAPER_SECRET;
    assert.strictEqual((await call('/api/paper/v1/account', { auth: READ })).status, 503);
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.close();
  }
  console.log('paper agent API OK (keys, scopes, reasons, idempotency, quota, pause, isolation, revoke)');
})().catch(e => { console.error(e); process.exit(1); });
