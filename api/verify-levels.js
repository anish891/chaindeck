const assert = require('assert');
const L = require('./services/levels');

const IST = 330 * 60 * 1000;
const day0 = Date.UTC(2026, 9, 12, 9, 15) - IST; // Mon 12 Oct 2026 09:15 IST
const mk = (i, o, h, l, c, v = 1000, base = day0) => ({ t: base + i * 300000, o, h, l, c, v });

// ATR
{
  const cs = [mk(0, 100, 102, 98, 101), mk(1, 101, 105, 100, 104), mk(2, 104, 106, 103, 105)];
  assert.strictEqual(L.atr(cs), (5 + 3) / 2);
  assert.strictEqual(L.atr([]), 0);
}

// VWAP restarts each IST day and skips volume-less candles
{
  const d2 = day0 + 86400000;
  const cs = [mk(0, 100, 100, 100, 100, 100), mk(1, 110, 110, 110, 110, 300), mk(0, 200, 200, 200, 200, 50, d2), mk(1, 1, 1, 1, 1, null, d2)];
  const v = L.vwapSeries(cs);
  assert.strictEqual(v.length, 3);
  assert.strictEqual(v[1].value, (100 * 100 + 110 * 300) / 400);
  assert.strictEqual(v[2].value, 200, 'second day does not carry the first day');
}

// Volume profile: POC at the heaviest bin, value area contains it, HVN found
{
  const cs = [];
  for (let i = 0; i < 40; i++) cs.push(mk(i, 20000, 20005, 19995, 20000, 5000)); // heavy around 20000
  for (let i = 0; i < 10; i++) cs.push(mk(40 + i, 20100, 20105, 20095, 20100, 800));
  for (let i = 0; i < 10; i++) cs.push(mk(50 + i, 19900, 19905, 19895, 19900, 800));
  const p = L.volumeProfile(cs, 10);
  assert.ok(Math.abs(p.poc - 20000) <= 5, `POC near 20000, got ${p.poc}`);
  assert.ok(p.val <= p.poc && p.poc <= p.vah);
  assert.ok(p.hvn.length >= 1, 'secondary nodes detected');
  assert.strictEqual(L.volumeProfile(cs.slice(0, 2), 10), null, 'too little data');
  assert.strictEqual(L.volumeProfile(cs.map(c => ({ ...c, v: null })), 10), null, 'no volume, no profile');
}

// Swing points
{
  const highs = [10, 11, 12, 15, 12, 11, 10, 9, 10, 11, 12];
  const cs = highs.map((h, i) => mk(i, h - 1, h, h - 2, h - 1));
  const s = L.swingPoints(cs, 3);
  assert.deepStrictEqual(s.highs.map(x => x.price), [15]);
  assert.ok(s.lows.some(x => x.price === 7), 'low at index 7');
}

// Prior day and week ranges
{
  const D = (y, m, d, h, l, c) => ({ t: Date.UTC(y, m, d, 4) - 0, o: c, h, l, c, v: 1 });
  const daily = [
    D(2026, 9, 5, 120, 100, 110), // Mon prev week
    D(2026, 9, 9, 130, 105, 125), // Fri prev week
    D(2026, 9, 12 - 0, 140, 120, 135)
  ];
  daily[2].t = Date.UTC(2026, 9, 12, 4); // today, must be excluded
  const r = L.priorRanges(daily, '2026-10-12');
  assert.strictEqual(r.prevHigh, 130);
  assert.strictEqual(r.prevLow, 105);
  assert.strictEqual(r.week.high, 130);
  assert.strictEqual(r.week.low, 100);
  assert.strictEqual(L.priorRanges([], '2026-10-12'), null);
}

// Clustering: nearby levels merge, far ones stay apart, agreement across families raises strength
{
  const lv = (price, type) => ({ price, type, weight: L.SOURCES[type].weight, family: L.SOURCES[type].family, label: type });
  const zs = L.clusterLevels([lv(24500, 'callWall'), lv(24505, 'prevHigh'), lv(24498, 'vwap'), lv(24800, 'round'), lv(24100, 'putWall')], 15);
  assert.strictEqual(zs.length, 3);
  const top = zs.find(z => z.mid > 24490 && z.mid < 24510);
  assert.strictEqual(top.sources.length, 3);
  assert.deepStrictEqual(top.families.sort(), ['options', 'prior', 'volume']);
  const lone = zs.find(z => z.mid === 24800);
  assert.ok(top.strength > lone.strength, 'multi-family zone beats a lone round number');
  assert.ok(top.strength <= 100 && lone.strength >= 1);
  assert.deepStrictEqual(L.clusterLevels([], 10), []);
}

// Full ladder: kinds relative to spot, OI walls ranked by size, deterministic
{
  const spot = 24300;
  const input = {
    spot,
    walls: { calls: [{ strike: 24500, oi: 9e6 }, { strike: 24400, oi: 2e6 }], puts: [{ strike: 24100, oi: 8e6 }, { strike: 24200, oi: 1e6 }] },
    maxPain: 24300, zeroGamma: 24250,
    cpr: { pivot: 24310, tc: 24330, bc: 24290, r1: 24450, r2: 24600, s1: 24150, s2: 24000 },
    prior: { prevHigh: 24500, prevLow: 24100, prevClose: 24280, week: { high: 24650, low: 23950 } },
    candles: [], profile: null, vwap: 24295, atr: 40
  };
  const a = L.buildLadder(input);
  const b = L.buildLadder(input);
  assert.deepStrictEqual(a, b, 'deterministic');
  assert.ok(a.zones.length > 0 && a.zones.length <= 12);
  const res = a.zones.find(z => z.mid > 24480 && z.mid < 24520);
  const sup = a.zones.find(z => z.mid > 24090 && z.mid < 24110);
  assert.strictEqual(res.kind, 'resistance');
  assert.strictEqual(sup.kind, 'support');
  assert.ok(res.families.includes('options') && res.families.includes('prior'), 'call wall + previous high agree');
  assert.ok(a.zones.every((z, i, arr) => i === 0 || arr[i - 1].mid >= z.mid), 'sorted high to low');
  assert.ok(a.zones.some(z => z.kind === 'inside'), 'spot sits inside the pivot/vwap/max-pain cluster');
  const n = L.nearestZones(a);
  assert.ok(n.above.mid > spot && n.below.mid < spot);
  assert.strictEqual(L.buildLadder({ spot: NaN }).zones.length, 0);
}

// Zone tracking: untested / held / broken
{
  const zone = { low: 24500, high: 24505, mid: 24502, strength: 50, families: [], sources: [] };
  const tol = 10;
  const below = [mk(0, 24400, 24410, 24390, 24400)];
  assert.strictEqual(L.trackZones([zone], below, tol)[0].status, 'untested');
  const rejected = [mk(0, 24400, 24410, 24390, 24400), mk(1, 24480, 24503, 24475, 24485)];
  const t1 = L.trackZones([zone], rejected, tol)[0];
  assert.strictEqual(t1.status, 'held');
  assert.strictEqual(t1.touches, 1);
  assert.strictEqual(t1.held, 1);
  const broke = [...rejected, mk(2, 24490, 24540, 24488, 24535)];
  assert.strictEqual(L.trackZones([zone], broke, tol)[0].status, 'broken');
}

console.log('levels checks passed');
