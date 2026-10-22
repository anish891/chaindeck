const assert = require('assert');
const S = require('./services/scorecard');

const IST = 330 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 12, 9, 15) - IST;
const bar = 5 * 60000;
const c = (i, o, h, l, cl) => ({ t: t0 + i * bar, o, h, l, c: cl, v: 1000 });
const P = { ...S.PARAMS }; // band 0.15, bounce 0.5, break 0.25, horizon 12 -> with ATR 20: band 3, bounce 10, break 5
const atrs = n => new Array(n).fill(20);
const scan = (cs, v = 24300, from = 0, to = cs.length - 1) => S.scanLevel(cs, atrs(cs.length), from, to, () => v, () => true, P);

// ── the touch test ──
{
  // support: comes from above, touches, closes well away -> bounce on the touch candle itself
  let ev = scan([c(0, 24330, 24335, 24325, 24330), c(1, 24330, 24332, 24299, 24312)]);
  assert.deepStrictEqual(ev.map(e => [e.outcome, e.side]), [['bounce', 'support']]);

  // a wick through the level that closes back above is still a bounce, not a break
  ev = scan([c(0, 24330, 24335, 24325, 24330), c(1, 24330, 24332, 24288, 24312)]);
  assert.strictEqual(ev[0].outcome, 'bounce');

  // closes through by more than 0.25 ATR -> break
  ev = scan([c(0, 24330, 24335, 24325, 24330), c(1, 24330, 24332, 24285, 24290)]);
  assert.strictEqual(ev[0].outcome, 'break');

  // touch candle closes only slightly clear; the next candle's high carries the bounce
  ev = scan([c(0, 24330, 24335, 24325, 24330), c(1, 24310, 24311, 24299, 24304), c(2, 24304, 24315, 24303, 24312)]);
  assert.strictEqual(ev[0].outcome, 'bounce');

  // a later candle that reaches the bounce size by its high but CLOSES through is a break (conservative)
  ev = scan([c(0, 24330, 24335, 24325, 24330), c(1, 24310, 24311, 24299, 24304), c(2, 24304, 24316, 24280, 24288)]);
  assert.strictEqual(ev[0].outcome, 'break');

  // neither: hovers around the level for the whole horizon
  const hover = [c(0, 24330, 24335, 24325, 24330), c(1, 24310, 24311, 24299, 24304), ...Array.from({ length: 14 }, (_, k) => c(2 + k, 24304, 24307, 24298, 24303))];
  ev = scan(hover);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].outcome, 'neither');

  // not armed: the previous close was inside the band, so a touch is not a test
  assert.deepStrictEqual(scan([c(0, 24302, 24305, 24298, 24302), c(1, 24302, 24310, 24299, 24308)]), []);
  // never reaches the level
  assert.deepStrictEqual(scan([c(0, 24330, 24335, 24325, 24330), c(1, 24330, 24340, 24320, 24335)]), []);

  // resistance mirrors it: comes from below
  ev = scan([c(0, 24270, 24275, 24265, 24270), c(1, 24270, 24301, 24268, 24288)]);
  assert.deepStrictEqual(ev.map(e => [e.outcome, e.side]), [['bounce', 'resistance']]);
  ev = scan([c(0, 24270, 24275, 24265, 24270), c(1, 24270, 24315, 24268, 24310)]);
  assert.strictEqual(ev[0].outcome, 'break');

  // after an event the level cannot fire again until the horizon has passed (no double counting of one chop)
  const again = [c(0, 24330, 24335, 24325, 24330), c(1, 24330, 24332, 24299, 24312), c(2, 24312, 24334, 24310, 24330), c(3, 24330, 24332, 24299, 24312)];
  assert.strictEqual(scan(again).length, 1);

  // the horizon never reaches past the session end
  const ending = [c(0, 24330, 24335, 24325, 24330), c(1, 24310, 24311, 24299, 24304), c(2, 24304, 24305, 24300, 24303)];
  assert.strictEqual(scan(ending, 24300, 0, 2)[0].outcome, 'neither');
  const spill = [...ending, c(3, 24304, 24330, 24303, 24325), ...Array.from({ length: 14 }, (_, k) => c(4 + k, 24325, 24328, 24322, 24325))]; // would be a bounce, but the session ended at index 2
  assert.strictEqual(scan(spill, 24300, 0, 2)[0].outcome, 'neither');

  // causality: changing candles after the event window does not change an earlier verdict
  const base = [c(0, 24330, 24335, 24325, 24330), c(1, 24330, 24332, 24299, 24312), ...Array.from({ length: 20 }, (_, k) => c(2 + k, 24330, 24334, 24325, 24330))];
  const wild = base.slice(0, 15).concat(Array.from({ length: 7 }, (_, k) => c(15 + k, 24100, 24500, 24000, 24400)));
  assert.deepStrictEqual(scan(base).filter(e => e.i < 2), scan(wild).filter(e => e.i < 2));
}

// ── rolling ATR is causal ──
{
  const cs = Array.from({ length: 30 }, (_, i) => c(i, 100, 110, 90, 100));
  const a = S.rollingAtr(cs);
  const shifted = cs.slice(0, 20).concat(Array.from({ length: 10 }, (_, i) => c(20 + i, 100, 500, 1, 100)));
  assert.deepStrictEqual(S.rollingAtr(shifted).slice(0, 20), a.slice(0, 20));
}

// ── whole scorecard on synthetic markets ──
function market({ seed, sessions = 60, reflectEvery = 0 }) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const gauss = () => { let x = 0; for (let i = 0; i < 6; i++) x += rnd(); return (x - 3) * 1.4; };
  const out = [], daily = [];
  let price = 24000;
  for (let d = 0; d < sessions; d++) {
    const base = Date.UTC(2026, 6, 1 + d + Math.floor(d / 5) * 2, 3, 45); // weekdays-ish, 09:15 IST
    let hi = -Infinity, lo = Infinity;
    const first = price;
    for (let i = 0; i < 75; i++) {
      const o = price;
      let cl = o + gauss() * 9;
      if (reflectEvery) { // bounce off every multiple of `reflectEvery`, like a level that is truly respected
        const g = Math.round(cl / reflectEvery) * reflectEvery;
        if ((o - g) * (cl - g) < 0 || Math.abs(cl - g) < 2) cl = 2 * g - cl + (o > g ? 6 : -6);
      }
      const h = Math.max(o, cl) + rnd() * 4, l = Math.min(o, cl) - rnd() * 4;
      out.push({ t: base + i * bar, o, h, l, c: cl, v: 1000 + Math.floor(rnd() * 500) });
      hi = Math.max(hi, h); lo = Math.min(lo, l); price = cl;
    }
    daily.push({ t: base, o: first, h: hi, l: lo, c: price, v: 1 });
  }
  return { candles: out, daily };
}
{
  const m = market({ seed: 11 });
  const card = S.buildScorecard(m.candles, m.daily);
  assert.strictEqual(card.sessions, 60);
  assert.ok(card.null.touches > 100, 'the baseline has plenty of events');
  for (const t of ['prevHigh', 'prevLow', 'cprPivot', 'swingHigh', 'swingLow', 'vwap', 'poc', 'round']) assert.ok(card.types[t], `${t} measured`);
  assert.deepStrictEqual(card.notMeasured, ['callWall', 'putWall', 'maxPain', 'zeroGamma']);
  assert.deepStrictEqual(S.buildScorecard(m.candles, m.daily), card, 'deterministic');
  // a pure random walk has no real levels: nothing should look "respected" beyond a stray false positive
  const respected = Object.values(card.types).filter(t => t.verdict === 'respected').length;
  assert.ok(respected <= 2, `random walk produced ${respected} respected level types`);
  for (const t of Object.values(card.types)) assert.ok(t.bounce + t.break + t.neither === t.touches);

  // a market that genuinely bounces off round numbers is detected as such
  const r = market({ seed: 5, reflectEvery: 100 });
  const rc = S.buildScorecard(r.candles, r.daily);
  assert.strictEqual(rc.types.round.verdict, 'respected', `round bounce ${rc.types.round.bounceRate} vs baseline ${rc.types.round.baseline}`);
  assert.ok(rc.types.round.bounceRate > rc.types.round.baseline + 0.1);
}

// ── weight multipliers: only proven types move, and only within bounds ──
{
  const card = { types: {
    a: { verdict: 'respected', bounceRate: 0.70, baseline: 0.55 },
    b: { verdict: 'respected', bounceRate: 0.95, baseline: 0.50 },
    c: { verdict: 'ignored', bounceRate: 0.40, baseline: 0.55 },
    d: { verdict: 'none', bounceRate: 0.60, baseline: 0.55 },
    e: { verdict: 'insufficient', bounceRate: 1, baseline: 0.5 }
  } };
  const m = S.weightMultipliers(card);
  assert.ok(Math.abs(m.a - 1.375) <= 0.006, 'about +37 percent: ' + m.a);
  assert.strictEqual(m.b, 1.5, 'capped at +50 percent');
  assert.strictEqual(m.c, 0.6);
  assert.ok(!('d' in m) && !('e' in m), 'unproven types keep their default weight');
  assert.deepStrictEqual(S.weightMultipliers(null), {});
}

console.log('scorecard checks passed');
