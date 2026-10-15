const assert = require('assert');
const S = require('./services/signals');

const IST = 330 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 12, 9, 15) - IST;
const mk = (i, o, h, l, c, v = 1000) => ({ t: t0 + i * 300000, o, h, l, c, v });
const flat = n => Array.from({ length: n }, (_, i) => mk(i, 24300, 24315, 24285, 24300 + (i % 2 ? 4 : -4)));

const zone = (low, high, strength, kind, sources = [{ label: 'Put OI wall', type: 'putWall', family: 'options' }]) =>
  ({ low, high, mid: (low + high) / 2, strength, kind, families: sources.map(s => s.family), sources, touches: 0, held: 0, status: 'untested', distancePct: 0 });

// option evidence
{
  const strikes = [
    { strike: 24300, PE: { changeinOpenInterest: 900000 }, CE: { changeinOpenInterest: -200000 } },
    { strike: 24250, PE: { changeinOpenInterest: 300000 }, CE: { changeinOpenInterest: 0 } },
    { strike: 24900, PE: { changeinOpenInterest: 0 }, CE: { changeinOpenInterest: 100000 } }
  ];
  const bull = S.optionEvidence(strikes, 24300, 'bull');
  assert.ok(bull.strength > 0.5 && /put writing/.test(bull.text), `bull evidence, got ${JSON.stringify(bull)}`);
  const bear = S.optionEvidence(strikes, 24300, 'bear');
  assert.ok(bear.strength < bull.strength, 'put writing does not support a bearish read');
  assert.deepStrictEqual(S.optionEvidence([], 24300, 'bull'), { strength: 0, text: null });
}

// volume ratio
{
  const cs = flat(30);
  cs[29].v = 3000;
  assert.strictEqual(S.volumeRatio(cs, 29), 3);
  cs[29].v = null;
  assert.strictEqual(S.volumeRatio(cs, 29), null, 'no volume is null, not zero');
}

// signal: hammer at a strong support zone with put writing and volume -> confirmed, strong, with a plan
{
  const cs = flat(30);
  const i = cs.length;
  cs.push(mk(i, 24296, 24300, 24250, 24298, 3000)); // hammer-like candle
  cs.push(mk(i + 1, 24298, 24310, 24296, 24308, 1200)); // confirmation, took out the high
  const ladder = {
    spot: 24308, atr: 30, tolerance: 25,
    zones: [zone(24245, 24260, 80, 'support'), zone(24420, 24440, 60, 'resistance', [{ label: 'Call OI wall', type: 'callWall', family: 'options' }])]
  };
  const pattern = { i, t: cs[i].t, name: 'hammer', label: 'Hammer', dir: 'bull', kind: 'candle', quality: 0.8 };
  const strikes = [{ strike: 24250, PE: { changeinOpenInterest: 800000 }, CE: { changeinOpenInterest: 0 } }, { strike: 24500, PE: { changeinOpenInterest: 0 }, CE: { changeinOpenInterest: 50000 } }];
  const bt = { horizon: 12, patterns: { hammer: { name: 'hammer', n: 80, hitRate: 0.62, baseline: 0.5, ci: { low: 0.51, high: 0.72 }, verdict: 'edge' } } };
  const [sig] = S.buildSignals({ candles: cs, patterns: [pattern], ladder, strikes, backtest: bt, interval: '5m' });
  assert.ok(sig, 'signal produced');
  assert.strictEqual(sig.dir, 'bull');
  assert.ok(sig.confirmed && sig.families.length >= 3, `families ${sig.families}`);
  assert.ok(sig.score >= 70 && sig.grade === 'strong', `score ${sig.score}`);
  assert.strictEqual(sig.trigger, 24300);
  assert.ok(sig.invalidation < 24250);
  assert.strictEqual(sig.target, 24420);
  assert.ok(sig.rr > 1);
  assert.strictEqual(sig.state, 'triggered', 'a later candle already traded above the trigger');
  assert.strictEqual(sig.history.verdict, 'edge');

  // same setup but no historical edge scores lower, and is labelled
  const noEdge = { horizon: 12, patterns: { hammer: { ...bt.patterns.hammer, verdict: 'none' } } };
  const [weaker] = S.buildSignals({ candles: cs, patterns: [pattern], ladder, strikes, backtest: noEdge, interval: '5m' });
  assert.ok(weaker.score < sig.score, 'no edge lowers the score');

  // invalidated once price closes beyond the invalidation level
  const broken = [...cs, mk(i + 2, 24290, 24292, 24200, 24210)];
  assert.strictEqual(S.buildSignals({ candles: broken, patterns: [pattern], ladder, strikes, backtest: bt, interval: '5m' }).length, 0);

  // old patterns expire
  const aged = [...cs]; for (let k = 0; k < 8; k++) aged.push(mk(i + 2 + k, 24300, 24310, 24292, 24302));
  assert.strictEqual(S.buildSignals({ candles: aged, patterns: [pattern], ladder, strikes, backtest: bt, interval: '5m' }).length, 0);
}

// a lone pattern with nothing else agreeing is NOT confirmed
{
  const cs = flat(30);
  const i = cs.length;
  cs.push(mk(i, 24296, 24300, 24250, 24298, 900));
  const ladder = { spot: 24298, atr: 30, tolerance: 25, zones: [] };
  const pattern = { i, t: cs[i].t, name: 'hammer', label: 'Hammer', dir: 'bull', kind: 'candle', quality: 0.9 };
  const [sig] = S.buildSignals({ candles: cs, patterns: [pattern], ladder, strikes: [], backtest: null, interval: '5m' });
  assert.strictEqual(sig.confirmed, false);
  assert.strictEqual(sig.grade, 'weak');
  assert.deepStrictEqual(sig.families, ['price']);
  assert.ok(sig.evidence.some(e => /No volume|no expansion/.test(e.text)) || sig.evidence.length >= 2);
}

// bearish pattern at a support zone is penalised, not rewarded
{
  const cs = flat(30);
  const i = cs.length;
  cs.push(mk(i, 24300, 24350, 24298, 24302, 2500));
  const ladder = { spot: 24302, atr: 30, tolerance: 25, zones: [zone(24340, 24355, 80, 'support')] };
  const pattern = { i, t: cs[i].t, name: 'shootingStar', label: 'Shooting star', dir: 'bear', kind: 'candle', quality: 0.7 };
  const [sig] = S.buildSignals({ candles: cs, patterns: [pattern], ladder, strikes: [], backtest: null, interval: '5m' });
  assert.ok(!sig.families.includes('level'));
  assert.ok(sig.evidence.some(e => e.against));
}

// action zones need two evidence families
{
  const cs = flat(40);
  const ladder = { spot: 24300, tolerance: 25, atr: 30, zones: [
    { ...zone(24200, 24215, 70, 'support'), status: 'held', touches: 2, held: 2, distancePct: -0.35 },
    { ...zone(23900, 23910, 60, 'support'), distancePct: -0.8 },
    { ...zone(24400, 24415, 65, 'resistance'), distancePct: 0.4 }
  ] };
  const strikes = [{ strike: 24200, PE: { changeinOpenInterest: 700000 }, CE: { changeinOpenInterest: 0 } }];
  const zs = S.buildActionZones({ candles: cs, ladder, strikes, profile: { poc: 24410, vah: 24500, val: 24000, hvn: [] }, patterns: [], interval: '5m' });
  assert.strictEqual(zs.length, 2, 'support 23900 has only the level itself and is skipped');
  const buy = zs.find(z => z.side === 'buy');
  assert.ok(buy.families.includes('options') && buy.families.includes('price'));
  const sell = zs.find(z => z.side === 'sell');
  assert.deepStrictEqual(sell.families.sort(), ['level', 'volume']);
  assert.ok(zs.every(z => z.families.length >= 2));
}

console.log('signals checks passed');
