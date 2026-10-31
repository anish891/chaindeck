// Expiry-day readings: how fast the ATM straddle is decaying against time decay alone, how close spot sits to max pain
// and the heaviest OI strikes (with the probability options price for a close near each), and how concentrated gamma is
// near the money. Pure logic (no DOM, no imports) so api/verify-expiry.js can load it in Node.
//
// Inputs: d = /api/option-chain data, points = /api/intraday points (t, spot, straddle, maxPain, gexCr, atmIv).

const IST_OFFSET_MS = 330 * 60000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
const SESSION_MIN = CLOSE_MIN - OPEN_MIN; // 375
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const PIN_BAND = 25; // half a NIFTY strike step: "closes at this strike"
const NEAR_STRIKES = 5; // strikes either side of ATM for the gamma view
const DECAY_MIN_ELAPSED = 15; // minutes of session before the decay verdict means anything
const DECAY_TOLERANCE = 0.1; // within 10% of the time-only path counts as "in line"

/** '04-Nov-2026' -> '2026-11-04', or null. */
export function expiryYmd(expiry) {
  const m = /^(\d{2})-([A-Z][a-z]{2})-(\d{4})$/.exec(expiry || '');
  if (!m || MONTHS[m[2]] === undefined) return null;
  return `${m[3]}-${String(MONTHS[m[2]] + 1).padStart(2, '0')}-${m[1]}`;
}

function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const ymd = d.toISOString().slice(0, 10);
  return { ymd, mins: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60, weekday: d.getUTCDay() };
}

/** 15:30 IST on the expiry date, in ms. */
function expiryCloseMs(ymd) {
  return Date.parse(`${ymd}T10:00:00Z`);
}

/** Trading minutes left in the expiry session at time t (0 once it closes, the full session before it opens). */
export function sessionMinutesLeft(t) {
  const { mins } = istParts(t);
  return Math.max(0, CLOSE_MIN - Math.max(mins, OPEN_MIN));
}

function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const dd = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = dd * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/**
 * Probability that the expiry close lands within `band` points of `strike`, with the move to expiry treated as normal
 * with standard deviation `sigma` points (1.25 x the ATM straddle). Priced by options, not a forecast.
 */
export function closeNearProb(spot, strike, sigma, band = PIN_BAND) {
  if (!(sigma > 0) || !(spot > 0)) return null;
  return normalCdf((strike + band - spot) / sigma) - normalCdf((strike - band - spot) / sigma);
}

/** Black-Scholes gamma per unit of the underlying, calendar time (NSE IVs are quoted on a 365-day basis). */
export function bsGamma(spot, strike, years, ivPct) {
  const v = ivPct / 100;
  if (!(spot > 0) || !(strike > 0) || !(years > 0) || !(v > 0)) return null;
  const sq = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * v * v * years) / (v * sq);
  return Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI) / (spot * v * sq);
}

const yearsTo = (closeMs, t) => Math.max(0, closeMs - t) / (365 * 86400000);

/**
 * Straddle against the path time decay alone would take. With IV and spot unchanged, an ATM straddle is close to
 * proportional to the square root of time left, so from its value at the first snapshot after 09:15 it "should" be
 * open x sqrt(minutes left now / minutes left then). Running below that path means premium is falling faster than the
 * clock (IV coming off, or price pinned); above it means price is moving or IV is rising.
 */
export function straddleDecay(points, expiryDay, live = null) {
  const today = (points || []).filter(p => p && p.straddle > 0 && Number.isFinite(p.t))
    .filter(p => { const ip = istParts(p.t); return ip.ymd === expiryDay && ip.mins >= OPEN_MIN && ip.mins <= CLOSE_MIN; })
    .sort((a, b) => a.t - b.t);
  if (live && live.straddle > 0 && Number.isFinite(live.t) && istParts(live.t).ymd === expiryDay
    && (!today.length || live.t > today[today.length - 1].t) && istParts(live.t).mins >= OPEN_MIN) {
    today.push({ t: live.t, straddle: live.straddle });
  }
  if (!today.length) return { status: 'waiting', series: [] };

  const first = today[0];
  const m0 = sessionMinutesLeft(first.t);
  const pathAt = t => (m0 > 0 ? first.straddle * Math.sqrt(sessionMinutesLeft(t) / m0) : null);
  const series = today.map(p => ({ t: p.t, straddle: p.straddle, timeOnly: pathAt(p.t) }));
  const last = today[today.length - 1];
  const elapsed = m0 - sessionMinutesLeft(last.t);
  const timeOnlyNow = pathAt(last.t);
  const minsLeft = sessionMinutesLeft(last.t);

  // Last 30 minutes: points per hour actually lost, and what time decay alone would have taken over the same stretch
  let rate = null;
  const back = [...today].reverse().find(p => p.t <= last.t - 30 * 60000);
  if (back) {
    const hrs = (last.t - back.t) / 3600000;
    const pathBack = pathAt(back.t), pathNow = pathAt(last.t);
    rate = {
      actualPerHour: (back.straddle - last.straddle) / hrs,
      timeOnlyPerHour: pathBack !== null && pathNow !== null ? (pathBack - pathNow) / hrs : null,
      sinceMs: back.t
    };
  }

  let verdict = 'early';
  let ratio = null;
  if (elapsed >= DECAY_MIN_ELAPSED && timeOnlyNow > 0 && minsLeft >= 5) {
    ratio = last.straddle / timeOnlyNow;
    verdict = ratio < 1 - DECAY_TOLERANCE ? 'faster' : ratio > 1 + DECAY_TOLERANCE ? 'slower' : 'inline';
  } else if (minsLeft < 5) {
    verdict = 'closing';
  }

  // Where the time-only path would sit later today, from the current value (only checkpoints still ahead)
  const ahead = [13 * 60, 14 * 60, 15 * 60].filter(m => m > CLOSE_MIN - minsLeft).map(m => {
    const left = CLOSE_MIN - m;
    return { mins: m, value: minsLeft > 0 ? last.straddle * Math.sqrt(left / minsLeft) : null };
  });

  return {
    status: 'ok',
    open: { t: first.t, straddle: first.straddle },
    now: { t: last.t, straddle: last.straddle },
    decayedPct: ((first.straddle - last.straddle) / first.straddle) * 100,
    timeOnlyNow,
    ratio,
    verdict,
    rate,
    ahead,
    minsLeft,
    series
  };
}

/** Max pain over the day, distance from spot, and the close-near probability for max pain and the heaviest strikes. */
export function pinRisk(d, points, expiryDay) {
  const spot = d.spot;
  const sigma = d.straddleDetails && d.straddleDetails.oneSigmaMove > 0 ? d.straddleDetails.oneSigmaMove : null;
  const maxPain = d.maxPain;

  const path = (points || []).filter(p => p && p.maxPain > 0 && Number.isFinite(p.t) && istParts(p.t).ymd === expiryDay)
    .sort((a, b) => a.t - b.t);
  const shifts = [];
  for (let i = 1; i < path.length; i++) {
    if (path[i].maxPain !== path[i - 1].maxPain) shifts.push({ t: path[i].t, from: path[i - 1].maxPain, to: path[i].maxPain });
  }
  if (path.length && maxPain > 0 && path[path.length - 1].maxPain !== maxPain) {
    shifts.push({ t: Date.parse(d.dataAsOf) || path[path.length - 1].t, from: path[path.length - 1].maxPain, to: maxPain });
  }

  // Heaviest combined OI strikes within 2 sigma of spot (at least 150 points so a tiny late-day sigma still shows a few)
  const reach = Math.max(150, sigma ? 2 * sigma : 0);
  const heavy = (d.strikes || [])
    .map(s => ({ strike: s.strike, ceOI: s.CE?.openInterest || 0, peOI: s.PE?.openInterest || 0 }))
    .map(s => ({ ...s, oi: s.ceOI + s.peOI }))
    .filter(s => s.oi > 0 && Math.abs(s.strike - spot) <= reach)
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 3)
    .map(s => ({ ...s, distance: s.strike - spot, prob: closeNearProb(spot, s.strike, sigma) }));

  return {
    spot,
    sigma,
    maxPain,
    distance: maxPain > 0 ? spot - maxPain : null,
    distanceSigma: maxPain > 0 && sigma ? (spot - maxPain) / sigma : null,
    maxPainProb: maxPain > 0 ? closeNearProb(spot, maxPain, sigma) : null,
    atOpen: path.length ? path[0].maxPain : null,
    shifts: shifts.slice(-5),
    shiftCount: shifts.length,
    heavy,
    band: PIN_BAND
  };
}

/**
 * Gamma by strike near the money, with the same dealer convention as the server's GEX (long calls, short puts), and the
 * ATM gamma now against the open: on expiry day the same 50-point move swings an ATM option's delta far more by the
 * afternoon than at 09:15.
 */
export function gammaNearMoney(d, points, closeMs) {
  const spot = d.spot;
  const lot = (d.gex && d.gex.lotSize) || 65;
  const scale = lot * spot * spot * 0.01 / 1e7; // OI x gamma -> Cr per 1% move
  const rows = (d.strikes || []).map(s => {
    const cg = s.CE?.greeks?.gamma || 0, pg = s.PE?.greeks?.gamma || 0;
    const c = (s.CE?.openInterest || 0) * cg * scale;
    const p = (s.PE?.openInterest || 0) * pg * scale;
    return { strike: s.strike, callCr: c, putCr: p, netCr: c - p, grossCr: c + p };
  });
  const totalGross = rows.reduce((a, r) => a + r.grossCr, 0);
  const atm = d.atm || Math.round(spot / 50) * 50;
  const near = rows.filter(r => Math.abs(r.strike - atm) <= NEAR_STRIKES * 50).sort((a, b) => a.strike - b.strike);
  const nearGross = near.reduce((a, r) => a + r.grossCr, 0);
  const peak = near.reduce((best, r) => (!best || r.grossCr > best.grossCr ? r : best), null);

  // ATM gamma per unit with the same formula at both times, so the ratio compares like with like
  const liveT = Date.parse(d.dataAsOf) || null;
  const gNow = liveT ? bsGamma(spot, atm, yearsTo(closeMs, liveT), d.atmIv) : null;
  const firstToday = (points || []).filter(p => p && p.spot > 0 && p.atmIv > 0 && Number.isFinite(p.t))
    .filter(p => { const ip = istParts(p.t); return ip.ymd === istParts(closeMs).ymd && ip.mins >= OPEN_MIN; })
    .sort((a, b) => a.t - b.t)[0] || null;
  const gOpen = firstToday ? bsGamma(firstToday.spot, Math.round(firstToday.spot / 50) * 50, yearsTo(closeMs, firstToday.t), firstToday.atmIv) : null;

  const gex = (points || []).filter(p => p && Number.isFinite(p.gexCr) && Number.isFinite(p.t) && istParts(p.t).ymd === istParts(closeMs).ymd)
    .sort((a, b) => a.t - b.t);

  return {
    rows: near,
    maxAbsNet: near.reduce((m, r) => Math.max(m, Math.abs(r.netCr)), 0),
    nearSharePct: totalGross > 0 ? (nearGross / totalGross) * 100 : null,
    peak,
    atm,
    atmGamma: gNow,
    deltaPer50: gNow !== null ? gNow * 50 : null,
    atmGammaOpen: gOpen,
    gammaVsOpen: gNow !== null && gOpen > 0 ? gNow / gOpen : null,
    netGexCr: d.gex ? d.gex.totalGexCr : null,
    netGexOpenCr: gex.length ? gex[0].gexCr : null,
    zeroGamma: d.gex ? d.gex.zeroGammaLevel : null,
    regime: d.gex ? d.gex.gexRegime : null
  };
}

/** Everything the panel shows. `isExpiryDay` compares the expiry date with the date NSE quoted the prices. */
export function computeExpiryDay(d, points = [], nowMs = Date.now()) {
  if (!d || !d.expiry || !(d.spot > 0)) return { status: 'nodata' };
  const ymd = expiryYmd(d.expiry);
  if (!ymd) return { status: 'nodata' };
  const quoteMs = Date.parse(d.dataAsOf) || nowMs;
  const quoteDay = istParts(quoteMs).ymd;
  const closeMs = expiryCloseMs(ymd);
  const isExpiryDay = quoteDay === ymd;
  const weekday = istParts(closeMs).weekday;

  return {
    status: 'ok',
    expiry: d.expiry,
    expiryYmd: ymd,
    weekday,
    isExpiryDay,
    tradingDaysLeft: d.straddleDetails ? d.straddleDetails.tradingDaysLeft : null,
    minsLeft: isExpiryDay ? sessionMinutesLeft(quoteMs) : null,
    decay: isExpiryDay ? straddleDecay(points, ymd, { t: quoteMs, straddle: d.straddlePrice }) : { status: 'not-expiry', series: [] },
    pin: pinRisk(d, isExpiryDay ? points : [], ymd),
    gamma: gammaNearMoney(d, isExpiryDay ? points : [], closeMs)
  };
}

export const EXPIRY_CONSTANTS = { SESSION_MIN, PIN_BAND, NEAR_STRIKES, DECAY_TOLERANCE, DECAY_MIN_ELAPSED };
