// Turns detected patterns into ranked, explainable signals and finds buying / selling zones.
//
// Nothing here knows who bought or sold: there is no order-flow feed. It shows EVIDENCE that is consistent with buying or
// selling pressure (put writing, call unwinding, volume expansion on the ETF proxy), and refuses to call anything
// "confirmed" unless at least two independent families of evidence agree.

const { atr } = require('./levels');

const MIN_FAMILIES = 2;
const MAX_AGE = { '5m': 6, '15m': 4, '1d': 2 };

const finite = x => typeof x === 'number' && Number.isFinite(x);
const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Option-chain evidence around a price. For a bullish read: put writing near/below the price, or call OI being unwound
 * above it. Bearish is the mirror image. Strength is the share of all OI change that supports the read (0..1).
 */
function optionEvidence(strikes, price, dir) {
  if (!Array.isArray(strikes) || !strikes.length || !finite(price)) return { strength: 0, text: null };
  let total = 0, support = 0;
  const near = pct => s => Math.abs(s.strike - price) / price <= pct;
  let ceWrite = 0, peWrite = 0, ceUnwind = 0, peUnwind = 0;
  for (const s of strikes) {
    const ce = (s.CE && s.CE.changeinOpenInterest) || 0;
    const pe = (s.PE && s.PE.changeinOpenInterest) || 0;
    total += Math.abs(ce) + Math.abs(pe);
    if (near(0.006)(s) || (s.strike < price && near(0.015)(s))) {
      if (pe > 0) peWrite += pe;
      if (pe < 0) peUnwind += -pe;
    }
    if (near(0.006)(s) || (s.strike > price && near(0.015)(s))) {
      if (ce > 0) ceWrite += ce;
      if (ce < 0) ceUnwind += -ce;
    }
  }
  if (!total) return { strength: 0, text: null };
  let parts = [];
  if (dir === 'bull') {
    support = peWrite + ceUnwind;
    if (peWrite) parts.push(`put writing +${(peWrite / 1e5).toFixed(1)}L`);
    if (ceUnwind) parts.push(`call unwinding -${(ceUnwind / 1e5).toFixed(1)}L`);
    if (ceWrite > peWrite + ceUnwind) support *= 0.4; // fresh call writing leans against the read
  } else {
    support = ceWrite + peUnwind;
    if (ceWrite) parts.push(`call writing +${(ceWrite / 1e5).toFixed(1)}L`);
    if (peUnwind) parts.push(`put unwinding -${(peUnwind / 1e5).toFixed(1)}L`);
    if (peWrite > ceWrite + peUnwind) support *= 0.4;
  }
  const strength = Math.min(1, support / total / 0.3); // 30% of all OI change is a full-strength read
  return { strength, text: strength >= 0.25 && parts.length ? parts.join(', ') : null };
}

/** Volume of candle `i` relative to the median of the previous 20 (ETF proxy). null when there is no volume data. */
function volumeRatio(candles, i) {
  const v = candles[i] && candles[i].v;
  if (!v) return null;
  const prev = candles.slice(Math.max(0, i - 20), i).map(c => c.v).filter(Boolean);
  if (prev.length < 5) return null;
  const m = median(prev);
  return m ? v / m : null;
}

const VERDICT_ADJUST = { edge: 0, insufficient: -5, none: -10, negative: -25 };

function gradeOf(score) {
  return score >= 70 ? 'strong' : score >= 50 ? 'moderate' : 'weak';
}

// Chart markers: which of the detected patterns deserve an arrow. Raw detection fires on roughly every 4th candle, which is
// noise. A marker needs a structural pattern type, decent quality and no clear negative record, and markers keep a minimum
// spacing (the stronger one wins). Patterns behind a confirmed signal are always kept.
const NOTABLE_TYPES = new Set([
  'hammer', 'shootingStar', 'bullEngulfing', 'bearEngulfing', 'piercing', 'darkCloud', 'morningStar', 'eveningStar',
  'doubleTop', 'doubleBottom', 'headShoulders', 'inverseHeadShoulders', 'sweepHigh', 'sweepLow'
]);
const MARKER_MIN_QUALITY = 0.65;
const MARKER_GAP = { '5m': 10, '15m': 6, '1d': 4 };

/** Returns a Set of "name|t" keys for patterns that should get a marker. */
function selectNotable(patterns, { interval, backtest, signals = [] } = {}) {
  const gap = MARKER_GAP[interval] || 8;
  const keep = [];
  const forced = new Set(signals.filter(s => s.confirmed).map(s => `${s.pattern}|${s.t}`));
  const ok = p => {
    if (forced.has(`${p.name}|${p.t}`)) return true;
    if (!NOTABLE_TYPES.has(p.name) || p.quality < MARKER_MIN_QUALITY) return false;
    const stats = backtest && backtest.patterns && backtest.patterns[p.name];
    return !(stats && stats.verdict === 'negative');
  };
  const candidates = patterns.filter(ok).sort((a, b) => (forced.has(`${b.name}|${b.t}`) - forced.has(`${a.name}|${a.t}`)) || b.quality - a.quality);
  for (const p of candidates) {
    const isForced = forced.has(`${p.name}|${p.t}`);
    if (!isForced && keep.some(k => Math.abs(k.i - p.i) < gap)) continue;
    keep.push(p);
  }
  return new Set(keep.map(p => `${p.name}|${p.t}`));
}

/**
 * Build signals from patterns on the most recent candles.
 *  candles, patterns (detectAll output), ladder (buildLadder), strikes (option chain), backtest (backtest() output), interval
 */
function buildSignals({ candles, patterns, ladder, strikes, backtest, interval }) {
  if (!candles || candles.length < 10 || !ladder || !finite(ladder.spot)) return [];
  const maxAge = MAX_AGE[interval] || 4;
  const lastIdx = candles.length - 1;
  const a = ladder.atr || atr(candles);
  const tol = ladder.tolerance || ladder.spot * 0.0012;
  const out = [];

  for (const p of patterns || []) {
    const age = lastIdx - p.i;
    if (age < 0 || age > maxAge) continue;
    const c = candles[p.i];
    const bull = p.dir === 'bull';
    const anchor = bull ? c.l : c.h; // where the reversal is claimed to have happened
    const evidence = [{ family: 'price', text: `${p.label}${p.kind === 'chart' ? ' (chart pattern)' : ''}, quality ${Math.round(p.quality * 100)}%` }];
    let score = 25 * p.quality;
    const agree = new Set(['price']);

    // zone context
    const zone = ladder.zones
      .filter(z => anchor >= z.low - tol * 1.5 && anchor <= z.high + tol * 1.5)
      .sort((x, y) => y.strength - x.strength)[0];
    if (zone) {
      const wantSide = bull ? 'support' : 'resistance';
      const againstSide = bull ? 'resistance' : 'support';
      const zoneIsRight = zone.kind === wantSide || zone.kind === 'inside';
      if (zoneIsRight && zone.strength >= 30) {
        score += 30 * (zone.strength / 100);
        agree.add('level');
        const top = zone.sources.slice(0, 3).map(s => s.label).join(' + ');
        evidence.push({ family: 'level', text: `${bull ? 'At support' : 'At resistance'} ${Math.round(zone.low)}-${Math.round(zone.high)} (strength ${zone.strength}): ${top}` });
      } else if (zone.kind === againstSide && zone.strength >= 30) {
        score -= 8;
        evidence.push({ family: 'level', text: `Against a ${againstSide} zone at ${Math.round(zone.low)}-${Math.round(zone.high)}`, against: true });
      }
    }

    // volume
    const vr = volumeRatio(candles, p.i);
    if (vr === null) {
      evidence.push({ family: 'volume', text: 'No volume data for this candle', neutral: true });
    } else if (vr >= 1.5) {
      score += 20; agree.add('volume');
      evidence.push({ family: 'volume', text: `Volume ${vr.toFixed(1)}x the recent median (ETF proxy)` });
    } else if (vr >= 1.2) {
      score += 12; agree.add('volume');
      evidence.push({ family: 'volume', text: `Volume ${vr.toFixed(1)}x the recent median (ETF proxy)` });
    } else {
      evidence.push({ family: 'volume', text: `Volume ${vr.toFixed(1)}x the median: no expansion`, neutral: true });
    }

    // options (live chain only describes now, so it only counts for signals on the latest few candles)
    if (age <= 2) {
      const oe = optionEvidence(strikes, anchor, p.dir);
      if (oe.text) {
        score += 25 * oe.strength;
        if (oe.strength >= 0.3) agree.add('options');
        evidence.push({ family: 'options', text: oe.text });
      }
    }

    // history: the pattern's own record on this instrument
    const stats = backtest && backtest.patterns && backtest.patterns[p.name] ? backtest.patterns[p.name] : null;
    const verdict = stats ? stats.verdict : 'insufficient';
    score += VERDICT_ADJUST[verdict];

    // plan: trigger, invalidation and the nearest opposing zone
    const buffer = Math.max(a * 0.1, 1);
    const trigger = p.kind === 'chart' && finite(p.level) ? (bull ? Math.max(c.h, p.level) : Math.min(c.l, p.level)) : bull ? c.h : c.l;
    const invalidation = p.kind === 'chart' && finite(p.level) ? (bull ? Math.min(c.l, p.level) - buffer : Math.max(c.h, p.level) + buffer) : bull ? c.l - buffer : c.h + buffer;
    const opposing = ladder.zones
      .filter(z => (bull ? z.low > trigger + tol : z.high < trigger - tol))
      .sort((x, y) => (bull ? x.low - y.low : y.high - x.high))[0] || null;
    const target = opposing ? (bull ? opposing.low : opposing.high) : null;
    const risk = Math.abs(trigger - invalidation);
    const rr = target && risk > 0 ? Math.abs(target - trigger) / risk : null;

    // state against the candles that came after
    const after = candles.slice(p.i + 1);
    let state = 'waiting';
    if (after.some(x => (bull ? x.c < invalidation : x.c > invalidation))) state = 'invalidated';
    else if (after.some(x => (bull ? x.h > trigger : x.l < trigger))) state = 'triggered';

    const families = [...agree];
    // A reversal pattern floating in empty space is not a trade idea: it must sit at a level AND have one more family behind it.
    const confirmed = families.length >= MIN_FAMILIES && agree.has('level');
    const total = Math.max(0, Math.min(100, Math.round(score)));
    out.push({
      id: `${p.name}|${p.t}`,
      t: p.t,
      i: p.i,
      age,
      pattern: p.name,
      label: p.label,
      dir: p.dir,
      kind: p.kind,
      score: total,
      grade: confirmed ? gradeOf(total) : 'weak',
      confirmed,
      families,
      evidence,
      trigger,
      invalidation,
      target,
      targetZone: opposing ? { low: opposing.low, high: opposing.high, strength: opposing.strength } : null,
      rr: rr === null ? null : Math.round(rr * 10) / 10,
      state,
      history: stats ? { n: stats.n, hitRate: stats.hitRate, baseline: stats.baseline, ci: stats.ci, verdict: stats.verdict, horizon: backtest.horizon } : null
    });
  }
  return out
    .filter(s => s.state !== 'invalidated')
    .sort((x, y) => y.score - x.score || x.age - y.age);
}

/**
 * Buying / selling zones. A support zone only becomes a buying zone when at least two evidence families back it:
 * the level itself counts as one; then option positioning, volume at the price, and price reaction each add one.
 */
function buildActionZones({ candles, ladder, strikes, profile, patterns, interval }) {
  if (!ladder || !ladder.zones) return [];
  const out = [];
  const recent = (patterns || []).filter(p => candles && candles.length - 1 - p.i <= (MAX_AGE[interval] || 4) * 3);
  const tol = ladder.tolerance;

  for (const z of ladder.zones) {
    if (z.kind === 'inside' || z.strength < 35) continue;
    const buy = z.kind === 'support';
    const dir = buy ? 'bull' : 'bear';
    const evidence = [{ family: 'level', text: `${z.sources.slice(0, 3).map(s => s.label).join(' + ')} (strength ${z.strength})` }];
    const fam = new Set(['level']);

    const oe = optionEvidence(strikes, z.mid, dir);
    if (oe.text && oe.strength >= 0.3) { fam.add('options'); evidence.push({ family: 'options', text: oe.text }); }

    // volume: the zone sits on a high volume node or the profile's point of control / value edge
    if (profile) {
      const nodes = [profile.poc, profile.vah, profile.val, ...(profile.hvn || [])];
      const hit = nodes.find(n => n >= z.low - tol && n <= z.high + tol);
      if (hit !== undefined) { fam.add('volume'); evidence.push({ family: 'volume', text: 'Heavy traded volume at this price (ETF volume profile)' }); }
    }

    // price: reversal patterns in that direction formed here, or the zone already held on a test
    const patt = recent.filter(p => p.dir === dir && candles[p.i] && (buy ? candles[p.i].l : candles[p.i].h) >= z.low - tol * 1.5 && (buy ? candles[p.i].l : candles[p.i].h) <= z.high + tol * 1.5);
    if (patt.length) { fam.add('price'); evidence.push({ family: 'price', text: `${patt[patt.length - 1].label} formed here` }); }
    // 'held' only means "not broken"; it is evidence only if at least one test actually closed on the right side
    else if (z.status === 'held' && z.held > 0) { fam.add('price'); evidence.push({ family: 'price', text: `Held on ${z.held} of ${z.touches} test${z.touches > 1 ? 's' : ''} today` }); }

    if (fam.size < MIN_FAMILIES) continue;
    if (z.status === 'broken') continue;
    out.push({
      side: buy ? 'buy' : 'sell',
      low: z.low, high: z.high, mid: z.mid,
      strength: z.strength,
      families: [...fam],
      evidence,
      status: z.status,
      distancePct: z.distancePct
    });
  }
  return out.sort((x, y) => Math.abs(x.distancePct) - Math.abs(y.distancePct));
}

module.exports = { NOTABLE_TYPES, MARKER_MIN_QUALITY, MARKER_GAP, selectNotable, MIN_FAMILIES, MAX_AGE, optionEvidence, volumeRatio, buildSignals, buildActionZones, gradeOf };
