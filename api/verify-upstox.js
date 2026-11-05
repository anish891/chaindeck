// Upstox client checks: no network, every reply comes from a fake fetch.
const assert = require('assert');
const upstox = require('./services/upstox');

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

  console.log('upstox checks passed');
})().catch(e => { console.error(e); process.exit(1); });
