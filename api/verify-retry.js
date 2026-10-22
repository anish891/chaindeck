const assert = require('assert');
const { withRetry } = require('./services/retry');

(async () => {
  const sleep = async () => {};
  // succeeds on the 3rd try
  let calls = 0;
  const v = await withRetry(async () => { calls += 1; if (calls < 3) throw new Error('nse'); return 'ok'; }, { sleep });
  assert.strictEqual(v, 'ok'); assert.strictEqual(calls, 3);

  // gives up after `attempts` and throws the last error
  calls = 0;
  await assert.rejects(() => withRetry(async () => { calls += 1; throw new Error(`fail ${calls}`); }, { attempts: 3, sleep }), /fail 3/);
  assert.strictEqual(calls, 3);

  // non-retryable errors are thrown at once (a bad expiry will never get better)
  calls = 0;
  const bad = Object.assign(new Error('bad'), { code: 'BAD_EXPIRY' });
  await assert.rejects(() => withRetry(async () => { calls += 1; throw bad; }, { sleep, shouldRetry: e => e.code !== 'BAD_EXPIRY' }), /bad/);
  assert.strictEqual(calls, 1);

  // stops retrying when the time budget is spent
  let clock = 0; calls = 0;
  await assert.rejects(() => withRetry(async () => { calls += 1; clock += 4000; throw new Error('slow'); }, { attempts: 5, delayMs: 800, budgetMs: 6500, now: () => clock, sleep }), /slow/);
  assert.strictEqual(calls, 2, 'a third 4s attempt would blow the budget');

  console.log('retry checks passed');
})().catch(e => { console.error(e); process.exit(1); });
