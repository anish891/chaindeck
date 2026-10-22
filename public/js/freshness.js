// How current is each data feed? Pure helpers (no DOM, no imports) so the thresholds can be unit-tested.
//
//   freshness(kind, ageSec, { stale, open, hasData }) -> { level: 'ok' | 'warn' | 'bad' | 'idle', text }
//
// Outside market hours nothing is expected to move, so a feed is 'idle' (neutral) unless the server says it is serving
// a leftover copy. While the market is open the age decides the colour.

// seconds of age before a feed turns amber, then red
export const THRESHOLDS = {
  chain: { warn: 90, bad: 180 },   // NSE refreshes its option chain about every 30 to 60 seconds
  candles: { warn: 120, bad: 360 }, // measured as how far the latest bar's end is behind the clock; Yahoo is delayed by design
  saved: { warn: 180, bad: 360 }    // the per-minute cron snapshot
};

export function formatAge(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'n/a';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export function freshness(kind, ageSec, { stale = false, open = true, hasData = true } = {}) {
  const t = THRESHOLDS[kind];
  if (!t) throw new Error(`Unknown feed ${kind}`);
  if (!hasData) return { level: open ? 'bad' : 'idle', text: 'no data' };
  if (stale) return { level: 'bad', text: `stale ${formatAge(ageSec)}` };
  if (!open) return { level: 'idle', text: formatAge(ageSec) };
  if (!Number.isFinite(ageSec)) return { level: 'idle', text: 'n/a' };
  const level = ageSec >= t.bad ? 'bad' : ageSec >= t.warn ? 'warn' : 'ok';
  return { level, text: formatAge(ageSec) };
}

const BAR_MS = { '5m': 5 * 60000, '15m': 15 * 60000 };

/** Seconds the latest candle is behind real time (0 while the bar is still forming). null for daily candles. */
export function candleLagSec(feed, interval, nowMs) {
  if (!feed || !feed.lastBarT || !BAR_MS[interval]) return null;
  return Math.max(0, (nowMs - (feed.lastBarT + BAR_MS[interval])) / 1000);
}
