// Conditional backtest: WHEN do reversal patterns work?
//
// The plain backtest averages over every candle of the day. This splits the same history by conditions that are known at
// the moment the pattern completes (never anything from the future):
//   time      first hour / midday / last hour of the session
//   dayType   trending (price has moved most of the day's range in one direction) / ranging / early (too soon to say)
//   level     the pattern sits at a stacked level (2+ levels within reach) / at one level / in open space
// Each condition is judged on its own (not crossed with the others), because slicing 60 sessions many ways breeds false
// positives. Every bucket is compared with the baseline for the SAME bucket (how often ANY candle in it moved that way),
// so time-of-day drift does not pass for skill. A bucket needs 30 samples to be called anything.
//
// Levels here are the ones that can be rebuilt for any past day: previous day and week, CPR and pivots, round numbers.

const { SOURCES, priorRanges, roundLevels } = require('./levels');
const { computeCPR } = require('./analytics');
const { wilson, verdict, HORIZONS, fits } = require('./backtest');
const { NOTABLE_TYPES } = require('./signals');

const IST_OFFSET_MS = 330 * 60 * 1000;
const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinute = ms => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

const EARLY_CANDLES = 6;
const TREND_RATIO = 0.6;
const MIN_PATTERN_QUALITY = 0.5;

/** [{ type, price }] for one session, from information available before it opens. */
function staticLevels({ prior, prevDay, open }) {
  const out = [];
  const add = (type, price) => { if (Number.isFinite(price) && price > 0) out.push({ type, price }); };
  if (prior) {
    add('prevHigh', prior.prevHigh); add('prevLow', prior.prevLow); add('prevClose', prior.prevClose);
    if (prior.week) { add('weekHigh', prior.week.high); add('weekLow', prior.week.low); }
  }
  if (prevDay) {
    const cpr = computeCPR(prevDay.h, prevDay.l, prevDay.c);
    add('cprPivot', cpr.pivot);
    add('cprEdge', cpr.tc); add('cprEdge', cpr.bc);
    add('pivotR', cpr.r1); add('pivotR', cpr.r2);
    add('pivotS', cpr.s1); add('pivotS', cpr.s2);
  }
  if (Number.isFinite(open)) {
    roundLevels(open, 500).forEach(p => add('round', p));
    roundLevels(open, 100).filter(p => p % 500 !== 0).forEach(p => add('round', p));
  }
  return out;
}

function timeBucket(t) {
  const m = istMinute(t);
  return m < 10 * 60 + 15 ? 'open' : m < 14 * 60 + 15 ? 'midday' : 'close';
}

/** Trending or ranging, from the session so far (candles sFrom..i inclusive). */
function dayTypeAt(candles, sFrom, i) {
  if (i - sFrom < EARLY_CANDLES) return 'early';
  let hi = -Infinity, lo = Infinity;
  for (let k = sFrom; k <= i; k++) { hi = Math.max(hi, candles[k].h); lo = Math.min(lo, candles[k].l); }
  const range = hi - lo;
  if (!(range > 0)) return 'ranging';
  return Math.abs(candles[i].c - candles[sFrom].o) / range >= TREND_RATIO ? 'trending' : 'ranging';
}

function levelBucket(price, levels, tol) {
  const near = levels.filter(l => Math.abs(l.price - price) <= tol);
  return near.length >= 2 ? 'stacked' : near.length === 1 ? 'single' : 'open';
}

/** Per-session lookups for a candle series: which session each candle is in, and that session's static levels. */
function buildEnv(candles, daily) {
  const sessions = [];
  const sessionOf = new Array(candles.length);
  candles.forEach((c, i) => {
    const day = istDay(c.t);
    const s = sessions[sessions.length - 1];
    if (s && s.day === day) s.to = i; else sessions.push({ day, from: i, to: i, levels: null });
    sessionOf[i] = sessions.length - 1;
  });
  for (const s of sessions) {
    const prior = priorRanges(daily, s.day);
    const prevDay = (daily || []).filter(d => istDay(d.t) < s.day).pop();
    s.levels = staticLevels({ prior, prevDay, open: candles[s.from].o });
  }
  return { sessions, sessionOf };
}

function atrAt(candles, i, n = 14) {
  let sum = 0, count = 0;
  for (let k = Math.max(1, i - n + 1); k <= i; k++) {
    const p = candles[k - 1], c = candles[k];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    count += 1;
  }
  return count ? sum / count : candles[i].h - candles[i].l;
}

/** The three condition labels for candle i if a reversal in direction `dir` completed on it. */
function contextAt(candles, i, dir, env) {
  const s = env.sessions[env.sessionOf[i]];
  const c = candles[i];
  const price = dir === 'bull' ? c.l : c.h; // where the reversal is claimed to have happened
  const tol = Math.max(0.5 * atrAt(candles, i), price * 0.0008);
  return { time: timeBucket(c.t), dayType: dayTypeAt(candles, s.from, i), level: levelBucket(price, s.levels, tol) };
}

const DIMENSIONS = ['time', 'dayType', 'level'];

/**
 * Hit rates for notable patterns by condition, against the baseline of every candle in the same condition.
 * Returns { interval, horizon, minSamples, dims: { time: { open: { bull: stats, bear: stats }, ... }, ... } }.
 */
function conditionalBacktest(candles, daily, interval, patterns) {
  const horizon = HORIZONS[interval];
  if (!horizon || interval === '1d') return null;
  const env = buildEnv(candles, daily);
  const tally = {}; // dim -> bucket -> dir -> { pn, ph, bn, bh }
  const bump = (dim, bucket, dir, key) => {
    const t = ((tally[dim] = tally[dim] || {})[bucket] = tally[dim][bucket] || {});
    const d = (t[dir] = t[dir] || { pn: 0, ph: 0, bn: 0, bh: 0 });
    d[key] += 1;
  };
  const signedMove = (i, dir) => ((dir === 'bull' ? 1 : -1) * (candles[i + 1 + horizon].c - candles[i + 1].o));

  // baseline: every candle, both directions
  for (let i = 6; i + 1 + horizon < candles.length; i++) {
    if (!fits(candles, i, horizon, true)) continue;
    for (const dir of ['bull', 'bear']) {
      const ctx = contextAt(candles, i, dir, env);
      const hit = signedMove(i, dir) > 0;
      for (const dim of DIMENSIONS) { bump(dim, ctx[dim], dir, 'bn'); if (hit) bump(dim, ctx[dim], dir, 'bh'); }
    }
  }
  // patterns
  let used = 0;
  for (const p of patterns) {
    if (!NOTABLE_TYPES.has(p.name) || p.quality < MIN_PATTERN_QUALITY) continue;
    if (!fits(candles, p.i, horizon, true)) continue;
    const ctx = contextAt(candles, p.i, p.dir, env);
    const hit = signedMove(p.i, p.dir) > 0;
    used += 1;
    for (const dim of DIMENSIONS) { bump(dim, ctx[dim], p.dir, 'pn'); if (hit) bump(dim, ctx[dim], p.dir, 'ph'); }
  }

  const dims = {};
  for (const dim of DIMENSIONS) {
    dims[dim] = {};
    for (const [bucket, byDir] of Object.entries(tally[dim] || {})) {
      dims[dim][bucket] = {};
      for (const [dir, t] of Object.entries(byDir)) {
        const baseline = t.bn ? t.bh / t.bn : 0.5;
        const ci = wilson(t.ph, t.pn);
        dims[dim][bucket][dir] = {
          n: t.pn, hits: t.ph, hitRate: t.pn ? t.ph / t.pn : null, baseline, baselineN: t.bn, ci,
          verdict: verdict(t.pn, ci, baseline)
        };
      }
    }
  }
  return { interval, horizon, patternsUsed: used, dims };
}

/**
 * Score adjustment for a live pattern from its context, and the evidence lines that explain it.
 * edge: +6 per condition, clearly worse than the baseline: -10, otherwise 0. Capped to [-20, +12].
 */
const CONTEXT_LABELS = {
  time: { open: 'first hour', midday: 'midday', close: 'last hour' },
  dayType: { trending: 'a trending day', ranging: 'a ranging day', early: 'early in the session' },
  level: { stacked: 'at stacked levels', single: 'at a single level', open: 'in open space' }
};

function contextAdjustment(conditional, ctx, dir) {
  const lines = [];
  let adjust = 0;
  if (!conditional || !ctx) return { adjust, lines };
  for (const dim of DIMENSIONS) {
    const stat = conditional.dims[dim] && conditional.dims[dim][ctx[dim]] && conditional.dims[dim][ctx[dim]][dir];
    const label = CONTEXT_LABELS[dim][ctx[dim]];
    if (!stat || stat.verdict === 'insufficient') continue;
    const pc = x => Math.round(x * 100);
    const text = `${label}: this kind of pattern hit ${pc(stat.hitRate)}% vs ${pc(stat.baseline)}% for any candle (n=${stat.n})`;
    if (stat.verdict === 'edge') { adjust += 6; lines.push({ family: 'context', text: text + ', better than usual' }); }
    else if (stat.verdict === 'negative') { adjust -= 10; lines.push({ family: 'context', text: text + ', worse than usual', against: true }); }
    // 'no clear difference' adds nothing actionable, so it is left out of the signal (the panel table still shows it)
  }
  return { adjust: Math.max(-20, Math.min(12, adjust)), lines };
}

module.exports = { DIMENSIONS, CONTEXT_LABELS, staticLevels, timeBucket, dayTypeAt, levelBucket, buildEnv, contextAt, conditionalBacktest, contextAdjustment };
