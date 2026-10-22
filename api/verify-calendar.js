// BUG-002 / MATH-004: the app must know about NSE holidays (weekday closures), not just weekends.
const assert = require('assert');
const cal = require('./services/calendar');
const nse = require('./services/nse');
const vol = require('./services/volatility');

const IST = 330 * 60000;
const at = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi) - IST; // an IST wall-clock time

(async () => {
  // fallback list is loaded out of the box
  assert.ok(cal.isHoliday('2026-10-20') && cal.isHoliday('2026-01-15') && !cal.isHoliday('2026-10-21'));
  assert.strictEqual(cal.FALLBACK_HOLIDAYS.length, 16);
  assert.ok(cal.FALLBACK_HOLIDAYS.every(d => cal.isTradingDayYmd(d) === false && new Date(d + 'T00:00:00Z').getUTCDay() % 6 !== 0), 'every fallback date is a weekday holiday');

  // market hours: Dussehra (Tue 20 Oct 2026) is closed even at 11:00; the next day is open; weekends stay closed
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 20, 11, 0)), false, 'holiday');
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 21, 11, 0)), true, 'normal Wednesday');
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 24, 11, 0)), false, 'Saturday');
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 21, 9, 0)), false, 'before the open');
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 21, 9, 7), { before: 5 }), false);
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 21, 9, 12), { before: 5 }), true, 'buffer before the open');
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 21, 15, 38), { after: 10 }), true, 'buffer after the close');
  assert.strictEqual(cal.isMarketOpenAt(at(2026, 10, 21, 15, 45), { after: 10 }), false);

  // trading minutes skip the holiday: Mon 19 15:30 -> Thu 22 15:30 is Wed + Thu only (the Tuesday is a holiday)
  assert.strictEqual(cal.tradingMinutesBetween(at(2026, 10, 19, 15, 30), at(2026, 10, 22, 15, 30)), 2 * 375);
  assert.strictEqual(vol.tradingMinutesBetween(at(2026, 10, 19, 15, 30), at(2026, 10, 22, 15, 30)), 2 * 375, 'the volatility module uses the same calendar');
  assert.strictEqual(cal.tradingMinutesBetween(at(2026, 10, 21, 10, 0), at(2026, 10, 21, 11, 0)), 60);
  assert.strictEqual(cal.tradingMinutesBetween(at(2026, 10, 24, 10, 0), at(2026, 10, 25, 11, 0)), 0, 'a weekend');
  // IV conversion over a holiday week uses fewer trading minutes, so the trading-time IV is higher than without the holiday
  const exp = vol.expiryCloseMs('22-Oct-2026');
  const withHoliday = vol.toTradingTimeIv(14, at(2026, 10, 19, 15, 30), exp);
  cal.setHolidays([]);
  const withoutHoliday = vol.toTradingTimeIv(14, at(2026, 10, 19, 15, 30), exp);
  assert.ok(withHoliday > withoutHoliday, `variance spread over fewer trading minutes: ${withHoliday} vs ${withoutHoliday}`);
  cal.setHolidays(cal.FALLBACK_HOLIDAYS);

  // NSE's leftover-copy limit is the long one on a holiday and the short one on a normal trading day
  assert.strictEqual(nse.staleLimitMs(at(2026, 10, 20, 11, 0)), 6 * 3600 * 1000, 'holiday');
  assert.strictEqual(nse.staleLimitMs(at(2026, 10, 21, 11, 0)), 2 * 60 * 1000, 'trading day');

  // parsing NSE's holiday master
  assert.strictEqual(cal.nseDateToYmd('26-Jan-2026'), '2026-01-26');
  assert.strictEqual(cal.nseDateToYmd('5-feb-2027'), '2027-02-05');
  assert.strictEqual(cal.nseDateToYmd('garbage'), null);
  const payload = { FO: ['15-Jan-2026', '26-Jan-2026', '03-Mar-2026', '26-Mar-2026', '31-Mar-2026', '03-Apr-2026'].map(d => ({ tradingDate: d })) };
  assert.strictEqual(cal.setHolidaysFromNse(payload), 6);
  assert.ok(cal.isHoliday('2026-03-03') && !cal.isHoliday('2026-10-20'), 'the list is replaced by what NSE sent');
  assert.strictEqual(cal.snapshot().source, 'nse');
  // an odd payload never wipes a good list
  assert.strictEqual(cal.setHolidaysFromNse({ FO: [] }), 0);
  assert.strictEqual(cal.setHolidaysFromNse({ FO: [{ tradingDate: 'x' }] }), 0);
  assert.strictEqual(cal.setHolidaysFromNse(null), 0);
  assert.ok(cal.isHoliday('2026-03-03'));
  cal.setHolidays(cal.FALLBACK_HOLIDAYS);

  // refreshHolidays: uses the fetcher, caches for a day, survives failures, retries sooner after a failure
  let calls = 0;
  const good = async () => { calls += 1; return payload; };
  const out = await nse.refreshHolidays({ force: true, fetcher: good, cookiesFn: async () => '' });
  assert.strictEqual(calls, 1); assert.strictEqual(out.source, 'nse');
  await nse.refreshHolidays({ fetcher: good, cookiesFn: async () => '' });
  assert.strictEqual(calls, 1, 'cached for a day');
  cal.setHolidays(cal.FALLBACK_HOLIDAYS);
  const prevErr = console.error; console.error = () => {};
  const bad = async () => { throw new Error('NSE down'); };
  const afterFail = await nse.refreshHolidays({ force: true, fetcher: bad, cookiesFn: async () => '' });
  console.error = prevErr;
  assert.ok(afterFail.holidays.includes('2026-10-20'), 'a failed refresh keeps the previous list');

  // BUG-005: the expiry probe is derived from the date, and always passes the app's own expiry validator
  assert.strictEqual(nse.formatNseDate(Date.UTC(2026, 9, 24, 6, 0)), '24-Oct-2026');
  assert.strictEqual(nse.formatNseDate(Date.UTC(2026, 11, 31, 20, 0)), '01-Jan-2027', '20:00 UTC on 31 Dec is already 1 Jan in IST');
  assert.strictEqual(nse.formatNseDate(Date.UTC(2027, 1, 5, 0, 0)), '05-Feb-2027');
  assert.ok(require('./security').isValidExpiry(nse.formatNseDate(Date.now())));
  assert.ok(!/30-Jun-2026/.test(require('fs').readFileSync(require('path').join(__dirname, 'services/nse.js'), 'utf8')), 'no hard-coded probe date');

  console.log('calendar checks passed');
})().catch(e => { console.error(e); process.exit(1); });
