// Forward log: every confirmed signal and buying / selling zone is saved when it first appears, then scored against
// what price actually did next. This is the only honest test of the option-chain evidence, because there are no
// historical option chains to backtest against.
//
// Everything that scores is a pure function of (entry, candles), so a missed cron tick or a restart changes nothing:
// the next tick re-reads the candles and reaches the same verdict.
//
// Signal outcome (long shown; short is the mirror image):
//   wait up to WAIT candles for price to trade through the trigger        -> else "expired" / "invalidated" (no trade)
//   once triggered, risk R = trigger - invalidation, entry = trigger (or the open if it gapped past it)
//   win  = price gets +1R before touching the invalidation level
//   loss = invalidation touched first (a candle that touches both counts as a loss: conservative)
//   flat = neither within HORIZON candles or by the session close; scored at the close
// A fair coin gives win/(win+loss) of 50 percent, which is the baseline the panel compares against.
//
// Zone outcome: "held" if price reached the zone and then moved 1 ATR away before closing through it, "broke" if it
// closed through it first, "inconclusive" if neither by the close, "untouched" if price never got there.

const store = require('./storage');
const { wilson } = require('./backtest');
const { istDay } = require('./candles');

const KEY = 'fl:entries';
const BAR_MS = { '5m': 5 * 60000, '15m': 15 * 60000 };
const WAIT = { '5m': 6, '15m': 4 };       // candles to wait for the trigger
const HORIZON = { '5m': 12, '15m': 8 };   // candles to run after the trigger
const WIN_R = 1;
const MIN_SAMPLES = 30;
const MAX_SIGNAL_AGE_MS = 45 * 60 * 1000; // only record signals that are fresh by the clock, not replays of old candles

const sign = dir => (dir === 'bull' ? 1 : -1);

// ── entries ──────────────────────────────────────────────────────────────

function signalEntry(sig, interval, recordedAt) {
  return {
    id: `sig|${interval}|${sig.pattern}|${sig.t}`,
    kind: 'signal',
    interval,
    t: sig.t,
    recordedAt,
    day: istDay(sig.t),
    pattern: sig.pattern,
    label: sig.label,
    dir: sig.dir,
    score: sig.score,
    grade: sig.grade,
    families: sig.families,
    verdict: sig.history ? sig.history.verdict : 'insufficient',
    trigger: sig.trigger,
    invalidation: sig.invalidation,
    target: sig.target || null,
    status: 'open'
  };
}

function zoneEntry(z, interval, lastCandleT, recordedAt, atr, tol) {
  return {
    id: `zone|${istDay(lastCandleT)}|${z.side}|${Math.round(z.mid / 10) * 10}`,
    kind: 'zone',
    interval,
    t: lastCandleT,
    recordedAt,
    day: istDay(lastCandleT),
    side: z.side,
    low: z.low,
    high: z.high,
    mid: z.mid,
    strength: z.strength,
    families: z.families,
    atr,
    tol,
    status: 'open'
  };
}

// ── scoring (pure) ───────────────────────────────────────────────────────

function resolveSignal(entry, candles) {
  const bar = BAR_MS[entry.interval];
  const wait = WAIT[entry.interval];
  const horizon = HORIZON[entry.interval];
  const i0 = candles.findIndex(c => c.t === entry.t);
  if (i0 < 0) return candles.length && candles[0].t > entry.t ? { ...entry, status: 'resolved', outcome: 'unknown' } : entry;
  const d = sign(entry.dir);
  const trig = entry.trigger, inv = entry.invalidation;
  const risk = Math.abs(trig - inv);
  if (!(risk > 0)) return { ...entry, status: 'resolved', outcome: 'unknown' };
  const crossesTrigger = c => (d > 0 ? c.h >= trig : c.l <= trig);
  const touchesInv = c => (d > 0 ? c.l <= inv : c.h >= inv);
  const closeBeyondInv = c => (d > 0 ? c.c < inv : c.c > inv);
  const after = candles.slice(i0 + 1);

  // phase 1: wait for the trigger
  let k = -1;
  for (let j = 0; j < after.length && j < wait; j++) {
    const c = after[j];
    if (crossesTrigger(c)) { k = j; break; }
    if (closeBeyondInv(c)) return { ...entry, status: 'resolved', outcome: 'invalidated', resolvedAt: c.t };
  }
  if (k < 0) {
    return after.length >= wait ? { ...entry, status: 'resolved', outcome: 'expired', resolvedAt: after[wait - 1].t } : entry;
  }

  // phase 2: triggered
  const tc = after[k];
  const entryPrice = d > 0 ? Math.max(trig, tc.o) : Math.min(trig, tc.o);
  const winLevel = entryPrice + d * WIN_R * risk;
  const base = { ...entry, triggeredAt: tc.t, entryPrice };
  const tradeDay = istDay(tc.t);
  if (touchesInv(tc)) return { ...base, status: 'resolved', outcome: 'loss', rMultiple: -1, mfeR: 0, resolvedAt: tc.t };

  let mfe = 0, mae = 0, last = tc;
  const run = after.slice(k + 1, k + 1 + horizon);
  for (const c of run) {
    if (istDay(c.t) !== tradeDay) { // overnight: close the trade at the last candle of its own session
      return { ...base, status: 'resolved', outcome: 'flat', rMultiple: r2(((last.c - entryPrice) * d) / risk), mfeR: r2(mfe), maeR: r2(mae), resolvedAt: last.t };
    }
    const favour = d > 0 ? c.h - entryPrice : entryPrice - c.l;
    const adverse = d > 0 ? entryPrice - c.l : c.h - entryPrice;
    if (touchesInv(c)) return { ...base, status: 'resolved', outcome: 'loss', rMultiple: -1, mfeR: r2(mfe), maeR: r2(Math.max(mae, adverse / risk)), resolvedAt: c.t };
    if ((d > 0 ? c.h >= winLevel : c.l <= winLevel)) return { ...base, status: 'resolved', outcome: 'win', rMultiple: WIN_R, mfeR: r2(Math.max(mfe, favour / risk)), maeR: r2(mae), resolvedAt: c.t };
    mfe = Math.max(mfe, favour / risk);
    mae = Math.max(mae, adverse / risk);
    last = c;
  }
  if (run.length >= horizon) return { ...base, status: 'resolved', outcome: 'flat', rMultiple: r2(((last.c - entryPrice) * d) / risk), mfeR: r2(mfe), maeR: r2(mae), resolvedAt: last.t };
  return { ...base, status: 'open', mfeR: r2(mfe), maeR: r2(mae) };
}

function resolveZone(entry, candles) {
  const day = entry.day;
  const buy = entry.side === 'buy';
  const reach = entry.tol * 0.25;
  const away = entry.atr; // 1 ATR clear of the zone counts as a hold
  const sessionCandles = candles.filter(c => c.t > entry.t && istDay(c.t) === day);
  const dayOver = candles.some(c => istDay(c.t) > day);

  let touchedAt = null, best = 0;
  for (const c of sessionCandles) {
    let touchCandle = false;
    if (touchedAt === null) {
      if (buy ? c.l <= entry.high + reach : c.h >= entry.low - reach) { touchedAt = c.t; touchCandle = true; } else continue;
    }
    // On the candle that first reaches the zone the high may have come BEFORE the touch, so only its close counts as a bounce.
    const far = touchCandle ? (buy ? c.c - entry.high : entry.low - c.c) : (buy ? c.h - entry.high : entry.low - c.l);
    best = Math.max(best, far);
    const through = buy ? c.c < entry.low - entry.tol : c.c > entry.high + entry.tol;
    if (through) return { ...entry, status: 'resolved', outcome: 'broke', touchedAt, moveAtr: r2(best / entry.atr), resolvedAt: c.t };
    if (best >= away) return { ...entry, status: 'resolved', outcome: 'held', touchedAt, moveAtr: r2(best / entry.atr), resolvedAt: c.t };
  }
  if (!dayOver) return touchedAt ? { ...entry, touchedAt, moveAtr: r2(best / entry.atr) } : entry;
  return { ...entry, status: 'resolved', outcome: touchedAt ? 'inconclusive' : 'untouched', touchedAt, moveAtr: r2(best / entry.atr) };
}

const r2 = n => Math.round(n * 100) / 100;

function resolveEntry(entry, candles) {
  return entry.kind === 'zone' ? resolveZone(entry, candles) : resolveSignal(entry, candles);
}

// ── statistics (pure) ────────────────────────────────────────────────────

function winStats(list) {
  const wins = list.filter(e => e.outcome === 'win').length;
  const losses = list.filter(e => e.outcome === 'loss').length;
  const flat = list.filter(e => e.outcome === 'flat').length;
  const decided = wins + losses;
  const ci = wilson(wins, decided);
  const traded = list.filter(e => Number.isFinite(e.rMultiple));
  const avgR = traded.length ? traded.reduce((s, e) => s + e.rMultiple, 0) / traded.length : null;
  let verdict = 'insufficient';
  if (decided >= MIN_SAMPLES) verdict = ci.low > 0.5 ? 'edge' : ci.high < 0.5 ? 'negative' : 'none';
  return { n: list.length, wins, losses, flat, decided, winRate: decided ? wins / decided : null, ci, avgR: avgR === null ? null : r2(avgR), verdict };
}

function holdStats(list) {
  const held = list.filter(e => e.outcome === 'held').length;
  const broke = list.filter(e => e.outcome === 'broke').length;
  const decided = held + broke;
  const ci = wilson(held, decided);
  let verdict = 'insufficient';
  if (decided >= MIN_SAMPLES) verdict = ci.low > 0.5 ? 'edge' : ci.high < 0.5 ? 'negative' : 'none';
  return { n: list.length, held, broke, inconclusive: list.filter(e => e.outcome === 'inconclusive').length, untouched: list.filter(e => e.outcome === 'untouched').length, decided, holdRate: decided ? held / decided : null, ci, verdict };
}

function computeStats(entries) {
  const sigs = entries.filter(e => e.kind === 'signal');
  const zones = entries.filter(e => e.kind === 'zone');
  const sigDone = sigs.filter(e => e.status === 'resolved');
  const traded = sigDone.filter(e => ['win', 'loss', 'flat'].includes(e.outcome));
  const groups = (list, keyFn) => {
    const out = {};
    list.forEach(e => { const k = keyFn(e); (out[k] = out[k] || []).push(e); });
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, winStats(v)]));
  };
  const has = f => e => ((e.families || []).includes(f) ? `with ${f}` : `without ${f}`);
  const zoneDone = zones.filter(e => e.status === 'resolved');
  const zgroups = (keyFn) => {
    const out = {};
    zoneDone.forEach(e => { const k = keyFn(e); (out[k] = out[k] || []).push(e); });
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, holdStats(v)]));
  };
  return {
    minSamples: MIN_SAMPLES,
    signals: {
      recorded: sigs.length,
      open: sigs.filter(e => e.status === 'open').length,
      neverTriggered: sigDone.filter(e => e.outcome === 'expired' || e.outcome === 'invalidated').length,
      overall: winStats(traded),
      byGrade: groups(traded, e => e.grade),
      byDirection: groups(traded, e => e.dir),
      byOptions: groups(traded, has('options')),
      byVolume: groups(traded, has('volume')),
      byLevel: groups(traded, has('level')),
      byPattern: groups(traded, e => e.pattern)
    },
    zones: {
      recorded: zones.length,
      open: zones.filter(e => e.status === 'open').length,
      overall: holdStats(zoneDone),
      bySide: zgroups(e => e.side),
      byEvidence: zgroups(e => (e.families.length >= 3 ? '3 or more kinds agree' : '2 kinds agree'))
    }
  };
}

// ── persistence and the per-minute tick ──────────────────────────────────

async function loadAll() {
  const raw = await store.hgetall(KEY);
  return Object.values(raw).map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);
}

/**
 * Called after each cron snapshot with the analyses for the intervals we track ({ '5m': analysis, '15m': analysis }).
 * Records new confirmed signals and zones, then scores everything still open. Returns counts.
 */
async function tick(analyses, { now = Date.now(), open = true, load = loadAll, save = (e) => store.hset(KEY, e.id, JSON.stringify(e)) } = {}) {
  const existing = new Map((await load()).map(e => [e.id, e]));
  const writes = new Map();
  let recorded = 0, resolved = 0;

  for (const [interval, a] of Object.entries(analyses)) {
    if (!a || !a.candles || !a.candles.length) continue;
    const lastBar = a.candles[a.candles.length - 1];
    const fresh = open && a.feed && !a.feed.stale && a.feed.source === 'yahoo' && now - (lastBar.t + BAR_MS[interval]) < 15 * 60000;
    if (fresh) {
      for (const sig of a.signals || []) {
        if (!sig.confirmed || sig.state === 'invalidated') continue;
        if (now - sig.t > MAX_SIGNAL_AGE_MS) continue;
        const e = signalEntry(sig, interval, now);
        if (!existing.has(e.id) && !writes.has(e.id)) { writes.set(e.id, e); recorded += 1; }
      }
      if (interval === '5m') { // zones do not depend on the timeframe; record them once
        for (const z of a.actionZones || []) {
          const e = zoneEntry(z, interval, lastBar.t, now, a.atr || 0, a.tolerance || Math.max((a.spot || 0) * 0.0012, (a.atr || 0) * 0.25));
          if (!(e.atr > 0)) continue;
          if (!existing.has(e.id) && !writes.has(e.id)) { writes.set(e.id, e); recorded += 1; }
        }
      }
    }
  }

  const all = new Map([...existing, ...writes]);
  for (const e of all.values()) {
    if (e.status !== 'open') continue;
    const a = analyses[e.interval];
    if (!a || !a.candles || !a.candles.length) continue;
    const next = resolveEntry(e, a.candles);
    if (JSON.stringify(next) !== JSON.stringify(e)) {
      writes.set(e.id, next);
      if (next.status === 'resolved') resolved += 1;
    }
  }

  for (const e of writes.values()) await save(e);
  return { recorded, resolved, written: writes.size };
}

/** Everything the page needs: stats, still-open entries and the most recent outcomes. */
async function getLog(load = loadAll) {
  const entries = await load();
  entries.sort((a, b) => b.t - a.t);
  return {
    since: entries.length ? Math.min(...entries.map(e => e.recordedAt || e.t)) : null,
    stats: computeStats(entries),
    open: entries.filter(e => e.status === 'open').slice(0, 10),
    recent: entries.filter(e => e.status === 'resolved' && !['expired', 'invalidated', 'unknown'].includes(e.outcome) && e.outcome !== 'untouched').slice(0, 15)
  };
}

/** Cron entry point: build the 5m and 15m analyses and run a tick. Never throws; the snapshot must not depend on it. */
async function run(d, { timeoutMs = 4500 } = {}) {
  if (!store.configured) return { skipped: 'no-storage' };
  const { analyze } = require('./chartAnalysis');
  const { marketOpenNow } = require('./candles');
  const work = (async () => {
    const [a5, a15] = await Promise.all([analyze('5m', { d }), analyze('15m', { d })]);
    return tick({ '5m': a5, '15m': a15 }, { open: marketOpenNow() });
  })();
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('forward log timed out')), timeoutMs); });
  try {
    return await Promise.race([work, limit]);
  } catch (err) {
    console.error('forward log tick failed:', err.message);
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  run, KEY, WAIT, HORIZON, WIN_R, MIN_SAMPLES, signalEntry, zoneEntry, resolveSignal, resolveZone, resolveEntry, computeStats, winStats, holdStats, tick, getLog, configured: store.configured };
