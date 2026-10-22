const assert = require('assert');
const F = require('./services/forwardlog');

const IST = 330 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 12, 9, 15) - IST; // 09:15 IST Monday
const bar = 5 * 60000;
const c = (i, o, h, l, cl, base = t0) => ({ t: base + i * bar, o, h, l, c: cl, v: 1000 });
const longEntry = (over = {}) => ({ id: 'x', kind: 'signal', interval: '5m', t: t0, recordedAt: t0, day: '2026-10-12', pattern: 'hammer', label: 'Hammer', dir: 'bull', score: 80, grade: 'strong', families: ['price', 'level', 'options'], trigger: 24300, invalidation: 24260, target: 24400, status: 'open', ...over });
const sig0 = c(0, 24280, 24300, 24265, 24295); // the signal candle itself (index 0)
const flatBar = (i, p = 24290) => c(i, p, p + 4, p - 4, p);

// ── signals: long side ──
{
  // triggers on bar 1 then reaches +1R (24340) on bar 3 -> win
  let r = F.resolveSignal(longEntry(), [sig0, c(1, 24298, 24305, 24290, 24302), c(2, 24302, 24320, 24300, 24318), c(3, 24318, 24345, 24316, 24340)]);
  assert.strictEqual(r.status, 'resolved'); assert.strictEqual(r.outcome, 'win'); assert.strictEqual(r.rMultiple, 1);
  assert.strictEqual(r.entryPrice, 24300);

  // triggers then hits the stop -> loss
  r = F.resolveSignal(longEntry(), [sig0, c(1, 24298, 24305, 24290, 24302), c(2, 24302, 24310, 24255, 24258)]);
  assert.strictEqual(r.outcome, 'loss'); assert.strictEqual(r.rMultiple, -1);

  // a candle that touches both the win level and the stop is a loss (conservative)
  r = F.resolveSignal(longEntry(), [sig0, c(1, 24298, 24305, 24290, 24302), c(2, 24302, 24345, 24255, 24300)]);
  assert.strictEqual(r.outcome, 'loss', 'ambiguous candle counts against us');

  // triggering candle that also breaches the stop is a loss too
  r = F.resolveSignal(longEntry(), [sig0, c(1, 24298, 24310, 24250, 24262)]);
  assert.strictEqual(r.outcome, 'loss');

  // gap above the trigger: entry is the open, not the trigger, so the win level moves with it
  r = F.resolveSignal(longEntry(), [sig0, c(1, 24312, 24320, 24310, 24318), c(2, 24318, 24330, 24316, 24328), c(3, 24328, 24355, 24326, 24350)]);
  assert.strictEqual(r.entryPrice, 24312);
  assert.strictEqual(r.outcome, 'win', 'risk 40 pts: 24312 + 40 = 24352 reached');
  assert.strictEqual(F.resolveSignal(longEntry(), [sig0, c(1, 24312, 24320, 24310, 24318), c(2, 24318, 24330, 24316, 24328), c(3, 24328, 24350, 24326, 24349)]).status, 'open', '24350 is short of 24352');

  // never triggers: expires after WAIT candles
  const quiet = [sig0, ...[1, 2, 3, 4, 5, 6].map(i => flatBar(i))];
  assert.strictEqual(F.resolveSignal(longEntry(), quiet).outcome, 'expired');
  // closes below the stop before triggering: invalidated, no trade
  assert.strictEqual(F.resolveSignal(longEntry(), [sig0, c(1, 24280, 24290, 24240, 24250)]).outcome, 'invalidated');

  // not enough candles yet: stays open
  assert.strictEqual(F.resolveSignal(longEntry(), [sig0, flatBar(1), flatBar(2)]).status, 'open');
  // triggered but unresolved and young: open, remembers the trigger
  const young = F.resolveSignal(longEntry(), [sig0, c(1, 24298, 24305, 24290, 24302), c(2, 24302, 24310, 24296, 24306)]);
  assert.strictEqual(young.status, 'open'); assert.ok(young.triggeredAt);

  // flat after HORIZON candles, scored at the close
  const drift = [sig0, c(1, 24298, 24305, 24290, 24302), ...Array.from({ length: 12 }, (_, i) => c(2 + i, 24302, 24315, 24290, 24310))];
  r = F.resolveSignal(longEntry(), drift);
  assert.strictEqual(r.outcome, 'flat'); assert.strictEqual(r.rMultiple, 0.25, '(24310-24300)/40');

  // candle series that no longer contains the signal candle is not scored against the wrong bars
  assert.strictEqual(F.resolveSignal(longEntry({ t: t0 - 10 * bar }), [sig0, flatBar(1)]).outcome, 'unknown');
}

// ── signals: short side mirrors ──
{
  const e = longEntry({ dir: 'bear', trigger: 24200, invalidation: 24240 });
  const s0 = c(0, 24230, 24235, 24200, 24205);
  assert.strictEqual(F.resolveSignal(e, [s0, c(1, 24204, 24208, 24195, 24198), c(2, 24198, 24199, 24150, 24158)]).outcome, 'win', 'short reaches 24160');
  assert.strictEqual(F.resolveSignal(e, [s0, c(1, 24204, 24208, 24195, 24198), c(2, 24198, 24245, 24190, 24243)]).outcome, 'loss');
}

// overnight: a trade that has not resolved by the end of its session is closed there
{
  const nextDay = t0 + 86400000;
  const entry = longEntry();
  const cs = [sig0, c(1, 24298, 24305, 24290, 24302), c(2, 24302, 24310, 24296, 24306), c(0, 24400, 24410, 24390, 24405, nextDay)];
  const r = F.resolveSignal(entry, cs);
  assert.strictEqual(r.status, 'resolved'); assert.strictEqual(r.outcome, 'flat');
  assert.strictEqual(r.resolvedAt, cs[2].t, 'closed at the last candle of its own session, ignoring the next day gap');
}

// ── zones ──
{
  const z = (over = {}) => ({ id: 'z', kind: 'zone', interval: '5m', t: t0, day: '2026-10-12', side: 'buy', low: 24200, high: 24210, mid: 24205, strength: 70, families: ['level', 'options'], atr: 30, tol: 20, status: 'open', ...over });
  const above = i => c(i, 24280, 24290, 24270, 24285);
  // touches then moves 1 ATR clear -> held
  let r = F.resolveZone(z(), [above(0), c(1, 24260, 24262, 24208, 24215), c(2, 24215, 24245, 24212, 24240)]);
  assert.strictEqual(r.outcome, 'held'); assert.ok(r.moveAtr >= 1);
  // touches then closes through -> broke
  r = F.resolveZone(z(), [above(0), c(1, 24260, 24262, 24205, 24212), c(2, 24212, 24215, 24150, 24170)]);
  assert.strictEqual(r.outcome, 'broke');
  // still the same session and nothing decisive: open
  assert.strictEqual(F.resolveZone(z(), [above(0), above(1)]).status, 'open');
  // next day arrives without a touch -> untouched; with a touch but no result -> inconclusive
  const nd = t0 + 86400000;
  assert.strictEqual(F.resolveZone(z(), [above(0), above(1), c(0, 24280, 24290, 24270, 24285, nd)]).outcome, 'untouched');
  assert.strictEqual(F.resolveZone(z(), [above(0), c(1, 24260, 24262, 24208, 24212), c(0, 24280, 24290, 24270, 24285, nd)]).outcome, 'inconclusive');
  // sell zone mirror
  const s = z({ side: 'sell', low: 24400, high: 24410, mid: 24405 });
  assert.strictEqual(F.resolveZone(s, [c(0, 24300, 24310, 24290, 24305), c(1, 24390, 24402, 24385, 24392), c(2, 24392, 24395, 24360, 24365)]).outcome, 'held');
}

// ── stats ──
{
  const mk = (outcome, over = {}) => ({ kind: 'signal', status: 'resolved', outcome, grade: 'strong', dir: 'bull', pattern: 'hammer', families: ['price', 'level'], rMultiple: outcome === 'win' ? 1 : outcome === 'loss' ? -1 : 0.2, ...over });
  const list = [...Array(7).fill(0).map(() => mk('win')), ...Array(3).fill(0).map(() => mk('loss')), mk('flat'), mk('expired', { rMultiple: undefined })];
  const st = F.computeStats(list);
  assert.strictEqual(st.signals.overall.wins, 7);
  assert.strictEqual(st.signals.overall.losses, 3);
  assert.strictEqual(st.signals.overall.winRate, 0.7);
  assert.strictEqual(st.signals.overall.verdict, 'insufficient', '10 decided trades can never be called an edge');
  assert.strictEqual(st.signals.neverTriggered, 1);
  assert.strictEqual(st.signals.overall.avgR, r(((7 * 1) - 3 + 0.2) / 11));
  assert.ok(st.signals.byOptions['without options'] && !st.signals.byOptions['with options']);

  // enough samples: 60 wins of 90 decided clears the 50 percent baseline
  const big = [...Array(60).fill(0).map(() => mk('win')), ...Array(30).fill(0).map(() => mk('loss'))];
  assert.strictEqual(F.computeStats(big).signals.overall.verdict, 'edge');
  const coin = [...Array(45).fill(0).map(() => mk('win')), ...Array(45).fill(0).map(() => mk('loss'))];
  assert.strictEqual(F.computeStats(coin).signals.overall.verdict, 'none');
  const bad = [...Array(25).fill(0).map(() => mk('win')), ...Array(65).fill(0).map(() => mk('loss'))];
  assert.strictEqual(F.computeStats(bad).signals.overall.verdict, 'negative');

  const zs = [0, 1, 2].map(() => ({ kind: 'zone', status: 'resolved', outcome: 'held', side: 'buy', families: ['level', 'options'] })).concat([{ kind: 'zone', status: 'resolved', outcome: 'broke', side: 'sell', families: ['level', 'volume', 'options'] }, { kind: 'zone', status: 'resolved', outcome: 'untouched', side: 'buy', families: ['level', 'options'] }]);
  const zst = F.computeStats(zs).zones;
  assert.strictEqual(zst.overall.held, 3); assert.strictEqual(zst.overall.broke, 1); assert.strictEqual(zst.overall.untouched, 1);
  assert.ok(zst.byEvidence['3 or more kinds agree']);
  function r(n) { return Math.round(n * 100) / 100; }
}

// ── storage: a fake store that implements exactly what makeRepo uses, and counts reads ──
function fakeStore() {
  const hashes = new Map(), lists = new Map(), strings = new Map();
  const reads = { hgetall: [], lrange: [] };
  const h = k => hashes.get(k) || hashes.set(k, new Map()).get(k);
  const exec = ([cmd, key, ...rest]) => {
    switch (cmd) {
      case 'HSET': h(key).set(String(rest[0]), String(rest[1])); return 1;
      case 'HDEL': return hashes.has(key) && h(key).delete(String(rest[0])) ? 1 : 0;
      case 'RPUSH': { const l = lists.get(key) || lists.set(key, []).get(key); l.push(String(rest[0])); return l.length; }
      case 'EXPIRE': return 1;
      default: throw new Error('unsupported ' + cmd);
    }
  };
  return {
    hashes, lists, strings, reads,
    async hgetall(k) { reads.hgetall.push(k); return Object.fromEntries(hashes.get(k) || []); },
    async hset(k, f, v) { return exec(['HSET', k, f, v]); },
    async lrange(k) { reads.lrange.push(k); return [...(lists.get(k) || [])]; },
    async pipeline(cmds) { return cmds.map(exec); },
    async get(k) { return strings.has(k) ? strings.get(k) : null; },
    async set(k, v) { strings.set(k, String(v)); return 'OK'; },
    async del(k) { hashes.delete(k); lists.delete(k); strings.delete(k); return 1; }
  };
}

// ── tick: records only fresh, confirmed things, once; then scores them ──
(async () => {
  const st = fakeStore();
  const repo = F.makeRepo(st);
  const now = t0 + 6 * bar; // 09:45 IST on 2026-10-12
  const candles = [sig0, c(1, 24298, 24305, 24290, 24302), c(2, 24302, 24320, 24300, 24318), c(3, 24318, 24345, 24316, 24340), c(4, 24340, 24344, 24330, 24338), c(5, 24338, 24342, 24330, 24335)];
  const mkSig = (over = {}) => ({ pattern: 'hammer', label: 'Hammer', t: t0, dir: 'bull', score: 80, grade: 'strong', confirmed: true, state: 'waiting', families: ['price', 'level', 'options'], trigger: 24300, invalidation: 24260, target: 24400, history: { verdict: 'none' }, ...over });
  const analysis = (over = {}) => ({ candles, feed: { stale: false, source: 'yahoo' }, spot: 24335, atr: 30, tolerance: 20, signals: [mkSig(), mkSig({ pattern: 'doji', confirmed: false }), mkSig({ pattern: 'old', t: t0 - 3 * 3600000 })], actionZones: [{ side: 'buy', low: 24200, high: 24210, mid: 24205, strength: 70, families: ['level', 'options'] }], zones: [], ...over });
  const doneEntries = () => [...st.lists.values()].flat().map(JSON.parse);
  const openEntries = () => [...(st.hashes.get(F.OPEN_KEY) || new Map()).values()].map(JSON.parse);

  let res = await F.tick({ '5m': analysis() }, { now, repo });
  assert.strictEqual(res.recorded, 2, 'one confirmed fresh signal and one zone; unconfirmed and old signals are ignored');
  const sigEntry = doneEntries().find(e => e.kind === 'signal');
  assert.ok(sigEntry && sigEntry.status === 'resolved' && sigEntry.outcome === 'win', 'scored in the same tick against the candles already available');
  assert.strictEqual(res.resolved, 1);
  assert.deepStrictEqual(openEntries().map(e => e.kind), ['zone'], 'the signal left the open set; the still-running zone stays');
  assert.ok(st.lists.has('fl:done:2026-10'), 'resolved entries are filed by month');

  res = await F.tick({ '5m': analysis() }, { now, repo });
  assert.strictEqual(res.recorded, 0, 'idempotent: a signal that already resolved is not recorded again while it is still on screen');
  assert.strictEqual(res.written, 0, 'and nothing is rewritten when nothing changed');
  assert.strictEqual(doneEntries().length, 1);

  // an open entry is only rewritten when it changes, and moves to the monthly list the moment it resolves
  const zoneOpen = openEntries()[0];
  const tomorrowCandles = [...candles, { t: t0 + 86400000, o: 24300, h: 24310, l: 24290, c: 24300, v: 1 }];
  res = await F.tick({ '5m': analysis({ candles: tomorrowCandles, actionZones: [] }) }, { now: now + 60000, repo });
  assert.strictEqual(res.resolved, 1, 'the zone resolves once the next day arrives');
  assert.strictEqual(openEntries().length, 0);
  assert.ok(doneEntries().some(e => e.id === zoneOpen.id && e.status === 'resolved'));

  // stale or non-Yahoo data never creates entries
  const st2 = fakeStore(), repo2 = F.makeRepo(st2);
  assert.strictEqual((await F.tick({ '5m': analysis({ feed: { stale: true, source: 'yahoo' } }) }, { now, repo: repo2 })).recorded, 0);
  assert.strictEqual((await F.tick({ '5m': analysis({ feed: { stale: false, source: 'stored' } }) }, { now, repo: repo2 })).recorded, 0);
  assert.strictEqual((await F.tick({ '5m': analysis() }, { now, repo: repo2, open: false })).recorded, 0, 'nothing is recorded outside market hours');
  assert.strictEqual((await F.tick({ '5m': analysis() }, { now: now + 40 * 60000, repo: repo2 })).recorded, 0, 'a lagging last bar (over 15 minutes behind) is not fresh');

  // log summary reads open entries plus the monthly lists
  const log = await F.getLog({ repo, now });
  assert.strictEqual(log.stats.signals.recorded, 1);
  assert.strictEqual(log.stats.zones.recorded, 1);
  assert.ok(log.recent.some(e => e.kind === 'signal' && e.outcome === 'win'));

  // ── ARCH-001: the per-minute tick does not read history, however much there is ──
  {
    const big = fakeStore(), bigRepo = F.makeRepo(big);
    const old = JSON.stringify({ id: 'x', kind: 'signal', status: 'resolved', outcome: 'win', day: '2026-09-10', t: 1 });
    big.lists.set('fl:done:2026-09', Array.from({ length: 5000 }, (_, i) => old.replace('"x"', `"x${i}"`)));
    big.strings.set('fl:migrated', '1');
    await F.tick({ '5m': analysis() }, { now, repo: bigRepo });
    assert.deepStrictEqual(big.reads.lrange, [], 'a tick never reads the resolved lists');
    assert.ok(big.reads.hgetall.every(k => k === F.OPEN_KEY || k.startsWith('fl:ids:')), `tick reads only the open set and id hashes: ${big.reads.hgetall}`);
    assert.ok(!big.reads.hgetall.includes('fl:entries'), 'the legacy all-entries hash is not read after migration');
  }

  // ── migration from the first layout (one hash of everything) ──
  {
    const m = fakeStore(), mRepo = F.makeRepo(m);
    const legacy = {
      a: { id: 'a', kind: 'signal', status: 'resolved', outcome: 'loss', day: '2026-10-12', t: t0, recordedAt: t0, families: ['price', 'level'] },
      b: { id: 'b', kind: 'zone', status: 'open', day: '2026-10-12', t: t0, interval: '5m', side: 'buy', low: 1, high: 2, mid: 1.5, atr: 5, tol: 1, families: ['level', 'options'] },
      c: { id: 'c', kind: 'signal', status: 'resolved', outcome: 'win', day: '2026-02-01', t: 5, recordedAt: 5, families: ['price'] }
    };
    m.hashes.set('fl:entries', new Map(Object.entries(legacy).map(([k, v]) => [k, JSON.stringify(v)])));
    const moved = await mRepo.migrateLegacy(now);
    assert.strictEqual(moved, 3);
    assert.deepStrictEqual((await mRepo.loadOpen()).map(e => e.id), ['b']);
    const resolved = await mRepo.loadResolved(6, now);
    assert.deepStrictEqual(resolved.map(e => e.id).sort(), ['a'], 'months older than the window are filed but outside the 6-month read');
    assert.ok(m.lists.has('fl:done:2026-02'), 'older entries are still stored, by month');
    assert.ok((await mRepo.loadSeen(['2026-10-12'])).has('a'), 'recent ids are marked seen so they are not recorded twice');
    assert.ok(!m.hashes.has('fl:entries'), 'the legacy hash is deleted after a successful migration');
    assert.strictEqual(await mRepo.migrateLegacy(now), 0, 'and it runs only once');
  }

  console.log('forward log checks passed');
})().catch(e => { console.error(e); process.exit(1); });
