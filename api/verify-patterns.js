const assert = require('assert');
const P = require('./services/patterns');
const B = require('./services/backtest');

const IST = 330 * 60 * 1000;
const day0 = Date.UTC(2026, 9, 12, 9, 15) - IST;
let seq = 0;
const cd = (o, h, l, c) => ({ t: day0 + seq++ * 300000, o, h, l, c, v: 1000 });
const reset = () => { seq = 0; };

// A steady fall of 12 candles with ~30-point ranges, so ATR is about 30 and the trend is clearly down.
function downtrend(start = 24600, n = 12) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) { out.push(cd(p, p + 8, p - 30, p - 22)); p -= 22; }
  return out;
}
function uptrend(start = 24000, n = 12) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) { out.push(cd(p, p + 30, p - 8, p + 22)); p += 22; }
  return out;
}
const names = list => list.map(x => x.name);
const last = cs => P.detectCandle(cs, cs.length - 1);

// hammer after a fall; hanging man in the same shape after a rise
{
  reset();
  const cs = downtrend();
  const lo = cs[cs.length - 1].c;
  cs.push(cd(lo, lo + 8, lo - 40, lo + 6)); // long lower shadow, tiny upper
  assert.ok(names(last(cs)).includes('hammer'), 'hammer after downtrend');
  assert.ok(!names(last(cs)).includes('hangingMan'));
  reset();
  const up = uptrend();
  const hi = up[up.length - 1].c;
  up.push(cd(hi, hi + 8, hi - 40, hi + 6));
  assert.ok(names(last(up)).includes('hangingMan'), 'same shape after uptrend is a hanging man');
  assert.ok(!names(last(up)).includes('hammer'));
}

// shooting star / inverted hammer
{
  reset();
  const up = uptrend();
  const hi = up[up.length - 1].c;
  up.push(cd(hi, hi + 45, hi - 8, hi - 6));
  assert.ok(names(last(up)).includes('shootingStar'));
  reset();
  const dn = downtrend();
  const lo = dn[dn.length - 1].c;
  dn.push(cd(lo, lo + 45, lo - 3, lo + 6));
  assert.ok(names(last(dn)).includes('invertedHammer'));
}

// engulfing, piercing, dark cloud, harami
{
  reset();
  let cs = downtrend();
  let lo = cs[cs.length - 1].c;
  cs.push(cd(lo + 2, lo + 4, lo - 25, lo - 20)); // bearish prior
  cs.push(cd(lo - 24, lo + 30, lo - 26, lo + 24)); // engulfs
  assert.ok(names(last(cs)).includes('bullEngulfing'));

  reset();
  cs = uptrend();
  let hi = cs[cs.length - 1].c;
  cs.push(cd(hi - 2, hi + 25, hi - 4, hi + 20));
  cs.push(cd(hi + 24, hi + 26, hi - 30, hi - 24));
  assert.ok(names(last(cs)).includes('bearEngulfing'));

  reset();
  cs = downtrend();
  lo = cs[cs.length - 1].c;
  cs.push(cd(lo + 2, lo + 4, lo - 40, lo - 36)); // bearish, body ~38
  cs.push(cd(lo - 44, lo - 10, lo - 46, lo - 12)); // opens below prior close, closes above midpoint (lo-17) but below its open
  const pierce = names(last(cs));
  assert.ok(pierce.includes('piercing'), `piercing, got ${pierce}`);

  reset();
  cs = uptrend();
  hi = cs[cs.length - 1].c;
  cs.push(cd(hi - 2, hi + 38, hi - 4, hi + 36)); // bullish, body ~38
  cs.push(cd(hi + 44, hi + 46, hi + 8, hi + 10)); // opens above prior close, closes below midpoint (hi+17), above its open
  assert.ok(names(last(cs)).includes('darkCloud'));

  reset();
  cs = downtrend();
  lo = cs[cs.length - 1].c;
  cs.push(cd(lo + 2, lo + 4, lo - 40, lo - 36));
  cs.push(cd(lo - 34, lo - 8, lo - 35, lo - 13)); // smaller bull body inside prior body
  assert.ok(names(last(cs)).includes('bullHarami'));
}

// morning and evening star
{
  reset();
  let cs = downtrend();
  let lo = cs[cs.length - 1].c;
  cs.push(cd(lo + 2, lo + 4, lo - 40, lo - 36));
  cs.push(cd(lo - 44, lo - 38, lo - 50, lo - 43)); // small body
  cs.push(cd(lo - 42, lo + 5, lo - 44, lo + 2)); // strong bull close above first midpoint
  assert.ok(names(last(cs)).includes('morningStar'));
  reset();
  cs = uptrend();
  let hi = cs[cs.length - 1].c;
  cs.push(cd(hi - 2, hi + 40, hi - 4, hi + 36));
  cs.push(cd(hi + 42, hi + 50, hi + 38, hi + 43));
  cs.push(cd(hi + 42, hi + 44, hi - 6, hi - 2));
  assert.ok(names(last(cs)).includes('eveningStar'));
}

// no reversal pattern without a trend to reverse
{
  reset();
  const flat = [];
  for (let i = 0; i < 12; i++) flat.push(cd(24300, 24315, 24285, i % 2 ? 24305 : 24295));
  flat.push(cd(24300, 24304, 24260, 24302));
  assert.deepStrictEqual(names(last(flat)).filter(n => n === 'hammer' || n === 'hangingMan'), [], 'hammer shape in a flat market is ignored');
}

// chart patterns: double top breaks the neckline; double bottom; sweep; none on noise
{
  reset();
  const path = [];
  const leg = (from, to, steps) => { for (let i = 1; i <= steps; i++) path.push(from + ((to - from) * i) / steps); };
  path.push(24000);
  leg(24000, 24200, 10);
  leg(24200, 24100, 6);
  leg(24100, 24198, 6);
  leg(24198, 24020, 10); // breaks the 24100 neckline
  const cs = path.map((p, i) => { const prev = i ? path[i - 1] : p; return cd(prev, Math.max(prev, p) + 6, Math.min(prev, p) - 6, p); });
  const found = P.detectChart(cs);
  assert.ok(names(found).includes('doubleTop'), `double top, got ${names(found)}`);
  const dt = found.find(x => x.name === 'doubleTop');
  assert.strictEqual(dt.dir, 'bear');
  assert.ok(dt.i > 22, 'fires after the second top is confirmed, on the neckline break');
  assert.ok(Math.abs(dt.level - 24094) < 12, 'neckline level reported');

  reset();
  const mir = path.map(p => 48000 - p);
  const cs2 = mir.map((p, i) => { const prev = i ? mir[i - 1] : p; return cd(prev, Math.max(prev, p) + 6, Math.min(prev, p) - 6, p); });
  assert.ok(names(P.detectChart(cs2)).includes('doubleBottom'));

  // sweep above a swing high, closing back below it
  reset();
  const sp = [];
  const legs = (from, to, steps) => { for (let i = 1; i <= steps; i++) sp.push(from + ((to - from) * i) / steps); };
  sp.push(24000); legs(24000, 24200, 10); legs(24200, 24120, 8); legs(24120, 24170, 8); legs(24170, 24150, 8);
  const cs3 = sp.map((p, i) => { const prev = i ? sp[i - 1] : p; return cd(prev, Math.max(prev, p) + 4, Math.min(prev, p) - 4, p); });
  cs3[10].h += 5; // a clean, strict swing high (ties are not swings)
  cs3.push(cd(24150, 24230, 24145, 24158)); // pokes above 24204 high, rejects hard
  const sw = P.detectChart(cs3).filter(x => x.name === 'sweepHigh');
  assert.strictEqual(sw.length, 1);
  assert.strictEqual(sw[0].i, cs3.length - 1);

  // short or noisy series produce nothing
  assert.deepStrictEqual(P.detectChart(cs3.slice(0, 10)), []);
}

// causality: appending future candles never changes what was detected earlier
{
  reset();
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cs = [];
  let p = 24000;
  for (let i = 0; i < 400; i++) {
    const o = p, c = p + (rnd() - 0.5) * 40, h = Math.max(o, c) + rnd() * 15, l = Math.min(o, c) - rnd() * 15;
    cs.push(cd(o, h, l, c));
    p = c;
  }
  const full = P.detectAll(cs);
  const cut = 300;
  const partial = P.detectAll(cs.slice(0, cut));
  const fullEarly = full.filter(x => x.i < cut - 4).map(x => `${x.i}|${x.name}`);
  const partEarly = partial.filter(x => x.i < cut - 4).map(x => `${x.i}|${x.name}`);
  assert.deepStrictEqual(partEarly, fullEarly, 'detections up to candle N never depend on later candles');
  assert.ok(full.length > 0, 'random data still triggers some patterns');
}

// Wilson interval and verdicts
{
  const ci = B.wilson(60, 100);
  assert.ok(Math.abs(ci.low - 0.502) < 0.01 && Math.abs(ci.high - 0.691) < 0.01, `wilson 60/100 got ${ci.low},${ci.high}`);
  assert.deepStrictEqual(B.wilson(0, 0), { low: 0, high: 1 });
  assert.strictEqual(B.verdict(10, { low: 0.9, high: 1 }, 0.5), 'insufficient', 'too few samples can never be an edge');
  assert.strictEqual(B.verdict(100, { low: 0.55, high: 0.7 }, 0.5), 'edge');
  assert.strictEqual(B.verdict(100, { low: 0.4, high: 0.6 }, 0.5), 'none');
  assert.strictEqual(B.verdict(100, { low: 0.2, high: 0.45 }, 0.5), 'negative');
}

// Backtest mechanics: entry is the NEXT open, hits counted in the pattern direction, session boundaries respected
{
  reset();
  const cs = [];
  for (let i = 0; i < 60; i++) cs.push(cd(24000 + i, 24005 + i, 23995 + i, 24002 + i)); // steady rise, one session
  const fake = [{ i: 10, name: 'hammer', dir: 'bull' }, { i: 20, name: 'shootingStar', dir: 'bear' }, { i: 58, name: 'hammer', dir: 'bull' }];
  const r = B.backtest(cs, '5m', fake);
  assert.strictEqual(r.patterns.hammer.n, 1, 'the one too close to the end is dropped');
  assert.strictEqual(r.patterns.hammer.hits, 1);
  assert.strictEqual(r.patterns.shootingStar.hits, 0, 'rising market makes a bear call miss');
  assert.ok(r.baseline.bull > 0.99 && r.baseline.bear < 0.01, 'baseline reflects the drift');
  assert.strictEqual(r.patterns.hammer.verdict, 'insufficient');

  // trades that would cross into the next session are excluded for intraday
  reset();
  const two = [];
  for (let i = 0; i < 30; i++) two.push(cd(24000, 24005, 23995, 24002));
  const next = day0 + 86400000;
  for (let i = 0; i < 30; i++) two.push({ t: next + i * 300000, o: 24000, h: 24005, l: 23995, c: 24002, v: 1 });
  const r2 = B.backtest(two, '5m', [{ i: 25, name: 'hammer', dir: 'bull' }, { i: 5, name: 'hammer', dir: 'bull' }]);
  assert.strictEqual(r2.patterns.hammer.n, 1, 'overnight trade excluded');
  assert.throws(() => B.backtest(two, '1h'), /Unsupported/);
}

console.log('pattern + backtest checks passed');
