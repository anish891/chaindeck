// Paper trading over HTTP: owner sign-in, the routes, the cron tick, the payoff maths and the page wiring.
// Runs the real Express app on an ephemeral port with the paper service swapped for one on a fake store and NSE feed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const fetch = require('node-fetch');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const app = require('./index');
const paperRouter = require('./routes/paper');
const { createService } = require('./services/paperAccounts');
const { formatNseDate } = require('./services/nse');

const listen = a => new Promise(res => { const s = http.createServer(a).listen(0, () => res(s)); });
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

function feed(expiry) {
  const data = [];
  for (let k = 24500; k <= 25500; k += 50) {
    const ce = Math.max(5, 25000 - k + 120), pe = Math.max(5, k - 25000 + 110);
    data.push({ expiryDate: expiry, strikePrice: k, CE: { lastPrice: ce, bidprice: ce - 0.5, askPrice: ce + 0.5, impliedVolatility: 12, openInterest: 1000 }, PE: { lastPrice: pe, bidprice: pe - 0.5, askPrice: pe + 0.5, impliedVolatility: 13, openInterest: 1000 } });
  }
  return { records: { timestamp: nseTs(Date.now() - 10000), underlyingValue: 25010, expiryDates: EXPIRIES, data } };
}

(async () => {
  // ── payoff maths (browser module, loaded without its file name so Node treats it as ESM) ──
  const P = await import('data:text/javascript,' + encodeURIComponent(read('public/js/paper-payoff.js')));
  {
    const S = 25000, K = 25000, T = 7 / 365, sig = 0.12, r = 0.06;
    const parity = P.bsPrice('CE', S, K, T, sig, r) - P.bsPrice('PE', S, K, T, sig, r) - (S - K * Math.exp(-r * T));
    assert(Math.abs(parity) < 1e-6, 'Black-Scholes satisfies put-call parity');
    assert(Math.abs(P.normCdf(0) - 0.5) < 1e-7 && Math.abs(P.normCdf(1.96) - 0.975) < 1e-4);
    const now = Date.now();
    const longCall = P.payoffSeries([{ strike: 25000, optionType: 'CE', qty: 65, avgPrice: 100, iv: 12 }], { spot: 25000, expiryMs: now + 7 * DAY, nowMs: now });
    assert.deepStrictEqual(longCall.breakevens, [25100]);
    assert.strictEqual(longCall.maxProfit, null, 'long call: unlimited upside');
    assert.strictEqual(longCall.maxLoss, -6500, 'long call: lose the premium');
    const spread = P.payoffSeries([
      { strike: 25000, optionType: 'PE', qty: -65, avgPrice: 100, iv: 13 },
      { strike: 24900, optionType: 'PE', qty: 65, avgPrice: 65, iv: 13 }
    ], { spot: 25000, expiryMs: now + 7 * DAY, nowMs: now });
    assert.strictEqual(spread.maxProfit, 35 * 65);
    assert.strictEqual(spread.maxLoss, -65 * 65);
    assert.deepStrictEqual(spread.breakevens, [24965]);
    const shortCall = P.payoffSeries([{ strike: 25000, optionType: 'CE', qty: -65, avgPrice: 100 }], { spot: 25000, expiryMs: now + DAY, nowMs: now });
    assert.strictEqual(shortCall.maxLoss, null, 'naked short call: unlimited loss');
    assert.strictEqual(P.payoffSeries([], { spot: 25000, expiryMs: now, nowMs: now }), null);
  }

  // ── page wiring: every action the page or its templates name exists, and the page is CSP-clean ──
  {
    const html = read('public/paper.html');
    const js = read('public/js/paper.js');
    const block = /const ACTIONS = \{([\s\S]*?)\n\};/.exec(js);
    assert(block, 'ACTIONS map in paper.js');
    const known = new Set([...block[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*(?::|,|$)/gm)].map(m => m[1]));
    const used = new Set([...(html + js).matchAll(/data-(?:click|change)="([^"$]+)/g)].flatMap(m => m[1].split(/\s+/).map(x => x.split(':')[0])));
    const dead = [...used].filter(n => n && !known.has(n));
    assert.deepStrictEqual(dead, [], `paper page actions with no handler: ${dead.join(', ')}`);
    for (const name of known) assert(new RegExp(`function\\s+${name}\\b`).test(js), `ACTIONS.${name} is defined in paper.js`);
    assert.strictEqual((html.match(/\son[a-z]+="/gi) || []).length, 0, 'no inline event handlers');
    assert.strictEqual((html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || []).length, 0, 'no inline scripts');
    assert.strictEqual((html.match(/\b(?:src|href)="https?:\/\//gi) || []).length, 0, 'no third-party resources');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    const missing = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]))].filter(id => !ids.has(id));
    assert.deepStrictEqual(missing, [], `paper.js looks up ids that paper.html does not have: ${missing.join(', ')}`);
    assert(/href="\/paper\.html"/.test(read('public/index.html')), 'the dashboard links to the paper page');
    for (const f of ['public/paper.html', 'public/js/paper.js', 'public/js/paper-payoff.js', 'public/css/paper.css']) {
      assert(!/—/.test(read(f)), `${f}: no em dashes`);
      assert(!/\p{Extended_Pictographic}/u.test(read(f).replace(/[©®™]/g, '')), `${f}: no emoji`);
    }
  }

  // ── HTTP ──
  paperRouter.setService(createService({
    store: fakeStore(),
    isMarketOpen: () => true,
    loadRaw: async e => ({ raw: feed(e || EXP), allExpiries: EXPIRIES, targetExpiry: e || EXP, stale: false }),
    loadSettle: async () => null
  }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { VERCEL: process.env.VERCEL, PAPER_SECRET: process.env.PAPER_SECRET, CRON_SECRET: process.env.CRON_SECRET };
  const call = (p, { method = 'GET', body, cookie, auth, type = 'application/json' } = {}) => fetch(base + p, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': type }), ...(cookie && { Cookie: cookie }), ...(auth && { Authorization: auth }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
  try {
    // production without PAPER_SECRET: off, fail closed
    process.env.VERCEL = '1';
    delete process.env.PAPER_SECRET;
    assert.strictEqual((await call('/api/paper/accounts')).status, 503);
    assert.strictEqual((await (await call('/api/paper/session')).json()).configured, false);
    process.env.CRON_SECRET = 'cron-secret-for-tests';
    assert.strictEqual((await call('/api/cron/paper')).status, 401, 'the paper tick needs the cron secret');
    const tick = await call('/api/cron/paper', { auth: 'Bearer cron-secret-for-tests' });
    assert.strictEqual(tick.status, 200);
    assert.strictEqual((await tick.json()).accounts, 0);

    // production with PAPER_SECRET: sign in for a cookie
    process.env.PAPER_SECRET = 'paper-secret-for-tests';
    assert.strictEqual((await call('/api/paper/accounts')).status, 401);
    assert.strictEqual((await call('/api/paper/session', { method: 'POST', body: { secret: 'wrong' } })).status, 401);
    const ok = await call('/api/paper/session', { method: 'POST', body: { secret: 'paper-secret-for-tests' } });
    assert.strictEqual(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/api/paper']) assert(setCookie.includes(flag), `session cookie has ${flag}`);
    assert(!setCookie.includes('paper-secret-for-tests'), 'the cookie never contains the secret');
    const cookie = setCookie.split(';')[0];
    assert.strictEqual((await (await call('/api/paper/session', { cookie })).json()).signedIn, true);

    // a forged or expired cookie does not work; the bearer secret does
    const [name, val] = cookie.split('=');
    const [exp, sig] = val.split('.');
    assert.strictEqual((await call('/api/paper/accounts', { cookie: `${name}=${Number(exp) + 1}.${sig}` })).status, 401, 'changed expiry breaks the signature');
    assert.strictEqual((await call('/api/paper/accounts', { cookie: `${name}=${Date.now() - 1000}.${sig}` })).status, 401);
    assert.strictEqual((await call('/api/paper/accounts', { auth: 'Bearer paper-secret-for-tests' })).status, 200);
    assert.strictEqual((await call('/api/paper/accounts', { auth: 'Bearer nope' })).status, 401);

    // accounts: the default one appears on first use
    let r = await (await call('/api/paper/accounts', { cookie })).json();
    assert.deepStrictEqual(r.accounts.map(a => a.id), ['main']);
    assert.strictEqual((await call('/api/paper/accounts/BAD!', { cookie })).status, 400);
    assert.strictEqual((await call('/api/paper/accounts/ghost', { cookie })).status, 404);
    assert.strictEqual((await call('/api/paper/accounts', { method: 'POST', cookie, body: { id: 'main' } })).status, 409);
    assert.strictEqual((await call('/api/paper/accounts', { method: 'POST', cookie, body: { id: 'swing', name: 'Swing', startingCapital: 200000 } })).status, 201);

    // market for the ticket
    const m = await (await call('/api/paper/market', { cookie })).json();
    assert.strictEqual(m.expiry, EXP);
    assert.deepStrictEqual(m.expiries, EXPIRIES.slice(0, 4));
    assert.strictEqual(m.atmStrike, 25000);
    assert.strictEqual(m.strikes.length, 21, 'ATM plus or minus a dozen strikes, clipped to what exists');
    assert(m.health.ok);
    assert.strictEqual((await call('/api/paper/market?expiry=<x>', { cookie })).status, 400);

    // orders: writes must be JSON, the body cannot claim to be an agent, bad JSON is a clean 400
    const order = { instrument: `NIFTY|${EXP}|25000|CE`, side: 'BUY', lots: 1 };
    assert.strictEqual((await call('/api/paper/accounts/main/orders', { method: 'POST', cookie, body: 'instrument=x', type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.strictEqual((await call('/api/paper/accounts/main/orders', { method: 'POST', cookie, body: '{bad json' })).status, 400);
    const pv = await (await call('/api/paper/accounts/main/orders/preview', { method: 'POST', cookie, body: order })).json();
    assert(pv.ok && pv.fill.price === 120.5 && pv.availableAfter < pv.availableBefore, 'preview fills at the ask and nothing is saved');
    r = await call('/api/paper/accounts/main/orders', { method: 'POST', cookie, body: { ...order, source: 'agent' } });
    assert.strictEqual(r.status, 201, 'source is forced to manual, so no agent reason is demanded');
    const placed = await r.json();
    assert.strictEqual(placed.order.source, 'manual');
    assert.strictEqual(placed.trade.price, 120.5);
    r = await call('/api/paper/accounts/main/orders', { method: 'POST', cookie, body: { ...order, lots: 50 } });
    assert.strictEqual(r.status, 422);
    assert.strictEqual((await r.json()).code, 'BAD_LOTS');
    const rest = await (await call('/api/paper/accounts/main/orders', { method: 'POST', cookie, body: { ...order, orderType: 'LIMIT', limitPrice: 50 } })).json();
    assert.strictEqual(rest.order.status, 'OPEN');
    assert.strictEqual((await call('/api/paper/accounts/main/orders/xyz', { method: 'DELETE', cookie })).status, 400);
    assert.strictEqual((await call(`/api/paper/accounts/main/orders/${rest.order.id}`, { method: 'DELETE', cookie })).status, 200);
    assert.strictEqual((await call(`/api/paper/accounts/main/orders/${rest.order.id}`, { method: 'DELETE', cookie })).status, 422, 'already cancelled');

    // account view
    const view = await (await call('/api/paper/accounts/main', { cookie })).json();
    assert.strictEqual(view.summary.positions.length, 1);
    assert.strictEqual(view.orders[0].id, rest.order.id, 'newest order first');
    assert.strictEqual(view.trades.length, 1);
    const sv = view.summary;
    assert(Math.abs(sv.equity - (sv.startingCapital + sv.realized + sv.unrealized - sv.charges)) < 0.02);

    // reset, delete, sign out
    assert.strictEqual((await call('/api/paper/accounts/swing/reset', { method: 'POST', cookie, body: {} })).status, 200);
    assert.strictEqual((await call('/api/paper/accounts/swing', { method: 'DELETE', cookie, body: {} })).status, 200);
    const out = await call('/api/paper/session', { method: 'DELETE', cookie, body: {} });
    assert(/Max-Age=0/.test(out.headers.get('set-cookie')), 'sign out clears the cookie');
    for (const r2 of [await call('/api/paper/accounts', { cookie }), await call('/api/paper/market', { cookie })]) assert.strictEqual(r2.headers.get('cache-control'), 'no-store');

    // local development without PAPER_SECRET: open, for convenience
    delete process.env.VERCEL;
    delete process.env.PAPER_SECRET;
    assert.strictEqual((await call('/api/paper/accounts')).status, 200);
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.close();
  }
  console.log('paper trading API OK (owner sign-in, routes, cron tick, payoff, page wiring)');
})().catch(e => { console.error(e); process.exit(1); });
