// The trust layer's brain: combines the server's integrity checks with checks only the browser can make, and decides one
// overall status plus whether signals and alerts must pause. Pure (no DOM, no storage) so it is unit-tested in Node.
//
//   evaluateTrust(input) -> { status: 'ok' | 'warn' | 'bad', checks, summary, blocking, reasons, flags }
//
// input: { now, marketOpen, chain: { d, ageSec, stale, staleReason, integrity }, candles: {...} | null, saved: {...} | null,
//          content: { sameCount } }
//
// What this can do: show that the numbers are fresh, internally consistent and agree with a second source.
// What it cannot do: prove NSE itself is right.

import { freshness, candleLagSec } from './freshness.js';

// Checks whose failure means the screen must not be trusted for decisions: signals and alerts pause.
export const BLOCKING = new Set(['nse_fresh', 'nse_stale_copy', 'nse_content', 'spot_vs_yahoo', 'oi_totals', 'pcr_recompute', 'max_pain', 'parity', 'chain_rows', 'integrity_engine']);

// Which on-page values a failing check makes unverified (element ids; the UI tags the card around them)
export const CHECK_TARGETS = {
  nse_fresh: ['ksSpot', 'ksPcr', 'ksPain', 'mPCR'],
  nse_stale_copy: ['ksSpot', 'ksPcr', 'ksPain', 'mPCR'],
  nse_content: ['ksSpot', 'ksPcr'],
  spot_vs_yahoo: ['ksSpot'],
  pcr_recompute: ['ksPcr', 'mPCR'],
  oi_totals: ['mCallOI', 'mPutOI'],
  max_pain: ['ksPain'],
  parity: ['mStraddle'],
  basis: [],
  day_range: ['ksDay']
};

export const SPOT_TOLERANCE = { warn: 0.0015, fail: 0.004 }; // NSE vs Yahoo, as a fraction of spot (Yahoo is delayed, so not tighter)
export const FROZEN = { warn: 3, fail: 5 };                   // consecutive NEW snapshots with identical contents

const chk = (id, group, label, level, detail) => ({ id, group, label, level, detail });
const fromFresh = (f, okText) => ({ level: f.level === 'bad' ? 'fail' : f.level === 'warn' ? 'warn' : 'pass', detail: f.level === 'idle' ? `${f.text} (market closed)` : f.text === 'no data' ? 'no data' : `${okText} ${f.text}` });

/** Fingerprint of a snapshot's contents. Real snapshots change minute to minute; an identical fingerprint on a NEW timestamp is suspicious. */
export function contentSignature(d) {
  if (!d || !Array.isArray(d.strikes)) return null;
  let sum = 0;
  for (const s of d.strikes) {
    for (const leg of [s.CE, s.PE]) if (leg) sum += (leg.openInterest || 0) + (leg.lastPrice || 0) * 100 + (leg.totalTradedVolume || 0) * 7;
  }
  return `${Math.round(sum)}|${d.spot}`;
}

/** Track how many consecutive NEW snapshots carried identical contents. state: { asOf, sig, sameCount } */
export function trackContent(state, d) {
  const sig = contentSignature(d);
  const asOf = d && (d.dataAsOf || null);
  if (!sig || !asOf) return state || { asOf: null, sig: null, sameCount: 0 };
  if (!state || state.sig === null) return { asOf, sig, sameCount: 0 };
  if (asOf === state.asOf) return state; // same snapshot seen again: no new information
  return { asOf, sig, sameCount: sig === state.sig ? state.sameCount + 1 : 0 };
}

/** How many of the minutes since the open have a saved point. points: [{ t }]. */
export function snapshotCoverage(points, nowMs, marketOpen) {
  if (!Array.isArray(points) || !points.length) return null;
  const IST = 330 * 60000;
  const last = points[points.length - 1].t;
  const day = new Date(last + IST).toISOString().slice(0, 10);
  const todays = points.filter(p => new Date(p.t + IST).toISOString().slice(0, 10) === day);
  const open = Date.parse(`${day}T09:15:00+05:30`);
  const close = Date.parse(`${day}T15:30:00+05:30`);
  const end = marketOpen ? Math.min(nowMs, close) : Math.min(Math.max(todays[todays.length - 1].t, open), close);
  const expected = Math.max(0, Math.floor((end - open) / 60000));
  if (expected < 20) return null; // too early in the session to judge
  const minutes = new Set(todays.filter(p => p.t >= open && p.t <= close).map(p => Math.floor(p.t / 60000)));
  let largestGap = 0, prev = null;
  [...minutes].sort((a, b) => a - b).forEach(m => { if (prev !== null) largestGap = Math.max(largestGap, m - prev - 1); prev = m; });
  return { have: Math.min(minutes.size, expected), expected, ratio: Math.min(1, minutes.size / expected), largestGap };
}

export function evaluateTrust({ now, marketOpen, chain = null, candles = null, saved = null, content = null } = {}) {
  const checks = [];
  const F = 'Freshness';

  // ── NSE option chain ──
  if (!chain || !chain.d) {
    checks.push(chk('nse_fresh', F, 'Option chain from NSE is current', marketOpen ? 'fail' : 'skip', 'no option chain loaded'));
  } else {
    const f = freshness('chain', chain.ageSec, { stale: false, open: marketOpen, hasData: true });
    const r = fromFresh(f, 'last NSE update');
    checks.push(chk('nse_fresh', F, 'Option chain from NSE is current', r.level, r.detail));
    // While trading a leftover copy means the screen is behind the market (fail, pauses signals). After the close nothing is
    // moving, so the last good copy is still the right picture and it only warns.
    checks.push(chk('nse_stale_copy', F, 'Not showing a leftover copy', chain.stale ? (marketOpen ? 'fail' : 'warn') : 'pass', chain.stale ? `NSE did not answer, showing the last good copy${chain.staleReason ? ` (${chain.staleReason})` : ''}${marketOpen ? '' : '; the market is closed so nothing has changed'}` : 'live from NSE'));
    const same = content ? content.sameCount : 0;
    checks.push(chk('nse_content', F, 'Snapshots are actually changing', !marketOpen ? 'skip' : same >= FROZEN.fail ? 'fail' : same >= FROZEN.warn ? 'warn' : 'pass',
      !marketOpen ? 'market closed' : same >= FROZEN.warn ? `${same + 1} new snapshots in a row with identical contents` : 'contents change between snapshots'));
  }

  // ── candles (Yahoo) ──
  if (candles && candles.hasCandles) {
    const lag = candleLagSec(candles.feed, candles.interval, now);
    const pollAge = candles.clientFetchedAt ? (now - candles.clientFetchedAt) / 1000 : 0;
    const age = lag === null ? NaN : Math.max(lag, pollAge > 90 ? pollAge : 0);
    const f = freshness('candles', age, { stale: !!(candles.feed && candles.feed.stale), open: marketOpen && lag !== null, hasData: true });
    const r = fromFresh(f, 'latest candle is');
    checks.push(chk('candles_fresh', F, 'Price candles are current', r.level, candles.feed && candles.feed.source === 'stored' ? `${r.detail}; built from saved spot values, not Yahoo` : r.detail));
  } else {
    checks.push(chk('candles_fresh', F, 'Price candles are current', marketOpen ? 'warn' : 'skip', 'no candles loaded'));
  }

  // ── saved snapshots (cron) ──
  if (saved && saved.persistent === false) {
    checks.push(chk('saved_fresh', F, 'Per-minute snapshots are being saved', 'skip', 'storage is not configured, so history is only kept in memory'));
  } else if (saved && saved.points && saved.points.length) {
    const last = saved.points[saved.points.length - 1].t;
    const f = freshness('saved', (now - last) / 1000, { open: marketOpen, hasData: true });
    const r = fromFresh(f, 'last saved point');
    checks.push(chk('saved_fresh', F, 'Per-minute snapshots are being saved', r.level, r.detail));
    const cov = snapshotCoverage(saved.points, now, marketOpen);
    if (cov) {
      // Gaps in saved history never make the LIVE numbers wrong, so this check warns at most and never pauses anything.
      const level = cov.ratio < 0.9 ? 'warn' : 'pass';
      checks.push(chk('saved_coverage', 'History', 'Saved history is complete', level, `${cov.have} of ${cov.expected} minutes saved today${cov.largestGap > 3 ? `, longest gap ${cov.largestGap} min` : ''}`));
    }
  } else {
    checks.push(chk('saved_fresh', F, 'Per-minute snapshots are being saved', marketOpen ? 'warn' : 'skip', 'no saved history found (needs storage and the cron job)'));
  }

  // ── cross-source: NSE spot vs the Yahoo candle ──
  const lastClose = candles && candles.lastClose;
  if (chain && chain.d && Number.isFinite(lastClose) && candles.feed && candles.feed.source === 'yahoo' && !candles.feed.stale) {
    const gap = Math.abs(chain.d.spot - lastClose) / chain.d.spot;
    const lvl = gap <= SPOT_TOLERANCE.warn ? 'pass' : gap <= SPOT_TOLERANCE.fail ? 'warn' : 'fail';
    checks.push(chk('spot_vs_yahoo', 'Cross-check', 'NSE spot agrees with the Yahoo price', lvl, `${(gap * 100).toFixed(2)}% apart (NSE ${Math.round(chain.d.spot)}, Yahoo ${Math.round(lastClose)})`));
  } else {
    checks.push(chk('spot_vs_yahoo', 'Cross-check', 'NSE spot agrees with the Yahoo price', 'skip', 'no current Yahoo candle to compare with'));
  }

  // ── the server's independent recomputation ──
  const server = chain && chain.integrity && chain.integrity.checks;
  if (Array.isArray(server)) checks.push(...server);
  else if (chain && chain.d) checks.push(chk('integrity_engine', 'Option chain', 'Option chain recomputed independently', 'warn', 'the server sent no integrity checks'));

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  checks.forEach(c => { summary[c.level] += 1; });
  const failed = checks.filter(c => c.level === 'fail');
  const status = failed.length ? 'bad' : summary.warn ? 'warn' : 'ok';
  const blockers = failed.filter(c => BLOCKING.has(c.id));
  return {
    status,
    checks,
    summary,
    blocking: blockers.length > 0,
    reasons: blockers.map(c => `${c.label}: ${c.detail}`),
    flags: Object.fromEntries(checks.filter(c => c.level === 'fail' || c.level === 'warn').map(c => [c.id, c.level]))
  };
}
