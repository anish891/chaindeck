const assert = require('assert');
const C = require('../api/services/market/candles');

const IST = 330 * 60 * 1000;
// 2026-10-12 (Monday) 09:15 IST in epoch ms
const open = Date.UTC(2026, 9, 12, 9, 15) - IST;
const min = m => open + m * 60000;

// mergeVolume: exact timestamp for intraday, IST date for daily
{
  const idx = [{ t: min(0), o: 1, h: 2, l: 0, c: 1, v: null }, { t: min(5), o: 1, h: 2, l: 0, c: 1, v: null }];
  const etf = [{ t: min(5), o: 1, h: 1, l: 1, c: 1, v: 900 }];
  const m = C.mergeVolume(idx, etf);
  assert.strictEqual(m.candles[0].v, null);
  assert.strictEqual(m.candles[1].v, 900);
  assert.strictEqual(m.covered, 1);
  const d = C.mergeVolume([{ t: min(0), o: 1, h: 1, l: 1, c: 1, v: null }], [{ t: min(0) + 3600000, o: 1, h: 1, l: 1, c: 1, v: 5 }], true);
  assert.strictEqual(d.candles[0].v, 5, 'daily merge matches on IST date');
  assert.strictEqual(C.mergeVolume(idx, []).covered, 0);
}

// stored-spot fallback builds 5m candles with correct OHLC and ignores out-of-hours points
{
  const pts = [
    { t: min(0), spot: 100 }, { t: min(1), spot: 103 }, { t: min(2), spot: 98 }, { t: min(4), spot: 101 },
    { t: min(5), spot: 101 }, { t: min(9), spot: 105 },
    { t: min(-60), spot: 999 }, { t: min(400), spot: 999 }, { t: min(3), spot: NaN }
  ];
  const c = C.candlesFromSpotPoints(pts, 5);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c[0], { t: min(0), o: 100, h: 103, l: 98, c: 101, v: null });
  assert.deepStrictEqual(c[1], { t: min(5), o: 101, h: 105, l: 101, c: 105, v: null });
}

// live candles: one-minute candles from feed ticks, aggregated on the session grid and laid over the history
{
  C.clearCache();
  const feed = { subscribe: () => () => {}, on: () => () => {}, getState: () => ({ status: 'connected' }) };
  C.startLive(feed);
  const tick = (key, m, o, h, l, c, vol) => ({ key, ohlc: { I1: { ts: min(m), open: o, high: h, low: l, close: c, vol }, '1d': { ts: open - (9 * 60 + 15) * 60000, open: 90, high: 120, low: 80, close: c, vol: 0 } } });
  C.collectTicks([tick(C.SYMBOLS.index, 6, 100, 101, 99, 100.5, 0)]);
  C.collectTicks([tick(C.SYMBOLS.index, 6, 100, 103, 99, 102, 0)]); // the same minute again: the later tick wins
  C.collectTicks([tick(C.SYMBOLS.index, 7, 102, 104, 101, 103, 0), tick(C.SYMBOLS.index, 10, 103, 106, 102, 105, 0)]);
  C.collectTicks([tick('NSE_EQ|UNKNOWN', 7, 1, 1, 1, 1, 5), { key: C.SYMBOLS.index }]); // not a chart instrument / no candle: ignored
  assert.deepStrictEqual(
    C.aggregateMinutes([{ t: min(0), o: 1, h: 3, l: 1, c: 2, v: 10 }, { t: min(4), o: 2, h: 5, l: 0, c: 4, v: 5 }, { t: min(5), o: 4, h: 4, l: 4, c: 4, v: null }, { t: min(-1), o: 9, h: 9, l: 9, c: 9, v: 1 }, { t: min(375), o: 9, h: 9, l: 9, c: 9, v: 1 }], 5),
    [{ t: min(0), o: 1, h: 5, l: 0, c: 4, v: 15 }, { t: min(5), o: 4, h: 4, l: 4, c: 4, v: null }],
    'minutes are bucketed from 09:15; pre-open and post-close minutes are left out'
  );
  // history fetched during minute 6 holds candle 0-5 whole and candle 5-10 in part
  const history = [{ t: min(0), o: 98, h: 100, l: 97, c: 100, v: null }, { t: min(5), o: 100, h: 100.5, l: 99.5, c: 100.2, v: null }];
  const merged = C.withLive(C.SYMBOLS.index, history, '5m', min(6) + 20000);
  assert.deepStrictEqual(merged, [
    { t: min(0), o: 98, h: 100, l: 97, c: 100, v: null },
    { t: min(5), o: 100, h: 104, l: 99, c: 103, v: null },   // completed: history's open, the widest range, the live close
    { t: min(10), o: 103, h: 106, l: 102, c: 105, v: null }  // added
  ]);
  assert.deepStrictEqual(C.withLive(C.SYMBOLS.index, history, '5m', min(8)).map(c => c.c), [100, 100.2, 105], 'live minutes from before the history was fetched are not applied twice');
  // daily: today's candle comes from the feed's day candle
  const dayStart = open - (9 * 60 + 15) * 60000;
  const daily = C.withLive(C.SYMBOLS.index, [{ t: dayStart - 86400000, o: 1, h: 1, l: 1, c: 1, v: 7 }], '1d', min(0));
  assert.deepStrictEqual(daily[1], { t: dayStart, o: 90, h: 120, l: 80, c: 105, v: null });
  C.stopLive();
  C.clearCache();
}

// getCandles: history from the injected loader, volume merge, one lookup a day, and fallbacks (no network)
(async () => {
  C.clearCache();
  const feed = { subscribe: () => () => {}, on: () => () => {}, getState: () => ({ status: 'connected' }) };
  let calls = 0;
  const mk = (vol, n = 3) => Array.from({ length: n }, (_, i) => ({ t: min(i * 5), o: 100, h: 102, l: 98, c: 101, v: vol || null }));
  const ok = async key => { calls += 1; return mk(key === C.SYMBOLS.etf ? 5000 : 0); };
  const r = await C.getCandles('5m', { load: ok, feed });
  assert.strictEqual(r.source, 'upstox');
  assert.strictEqual(r.volumeSource, 'etf');
  assert.strictEqual(r.candles.length, 3);
  assert.strictEqual(r.candles[0].v, 5000);
  const before = calls;
  await C.getCandles('5m', { load: ok, feed });
  assert.strictEqual(calls, before, 'second call served from memory: history is looked up once a day');
  {
    // ...and again on the next IST day
    const origNow = Date.now;
    Date.now = () => origNow() + 24 * 3600 * 1000;
    await C.getCandles('5m', { load: ok, feed });
    Date.now = origNow;
    assert.strictEqual(calls, before + 2, 'a new day: index and ETF history are looked up again');
  }

  await assert.rejects(() => C.getCandles('1h', { load: ok, feed }), /Unsupported/, 'interval is whitelisted');

  // ETF fails: candles still returned, flagged as having no volume
  C.clearCache();
  const etfDown = async key => {
    if (key === C.SYMBOLS.etf) throw new Error('boom');
    return mk(0);
  };
  const r2 = await C.getCandles('5m', { load: etfDown, feed });
  assert.strictEqual(r2.source, 'upstox');
  assert.strictEqual(r2.volumeSource, 'none');

  // history fails entirely: stored spot fallback, then empty
  C.clearCache();
  const down = async () => { throw new Error('down'); };
  const origErr = console.error; console.error = () => {};
  const pts = [{ t: min(0), spot: 100 }, { t: min(2), spot: 101 }];
  const r3 = await C.getCandles('5m', { load: down, fallbackPoints: pts, feed });
  assert.strictEqual(r3.source, 'stored');
  assert.strictEqual(r3.candles.length, 1);
  C.clearCache();
  const r4 = await C.getCandles('5m', { load: down, feed });
  assert.strictEqual(r4.source, 'none');
  assert.deepStrictEqual(r4.candles, []);

  // The stored-history fallback is only loaded when the history lookup fails, never on an ordinary chart request.
  {
    let loads = 0;
    const loader = async () => { loads += 1; return pts; };
    C.clearCache();
    const fine = await C.getCandles('5m', { load: async () => mk(0), fallbackPoints: loader, feed });
    assert.strictEqual(fine.source, 'upstox');
    assert.strictEqual(loads, 0, 'history worked: storage is not read');
    C.clearCache();
    const fb = await C.getCandles('5m', { load: down, fallbackPoints: loader, feed });
    assert.strictEqual(fb.source, 'stored');
    assert.strictEqual(loads, 1, 'history down: storage is read once');
    C.clearCache();
    const broken = await C.getCandles('5m', { load: down, fallbackPoints: async () => { throw new Error('redis'); }, feed });
    assert.strictEqual(broken.source, 'none', 'a failing fallback loader degrades to no candles, not an error');
  }
  console.error = origErr;

  // stale cap: a failed refresh may reuse an old copy only while it is younger than the cap, and says so
  {
    C.clearCache();
    const origNow = Date.now;
    let clock = origNow();
    Date.now = () => clock;
    const prevErr = console.error; console.error = () => {};
    let fail = false;
    const loader = async () => { if (fail) throw new Error('down'); return { n: clock }; };
    const first = await C.cached('k', 1000, loader, 5000);
    assert.strictEqual(first.stale, false);
    clock += 500;
    assert.strictEqual((await C.cached('k', 1000, loader, 5000)).ts, first.ts, 'inside the TTL the cache is used');
    fail = true;
    clock += 2000; // TTL passed, refresh fails, copy is 2.5s old, cap is 5s
    const young = await C.cached('k', 1000, loader, 5000);
    assert.strictEqual(young.stale, true, 'leftover copy is flagged stale');
    assert.strictEqual(young.ts, first.ts, 'and keeps its real age');
    clock += 4000; // now 6.5s old, beyond the cap
    await assert.rejects(() => C.cached('k', 1000, loader, 5000), /down/, 'beyond the cap the error surfaces instead of an old picture');
    fail = false;
    assert.strictEqual((await C.cached('k', 1000, loader, 5000)).stale, false, 'recovers on the next success');
    console.error = prevErr;
    Date.now = origNow;
    assert.ok(C.STALE_MAX_OPEN_MS <= 5 * 60 * 1000, 'while the market is open a leftover copy never lives long');
  }

  C.stopLive();
  console.log('candles checks passed');
})().catch(e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
