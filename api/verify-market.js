// Tests for the India VIX / index snapshot cache in services/market.js (no network: the NSE loader is replaced).
const assert = require('assert');
const market = require('./services/market');

const realNow = Date.now;
let clock = Date.UTC(2026, 9, 12, 5, 0);
Date.now = () => clock;

const snap = n => ({ nifty: { last: n }, vix: { last: 14 }, sectors: [], breadth: null });
const never = () => new Promise(() => {});
const sleepy = (ms, v) => () => new Promise(resolve => setTimeout(() => resolve(v), ms));

(async () => {
  try {
    // 1. a normal load is cached for 15 seconds
    let calls = 0;
    market._setIndexLoader(async () => { calls += 1; return snap(1); });
    assert.strictEqual((await market.getIndexSnapshot({ timeoutMs: 50 })).nifty.last, 1);
    clock += 10 * 1000;
    await market.getIndexSnapshot({ timeoutMs: 50 });
    assert.strictEqual(calls, 1, 'second call inside the TTL is served from cache');

    // 2. the bug: NSE slower than the timeout used to return null, blanking VIX and sectors.
    //    Now the last good snapshot is returned instead.
    {
      let hang = false;
      market._setIndexLoader(async () => (hang ? never() : snap(3)));
      await market.getIndexSnapshot(); // cache = snap(3)
      clock += 20 * 1000;              // cache expired
      hang = true;
      const t0 = realNow();
      const got = await market.getIndexSnapshot({ timeoutMs: 40 });
      assert(got && got.nifty.last === 3, 'slow NSE: the last good snapshot comes back, not null');
      assert(realNow() - t0 < 1000, 'and it comes back at the timeout, without waiting for NSE');
    }

    // 3. a failing NSE also falls back to the last good snapshot
    {
      let fail = false;
      market._setIndexLoader(async () => { if (fail) throw new Error('403'); return snap(4); });
      await market.getIndexSnapshot();
      clock += 20 * 1000;
      fail = true;
      assert.strictEqual((await market.getIndexSnapshot()).nifty.last, 4, 'NSE error: last good snapshot');
    }

    // 4. but never one older than 10 minutes: that would show stale VIX as live
    {
      let hang = false;
      market._setIndexLoader(async () => (hang ? never() : snap(5)));
      await market.getIndexSnapshot();
      clock += 11 * 60 * 1000;
      hang = true;
      assert.strictEqual(await market.getIndexSnapshot({ timeoutMs: 30 }), null, 'an 11-minute-old snapshot is not used');
    }

    // 5. a slow but successful load still updates the cache for the next caller
    {
      market._setIndexLoader(sleepy(80, snap(6)));
      const first = await market.getIndexSnapshot({ timeoutMs: 20 });
      assert.strictEqual(first, null, 'nothing cached yet and NSE slow: null');
      await new Promise(r => setTimeout(r, 120));
      assert.strictEqual((await market.getIndexSnapshot({ timeoutMs: 20 })).nifty.last, 6, 'the late answer was cached');
    }

    console.log('market snapshot checks passed');
  } finally {
    Date.now = realNow;
    market._setIndexLoader(null);
  }
})().catch(err => { console.error(err); process.exit(1); });
