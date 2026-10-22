// Data integrity for the NSE option chain.
//
//   validateRaw(raw, prev)             runs BEFORE anything is cached: rejects structurally broken or non-sensical payloads,
//                                      so the last good copy is kept (and flagged stale) instead of showing garbage.
//   verifyProcessed(raw, data, expiry) runs AFTER analytics: recomputes the headline numbers straight from the raw payload,
//                                      with separate code, and compares. Two independent implementations agreeing is the
//                                      verification. It can show our maths matches NSE's data and that the data is internally
//                                      consistent; it cannot prove NSE itself is right.
//
// Check result: { id, group, label, level: 'pass' | 'warn' | 'fail' | 'skip', detail }.

const MIN_SPOT = 1000;
const MAX_SPOT = 200000;
const MAX_SPOT_JUMP = 0.08;        // between two snapshots less than a day apart
const MIN_ROWS = 20;
const IST = '+0530';

/** NSE timestamp "22-Oct-2026 15:29:59" -> epoch ms, or null. */
function parseNseTs(str) {
  if (!str || typeof str !== 'string') return null;
  const t = Date.parse(`${str.replace(/-/g, ' ')} GMT${IST}`);
  return Number.isFinite(t) ? t : null;
}

const finiteNum = x => typeof x === 'number' && Number.isFinite(x);
const spotOf = raw => {
  const r = raw && raw.records;
  if (!r) return NaN;
  return r.underlyingValue || (r.data && r.data[0] && ((r.data[0].CE && r.data[0].CE.underlyingValue) || (r.data[0].PE && r.data[0].PE.underlyingValue))) || NaN;
};

/** Rows for one expiry as sorted [{ strike, CE, PE }]. */
function strikesFor(raw, expiry) {
  const map = new Map();
  for (const r of (raw && raw.records && raw.records.data) || []) {
    if ((r.expiryDate || r.expiryDates) !== expiry) continue;
    const e = map.get(r.strikePrice) || { strike: r.strikePrice };
    if (r.CE) e.CE = r.CE;
    if (r.PE) e.PE = r.PE;
    map.set(r.strikePrice, e);
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

// ── 1. validation before caching ─────────────────────────────────────────

/**
 * @param prev the previously accepted { raw } (or null)
 * @returns { ok, reasons: string[] }
 */
function validateRaw(raw, prev = null, now = Date.now()) {
  const reasons = [];
  const rec = raw && raw.records;
  if (!rec || !Array.isArray(rec.data)) return { ok: false, reasons: ['missing records.data'] };
  if (rec.data.length < MIN_ROWS) reasons.push(`only ${rec.data.length} rows`);

  const spot = spotOf(raw);
  if (!finiteNum(spot) || spot < MIN_SPOT || spot > MAX_SPOT) reasons.push(`implausible spot ${spot}`);

  // Every numeric field the app later uses (and, for the table, writes into HTML) must really be a number: a string here
  // would flow through the maths and into the page unescaped.
  const NON_NEGATIVE = new Set(['openInterest', 'totalTradedVolume', 'lastPrice', 'impliedVolatility']);
  const LEG_FIELDS = ['openInterest', 'totalTradedVolume', 'changeinOpenInterest', 'lastPrice', 'impliedVolatility', 'underlyingValue', 'change'];
  let bad = 0, empty = 0, badStrike = 0, badExpiry = 0;
  for (const r of rec.data) {
    if (!finiteNum(r.strikePrice) || r.strikePrice <= 0) badStrike += 1;
    const ex = r.expiryDate !== undefined ? r.expiryDate : r.expiryDates;
    if (ex !== undefined && !(typeof ex === 'string' && /^\d{2}-[A-Za-z]{3}-\d{4}$/.test(ex))) badExpiry += 1;
    if (!r.CE && !r.PE) { empty += 1; continue; }
    for (const leg of [r.CE, r.PE]) {
      if (!leg) continue;
      for (const f of LEG_FIELDS) {
        const v = leg[f];
        if (v === undefined || v === null) continue;
        if (!finiteNum(v)) bad += 1;
        else if (NON_NEGATIVE.has(f) && v < 0) bad += 1;
      }
    }
  }
  if (bad) reasons.push(`${bad} non-numeric or negative values`);
  if (badStrike) reasons.push(`${badStrike} rows with an invalid strike price`);
  if (badExpiry) reasons.push(`${badExpiry} rows with a malformed expiry date`);
  if (rec.data.length && empty / rec.data.length > 0.2) reasons.push('many rows with no quotes');

  const ts = parseNseTs(rec.timestamp);
  if (rec.timestamp && ts === null) reasons.push('unreadable timestamp');
  if (ts !== null && ts > now + 10 * 60 * 1000) reasons.push('timestamp is in the future');

  if (prev && prev.raw) {
    const prevSpot = spotOf(prev.raw);
    const prevTs = parseNseTs(prev.raw.records && prev.raw.records.timestamp);
    if (finiteNum(spot) && finiteNum(prevSpot) && prevSpot > 0) {
      const sameDay = prevTs !== null && ts !== null && Math.abs(ts - prevTs) < 20 * 3600 * 1000;
      if (sameDay && Math.abs(spot - prevSpot) / prevSpot > MAX_SPOT_JUMP) reasons.push(`spot jumped ${(((spot - prevSpot) / prevSpot) * 100).toFixed(1)}% between snapshots`);
    }
    if (ts !== null && prevTs !== null && ts < prevTs) reasons.push('snapshot is older than the one already held');
  }
  return { ok: reasons.length === 0, reasons };
}

// ── 2. independent recomputation ─────────────────────────────────────────

const chk = (id, group, label, level, detail) => ({ id, group, label, level, detail });

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
}

/** Max pain by brute force: for each candidate expiry price, total payout to option buyers; the minimum wins. */
function maxPainBruteForce(strikes) {
  let best = null, bestPain = Infinity;
  const pain = new Map();
  for (const cand of strikes) {
    let total = 0;
    for (const s of strikes) {
      total += Math.max(0, cand.strike - s.strike) * ((s.CE && s.CE.openInterest) || 0);
      total += Math.max(0, s.strike - cand.strike) * ((s.PE && s.PE.openInterest) || 0);
    }
    pain.set(cand.strike, total);
    if (total < bestPain) { bestPain = total; best = cand.strike; }
  }
  return { strike: best, pain, min: bestPain };
}

function verifyProcessed(raw, data, expiry) {
  const out = [];
  const strikes = strikesFor(raw, expiry);
  const G = 'Option chain';

  if (!data || strikes.length < MIN_ROWS / 2) {
    out.push(chk('chain_rows', G, 'Enough strikes for this expiry', 'fail', `${strikes.length} strikes found`));
    return out;
  }
  out.push(chk('chain_rows', G, 'Enough strikes for this expiry', 'pass', `${strikes.length} strikes`));

  // totals and PCR, recomputed from the raw rows
  let callOI = 0, putOI = 0;
  for (const s of strikes) { callOI += (s.CE && s.CE.openInterest) || 0; putOI += (s.PE && s.PE.openInterest) || 0; }
  const near = (a, b, tolPct) => Math.abs(a - b) <= Math.max(1, Math.abs(b)) * tolPct;
  const totalsOk = near(callOI, data.totalCallOI, 0.0005) && near(putOI, data.totalPutOI, 0.0005);
  out.push(chk('oi_totals', G, 'Total call and put OI match the raw data', totalsOk ? 'pass' : 'fail', totalsOk ? `calls ${callOI.toLocaleString('en-IN')}, puts ${putOI.toLocaleString('en-IN')}` : `shown ${data.totalCallOI}/${data.totalPutOI}, raw ${callOI}/${putOI}`));

  const pcr = callOI > 0 ? putOI / callOI : 0;
  const pcrOk = Math.abs(pcr - data.pcr) <= 0.006;
  out.push(chk('pcr_recompute', G, 'PCR recomputed from strike OI', pcrOk ? 'pass' : 'fail', pcrOk ? `${pcr.toFixed(2)} matches` : `shown ${data.pcr}, recomputed ${pcr.toFixed(3)}`));

  // max pain
  const mp = maxPainBruteForce(strikes);
  const shownPain = mp.pain.get(data.maxPain);
  const mpOk = shownPain !== undefined && shownPain <= mp.min * 1.0001 + 1;
  out.push(chk('max_pain', G, 'Max pain recomputed independently', mpOk ? 'pass' : 'fail', mpOk ? `${data.maxPain}` : `shown ${data.maxPain}, recomputed ${mp.strike}`));

  // ATM strike is the nearest strike to spot
  const spot = data.spot;
  const nearest = strikes.reduce((b, s) => (Math.abs(s.strike - spot) < Math.abs(b.strike - spot) ? s : b), strikes[0]);
  const atmOk = Math.abs(nearest.strike - data.atm) <= 50;
  out.push(chk('atm_strike', G, 'ATM strike is the one nearest spot', atmOk ? 'pass' : 'fail', `ATM ${data.atm}, nearest ${nearest.strike}`));

  // put-call parity: every near-money strike should imply about the same forward (K + C - P)
  const ring = strikes.filter(s => Math.abs(s.strike - spot) <= 250 && s.CE && s.PE && s.CE.lastPrice > 0 && s.PE.lastPrice > 0);
  if (ring.length >= 3) {
    const fwd = ring.map(s => ({ k: s.strike, f: s.strike + s.CE.lastPrice - s.PE.lastPrice }));
    const med = median(fwd.map(x => x.f));
    const tol = spot * 0.0015;
    const bad = fwd.filter(x => Math.abs(x.f - med) > tol);
    const level = bad.length === 0 ? 'pass' : bad.length / fwd.length >= 0.4 ? 'fail' : 'warn';
    out.push(chk('parity', G, 'Put-call parity holds near the money', level, bad.length ? `${bad.length} of ${fwd.length} strikes imply a different forward (${bad.slice(0, 3).map(x => x.k).join(', ')}), likely stale quotes` : `${fwd.length} strikes agree on a forward near ${Math.round(med)}`));
  } else {
    out.push(chk('parity', G, 'Put-call parity holds near the money', 'skip', 'too few strikes with live quotes on both sides'));
  }

  // implied future vs spot
  if (finiteNum(data.impliedFuture)) {
    const gap = Math.abs(data.impliedFuture - spot) / spot;
    out.push(chk('basis', G, 'Implied future is close to spot', gap <= 0.01 ? 'pass' : gap <= 0.025 ? 'warn' : 'fail', `${(gap * 100).toFixed(2)}% apart`));
  } else {
    out.push(chk('basis', G, 'Implied future is close to spot', 'skip', 'no ATM quotes to derive it'));
  }

  // ATM IV in a plausible band
  if (finiteNum(data.atmIv) && data.atmIv > 0) {
    const ok = data.atmIv >= 4 && data.atmIv <= 100;
    out.push(chk('iv_range', G, 'ATM implied volatility is plausible', ok ? 'pass' : data.atmIv < 1 || data.atmIv > 150 ? 'fail' : 'warn', `${data.atmIv}%`));
  } else {
    out.push(chk('iv_range', G, 'ATM implied volatility is plausible', 'skip', 'IV not available'));
  }

  // the day's range must contain spot
  const day = data.day;
  if (day && finiteNum(day.high) && finiteNum(day.low) && day.high > 0) {
    const slack = spot * 0.0005;
    const ok = spot >= day.low - slack && spot <= day.high + slack;
    out.push(chk('day_range', G, 'Spot sits inside the day range', ok ? 'pass' : 'fail', `${day.low} to ${day.high}, spot ${spot}`));
  } else {
    out.push(chk('day_range', G, 'Spot sits inside the day range', 'skip', 'day range not available'));
  }
  return out;
}

/** True when any check failed outright. */
const hasFailure = checks => checks.some(c => c.level === 'fail');

module.exports = { parseNseTs, strikesFor, validateRaw, verifyProcessed, maxPainBruteForce, hasFailure, MAX_SPOT_JUMP };
