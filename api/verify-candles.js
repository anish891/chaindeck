const assert = require('assert');
const C = require('./services/candles');

const IST = 330 * 60 * 1000;
// 2026-10-12 (Monday) 09:15 IST in epoch ms
const open = Date.UTC(2026, 9, 12, 9, 15) - IST;
const min = m => open + m * 60000;

// parseYahoo drops incomplete candles, de-duplicates and sorts
{
  const json = { chart: { result: [{ timestamp: [min(10) / 1000, min(0) / 1000, min(5) / 1000, min(10) / 1000], indicators: { quote: [{
    open: [10, 1, null, 5], high: [11, 2, 3, 6], low: [9, 0, 1, 4], close: [10.5, 1.5, 2, 5.5], volume: [100, 0, 50, 70]
  }] } }] } };
  const out = C.parseYahoo(json);
  assert.deepStrictEqual(out.map(c => c.t), [min(0), min(10)], 'null-OHLC and duplicate candles dropped, sorted');
  assert.strictEqual(out[0].v, null, 'zero volume becomes null');
  assert.strictEqual(out[1].v, 100);
  assert.deepStrictEqual(C.parseYahoo({}), []);
  assert.deepStrictEqual(C.parseYahoo({ chart: { result: null } }), []);
}

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

// getCandles: Yahoo path, volume merge, caching and fallbacks (injected fetch, no network)
(async () => {
  C.clearCache();
  let calls = 0;
  const mk = (vol, n = 3) => ({ chart: { result: [{ timestamp: Array.from({ length: n }, (_, i) => min(i * 5) / 1000), indicators: { quote: [{
    open: Array(n).fill(100), high: Array(n).fill(102), low: Array(n).fill(98), close: Array(n).fill(101), volume: Array(n).fill(vol)
  }] } }] } });
  const ok = async url => { calls += 1; return { json: async () => mk(decodeURIComponent(url).includes('NIFTYBEES') ? 5000 : 0) }; };
  const r = await C.getCandles('5m', { fetchImpl: ok });
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.volumeSource, 'etf');
  assert.strictEqual(r.candles.length, 3);
  assert.strictEqual(r.candles[0].v, 5000);
  const before = calls;
  await C.getCandles('5m', { fetchImpl: ok });
  assert.strictEqual(calls, before, 'second call served from cache');

  await assert.rejects(() => C.getCandles('1h', { fetchImpl: ok }), /Unsupported/, 'interval is whitelisted');

  // ETF fails: candles still returned, flagged as having no volume
  C.clearCache();
  const etfDown = async url => {
    if (decodeURIComponent(url).includes('NIFTYBEES')) throw new Error('boom');
    return { json: async () => mk(0) };
  };
  const r2 = await C.getCandles('5m', { fetchImpl: etfDown });
  assert.strictEqual(r2.source, 'yahoo');
  assert.strictEqual(r2.volumeSource, 'none');

  // Yahoo fails entirely: stored spot fallback, then empty
  C.clearCache();
  const down = async () => { throw new Error('down'); };
  const origErr = console.error; console.error = () => {};
  const pts = [{ t: min(0), spot: 100 }, { t: min(2), spot: 101 }];
  const r3 = await C.getCandles('5m', { fetchImpl: down, fallbackPoints: pts });
  assert.strictEqual(r3.source, 'stored');
  assert.strictEqual(r3.candles.length, 1);
  C.clearCache();
  const r4 = await C.getCandles('5m', { fetchImpl: down });
  assert.strictEqual(r4.source, 'none');
  assert.deepStrictEqual(r4.candles, []);
  console.error = origErr;

  console.log('candles checks passed');
})().catch(e => { console.error(e); process.exit(1); });
