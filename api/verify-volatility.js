const assert = require('assert');
const v = require('./services/volatility');

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ± ${tol}`);
const ist = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 330 * 60000;

// 13-Oct-2026 expiry closes 15:30 IST = 10:00 UTC
assert.strictEqual(v.expiryCloseMs('13-Oct-2026'), Date.UTC(2026, 9, 13, 10, 0));
assert.strictEqual(v.expiryCloseMs('bad'), null);

// Trading minutes: one full session, partial sessions, weekends skipped
assert.strictEqual(v.tradingMinutesBetween(ist(2026, 10, 12, 9, 15), ist(2026, 10, 12, 15, 30)), 375);
assert.strictEqual(v.tradingMinutesBetween(ist(2026, 10, 12, 8, 0), ist(2026, 10, 12, 10, 15)), 60);
assert.strictEqual(v.tradingMinutesBetween(ist(2026, 10, 9, 15, 0), ist(2026, 10, 12, 9, 45)), 60); // Fri 30m + Mon 30m
assert.strictEqual(v.tradingMinutesBetween(ist(2026, 10, 10, 10, 0), ist(2026, 10, 11, 14, 0)), 0); // Sat-Sun
assert.strictEqual(v.tradingMinutesBetween(5, 5), 0);

// Trading-time IV: Friday close to Tuesday close spans a weekend, so it is above the calendar figure;
// Monday close to Wednesday close has no weekend, so it is below.
const fri = v.toTradingTimeIv(15, ist(2026, 10, 9, 15, 30), v.expiryCloseMs('13-Oct-2026'));
near(fri, 15 * Math.sqrt((4 / 365) / (750 / (252 * 375))), 1e-9, 'weekend-spanning trading IV');
assert(fri > 15);
const mon = v.toTradingTimeIv(15, ist(2026, 10, 12, 15, 30), v.expiryCloseMs('14-Oct-2026'));
assert(mon < 15);
assert.strictEqual(v.toTradingTimeIv(15, v.expiryCloseMs('13-Oct-2026') + 1, v.expiryCloseMs('13-Oct-2026')), null);
assert.strictEqual(v.toTradingTimeIv(0, 0, v.expiryCloseMs('13-Oct-2026')), null);

// Realised vol: a constant 0.05% one-minute move annualises to 0.0005 * sqrt(94500)
const t0 = ist(2026, 10, 12, 9, 15);
// Alternate up/down so every one-minute log return has magnitude 0.0005
const pts = [{ t: t0, spot: 22000 }];
for (let i = 1; i <= 70; i++) pts.push({ t: t0 + i * 60000, spot: pts[i - 1].spot * Math.exp(i % 2 ? 0.0005 : -0.0005) });
const expected = 0.0005 * Math.sqrt(252 * 375) * 100;
near(v.realisedVol(pts, 70, 15), expected, 1e-6, 'rv15');
near(v.realisedVol(pts, 70, 60), expected, 1e-6, 'rv60');
assert.strictEqual(v.realisedVol(pts, 3, 15), null, 'too few returns');
assert.strictEqual(v.realisedVol(pts, 20, 60), null, 'window not covered yet');

// Uneven spacing: same per-minute variance with 2-minute gaps gives the same answer
const sparse = [{ t: t0, spot: 22000 }];
for (let i = 1; i <= 35; i++) sparse.push({ t: t0 + i * 120000, spot: sparse[i - 1].spot * Math.exp(0.0005 * Math.SQRT2) });
near(v.realisedVol(sparse, sparse.length - 1, 30), expected, 1e-6, 'rv30 with 2-minute spacing');

// Series decoration keeps the input untouched
const series = v.addVolSeries(pts.map(p => ({ ...p, atmIv: 14 })), '13-Oct-2026');
assert.strictEqual(series.length, pts.length);
assert(series[70].rv15 > 0 && series[70].ivT > 0);
assert.strictEqual(series[2].rv15, null);
assert.strictEqual(pts[0].ivT, undefined);

// IV percentile
assert.deepStrictEqual(v.ivPercentile(15, [10, 12, 14, 16, 18]), { pct: 60, samples: 5 });
assert.deepStrictEqual(v.ivPercentile(15, [10, 12]), { pct: null, samples: 2 });

console.log('volatility checks passed');
