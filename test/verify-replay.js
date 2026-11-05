// Expiry replay: the server reads a past expiry day back from history (list, frames, trimming), and the browser rebuilds
// the Expiry Day panel's input at each frame (public/js/expiry-day.js replayInput) so the readings match that moment.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const history = require('../api/services/storage/history');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const load = f => import('data:text/javascript;base64,' + Buffer.from(read(f)).toString('base64'));
const ist = s => Date.parse(`${s}+05:30`);

// One snapshot shaped like /api/option-chain data at minute `m` after 09:15 on 27 Oct 2026 (an expiry day).
const snap = (m, expiry = '27-Oct-2026', ymd = '2026-10-27') => {
  const asOf = new Date(ist(`${ymd}T09:15:00`) + m * 60000 + 5000).toISOString();
  const spot = 22750 + Math.round(20 * Math.sin(m / 30));
  return {
    expiry, dataAsOf: asOf, fetchedAt: asOf, spot, pcr: 1, ntmPcr: 1, volPcr: 1,
    straddlePrice: Math.max(5, 160 * Math.sqrt((375 - m) / 375)), atmIv: 15, ivSkew: 1, vix: { last: 15 }, maxPain: m < 200 ? 22700 : 22750,
    gex: { totalGexCr: 1000 + m }, totalCallOI: 1, totalPutOI: 1, totalCallChgOI: 0, totalPutChgOI: 0, impliedFuture: spot,
    strikes: Array.from({ length: 61 }, (_, i) => 21250 + i * 50).map(strike => ({
      strike,
      CE: { openInterest: 1e5, changeinOpenInterest: 0, lastPrice: Math.max(0.05, spot - strike), impliedVolatility: 15 },
      PE: { openInterest: strike === 22750 ? 3e5 : 1e5, changeinOpenInterest: 0, lastPrice: Math.max(0.05, strike - spot), impliedVolatility: 16 }
    }))
  };
};

(async () => {
  // ── frame picking: one per 10 minutes inside the session, always ending on the last snapshot ──
  const pts = [];
  for (let t = ist('2026-10-27T09:10:00'); t <= ist('2026-10-27T15:31:00'); t += 60000) pts.push({ t, spot: 1 });
  const frames = history.pickReplayFrames(pts);
  assert.strictEqual(frames.length, 39, '09:15 to 15:30 in 10-minute steps');
  assert.strictEqual(frames[0].t, ist('2026-10-27T09:15:00'), 'nothing before the open');
  assert.strictEqual(frames.at(-1).t, ist('2026-10-27T15:30:00'), 'ends on the close (later snapshots are after hours)');
  assert.strictEqual(history.pickReplayFrames([]).length, 0);
  assert.strictEqual(history.ymdToExpiry('2026-10-27'), '27-Oct-2026');

  const X = await load('public/js/expiry-day.js');

  if (history.configured) {
    console.log('replay: storage is Upstash, skipping the write/read part (it would write test data to production)');
  } else {
    for (let m = 0; m <= 375; m += 5) await history.recordSnapshot(snap(m), null);
    await history.recordSnapshot(snap(0, '03-Nov-2026'), null); // another contract the same day: not an expiry-day series

    const days = await history.listExpiryReplays(ist('2026-11-01T12:00:00'));
    assert.deepStrictEqual(days.map(d => d.expiry), ['27-Oct-2026'], 'only the contract that expired that day is listed');
    assert.strictEqual(days[0].date, '2026-10-27');
    assert.strictEqual(days[0].points, 76);
    assert.strictEqual(days[0].strikesKept, true, 'within 7 days the strike snapshots are still kept');
    assert.strictEqual((await history.listExpiryReplays(ist('2026-11-04T12:00:00')))[0].strikesKept, false, 'after 7 days: decay only');
    assert.deepStrictEqual(await history.listExpiryReplays(ist('2026-10-27T12:00:00')), [], 'today is live, not a replay');

    const r = await history.getExpiryReplay('27-Oct-2026');
    assert.strictEqual(r.date, '2026-10-27');
    assert.strictEqual(r.points.length, 76);
    assert(r.frames.length >= 38 && r.frames.length <= 39, `about one frame per 10 minutes, got ${r.frames.length}`);
    r.frames.forEach(f => f.strikes.forEach(row => {
      const p = r.points.find(x => x.t === f.t);
      assert(Math.abs(row[0] - p.spot) <= 600, 'frames keep only strikes near that moment\'s spot');
    }));
    assert(r.frames[0].strikes.length < 61, 'far strikes are trimmed');
    assert.deepStrictEqual((await history.getExpiryReplay('27-oct-2026')).points, [], 'malformed month is not read');

    // ── the browser rebuild at a mid-day frame reads the day as it stood then ──
    const i = r.frames.findIndex(f => f.t >= ist('2026-10-27T13:00:00'));
    const input = X.replayInput({ expiry: r.expiry, points: r.points, frames: r.frames }, i, 65);
    assert(input.points.every(p => p.t <= r.frames[i].t), 'no look-ahead: only snapshots up to the frame');
    const x = X.computeExpiryDay(input.d, input.points, input.nowMs);
    assert.strictEqual(x.status, 'ok');
    assert.strictEqual(x.isExpiryDay, true);
    assert.strictEqual(x.decay.status, 'ok');
    assert(x.decay.series.length > 10 && x.decay.series.at(-1).t <= r.frames[i].t);
    assert(x.minsLeft > 140 && x.minsLeft < 150, `13:0x leaves about 145 minutes, got ${x.minsLeft}`);
    assert.strictEqual(x.pin.heavy[0].strike, 22750, 'heaviest OI strike comes from the saved snapshot');
    assert(x.pin.maxPainProb > 0, 'pin probability uses the rebuilt 1 sigma move');
    assert(x.gamma.rows.length === 11 && x.gamma.rows.some(rw => rw.grossCr > 0), 'gamma recomputed from saved IVs');
    assert(x.gamma.gammaVsOpen > 1, 'ATM gamma grows into the afternoon');
    assert.strictEqual(x.gamma.zeroGamma, null, 'zero gamma is not stored, so it reads n/a');
  }

  // ── replayInput edge cases ──
  assert.strictEqual(X.replayInput(null, 0), null);
  assert.strictEqual(X.replayInput({ expiry: '27-Oct-2026', points: [], frames: [{ t: 1, strikes: [] }] }, 0), null, 'no snapshot before the frame');
  assert.strictEqual(X.replayInput({ expiry: '27-Oct-2026', points: [{ t: 1, spot: 1 }], frames: [] }, 0), null);
  const decayOnly = X.replayInput({ expiry: '27-Oct-2026', points: [{ t: ist('2026-10-27T10:00:00'), spot: 22700, straddle: 120, maxPain: 22700, atmIv: 15 }], frames: [{ t: ist('2026-10-27T10:00:00'), strikes: [] }] }, 0);
  assert.deepStrictEqual(decayOnly.d.strikes, [], 'decay-only days rebuild with no strikes');
  assert.strictEqual(X.computeExpiryDay(decayOnly.d, decayOnly.points, decayOnly.nowMs).status, 'ok', 'and still compute');

  // ── page wiring: live data must not overwrite a replay on screen ──
  const app = read('public/js/app.js');
  assert(/if \(replayActive\(\)\) return;/.test(app), 'renderExpiryDay leaves the panel alone during a replay');
  const mod = read('public/js/expiry-replay.js');
  assert(!/innerHTML/.test(mod), 'replay controls are built with textContent only');
  const route = read('api/routes/index.js');
  assert(/router\.get\('\/expiry-replay'[\s\S]{0,300}isPlausibleExpiry\(expiry\)/.test(route), 'expiry is validated');
  assert(/Only past expiry days can be replayed/.test(route), 'today (still live) is refused');

  console.log('expiry replay checks passed');
})().catch(e => { console.error(e); process.exit(1); });
