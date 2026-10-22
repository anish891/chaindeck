const assert = require('assert');
const K = require('./services/conditions');
const { HORIZONS } = require('./services/backtest');

const IST = 330 * 60 * 1000;
const bar = 5 * 60000;
const open0 = Date.UTC(2026, 9, 12, 9, 15) - IST; // Mon 09:15 IST
const c = (i, o, h, l, cl, base = open0) => ({ t: base + i * bar, o, h, l, c: cl, v: 1000 });

// ── time buckets (IST) ──
assert.strictEqual(K.timeBucket(open0), 'open');
assert.strictEqual(K.timeBucket(open0 + 59 * 60000), 'open', '10:14');
assert.strictEqual(K.timeBucket(open0 + 60 * 60000), 'midday', '10:15');
assert.strictEqual(K.timeBucket(open0 + 299 * 60000), 'midday', '14:14');
assert.strictEqual(K.timeBucket(open0 + 300 * 60000), 'close', '14:15');

// ── day type uses only the session so far ──
{
  const trend = Array.from({ length: 12 }, (_, i) => c(i, 24000 + i * 20, 24000 + i * 20 + 22, 24000 + i * 20 - 2, 24000 + i * 20 + 20));
  assert.strictEqual(K.dayTypeAt(trend, 0, 3), 'early', 'fewer than 6 candles: too soon to say');
  assert.strictEqual(K.dayTypeAt(trend, 0, 11), 'trending');
  const chop = Array.from({ length: 12 }, (_, i) => c(i, 24000, 24030, 23970, 24000 + (i % 2 ? 10 : -10)));
  assert.strictEqual(K.dayTypeAt(chop, 0, 11), 'ranging');
  // a future crash does not change the label at an earlier candle
  const crash = trend.concat([c(12, 24240, 24250, 23000, 23100)]);
  assert.strictEqual(K.dayTypeAt(trend, 0, 11), 'trending');
  assert.strictEqual(K.dayTypeAt(crash, 0, 11), 'trending', 'a later crash cannot change an earlier label');
}

// ── level buckets ──
{
  const lv = [{ type: 'prevHigh', price: 24500 }, { type: 'round', price: 24500 }, { type: 'cprPivot', price: 24300 }];
  assert.strictEqual(K.levelBucket(24502, lv, 10), 'stacked');
  assert.strictEqual(K.levelBucket(24305, lv, 10), 'single');
  assert.strictEqual(K.levelBucket(24400, lv, 10), 'open');
}

// ── static levels ──
{
  const prior = { prevHigh: 24500, prevLow: 24200, prevClose: 24350, week: { high: 24700, low: 24000 } };
  const lv = K.staticLevels({ prior, prevDay: { h: 24500, l: 24200, c: 24350 }, open: 24310 });
  const types = new Set(lv.map(l => l.type));
  for (const t of ['prevHigh', 'prevLow', 'prevClose', 'weekHigh', 'weekLow', 'cprPivot', 'cprEdge', 'pivotR', 'pivotS', 'round']) assert.ok(types.has(t), t);
  assert.deepStrictEqual(K.staticLevels({ prior: null, prevDay: null, open: NaN }), []);
}

// ── the conditional backtest, on synthetic data ──
function randomMarket(sessions, seed) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [], daily = [];
  let price = 24000;
  for (let d = 0; d < sessions; d++) {
    const base = Date.UTC(2026, 6, 1 + d + Math.floor(d / 5) * 2, 3, 45);
    const first = price; let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < 75; i++) {
      const o = price, cl = o + (rnd() - 0.5) * 24;
      const h = Math.max(o, cl) + rnd() * 5, l = Math.min(o, cl) - rnd() * 5;
      out.push({ t: base + i * bar, o, h, l, c: cl, v: 1000 }); hi = Math.max(hi, h); lo = Math.min(lo, l); price = cl;
    }
    daily.push({ t: base, o: first, h: hi, l: lo, c: price, v: 1 });
  }
  return { candles: out, daily };
}
{
  const { candles, daily } = randomMarket(60, 3);
  const H = HORIZONS['5m'];
  const won = (i, dir) => (dir === 'bull' ? 1 : -1) * (candles[i + 1 + H].c - candles[i + 1].o) > 0;
  const env = K.buildEnv(candles, daily);
  const pick = (bucketFn, want, dir, count) => {
    const out = [];
    for (let i = 10; i + 2 + H < candles.length && out.length < count; i++) {
      if (new Date(candles[i].t + IST).getUTCDate() !== new Date(candles[i + 1 + H].t + IST).getUTCDate()) continue;
      if (bucketFn(candles[i], i) && won(i, dir) === want) out.push({ i, t: candles[i].t, name: 'hammer', dir, quality: 0.8 });
    }
    return out;
  };
  // planted skill: every midday bull pattern wins, every first-hour bull pattern loses; same random market underneath
  const patterns = [
    ...pick(cd => K.timeBucket(cd.t) === 'midday', true, 'bull', 60).filter((p, k) => k % 3 === 0),
    ...pick(cd => K.timeBucket(cd.t) === 'open', false, 'bull', 80)
  ];
  const r = K.conditionalBacktest(candles, daily, '5m', patterns);
  const mid = r.dims.time.midday.bull, op = r.dims.time.open.bull;
  assert.ok(mid.n >= 20 && mid.hitRate === 1, `midday sample is all wins (n=${mid.n})`);
  assert.ok(op.n >= 30 && op.hitRate === 0, `first-hour sample is all losses (n=${op.n})`);
  assert.strictEqual(op.verdict, 'negative', 'clearly worse than the first-hour baseline');
  assert.ok(Math.abs(op.baseline - 0.5) < 0.12, 'the baseline of a random walk is near a coin flip');
  assert.ok(mid.baselineN > 500, 'baseline uses every candle in that bucket, not just the patterns');
  assert.ok(r.dims.time.close.bull.n === 0 && r.dims.time.close.bull.verdict === 'insufficient' && r.dims.time.close.bull.hitRate === null, 'a bucket with baseline data but no patterns reports n=0, never a made-up rate');
  assert.ok(['edge', 'none', 'insufficient'].includes(mid.verdict));
  if (mid.n >= 30) assert.strictEqual(mid.verdict, 'edge');

  // too few samples can never be called anything
  const few = K.conditionalBacktest(candles, daily, '5m', patterns.slice(0, 5));
  for (const dim of K.DIMENSIONS) for (const b of Object.values(few.dims[dim])) for (const st of Object.values(b)) if (st.n < 30) assert.strictEqual(st.verdict, 'insufficient');

  // patterns of noisy types or low quality are not counted
  const junk = K.conditionalBacktest(candles, daily, '5m', patterns.map(p => ({ ...p, name: 'dojiLow' })));
  assert.strictEqual(junk.patternsUsed, 0);
  assert.strictEqual(K.conditionalBacktest(candles, daily, '1d', patterns), null, 'daily candles have no time-of-day to condition on');

  // causality: context of an early candle is unchanged when later candles are added
  const cut = candles.slice(0, 1500);
  const envCut = K.buildEnv(cut, daily);
  for (const i of [300, 800, 1200]) assert.deepStrictEqual(K.contextAt(cut, i, 'bull', envCut), K.contextAt(candles, i, 'bull', env));
  // direction matters for the level test (a bull reversal is judged at the low, a bear one at the high)
  const probe = K.contextAt(candles, 700, 'bull', env), probe2 = K.contextAt(candles, 700, 'bear', env);
  assert.strictEqual(probe.time, probe2.time);
}

// ── score adjustment ──
{
  const st = (verdict, n = 80) => ({ n, hitRate: 0.6, baseline: 0.5, verdict });
  const cond = { dims: { time: { midday: { bull: st('edge') } }, dayType: { ranging: { bull: st('negative') } }, level: { stacked: { bull: st('none') } } } };
  const ctx = { time: 'midday', dayType: 'ranging', level: 'stacked' };
  const r = K.contextAdjustment(cond, ctx, 'bull');
  assert.strictEqual(r.adjust, 6 - 10);
  assert.strictEqual(r.lines.length, 2, 'the no-difference bucket adds no line');
  assert.ok(r.lines.some(l => l.against) && r.lines.every(l => l.family === 'context'));
  assert.deepStrictEqual(K.contextAdjustment(null, ctx, 'bull'), { adjust: 0, lines: [] });
  const heavy = { dims: { time: { midday: { bull: st('negative') } }, dayType: { ranging: { bull: st('negative') } }, level: { stacked: { bull: st('negative') } } } };
  assert.strictEqual(K.contextAdjustment(heavy, ctx, 'bull').adjust, -20, 'capped');
  const good = { dims: { time: { midday: { bull: st('edge') } }, dayType: { ranging: { bull: st('edge') } }, level: { stacked: { bull: st('edge') } } } };
  assert.strictEqual(K.contextAdjustment(good, ctx, 'bull').adjust, 12, 'capped');
  assert.strictEqual(K.contextAdjustment({ dims: { time: { midday: { bull: st('insufficient') } } } }, ctx, 'bull').adjust, 0);
}

console.log('conditions checks passed');
