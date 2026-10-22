// NSE trading calendar (equity derivatives): which days the market is closed besides weekends.
//
// Pure module with no imports, so nse.js, volatility.js and the routes can all use it without import cycles.
// The list is refreshed from NSE's own holiday master (see nse.refreshHolidays) and falls back to the list below if
// that cannot be reached. The fallback covers 2026 only: for a year with no data the module has no holidays to apply
// and behaves like a plain Monday-Friday calendar, which is the previous behaviour.
//
// Special sessions (for example the one-hour Muhurat trading on Diwali) are not modelled.

const IST_OFFSET_MS = 330 * 60 * 1000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Official NSE trading holidays 2026 that fall on weekdays (verified against NSE's holiday master on 2026-10-24).
const FALLBACK_HOLIDAYS = [
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01',
  '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25'
];

let holidays = new Set(FALLBACK_HOLIDAYS);
let source = 'fallback';
let updatedAt = 0;

/** '26-Jan-2026' -> '2026-01-26', or null. */
function nseDateToYmd(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi === -1) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * Replace the holiday list from NSE's holiday-master JSON ({ FO: [{ tradingDate }], CM: [...] }).
 * Returns the number of dates loaded, or 0 (list unchanged) if the payload does not look right.
 */
function setHolidaysFromNse(json, now = Date.now()) {
  const rows = json && (Array.isArray(json.FO) && json.FO.length ? json.FO : Array.isArray(json.CM) ? json.CM : null);
  if (!rows) return 0;
  const dates = rows.map(r => nseDateToYmd(r && r.tradingDate)).filter(Boolean);
  // A holiday list always has several entries for a year; an empty or tiny one means the payload is not what we expect.
  if (dates.length < 5) return 0;
  holidays = new Set(dates);
  source = 'nse';
  updatedAt = now;
  return dates.length;
}

/** Test hook and manual override. */
function setHolidays(list) {
  holidays = new Set(list);
  source = 'manual';
  updatedAt = Date.now();
}

const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istDow = ms => new Date(ms + IST_OFFSET_MS).getUTCDay();

const isHoliday = ymd => holidays.has(ymd);

/** Is this IST calendar day a trading day (Monday-Friday and not an NSE holiday)? */
function isTradingDayYmd(ymd) {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(ymd);
}
const isTradingDay = ms => isTradingDayYmd(istYmd(ms));

/** Regular session (09:15-15:30 IST) on a trading day. `bufferMin` widens it on both sides (the app uses 5 / 10). */
function isMarketOpenAt(ms, { before = 0, after = 0 } = {}) {
  if (!isTradingDay(ms)) return false;
  const d = new Date(ms + IST_OFFSET_MS);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= OPEN_MIN - before && mins <= CLOSE_MIN + after;
}

/** Minutes of regular session between two instants: weekends and NSE holidays are skipped. */
function tradingMinutesBetween(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  const DAY_MS = 24 * 3600 * 1000;
  let total = 0;
  let dayStart = Math.floor((fromMs + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS; // IST midnight
  for (; dayStart < toMs; dayStart += DAY_MS) {
    if (!isTradingDay(dayStart + 12 * 3600 * 1000)) continue; // noon is safely inside the IST day
    const a = Math.max(dayStart + OPEN_MIN * 60000, fromMs);
    const b = Math.min(dayStart + CLOSE_MIN * 60000, toMs);
    if (b > a) total += (b - a) / 60000;
  }
  return total;
}

/** The list the page needs (ymd strings), plus where it came from. */
function snapshot() {
  return { holidays: [...holidays].sort(), source, updatedAt: updatedAt || null };
}

module.exports = {
  FALLBACK_HOLIDAYS,
  OPEN_MIN,
  CLOSE_MIN,
  nseDateToYmd,
  setHolidaysFromNse,
  setHolidays,
  isHoliday,
  isTradingDayYmd,
  isTradingDay,
  isMarketOpenAt,
  tradingMinutesBetween,
  snapshot
};
