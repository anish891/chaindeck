const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const toUrl = f => 'data:text/javascript;base64,' + Buffer.from(f).toString('base64');
  const fresh = toUrl(fs.readFileSync(path.join(__dirname, '../public/js/freshness.js'), 'utf8'));
  const src = fs.readFileSync(path.join(__dirname, '../public/js/data-checks.js'), 'utf8').replace("'./freshness.js'", `'${fresh}'`);
  const M = await import(toUrl(src));

  const IST = 330 * 60000;
  const now = Date.UTC(2026, 9, 22, 6, 0); // 11:30 IST Thursday
  const d = { spot: 22700, strikes: [{ strike: 22700, CE: { openInterest: 100, lastPrice: 120, totalTradedVolume: 50 }, PE: { openInterest: 90, lastPrice: 110, totalTradedVolume: 40 } }], dataAsOf: '2026-10-22T05:59:00.000Z' };
  const pass = id => ({ id, group: 'Option chain', label: id, level: 'pass', detail: 'ok' });
  const serverOk = { checks: ['chain_rows', 'oi_totals', 'pcr_recompute', 'max_pain', 'atm_strike', 'parity', 'basis'].map(pass) };
  const candlesOk = { hasCandles: true, interval: '5m', clientFetchedAt: now - 10000, lastClose: 22702, feed: { source: 'yahoo', stale: false, lastBarT: now - 3 * 60000 } };
  const savedOk = { points: Array.from({ length: 140 }, (_, i) => ({ t: Date.parse('2026-10-22T09:15:00+05:30') + i * 60000 })) };
  const base = (over = {}) => ({ now, marketOpen: true, chain: { d, ageSec: 40, stale: false, integrity: serverOk }, candles: candlesOk, saved: { points: savedOk.points.slice(0, 135) }, content: { sameCount: 0 }, ...over });
  const by = r => Object.fromEntries(r.checks.map(c => [c.id, c]));

  // everything healthy
  let r = M.evaluateTrust(base());
  assert.strictEqual(r.status, 'ok', JSON.stringify(r.checks.filter(c => c.level !== 'pass')));
  assert.strictEqual(r.blocking, false);
  assert.strictEqual(r.summary.fail, 0);

  // slow NSE: amber, then red and blocking
  r = M.evaluateTrust(base({ chain: { d, ageSec: 120, stale: false, integrity: serverOk } }));
  assert.strictEqual(by(r).nse_fresh.level, 'warn'); assert.strictEqual(r.status, 'warn'); assert.strictEqual(r.blocking, false);
  r = M.evaluateTrust(base({ chain: { d, ageSec: 240, stale: false, integrity: serverOk } }));
  assert.strictEqual(by(r).nse_fresh.level, 'fail'); assert.strictEqual(r.status, 'bad'); assert.strictEqual(r.blocking, true, 'a 4 minute stall pauses signals and alerts');
  assert.ok(r.reasons.length && /current/.test(r.reasons[0]));

  // leftover copy is blocking and says why
  r = M.evaluateTrust(base({ chain: { d, ageSec: 30, stale: true, staleReason: 'NSE payload rejected: spot jumped', integrity: serverOk } }));
  assert.strictEqual(by(r).nse_stale_copy.level, 'fail'); assert.ok(/rejected/.test(by(r).nse_stale_copy.detail)); assert.strictEqual(r.blocking, true);

  // after the close a leftover copy is expected: warning only, nothing pauses
  r = M.evaluateTrust(base({ marketOpen: false, chain: { d, ageSec: 30, stale: true, staleReason: 'timeout', integrity: serverOk } }));
  assert.strictEqual(by(r).nse_stale_copy.level, 'warn'); assert.strictEqual(r.blocking, false); assert.strictEqual(r.status, 'warn');

  // closed market: nothing time-based is a problem
  r = M.evaluateTrust(base({ marketOpen: false, chain: { d, ageSec: 99999, stale: false, integrity: serverOk } }));
  assert.strictEqual(r.status, 'ok'); assert.strictEqual(by(r).nse_content.level, 'skip');

  // frozen content: identical snapshots in a row
  r = M.evaluateTrust(base({ content: { sameCount: 3 } })); assert.strictEqual(by(r).nse_content.level, 'warn'); assert.strictEqual(r.blocking, false);
  r = M.evaluateTrust(base({ content: { sameCount: 5 } })); assert.strictEqual(by(r).nse_content.level, 'fail'); assert.strictEqual(r.blocking, true);

  // cross-source spot check
  r = M.evaluateTrust(base({ candles: { ...candlesOk, lastClose: 22700 * 1.003 } })); assert.strictEqual(by(r).spot_vs_yahoo.level, 'warn');
  r = M.evaluateTrust(base({ candles: { ...candlesOk, lastClose: 22700 * 1.01 } })); assert.strictEqual(by(r).spot_vs_yahoo.level, 'fail'); assert.strictEqual(r.blocking, true);
  r = M.evaluateTrust(base({ candles: { ...candlesOk, feed: { ...candlesOk.feed, source: 'stored' } } })); assert.strictEqual(by(r).spot_vs_yahoo.level, 'skip', 'saved-spot candles are not an independent source');
  r = M.evaluateTrust(base({ candles: null })); assert.strictEqual(by(r).spot_vs_yahoo.level, 'skip');

  // server integrity failures flow through, and only the blocking ones pause
  const bad = id => ({ ...pass(id), level: 'fail', detail: 'mismatch' });
  r = M.evaluateTrust(base({ chain: { d, ageSec: 30, stale: false, integrity: { checks: [bad('pcr_recompute'), pass('basis')] } } }));
  assert.strictEqual(r.status, 'bad'); assert.strictEqual(r.blocking, true); assert.strictEqual(r.flags.pcr_recompute, 'fail');
  r = M.evaluateTrust(base({ chain: { d, ageSec: 30, stale: false, integrity: { checks: [bad('day_range')] } } }));
  assert.strictEqual(r.status, 'bad'); assert.strictEqual(r.blocking, false, 'a failed day-range check is shown but does not pause signals');
  r = M.evaluateTrust(base({ chain: { d, ageSec: 30, stale: false, integrity: null } }));
  assert.strictEqual(by(r).integrity_engine.level, 'warn', 'missing server checks never count as verified');

  // no data at all
  r = M.evaluateTrust({ now, marketOpen: true, chain: null, candles: null, saved: null, content: null });
  assert.strictEqual(r.status, 'bad'); assert.strictEqual(r.blocking, true);

  // content tracker
  let st = null;
  const snap = (asOf, oi) => ({ dataAsOf: asOf, spot: 22700, strikes: [{ strike: 22700, CE: { openInterest: oi, lastPrice: 1 }, PE: { openInterest: 5, lastPrice: 1 } }] });
  st = M.trackContent(st, snap('a', 100));
  assert.strictEqual(st.sameCount, 0);
  st = M.trackContent(st, snap('a', 100)); assert.strictEqual(st.sameCount, 0, 'the same snapshot seen twice is not a new one');
  st = M.trackContent(st, snap('b', 100)); assert.strictEqual(st.sameCount, 1);
  st = M.trackContent(st, snap('c', 100)); assert.strictEqual(st.sameCount, 2);
  st = M.trackContent(st, snap('d', 101)); assert.strictEqual(st.sameCount, 0, 'any change resets it');
  assert.strictEqual(M.trackContent(null, null).sameCount, 0);

  // snapshot coverage
  const open = Date.parse('2026-10-22T09:15:00+05:30');
  const pts = n => Array.from({ length: n }, (_, i) => ({ t: open + i * 60000 }));
  assert.strictEqual(M.snapshotCoverage(pts(10), open + 10 * 60000, true), null, 'too early to judge');
  let cov = M.snapshotCoverage(pts(135), open + 135 * 60000, true);
  assert.ok(cov.ratio > 0.97 && cov.largestGap === 0);
  const gappy = pts(135).filter((_, i) => i < 40 || i > 70); // 31 missing minutes
  cov = M.snapshotCoverage(gappy, open + 135 * 60000, true);
  assert.strictEqual(cov.largestGap, 31); assert.ok(cov.ratio < 0.8);
  r = M.evaluateTrust(base({ saved: { points: gappy } }));
  assert.strictEqual(by(r).saved_coverage.level, 'warn', 'incomplete history warns but never fails');
  assert.ok(/longest gap 31/.test(by(r).saved_coverage.detail));
  assert.strictEqual(M.evaluateTrust(base({ saved: { points: pts(30), persistent: true } })).blocking, false);
  // no storage configured: skipped, not judged
  r = M.evaluateTrust(base({ saved: { points: gappy, persistent: false } }));
  assert.strictEqual(by(r).saved_fresh.level, 'skip'); assert.strictEqual(by(r).saved_coverage, undefined);
  assert.strictEqual(M.snapshotCoverage([], now, true), null);

  assert.ok(M.BLOCKING.has('parity') && !M.BLOCKING.has('day_range'));
  console.log('data checks passed');
})().catch(e => { console.error(e); process.exit(1); });
