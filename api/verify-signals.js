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

// a zone that was touched but never held (every close went through it, just not far enough to count as broken)
// must not be credited with price evidence: trackZones calls it 'held' with held === 0
{
  const cs = flat(40);
  const ladder = { spot: 24300, tolerance: 25, atr: 30, zones: [
    { ...zone(24200, 24215, 70, 'support'), status: 'held', touches: 3, held: 0, distancePct: -0.35 }
  ] };
  const zs = S.buildActionZones({ candles: cs, ladder, strikes: [], profile: null, patterns: [], interval: '5m' });
  assert.strictEqual(zs.length, 0, 'held 0 of 3 is not evidence, so the zone has only one family and is skipped');
  assert.ok(!JSON.stringify(zs).includes('Held on 0'), 'never shows "Held on 0 of N"');
}

// confirmation requires a level: pattern + volume at no zone is NOT a trade idea
{
  const cs = flat(30);
  const i = cs.length;
  cs.push(mk(i, 24296, 24300, 24250, 24298, 3000)); // big volume
  const ladder = { spot: 24298, atr: 30, tolerance: 25, zones: [] };
  const pattern = { i, t: cs[i].t, name: 'hammer', label: 'Hammer', dir: 'bull', kind: 'candle', quality: 0.9 };
  const [sig] = S.buildSignals({ candles: cs, patterns: [pattern], ladder, strikes: [], backtest: null, interval: '5m' });
  assert.ok(sig.families.includes('volume') && sig.families.length >= 2, 'two families agree');
  assert.strictEqual(sig.confirmed, false, 'but with no zone behind it the signal stays unconfirmed');
}

// marker selection: structural types only, quality floor, spacing, no negative record, confirmed signals always kept
{
  const P = (i, name, quality) => ({ i, t: i * 300000, name, quality, dir: 'bull' });
  const pats = [P(10, 'hammer', 0.9), P(12, 'bullEngulfing', 0.7), P(30, 'dojiLow', 0.95), P(40, 'tweezerBottom', 0.9), P(50, 'hammer', 0.5), P(60, 'morningStar', 0.8), P(70, 'hammer', 0.8)];
  let keep = S.selectNotable(pats, { interval: '5m' });
  assert.ok(keep.has('hammer|' + 10 * 300000), 'strong structural pattern kept');
  assert.ok(!keep.has('bullEngulfing|' + 12 * 300000), 'a weaker pattern within the spacing window loses to the stronger one');
  assert.ok(!keep.has('dojiLow|' + 30 * 300000) && !keep.has('tweezerBottom|' + 40 * 300000), 'noisy pattern types never get an arrow');
  assert.ok(!keep.has('hammer|' + 50 * 300000), 'low quality dropped');
  assert.ok(keep.has('morningStar|' + 60 * 300000) && keep.has('hammer|' + 70 * 300000));
  keep = S.selectNotable(pats, { interval: '5m', backtest: { patterns: { hammer: { verdict: 'negative' } } } });
  assert.ok(![...keep].some(k => k.startsWith('hammer|')), 'a pattern with a clearly negative record loses its arrow');
  keep = S.selectNotable(pats, { interval: '5m', signals: [{ confirmed: true, pattern: 'tweezerBottom', t: 40 * 300000 }] });
  assert.ok(keep.has('tweezerBottom|' + 40 * 300000), 'a pattern behind a confirmed signal always gets its arrow');
  // density: a dense run of detections collapses to well spaced markers
  const dense = Array.from({ length: 100 }, (_, i) => P(i, 'hammer', 0.7 + (i % 3) * 0.05));
  const kept = [...S.selectNotable(dense, { interval: '5m' })].length;
  assert.ok(kept <= 10, `100 candles of back-to-back patterns yield at most 10 arrows, got ${kept}`);
}

// context from the conditional backtest moves the score only when it is passed in, and explains itself
{
  const cs = flat(30);
  const i = cs.length;
  cs.push(mk(i, 24296, 24300, 24250, 24298, 3000));
  const ladder = { spot: 24298, atr: 30, tolerance: 25, zones: [zone(24245, 24260, 80, 'support')] };
  const pattern = { i, t: cs[i].t, name: 'hammer', label: 'Hammer', dir: 'bull', kind: 'candle', quality: 0.8 };
  const run = contextFor => S.buildSignals({ candles: cs, patterns: [pattern], ladder, strikes: [], backtest: null, interval: '5m', contextFor })[0];
  const base = run(null);
  const worse = run(() => ({ adjust: -10, lines: [{ family: 'context', text: 'midday: hit 41% vs 52%', against: true }] }));
  const better = run(() => ({ adjust: 6, lines: [{ family: 'context', text: 'first hour: hit 61% vs 48%' }] }));
  assert.strictEqual(worse.score, base.score - 10);
  assert.strictEqual(better.score, base.score + 6);
  assert.ok(worse.evidence.some(e => e.family === 'context' && e.against));
  assert.ok(!worse.families.includes('context') && !better.families.includes('context'), 'context never counts as a family that confirms a signal');
  assert.strictEqual(worse.confirmed, base.confirmed);
}

console.log('signals checks passed');
