const assert = require('assert');
const root = require('path').join(__dirname, 'services') + '/';
const history = require(root + 'history');

const mk = (minOffset, callOI) => {
  const asOf = new Date(Date.UTC(2026, 9, 8, 4, 0 + minOffset)).toISOString(); // 09:30 IST + offset
  return {
    expiry: '13-Oct-2026', dataAsOf: asOf, fetchedAt: asOf, spot: 22200 + minOffset, pcr: 0.6 + minOffset / 1000,
    ntmPcr: 0.8, volPcr: 1, straddlePrice: 280, atmIv: 14, ivSkew: 2, vix: { last: 15 }, maxPain: 22400,
    gex: { totalGexCr: 100, gexRegime: 'POSITIVE_GAMMA' }, totalCallOI: callOI, totalPutOI: 2e6, totalCallChgOI: 1, totalPutChgOI: 2,
    impliedFuture: 22210, maxCallOIStrike: 23000, maxPutOIStrike: 21000, cpr: { cprType: 'WIDE' }, atm: 22250,
    strikes: [{ strike: 22250, CE: { openInterest: callOI / 100, changeinOpenInterest: 5, lastPrice: 100, impliedVolatility: 13 }, PE: { openInterest: 5000, changeinOpenInterest: 5, lastPrice: 110, impliedVolatility: 14 } }]
  };
};

(async () => {
  console.log('backend:', history.backend, 'persistent:', history.configured);
  for (let m = 0; m <= 40; m += 1) {
    const r = await history.recordSnapshot(mk(m, 3e6 + m * 1e4), [1, 2, 3]);
    assert(r.recorded, `minute ${m} should record: ${JSON.stringify(r)}`);
  }
  // duplicate NSE timestamp must not double-record
  assert.strictEqual((await history.recordSnapshot(mk(40, 3.4e6), [1])).recorded, false);

  const out = await history.getIntraday('13-Oct-2026');
  assert.strictEqual(out.date, '2026-10-08');
  assert.strictEqual(out.points.length, 41);
  const lastT = out.points.at(-1).t;
  assert.strictEqual((lastT - out.baselines.m5.t) / 60000, 5);
  assert.strictEqual((lastT - out.baselines.m15.t) / 60000, 15);
  assert.strictEqual((lastT - out.baselines.m30.t) / 60000, 30);
  assert.strictEqual(out.baselines.open.t, out.points[0].t);
  assert.deepStrictEqual(Object.keys(out.baselines.m5.strikes), ['22250']);
  assert.strictEqual(out.baselines.m5.strikes[22250][0], (3e6 + 35 * 1e4) / 100);

  // too little history → baseline is null, not a wrong value
  await history.recordSnapshot({ ...mk(0, 1e6), expiry: '20-Oct-2026' }, null);
  const young = await history.getIntraday('20-Oct-2026');
  assert.strictEqual(young.baselines.m5, undefined);
  assert(young.baselines.open);

  // session summary only after 15:20 IST (09:50 UTC)
  const late = mk(0, 3e6); late.dataAsOf = late.fetchedAt = new Date(Date.UTC(2026, 9, 8, 10, 0)).toISOString(); late.expiry = '27-Oct-2026';
  await history.recordSnapshot(late, [9, 9, 9]);
  const sessions = await history.getSessions(10);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].date, '2026-10-08');
  // out-of-order arrival (two instances racing) must not scramble the series or the baselines
  {
    const ex = '24-Nov-2026';
    for (const m of [5, 0, 3, 1, 4, 2, 6]) await history.recordSnapshot({ ...mk(m, 3e6 + m * 1e4), expiry: ex }, null);
    const o = await history.getIntraday(ex);
    assert.deepStrictEqual(o.points.map(p => p.t), [...o.points.map(p => p.t)].sort((a, b) => a - b), 'points are returned in time order');
    assert.strictEqual(o.baselines.open.t, o.points[0].t, 'open baseline is the earliest snapshot, not the first inserted');
  }

  // snapshot + strike-history reads
  const lastPoint = out.points.at(-1);
  const sh = await history.getStrikeHistory('13-Oct-2026', 22250, null, 10);
  assert(sh.samples.length <= 11 && sh.samples.length >= 8, `sampled to ~10, got ${sh.samples.length}`);
  assert.strictEqual(sh.samples[0].t, out.points[0].t, 'includes the first snapshot');
  assert.strictEqual(sh.samples.at(-1).t, lastPoint.t, 'includes the latest snapshot');
  assert(sh.samples.every(x => x.strike === 22250 && typeof x.ceOI === 'number' && typeof x.spot === 'number'));
  assert.deepStrictEqual((await history.getStrikeHistory('13-Oct-2026', 99999, null, 10)).samples, [], 'strike never stored → no samples');
  assert.deepStrictEqual((await history.getStrikeHistory('01-Jan-2030', 22250)).samples, [], 'unknown expiry → empty');

  // ── BUG-001 regression: a failed write must not mark the snapshot as handled ──
  {
    const store = require(root + 'storage');
    const realPipeline = store.pipeline;
    const snap = { ...mk(90, 3.9e6), expiry: '14-Oct-2026' };
    let failing = true;
    store.pipeline = async (...a) => { if (failing) throw new Error('Upstash down'); return realPipeline(...a); };
    await assert.rejects(() => history.recordSnapshot(snap, null), /Upstash down/);
    failing = false;
    const retry = await history.recordSnapshot(snap, null);
    assert.strictEqual(retry.recorded, true, 'the retry of a snapshot whose write failed must record it');
    assert.strictEqual((await history.recordSnapshot(snap, null)).recorded, false, 'and only once');
    store.pipeline = realPipeline;
    const got = await history.getIntraday('14-Oct-2026');
    assert.strictEqual(got.points.length, 1);

    // a failed claim (storage down at the very first call) also leaves the snapshot retryable
    const realSetNx = store.setNx;
    const snap2 = { ...mk(91, 3.9e6), expiry: '14-Oct-2026' };
    store.setNx = async () => { throw new Error('claim failed'); };
    await assert.rejects(() => history.recordSnapshot(snap2, null), /claim failed/);
    store.setNx = realSetNx;
    assert.strictEqual((await history.recordSnapshot(snap2, null)).recorded, true);

    // duplicate timestamps in the stored series (two instances racing) are collapsed on read
    await store.pipeline([['RPUSH', 'oi:s:2026-10-08:14-Oct-2026', JSON.stringify({ t: got.points[0].t, spot: 1 })]]);
    assert.strictEqual((await history.getIntraday('14-Oct-2026', '2026-10-08')).points.length, 2, 'duplicate t collapsed');
    assert.strictEqual(typeof (await store.get('oi:lastsnap')), 'string', 'last snapshot time is recorded for the monitor endpoint');
  }

  // ARCH-003: snapshot health for an uptime monitor
  {
    const IST = 330 * 60000;
    const at = (d, h, m) => Date.UTC(2026, 9, d, h, m) - IST;
    const monday = (h, m) => at(26, h, m); // Mon 26 Oct 2026 is a trading day
    assert.strictEqual(history.snapshotHealth(monday(11, 0) - 60000, monday(11, 0)).healthy, true, 'a minute-old snapshot while open');
    const stalled = history.snapshotHealth(monday(11, 0) - 10 * 60000, monday(11, 0));
    assert.strictEqual(stalled.healthy, false); assert.strictEqual(stalled.ageSec, 600);
    assert.strictEqual(history.snapshotHealth(null, monday(11, 0)).healthy, false, 'no snapshot at all while open');
    assert.strictEqual(history.snapshotHealth(null, monday(9, 17)).healthy, true, 'two minutes after the open there may be none yet');
    assert.strictEqual(history.snapshotHealth(monday(11, 0) - 99999999, monday(19, 0)).healthy, true, 'closed: always healthy');
    assert.strictEqual(history.snapshotHealth(null, at(20, 11, 0)).healthy, true, 'an NSE holiday (Dussehra) is closed');
    assert.strictEqual(history.snapshotHealth(null, at(24, 11, 0)).healthy, true, 'Saturday');
  }

  console.log('✓ history OK:', out.points.length, 'points; baselines', Object.keys(out.baselines).join(','), '; sessions', sessions.length);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
