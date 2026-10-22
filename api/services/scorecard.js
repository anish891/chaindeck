// Measured scorecard for each KIND of support / resistance level.
//
// The ladder gives every level type a hand-picked weight. This replays the stored 5 minute history and measures how
// price actually treated each type, compared with arbitrary price points ("null levels") run through the identical test.
// A level type is only trusted more (or less) when the numbers clear that baseline with enough samples.
//
// Test, for one level L (static for the session, or a function of time like VWAP):
//   armed   : the previous candle closed more than BAND away from L, on some side
//   touch   : the next candle's range reaches within BAND of L
//   outcome : within HORIZON candles (never past the session close)
//             "bounce" if price moves BOUNCE x ATR away from L on the side it came from,
//             "break"  if a candle closes more than BREAK x ATR through L (a candle that does both counts as a break),
//             otherwise "neither".
//   A level can be re-tested only after the horizon has passed and price has moved away again.
// Everything uses only information available at that moment: prior day / week values, the prior session's volume
// profile, swings only once confirmed, running VWAP.
//
// Not measurable here: option OI walls, max pain and zero-gamma (there are no historical option chains). The forward
// log covers those.

const { atr: atrOf, swingPoints, priorRanges, volumeProfile, roundLevels } = require('./levels');
const { wilson, MIN_SAMPLES } = require('./backtest');
const { computeCPR } = require('./analytics');

const IST_OFFSET_MS = 330 * 60 * 1000;
const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

const PARAMS = { band: 0.15, bounce: 0.5, breakThrough: 0.25, horizon: 12, swingK: 3, swingWindow: 300 };

const NOT_MEASURED = ['callWall', 'putWall', 'maxPain', 'zeroGamma'];

/** Rolling ATR (14) for every candle, using only candles up to and including it. */
function rollingAtr(candles, n = 14) {
  const out = new Array(candles.length).fill(0);
  let sum = 0;
  const tr = candles.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c))));
  for (let i = 0; i < candles.length; i++) {
    sum += tr[i];
    if (i >= n) sum -= tr[i - n];
    out[i] = sum / Math.min(i + 1, n);
  }
  return out;
}

/**
 * Run the touch test for one level over candles[from..to] (inclusive, one session).
 * `value(i)` gives the level at candle i (constant for static levels). Returns [{ i, outcome, side, favAtr }].
 */
function scanLevel(candles, atrs, from, to, value, active = () => true, params = PARAMS) {
  const events = [];
  let cooldownUntil = -1;
  for (let i = Math.max(from + 1, 1); i <= to; i++) {
    if (!active(i)) continue;
    const v = value(i);
    const a = atrs[i - 1] || atrs[i];
    if (!(v > 0) || !(a > 0)) continue;
    const band = a * params.band;
    const prev = candles[i - 1];
    const prevV = value(i - 1);
    const dist = prev.c - prevV;

    if (i <= cooldownUntil) continue;
    if (Math.abs(dist) <= band) continue; // previous close was not clearly on one side: not armed
    const c = candles[i];
    const touched = c.l <= v + band && c.h >= v - band;
    if (!touched) continue;

    const side = dist > 0 ? 'support' : 'resistance'; // came from above = the level is being tested as support
    const dir = dist > 0 ? 1 : -1;
    let fav = dir > 0 ? c.c - v : v - c.c; // touch candle: only its close is trusted for the bounce
    let outcome = 'neither';
    const last = Math.min(i + params.horizon, to);
    if (dir > 0 ? c.c < v - a * params.breakThrough : c.c > v + a * params.breakThrough) outcome = 'break';
    else if (fav >= a * params.bounce) outcome = 'bounce';
    for (let j = i + 1; outcome === 'neither' && j <= last; j++) {
      const cj = candles[j];
      const vj = value(j);
      if (dir > 0 ? cj.c < vj - a * params.breakThrough : cj.c > vj + a * params.breakThrough) { outcome = 'break'; break; }
      const f = dir > 0 ? cj.h - vj : vj - cj.l;
      fav = Math.max(fav, f);
      if (f >= a * params.bounce) outcome = 'bounce';
    }
    events.push({ i, outcome, side, favAtr: Math.max(0, fav) / a });
    cooldownUntil = last + 1;
  }
  return events;
}

/** Group candle indexes into sessions: [{ day, from, to }]. */
function sessionsOf(candles) {
  const out = [];
  candles.forEach((c, i) => {
    const day = istDay(c.t);
    const s = out[out.length - 1];
    if (s && s.day === day) s.to = i; else out.push({ day, from: i, to: i });
  });
  return out;
}

/**
 * Score every level type. candles: 5m candles WITH volume (ETF proxy); daily: daily index candles.
 * Returns { sessions, candles, params, null, types: { type: stats }, notMeasured }.
 */
function buildScorecard(candles, daily, params = PARAMS) {
  const atrs = rollingAtr(candles);
  const sess = sessionsOf(candles).filter(s => s.to - s.from >= 40); // skip half days / bad data
  const swings = swingPoints(candles, params.swingK);
  const raw = {}; // type -> events
  const push = (type, ev) => { (raw[type] = raw[type] || []).push(...ev); };
  const nullEvents = [];

  for (let si = 0; si < sess.length; si++) {
    const s = sess[si];
    const prior = priorRanges(daily, s.day);
    const prevSession = si > 0 ? sess[si - 1] : null;
    const fixed = (type, price) => { if (price > 0) push(type, scanLevel(candles, atrs, s.from, s.to, () => price, () => true, params)); };

    if (prior) {
      fixed('prevHigh', prior.prevHigh);
      fixed('prevLow', prior.prevLow);
      fixed('prevClose', prior.prevClose);
      if (prior.week) { fixed('weekHigh', prior.week.high); fixed('weekLow', prior.week.low); }
      const prevDay = (daily || []).filter(d => istDay(d.t) < s.day).pop();
      if (prevDay) {
        const cpr = computeCPR(prevDay.h, prevDay.l, prevDay.c);
        fixed('cprPivot', cpr.pivot);
        fixed('cprEdge', cpr.tc); fixed('cprEdge', cpr.bc);
        fixed('pivotR', cpr.r1); fixed('pivotR', cpr.r2);
        fixed('pivotS', cpr.s1); fixed('pivotS', cpr.s2);
      }
    }

    // prior session's volume profile (needs ETF volume on that session)
    if (prevSession) {
      const prof = volumeProfile(candles.slice(prevSession.from, prevSession.to + 1), 10);
      if (prof) {
        fixed('poc', prof.poc); fixed('vah', prof.vah); fixed('val', prof.val);
        (prof.hvn || []).slice(0, 4).forEach(p => fixed('hvn', p));
      }
    }

    // round numbers around the open
    const open = candles[s.from].o;
    roundLevels(open, 500).forEach(p => fixed('round', p));
    roundLevels(open, 100).filter(p => p % 500 !== 0).forEach(p => fixed('round', p));

    // running VWAP (needs volume)
    let pv = 0, vol = 0;
    const vw = new Array(candles.length).fill(0);
    for (let i = s.from; i <= s.to; i++) {
      const c = candles[i];
      if (c.v) { pv += ((c.h + c.l + c.c) / 3) * c.v; vol += c.v; }
      vw[i] = vol ? pv / vol : 0;
    }
    if (vol > 0) push('vwap', scanLevel(candles, atrs, s.from, s.to, i => vw[i], i => vw[i] > 0, params));

    // confirmed swing highs / lows still inside the look-back window
    for (const [type, list] of [['swingHigh', swings.highs], ['swingLow', swings.lows]]) {
      for (const sw of list) {
        const known = sw.i + params.swingK;
        if (known >= s.to || known < s.from - params.swingWindow) continue;
        const start = Math.max(known, s.from);
        push(type, scanLevel(candles, atrs, start, s.to, () => sw.price, () => true, params));
      }
    }

    // null levels: arbitrary price points through the identical test (the baseline)
    const a0 = atrs[s.from + 14] || atrs[s.from] || 1;
    for (let k = -5; k <= 5; k++) {
      if (k === 0) continue;
      const price = open + k * 1.2 * a0; // ten arbitrary price points per session, 1.2 ATR apart
      nullEvents.push(...scanLevel(candles, atrs, s.from, s.to, () => price, () => true, params));
    }
  }

  const base = summarise(nullEvents);
  const types = {};
  for (const [type, ev] of Object.entries(raw)) types[type] = { ...summarise(ev), ...judge(ev, base) };
  return {
    sessions: sess.length,
    candles: candles.length,
    params,
    null: base,
    types,
    notMeasured: NOT_MEASURED
  };
}

function summarise(events) {
  const bounce = events.filter(e => e.outcome === 'bounce').length;
  const brk = events.filter(e => e.outcome === 'break').length;
  const decided = bounce + brk;
  const ci = wilson(bounce, decided);
  return {
    touches: events.length,
    bounce, break: brk, neither: events.length - decided,
    decided,
    bounceRate: decided ? bounce / decided : null,
    ci,
    avgFavAtr: events.length ? Math.round((events.reduce((s, e) => s + e.favAtr, 0) / events.length) * 100) / 100 : null
  };
}

function judge(events, base) {
  const s = summarise(events);
  const baseline = base.bounceRate;
  let verdict = 'insufficient';
  if (s.decided >= MIN_SAMPLES && baseline !== null) verdict = s.ci.low > baseline ? 'respected' : s.ci.high < baseline ? 'ignored' : 'none';
  return { baseline, verdict };
}

/**
 * How much to scale each level type's weight in the ladder. Only types whose record clears (or falls below) the baseline
 * with enough samples move; everything else stays at 1. Bounded so a noisy backtest cannot dominate.
 */
function weightMultipliers(card) {
  const out = {};
  if (!card || !card.types) return out;
  for (const [type, s] of Object.entries(card.types)) {
    if (s.verdict === 'respected') out[type] = Math.round((1 + Math.min(0.5, (s.bounceRate - s.baseline) * 2.5)) * 100) / 100;
    else if (s.verdict === 'ignored') out[type] = 0.6;
  }
  return out;
}

module.exports = { PARAMS, NOT_MEASURED, rollingAtr, scanLevel, sessionsOf, buildScorecard, summarise, weightMultipliers };
