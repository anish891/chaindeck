// Hardening and risk controls added on top of the existing security tests:
//   client address behind a trusted proxy, HSTS, JSON errors with no stack trace, "sign out everywhere",
//   the per-account daily loss limit,
//   and the order ticket's risk arithmetic.
// Runs the real Express app on an ephemeral port with fake storage and a fake option chain; nothing reaches Upstox or Redis.
const assert = require('assert');
const http = require('http');
const fetch = require('node-fetch');

const sec = require('../api/middleware/security');
const app = require('../api/index');
const paperRouter = require('../api/routes/paper');
const { createService } = require('../api/services/paper/paperAccounts');
const { formatNseDate } = require('../api/services/providers/nse');

const listen = a => new Promise(res => { const s = http.createServer(a).listen(0, () => res(s)); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;
const EXPIRIES = [3, 10, 17, 24, 31].map(d => formatNseDate(Date.now() + d * DAY));
const EXP = EXPIRIES[0];

function fakeStore() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, String(v)); return 'OK'; },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, String(v)), true)),
    del: async k => (m.delete(k) ? 1 : 0),
    hset: async (k, f, v) => { const h = m.get(k) || {}; h[f] = String(v); m.set(k, h); return 1; },
    hgetall: async k => ({ ...(m.get(k) || {}) }),
    hdel: async (k, f) => { const h = m.get(k) || {}; delete h[f]; return 1; }
  };
}

function nseTs(ms) {
  const d = new Date(ms + 330 * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${formatNseDate(ms)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** NIFTY chain around 25000. `shift` moves every premium, to mark an open position up or down. */
function feed(expiry, shift = 0) {
  const data = [];
  for (let k = 24500; k <= 25500; k += 50) {
    const ce = Math.max(5, 25000 - k + 120 + shift), pe = Math.max(5, k - 25000 + 110 + shift);
    data.push({ expiryDate: expiry, strikePrice: k, CE: { lastPrice: ce, bidprice: ce - 0.5, askPrice: ce + 0.5, impliedVolatility: 12, openInterest: 1000 }, PE: { lastPrice: pe, bidprice: pe - 0.5, askPrice: pe + 0.5, impliedVolatility: 13, openInterest: 1000 } });
  }
  return { records: { timestamp: nseTs(Date.now() - 10000), underlyingValue: 25010, expiryDates: EXPIRIES, data } };
}

const saved = { VERCEL: process.env.VERCEL, NODE_ENV: process.env.NODE_ENV, PAPER_SECRET: process.env.PAPER_SECRET, TRUST_PROXY: process.env.TRUST_PROXY };
const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

(async () => {
  delete process.env.VERCEL;
  delete process.env.NODE_ENV;
  delete process.env.TRUST_PROXY;

  // ── 1. the client address behind a reverse proxy is opt-in, and takes the entry the trusted proxy wrote ──
  {
    const req = xff => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '10.0.0.9' } });
    assert.strictEqual(sec.clientIp(req('1.2.3.4')), '10.0.0.9', 'without TRUST_PROXY the header is ignored (it can be forged)');
    process.env.TRUST_PROXY = '1';
    assert.strictEqual(sec.clientIp(req('1.2.3.4')), '1.2.3.4');
    assert.strictEqual(sec.clientIp(req('6.6.6.6, 1.2.3.4')), '1.2.3.4', 'an address the client typed itself (further left) is not believed');
    assert.strictEqual(sec.clientIp(req(null)), '10.0.0.9', 'no header: the socket address');
    process.env.TRUST_PROXY = '2';
    assert.strictEqual(sec.clientIp(req('6.6.6.6, 1.2.3.4, 172.16.0.1')), '1.2.3.4', 'two proxies: second from the right');
    assert.strictEqual(sec.clientIp(req('1.2.3.4')), '10.0.0.9', 'fewer entries than proxies: fall back to the socket');
    for (const bad of ['0', '-1', 'yes', '']) { process.env.TRUST_PROXY = bad; assert.strictEqual(sec.trustedProxies(), 0); }
    delete process.env.TRUST_PROXY;

    // two visitors behind one proxy get separate rate-limit buckets once the proxy is trusted
    const limiter = sec.rateLimit({ windowMs: 60000, max: 1 });
    const hit = xff => { let code = 200; limiter(req(xff), { setHeader() {}, status(c) { code = c; return { json() {} }; } }, () => {}); return code; };
    assert.deepStrictEqual([hit('1.1.1.1'), hit('2.2.2.2')], [200, 429], 'untrusted: both count as the proxy');
    process.env.TRUST_PROXY = '1';
    assert.deepStrictEqual([hit('3.3.3.3'), hit('4.4.4.4'), hit('3.3.3.3')], [200, 200, 429], 'trusted: each visitor has their own');
    delete process.env.TRUST_PROXY;
  }

  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, { method = 'GET', body, cookie, auth } = {}) => fetch(base + p, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...(auth && { Authorization: auth }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  try {
    // ── 2. HSTS in production only ──
    assert.strictEqual((await call('/api/health')).headers.get('strict-transport-security'), null, 'not in local development');
    process.env.NODE_ENV = 'production';
    assert.strictEqual((await call('/api/health')).headers.get('strict-transport-security'), sec.HSTS);
    assert(!/includeSubDomains/i.test(sec.HSTS), 'other sites on the domain are not ours to decide for');
    delete process.env.NODE_ENV;

    // ── 3. errors nobody handled answer as JSON and never carry a stack trace, even outside production ──
    {
      const unknown = await call('/api/no-such-thing');
      assert.strictEqual(unknown.status, 404);
      assert.deepStrictEqual(await unknown.json(), { ok: false, error: 'Not found.' });
      const badUrl = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/paper/accounts/%E0%A4%A' }, res => {
          let text = '';
          res.on('data', d => { text += d; });
          res.on('end', () => resolve({ status: res.statusCode, text, type: res.headers['content-type'] }));
        }).on('error', reject);
      });
      assert.strictEqual(badUrl.status, 400);
      assert(/application\/json/.test(badUrl.type), 'a malformed URL answers in JSON');
      assert(!/\bat\s|node_modules|\.js:\d+/.test(badUrl.text), 'no stack trace or file path in the answer');
      assert.strictEqual(JSON.parse(badUrl.text).ok, false);
    }

    // ── 4. sign out everywhere: every session issued so far stops working, here and on other devices ──
    {
      const store = fakeStore();
      paperRouter.setSessionStore(store);
      process.env.PAPER_SECRET = 'paper-secret-for-hardening-tests';
      paperRouter.setService(createService({
        store: fakeStore(), isMarketOpen: () => true, loadSettle: async () => null,
        loadRaw: async e => ({ raw: feed(e || EXP), allExpiries: EXPIRIES, targetExpiry: e || EXP, stale: false })
      }));
      const signIn = async () => (await call('/api/paper/session', { method: 'POST', body: { secret: process.env.PAPER_SECRET } })).headers.get('set-cookie').split(';')[0];
      const laptop = await signIn();
      const phone = await signIn();
      assert.strictEqual((await call('/api/paper/accounts', { cookie: laptop })).status, 200);
      assert.strictEqual((await call('/api/paper/session/revoke-all', { method: 'POST', body: {} })).status, 401, 'only the owner can end sessions');
      await wait(5); // a session issued in the very millisecond of the sign-out would still count as "before"
      const out = await call('/api/paper/session/revoke-all', { method: 'POST', body: {}, cookie: laptop });
      assert.strictEqual(out.status, 200);
      assert(/cd_paper=;/.test(out.headers.get('set-cookie')), 'this browser is signed out too');
      assert.strictEqual((await call('/api/paper/accounts', { cookie: laptop })).status, 401, 'the cookie that asked no longer works');
      assert.strictEqual((await call('/api/paper/accounts', { cookie: phone })).status, 401, 'nor does the one on another device');
      assert.strictEqual((await (await call('/api/paper/session', { cookie: phone })).json()).signedIn, false);
      assert(Number(await store.get('pt:sessions:notbefore')) > 0, 'the marker is saved, so a restart does not bring old sessions back');
      await wait(5);
      const again = await signIn();
      assert.strictEqual((await call('/api/paper/accounts', { cookie: again })).status, 200, 'signing in again works');
      assert.strictEqual((await call('/api/paper/accounts', { auth: `Bearer ${process.env.PAPER_SECRET}` })).status, 200, 'the secret itself is not a session');
      // after a restart the marker is read back from storage before the first request is judged
      sec.setSessionsNotBefore(0);
      paperRouter.setSessionStore(store);
      assert.strictEqual((await call('/api/paper/accounts', { cookie: phone })).status, 401, 'still signed out after a restart');
      assert.strictEqual((await call('/api/paper/accounts', { cookie: again })).status, 200);

      // ── 5. daily loss limit over HTTP: validation, and it shows on the account ──
      const acct = p => `/api/paper/accounts/main${p}`;
      const post = (p, body) => call(p, { method: 'POST', body, cookie: again });
      for (const bad of [{ maxDailyLoss: '5000' }, { maxDailyLoss: 50 }, { maxDailyLoss: -1 }, { maxDailyLoss: 1e12 }, {}]) {
        const r = await post(acct('/risk'), bad);
        assert.strictEqual(r.status, 400, `refuses ${JSON.stringify(bad)}`);
        assert.strictEqual((await r.json()).code, 'BAD_LIMIT');
      }
      assert.strictEqual((await call(acct('/risk'), { method: 'POST', body: { maxDailyLoss: 5000 } })).status, 401, 'owner only');
      assert.strictEqual((await call(acct(''), { cookie: again }).then(r => r.json())).risk, null, 'no limit until one is set');
      assert.deepStrictEqual((await (await post(acct('/risk'), { maxDailyLoss: 5000 })).json()).risk, { maxDailyLoss: 5000 });
      assert.deepStrictEqual((await call(acct(''), { cookie: again }).then(r => r.json())).risk, { maxDailyLoss: 5000, dayPnl: 0, breached: false });
      assert.strictEqual((await (await post(acct('/risk'), { maxDailyLoss: null })).json()).risk, null, 'null removes it');
      assert.strictEqual((await post('/api/paper/accounts/ghost/risk', { maxDailyLoss: 5000 })).status, 404);
    }
  } finally {
    restore();
    paperRouter.setSessionStore(null);
    server.close();
  }

  // ── 6. daily loss limit in the service: stops new risk, never an exit; applies to agents; survives a reset ──
  {
    let shift = 0;
    const svc = createService({
      store: fakeStore(), isMarketOpen: () => true, loadSettle: async () => null,
      loadRaw: async e => ({ raw: feed(e || EXP, shift), allExpiries: EXPIRIES, targetExpiry: e || EXP, stale: false })
    });
    await svc.createAccount({ id: 'main', name: 'Main', startingCapital: 5000000 }); // enough margin that only the limit can refuse a short
    const call25 = `NIFTY|${EXP}|25000|CE`;
    const put25 = `NIFTY|${EXP}|25000|PE`;
    const buy = (instrument, lots = 1, extra = {}) => svc.placeOrder('main', { instrument, side: 'BUY', lots, orderType: 'MARKET', ...extra });

    // no limit: exactly as before
    assert.strictEqual((await buy(call25, 2)).ok, true);
    assert.strictEqual((await svc.getSummary('main')).risk, null);

    await svc.setRiskLimits('main', { maxDailyLoss: 2000 });
    let s = await svc.getSummary('main');
    assert(s.risk.dayPnl < 0 && !s.risk.breached, 'a small loss (spread and charges) is inside the limit');
    assert.strictEqual((await buy(put25)).ok, true, 'inside the limit orders go through');

    shift = -40; // every premium falls 40 points: the long options are now well under water
    s = await svc.getSummary('main');
    assert(s.risk.breached && s.risk.dayPnl <= -2000, `the day's loss (${s.risk.dayPnl}) is past the limit`);
    const before = JSON.stringify((await svc.getSummary('main')).state);

    const refused = await buy(call25);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error.code, 'DAILY_LOSS_LIMIT');
    assert.strictEqual((await buy(`NIFTY|${EXP}|25100|PE`)).error.code, 'DAILY_LOSS_LIMIT', 'a new position is refused');
    assert.strictEqual((await svc.placeOrder('main', { instrument: call25, side: 'SELL', lots: 3, orderType: 'MARKET' })).error.code, 'DAILY_LOSS_LIMIT', 'selling more than is held would open a short');
    assert.strictEqual((await svc.placeOrder('main', { instrument: call25, side: 'BUY', lots: 1, orderType: 'MARKET', reason: 'averaging down' }, { agent: { keyId: 'k1', label: 'Bot' } })).error.code, 'DAILY_LOSS_LIMIT', 'agents are held to it too');
    assert.strictEqual(JSON.stringify((await svc.getSummary('main')).state), before, 'a refused order changes nothing');
    assert.strictEqual((await svc.previewOrder('main', { instrument: call25, side: 'BUY', lots: 1, orderType: 'MARKET' })).error.code, 'DAILY_LOSS_LIMIT', 'the preview says so before the order is sent');
    assert.strictEqual((await buy(call25, 99)).error.code, 'BAD_LOTS', 'an invalid order still gets its own error');

    assert.strictEqual((await svc.previewOrder('main', { instrument: call25, side: 'SELL', lots: 1, orderType: 'MARKET' })).ok, true);
    const exit = await svc.placeOrder('main', { instrument: call25, side: 'SELL', lots: 1, orderType: 'MARKET' });
    assert.strictEqual(exit.ok, true, 'reducing a position is always allowed');
    assert.strictEqual((await svc.placeOrder('main', { instrument: call25, side: 'SELL', lots: 1, orderType: 'MARKET' })).ok, true, 'and closing it');
    assert.strictEqual((await svc.placeOrder('main', { instrument: put25, side: 'SELL', lots: 1, orderType: 'MARKET' })).ok, true);

    await assert.rejects(svc.setRiskLimits('main', { maxDailyLoss: 10 }), e => e.code === 'BAD_LIMIT');
    await assert.rejects(svc.setRiskLimits('ghost', { maxDailyLoss: 5000 }), e => e.code === 'NOT_FOUND');
    await svc.resetAccount('main');
    assert.deepStrictEqual((await svc.getSummary('main')).risk, { maxDailyLoss: 2000, dayPnl: 0, breached: false }, 'a reset keeps the limit and starts the day again');
    assert.strictEqual(await svc.setRiskLimits('main', { maxDailyLoss: null }), null);
    shift = 0;
    assert.strictEqual((await buy(call25)).ok, true);

    // creating the same id twice at once: one wins, the other is told it is taken
    const both = await Promise.allSettled([svc.createAccount({ id: 'twin' }), svc.createAccount({ id: 'twin' })]);
    assert.deepStrictEqual(both.map(r => r.status).sort(), ['fulfilled', 'rejected']);
    assert.strictEqual(both.find(r => r.status === 'rejected').reason.code, 'EXISTS');
  }

  // ── 7. the order ticket's risk arithmetic (the app's own TypeScript, compiled as the shipped bundle is) ──
  {
    const U = await require('./helpers/paperUi').loadPaperUi();
    const quote = { ltp: 100, bid: 99.5, ask: 100.5, iv: 12, oi: 1000 };
    const form = over => ({ ...U.emptyForm(), ...over });

    assert.strictEqual(U.entryPrice(form(), 'BUY', quote), 100.5, 'a market buy pays the ask');
    assert.strictEqual(U.entryPrice(form(), 'SELL', quote), 99.5, 'a market sell receives the bid');
    assert.strictEqual(U.entryPrice(form(), 'BUY', { ...quote, ask: 0 }), 100, 'no ask: the last price');
    assert.strictEqual(U.entryPrice(form({ type: 'LIMIT', limit: '95' }), 'BUY', quote), 95);
    assert.strictEqual(U.entryPrice(form({ type: 'SL-M', trigger: '110' }), 'BUY', quote), 110);
    assert.strictEqual(U.entryPrice(form({ type: 'LIMIT', limit: '' }), 'BUY', quote), null);
    assert.strictEqual(U.entryPrice(form(), 'BUY', null), null);

    let r = U.riskRead(form({ lots: '2' }), 'BUY', quote, 65);
    assert.deepStrictEqual([r.basis, r.perLot, r.maxLoss, r.reward], ['premium', 6532.5, 13065, null], 'a bought option can lose its premium');
    r = U.riskRead(form({ lots: '2', bracket: true, stop: '80.5', target: '140.5' }), 'BUY', quote, 65);
    assert.deepStrictEqual([r.basis, r.perLot, r.maxLoss, r.reward, r.ratio], ['stop', 1300, 2600, 5200, 2], 'with a stop: the gap to the stop');
    r = U.riskRead(form({ bracket: true, stop: '120' }), 'BUY', quote, 65);
    assert.strictEqual(r.basis, 'premium', 'a stop on the wrong side is not counted as a stop');
    r = U.riskRead(form({ bracket: false, stop: '80.5' }), 'BUY', quote, 65);
    assert.strictEqual(r.basis, 'premium', 'a stop typed but switched off is not counted');
    r = U.riskRead(form(), 'SELL', quote, 65);
    assert.deepStrictEqual([r.basis, r.perLot, r.maxLoss], ['uncapped', null, null], 'a sold option with no stop has no cap');
    r = U.riskRead(form({ bracket: true, stop: '119.5', target: '59.5' }), 'SELL', quote, 65);
    assert.deepStrictEqual([r.basis, r.maxLoss, r.reward, r.ratio], ['stop', 1300, 2600, 2]);
    assert.strictEqual(U.riskRead(form(), 'BUY', null, 65).basis, 'unknown');
    assert.strictEqual(U.riskRead(form({ lots: '' }), 'BUY', quote, 65).maxLoss, null, 'no lots yet: per-lot risk only');
    assert.strictEqual(U.riskRead(form({ lots: '' }), 'BUY', quote, 65).perLot, 6532.5);

    assert.strictEqual(U.lotsForRisk(5000, 1300), 3);
    assert.strictEqual(U.lotsForRisk(1300, 1300), 1, 'exactly one lot fits');
    assert.strictEqual(U.lotsForRisk(1000, 1300), 0, 'even one lot is too much');
    assert.strictEqual(U.lotsForRisk(1e9, 1300), U.MAX_LOTS, 'never more than an order allows');
    for (const [budget, perLot] of [[0, 1300], [-5, 1300], [NaN, 1300], [5000, null], [5000, 0]]) assert.strictEqual(U.lotsForRisk(budget, perLot), 0);

    assert.deepStrictEqual([1250000, 24000000, 1500, 999, 0, null].map(U.compact), ['12.5L', '2.4Cr', '1.5K', '999', 'n/a', 'n/a']);

    // the pieces render: risk line and sizing on the ticket, OI and IV columns only when asked, the limit on the accounts panel
    const html = (C, props) => U.renderToStaticMarkup(U.createElement(C, props));
    const market = { symbol: 'NIFTY', asOf: Date.now(), spot: 25010, marketOpen: true, health: { ok: true }, expiries: [EXP], expiry: EXP, lotSize: 65, atmStrike: 25000, strikes: [{ strike: 25000, CE: quote, PE: { ...quote, oi: 250000 } }] };
    const noop = () => {};
    const sheet = html(U.OrderSheet, { accountId: 'main', market, selection: { instrument: `NIFTY|${EXP}|25000|CE`, side: 'BUY', nonce: 1 }, equity: 100000, onSide: noop, onClose: noop, onPlaced: noop });
    assert(/data-basis="premium"/.test(sheet) && sheet.includes('6,532.50') && sheet.includes('6.5% of the account'), 'the ticket shows what the trade can lose');
    assert(sheet.includes('Risk per trade'));
    const short = html(U.OrderSheet, { accountId: 'main', market, selection: { instrument: `NIFTY|${EXP}|25000|CE`, side: 'SELL', nonce: 1 }, onSide: noop, onClose: noop, onPlaced: noop });
    assert(/data-basis="uncapped"/.test(short) && short.includes('not capped'), 'a naked short is called out');
    const chain = html(U.Chain, { market, loaded: true, held: new Set(), onPick: noop, onExpiry: noop });
    assert(chain.includes('aria-pressed="false"') && !chain.includes('pt-detail'), 'OI and IV columns are off until asked for');
    assert(chain.includes('Bid 99.50 · Ask 100.50'), 'bid and ask on each price');
    const account = { agentsPaused: false, risk: { maxDailyLoss: 5000, dayPnl: -5200, breached: true }, summary: { id: 'main', name: 'Main', startingCapital: 100000, equity: 94800, positions: [], openOrders: [] }, orders: [], trades: [], curve: [] };
    const panel = html(U.AccountsPanel, { accounts: [{ id: 'main', name: 'Main' }], accountId: 'main', account, onAccountsChanged: noop, onAccountChanged: noop, onSignOutEverywhere: async () => null });
    assert(panel.includes('Daily loss limit on') && panel.includes('reached') && panel.includes('Sign out everywhere'));
    const plain = html(U.AccountsPanel, { accounts: [{ id: 'main', name: 'Main' }], accountId: 'main', account: { ...account, risk: null }, onAccountsChanged: noop, onAccountChanged: noop });
    assert(plain.includes('No limit set') && !plain.includes('Sign out everywhere'), 'no sign-in configured: nothing to sign out of');
  }

  console.log('hardening OK (proxy-aware limits, HSTS, JSON errors, sign out everywhere, daily loss limit, ticket risk)');
  process.exit(0);
})().catch(err => { restore(); console.error(err); process.exit(1); });
