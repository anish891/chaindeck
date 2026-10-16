// Support and resistance engine. Pure functions: every price level we can justify is collected with a weight, nearby
// levels are clustered into zones, and each zone gets a strength score and a live status (untested / held / broken).
//
// A zone is where several independent things agree, not a single line. Strength is the weighted agreement of distinct
// source families (option positioning, prior-session prices, chart structure, volume, round numbers).

const IST_OFFSET_MS = 330 * 60 * 1000;
const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

// type -> { weight, family, label }. Families stop one kind of evidence from counting twice.
const SOURCES = {
  callWall: { weight: 3, family: 'options', label: 'Call OI wall' },
  putWall: { weight: 3, family: 'options', label: 'Put OI wall' },
  maxPain: { weight: 2, family: 'options', label: 'Max pain' },
  zeroGamma: { weight: 2, family: 'options', label: 'Zero gamma' },
  cprPivot: { weight: 1.5, family: 'prior', label: 'CPR pivot' },
  cprEdge: { weight: 1.5, family: 'prior', label: 'CPR edge' },
  pivotR: { weight: 1.5, family: 'prior', label: 'Pivot R' },
  pivotS: { weight: 1.5, family: 'prior', label: 'Pivot S' },
  prevHigh: { weight: 2.5, family: 'prior', label: 'Previous day high' },
  prevLow: { weight: 2.5, family: 'prior', label: 'Previous day low' },
  prevClose: { weight: 1.5, family: 'prior', label: 'Previous close' },
  weekHigh: { weight: 2.5, family: 'prior', label: 'Previous week high' },
  weekLow: { weight: 2.5, family: 'prior', label: 'Previous week low' },
  dayHigh: { weight: 2, family: 'structure', label: 'Day high' },
  dayLow: { weight: 2, family: 'structure', label: 'Day low' },
  swingHigh: { weight: 2, family: 'structure', label: 'Swing high' },
  swingLow: { weight: 2, family: 'structure', label: 'Swing low' },
  vwap: { weight: 2, family: 'volume', label: 'VWAP' },
  poc: { weight: 2.5, family: 'volume', label: 'Volume point of control' },
  vah: { weight: 1.5, family: 'volume', label: 'Value area high' },
  val: { weight: 1.5, family: 'volume', label: 'Value area low' },
  hvn: { weight: 1.5, family: 'volume', label: 'High volume node' },
  round: { weight: 1, family: 'round', label: 'Round number' }
};

const finite = x => typeof x === 'number' && Number.isFinite(x);

/** Average true range over the last `n` candles. */
function atr(candles, n = 14) {
  if (!candles || candles.length < 2) return 0;
  const slice = candles.slice(-(n + 1));
  let sum = 0, count = 0;
  for (let i = 1; i < slice.length; i++) {
    const p = slice[i - 1], c = slice[i];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    count += 1;
  }
  return count ? sum / count : 0;
}

/**
 * Session-anchored VWAP, restarting each IST day. Uses typical price weighted by (ETF) volume.
 * Returns [{ t, value }] only for candles that carry volume, so it is never invented from nothing.
 */
function vwapSeries(candles) {
  const out = [];
  let day = null, pv = 0, vol = 0;
  for (const c of candles) {
    const d = istDay(c.t);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    if (!c.v) continue;
    pv += ((c.h + c.l + c.c) / 3) * c.v;
    vol += c.v;
    out.push({ t: c.t, value: pv / vol });
  }
  return out;
}

/**
 * Volume profile over index price bins. Each candle's volume is spread evenly across the bins its range touches.
 * Returns bins, the point of control, the 70% value area and high volume nodes (local peaks above 1.3x the mean).
 */
function volumeProfile(candles, binSize = 10) {
  const vc = (candles || []).filter(c => c.v && c.h >= c.l);
  if (vc.length < 5) return null;
  const lo = Math.floor(Math.min(...vc.map(c => c.l)) / binSize) * binSize;
  const hi = Math.ceil(Math.max(...vc.map(c => c.h)) / binSize) * binSize;
  const n = Math.max(1, Math.round((hi - lo) / binSize));
  if (n > 2000) return null;
  const vols = new Array(n).fill(0);
  for (const c of vc) {
    const a = Math.min(n - 1, Math.max(0, Math.floor((c.l - lo) / binSize)));
    const b = Math.min(n - 1, Math.max(0, Math.floor((c.h - lo) / binSize)));
    const share = c.v / (b - a + 1);
    for (let i = a; i <= b; i++) vols[i] += share;
  }
  const total = vols.reduce((s, v) => s + v, 0);
  if (!total) return null;
  const bins = vols.map((v, i) => ({ price: lo + i * binSize + binSize / 2, volume: v }));
  let poc = 0;
  vols.forEach((v, i) => { if (v > vols[poc]) poc = i; });

  // value area: grow outward from the POC taking the larger neighbour until 70% of volume is covered
  let l = poc, r = poc, covered = vols[poc];
  while (covered < total * 0.7 && (l > 0 || r < n - 1)) {
    const left = l > 0 ? vols[l - 1] : -1;
    const right = r < n - 1 ? vols[r + 1] : -1;
    if (left >= right) { l -= 1; covered += vols[l]; } else { r += 1; covered += vols[r]; }
  }
  const mean = total / n;
  const hvn = [];
  for (let i = 1; i < n - 1; i++) {
    if (i !== poc && vols[i] > mean * 1.3 && vols[i] >= vols[i - 1] && vols[i] >= vols[i + 1]) hvn.push(bins[i].price);
  }
  return { binSize, bins, poc: bins[poc].price, vah: bins[r].price + binSize / 2, val: bins[l].price - binSize / 2, hvn };
}

/** Swing highs/lows: a candle whose high (low) is the extreme of `k` candles either side. */
function swingPoints(candles, k = 3) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h < candles[i + j].h) isH = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l > candles[i + j].l) isL = false;
    }
    if (isH) highs.push({ i, t: candles[i].t, price: candles[i].h });
    if (isL) lows.push({ i, t: candles[i].t, price: candles[i].l });
  }
  return { highs, lows };
}

/** Previous completed day and week (Mon-Fri) high/low from daily candles. `today` is an IST YYYY-MM-DD string. */
function priorRanges(daily, today) {
  const done = (daily || []).filter(c => istDay(c.t) < today);
  if (!done.length) return null;
  const prev = done[done.length - 1];
  const weekKey = t => {
    const d = new Date(t + IST_OFFSET_MS);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    return monday.toISOString().slice(0, 10);
  };
  const thisWeek = weekKey(Date.parse(today + 'T06:00:00Z'));
  const lastWeekDays = done.filter(c => weekKey(c.t) < thisWeek);
  let week = null;
  if (lastWeekDays.length) {
    const key = weekKey(lastWeekDays[lastWeekDays.length - 1].t);
    const days = lastWeekDays.filter(c => weekKey(c.t) === key);
    week = { high: Math.max(...days.map(c => c.h)), low: Math.min(...days.map(c => c.l)) };
  }
  return { prevHigh: prev.h, prevLow: prev.l, prevClose: prev.c, week };
}

function roundLevels(spot, step) {
  const base = Math.round(spot / step) * step;
  return [-3, -2, -1, 0, 1, 2, 3].map(i => base + i * step).filter(p => Math.abs(p - spot) / spot < 0.02);
}

/**
 * Gather every level we can justify. `input` fields are all optional; missing sources are skipped.
 *   spot, walls {calls,puts}, maxPain, zeroGamma, cpr, prior (priorRanges), candles (intraday), profile, vwap (last value)
 */
function collectLevels(input) {
  const out = [];
  const add = (type, price, extra = {}) => {
    if (!finite(price) || price <= 0) return;
    const s = SOURCES[type];
    out.push({ type, price, weight: s.weight * (extra.scale || 1), family: s.family, label: extra.label || s.label, note: extra.note || null });
  };

  const { spot, walls, maxPain, zeroGamma, cpr, prior, candles, profile, vwap } = input;
  const topWalls = (list, n) => (list || []).filter(w => w && w.oi > 0).sort((a, b) => b.oi - a.oi).slice(0, n);
  const callTop = topWalls(walls && walls.calls, 3);
  const putTop = topWalls(walls && walls.puts, 3);
  const maxCall = callTop[0] ? callTop[0].oi : 0;
  const maxPut = putTop[0] ? putTop[0].oi : 0;
  callTop.forEach(w => add('callWall', w.strike, { scale: 0.5 + 0.5 * (w.oi / maxCall), note: `${(w.oi / 100000).toFixed(1)}L OI` }));
  putTop.forEach(w => add('putWall', w.strike, { scale: 0.5 + 0.5 * (w.oi / maxPut), note: `${(w.oi / 100000).toFixed(1)}L OI` }));
  add('maxPain', maxPain);
  add('zeroGamma', zeroGamma);

  if (cpr) {
    add('cprPivot', cpr.pivot);
    add('cprEdge', cpr.tc, { label: 'CPR top' });
    add('cprEdge', cpr.bc, { label: 'CPR bottom' });
    add('pivotR', cpr.r1, { label: 'Pivot R1' });
    add('pivotR', cpr.r2, { label: 'Pivot R2', scale: 0.7 });
    add('pivotS', cpr.s1, { label: 'Pivot S1' });
    add('pivotS', cpr.s2, { label: 'Pivot S2', scale: 0.7 });
  }
  if (prior) {
    add('prevHigh', prior.prevHigh);
    add('prevLow', prior.prevLow);
    add('prevClose', prior.prevClose);
    if (prior.week) {
      add('weekHigh', prior.week.high);
      add('weekLow', prior.week.low);
    }
  }
  if (candles && candles.length) {
    const today = istDay(candles[candles.length - 1].t);
    const todays = candles.filter(c => istDay(c.t) === today);
    if (todays.length >= 3) {
      add('dayHigh', Math.max(...todays.map(c => c.h)));
      add('dayLow', Math.min(...todays.map(c => c.l)));
    }
    const { highs, lows } = swingPoints(candles.slice(-300), 3);
    highs.slice(-4).forEach(s => add('swingHigh', s.price, { scale: 0.7 }));
    lows.slice(-4).forEach(s => add('swingLow', s.price, { scale: 0.7 }));
  }
  if (profile) {
    add('poc', profile.poc);
    add('vah', profile.vah);
    add('val', profile.val);
    (profile.hvn || []).slice(0, 4).forEach(p => add('hvn', p));
  }
  add('vwap', vwap);
  if (finite(spot)) {
    roundLevels(spot, 500).forEach(p => add('round', p, { label: 'Round 500', scale: 1.4 }));
    roundLevels(spot, 100).filter(p => p % 500 !== 0).forEach(p => add('round', p, { scale: 0.6 }));
  }
  return out;
}

/**
 * Cluster levels that sit within `tol` of each other into zones. Greedy over sorted prices, so it is deterministic.
 * Strength (0-100) rewards total weight, with extra credit for distinct source families agreeing.
 */
function clusterLevels(levels, tol) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const groups = [];
  for (const lv of sorted) {
    const g = groups[groups.length - 1];
    if (g && lv.price - g.items[g.items.length - 1].price <= tol && lv.price - g.items[0].price <= tol * 2) g.items.push(lv);
    else groups.push({ items: [lv] });
  }
  return groups.map(g => {
    const items = g.items;
    const totalWeight = items.reduce((s, x) => s + x.weight, 0);
    const mid = items.reduce((s, x) => s + x.price * x.weight, 0) / totalWeight;
    const families = [...new Set(items.map(x => x.family))];
    const raw = totalWeight + (families.length - 1) * 2;
    const strength = Math.max(1, Math.min(100, Math.round((1 - Math.exp(-raw / 7)) * 100)));
    return {
      low: Math.min(...items.map(x => x.price)),
      high: Math.max(...items.map(x => x.price)),
      mid,
      strength,
      families,
      sources: items
        .sort((a, b) => b.weight - a.weight)
        .map(x => ({ type: x.type, label: x.label, price: x.price, family: x.family, note: x.note }))
    };
  });
}

/**
 * Track how price has treated each zone over the candles given.
 * touches: candles whose range reached the zone. held: touched and the close stayed on the original side.
 * Status: broken (a close beyond the zone by more than `tol`, on the far side), held (touched, never broken), untested.
 */
function trackZones(zones, candles, tol) {
  return zones.map(z => {
    // The side a zone defends is decided by where price was before it first touched it, so use the first candle.
    const side = candles.length && candles[0].c < z.mid ? 'below' : 'above';
    let touches = 0, held = 0, broken = false, lastTouch = null;
    for (const c of candles) {
      const touched = c.h >= z.low - tol * 0.25 && c.l <= z.high + tol * 0.25;
      if (touched) {
        touches += 1;
        lastTouch = c.t;
        const stayed = side === 'below' ? c.c < z.low + tol * 0.25 : c.c > z.high - tol * 0.25;
        if (stayed) held += 1;
      }
      if (side === 'below' && c.c > z.high + tol) broken = true;
      if (side === 'above' && c.c < z.low - tol) broken = true;
    }
    const status = broken ? 'broken' : touches ? 'held' : 'untested';
    return { ...z, touches, held, status, lastTouch };
  });
}

/**
 * Full ladder. Zones above spot are resistance, below are support, the zone containing spot is `inside`.
 * `tracking` candles are the current session's, used to mark zones as tested or broken.
 */
function buildLadder(input, { tracking = null, maxZones = 12 } = {}) {
  const { spot } = input;
  if (!finite(spot)) return { spot: null, zones: [], atr: 0, tolerance: 0 };
  const atrValue = input.atr || atr(input.candles || []);
  const tol = Math.max(spot * 0.0012, atrValue * 0.25);
  let zones = clusterLevels(collectLevels(input), tol);
  zones = zones.filter(z => Math.abs(z.mid - spot) / spot < 0.025);
  if (tracking && tracking.length) zones = trackZones(zones, tracking, tol);
  else zones = zones.map(z => ({ ...z, touches: 0, held: 0, status: 'untested', lastTouch: null }));

  // A zone that price has since crossed flips role: broken resistance below price behaves as support, and vice versa.
  zones = zones.map(z => {
    const kind = z.high < spot - tol * 0.25 ? 'support' : z.low > spot + tol * 0.25 ? 'resistance' : 'inside';
    return { ...z, kind, distance: z.mid - spot, distancePct: ((z.mid - spot) / spot) * 100 };
  });

  const keep = zones.sort((a, b) => b.strength - a.strength).slice(0, maxZones).sort((a, b) => b.mid - a.mid);
  return { spot, atr: atrValue, tolerance: tol, zones: keep };
}

module.exports = {
  SOURCES,
  atr,
  vwapSeries,
  volumeProfile,
  swingPoints,
  priorRanges,
  roundLevels,
  collectLevels,
  clusterLevels,
  trackZones,
  buildLadder
};
