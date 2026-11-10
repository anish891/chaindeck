const calendar = require('./calendar');
const upstox = require('../providers/upstox');

// Keeps the trading-holiday calendar current from Upstox's /v2/market/holidays (there is no stream for the calendar).
// At most one successful refresh a day. Never throws: on any failure the list already in
// memory (the built-in fallback or the last good fetch) keeps being used, and the next attempt comes 30 minutes later.

const HOLIDAY_TTL_MS = 24 * 3600 * 1000;
const RETRY_AFTER_FAIL_MS = 30 * 60 * 1000;
let state = { ts: 0, inflight: null };

async function refreshHolidays({ force = false, get = upstox.get } = {}) {
  if (!force && Date.now() - state.ts < HOLIDAY_TTL_MS) return calendar.snapshot();
  if (state.inflight) return state.inflight;
  state.inflight = (async () => {
    try {
      const rows = await get('/v2/market/holidays');
      if (calendar.setHolidaysFromUpstox(rows) > 0) state.ts = Date.now();
      else state.ts = Date.now() - HOLIDAY_TTL_MS + RETRY_AFTER_FAIL_MS; // odd payload: try again in 30 minutes
    } catch (err) {
      console.error('holiday list refresh failed:', err.message);
      state.ts = Date.now() - HOLIDAY_TTL_MS + RETRY_AFTER_FAIL_MS;
    }
    return calendar.snapshot();
  })().finally(() => { state.inflight = null; });
  return state.inflight;
}

const _reset = () => { state = { ts: 0, inflight: null }; };

module.exports = { refreshHolidays, _reset };
