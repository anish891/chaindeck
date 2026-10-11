const assert = require('assert');
const { parseParticipantCsv, candidateDates, summarize } = require('./services/participants');

// Shape of NSE's file: a title row, a header with stray padding, one row per participant, then TOTAL
const csv = [
  '""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 09, 2026"",,,,,,,,,,,,,,',
  'Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short       ,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts      ,Total Short Contracts',
  'Client,291627,62104,3402919,185348,3396080,3418874,3337345,4049875,2104606,822867,1206045,1081989,13436973,9922706',
  'DII,48096,16166,289466,4646105,90783,62924,3788,1452,12110,43691,349667,34218,547070,5051396',
  'FII,34943,328931,3542863,2867395,600034,1245164,946852,704672,197429,316370,347630,186717,5936804,5382197',
  'Pro,64003,31468,833668,370068,1317359,1294501,1116272,1265464,916553,1011209,1327356,891213,5437293,5001841',
  'TOTAL,438669,438669,8068916,8068916,5404257,6021463,5404257,6021463,3230698,2194137,3230698,2194137,25358140,25358140'
].join('\r\n');

const rows = parseParticipantCsv(csv);
assert(rows, 'parses');
assert.deepStrictEqual(Object.keys(rows).sort(), ['Client', 'DII', 'FII', 'Pro']);
assert.strictEqual(rows.FII.futIdxLong, 34943);
assert.strictEqual(rows.FII.futIdxShort, 328931);
assert.strictEqual(rows.FII.futStkShort, 2867395, 'padded header names still map');
assert.strictEqual(rows.Client.totalLong, 13436973, 'padded header names still map');
assert.strictEqual(rows.Pro.optIdxPutShort, 1265464);

const fii = summarize(rows.FII);
assert.strictEqual(fii.futIdxNet, 34943 - 328931);
assert.strictEqual(fii.futIdxLongPct, 9.6);
assert.strictEqual(fii.optIdxCallNet, 600034 - 946852);
assert.strictEqual(fii.optIdxPutNet, 1245164 - 704672);
assert.strictEqual(summarize({ ...rows.FII, futIdxLong: 0, futIdxShort: 0 }).futIdxLongPct, null);

// Junk or partial files are rejected, not half-parsed
assert.strictEqual(parseParticipantCsv('<html>Not found</html>'), null);
assert.strictEqual(parseParticipantCsv(csv.split('\r\n').slice(0, 4).join('\n')), null);

// Lookback skips weekends: Sunday 11 Oct starts at Friday 9 Oct
const dates = candidateDates('2026-10-11');
assert.strictEqual(dates[0], '2026-10-09');
assert(dates.every(d => ![0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay())));
assert.strictEqual(dates.length, 15);

console.log('participant OI checks passed');
