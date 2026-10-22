const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/flow.js'), 'utf8');
  const { classifyFlow, FLOW_KINDS } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const spot = 24300;
  const sp = (type, strike, delta) => ({ type, strike, delta });

  // nothing in, quiet out
  let r = classifyFlow({ spikes: [], spot });
  assert.strictEqual(r.verdict, 'quiet'); assert.strictEqual(r.score, 0); assert.strictEqual(r.count, 0);

  // put writing near spot is buying pressure
  r = classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 60000)], spot });
  assert.strictEqual(r.verdict, 'bullish'); assert.ok(r.score > 15 && r.bullish.length === 1);
  assert.ok(/Buying pressure/.test(r.headline) && /24300/.test(r.headline));

  // call writing is selling pressure; put unwinding too
  r = classifyFlow({ spikes: [sp('CALL_WRITING', 24300, 60000), sp('PUT_UNWINDING', 24250, -40000)], spot });
  assert.strictEqual(r.verdict, 'bearish'); assert.strictEqual(r.bearish.length, 2); assert.ok(r.score < -15);
  r = classifyFlow({ spikes: [sp('CALL_COVERING', 24350, -50000)], spot });
  assert.strictEqual(r.verdict, 'bullish', 'short covering lifts price');

  // equal and opposite is mixed, not a direction
  r = classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 50000), sp('CALL_WRITING', 24300, 50000)], spot });
  assert.strictEqual(r.verdict, 'mixed'); assert.strictEqual(r.score, 0);

  // distance matters: the same move far from spot counts for much less
  const near = classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 50000)], spot });
  const far = classifyFlow({ spikes: [sp('PUT_WRITING', 25200, 50000)], spot });
  assert.ok(far.up < near.up / 3, `far ${far.up} vs near ${near.up}`);

  // size is capped so one enormous number cannot swamp everything
  const big = classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 5000000)], spot });
  const cap = classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 75000)], spot });
  assert.strictEqual(big.up, cap.up);

  // a flow at a strong level is boosted; a weak level is not
  const strong = classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 50000)], spot, zones: [{ low: 24290, high: 24310, kind: 'support', strength: 70 }] });
  assert.ok(strong.up > near.up);
  assert.deepStrictEqual(strong.bullish[0].level, { kind: 'support', low: 24290, high: 24310, strength: 70 });
  const weak = classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 50000)], spot, zones: [{ low: 24290, high: 24310, kind: 'support', strength: 30 }] });
  assert.strictEqual(weak.up, near.up);

  // volume surges are listed but never scored (direction is ambiguous)
  r = classifyFlow({ spikes: [], unusual: [{ strike: 24400, optionType: 'CE', intensity: 'HIGH', summary: 'x' }, { strike: 24300, optionType: 'PE', intensity: 'CRITICAL', summary: 'y' }], spot });
  assert.strictEqual(r.verdict, 'quiet'); assert.strictEqual(r.heavy.length, 2);
  assert.strictEqual(r.heavy[0].intensity, 'CRITICAL', 'critical first');

  // bad input is ignored, never thrown on
  r = classifyFlow({ spikes: [{ type: 'NOPE', strike: 24300, delta: 1 }, { type: 'PUT_WRITING', strike: NaN, delta: 1 }, sp('PUT_WRITING', 24300, 'x')], spot });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(classifyFlow({ spikes: [sp('PUT_WRITING', 24300, 50000)], spot: NaN }).count, 0);
  assert.ok(Object.keys(FLOW_KINDS).length === 4);

  console.log('flow panel logic checks passed');
})().catch(e => { console.error(e); process.exit(1); });
