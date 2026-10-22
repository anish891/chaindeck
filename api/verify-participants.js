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

// BUG-003: malformed numbers fail the file instead of silently becoming 0
{
  const bad = csv.replace('291627', 'N/A');
  assert.strictEqual(parseParticipantCsv(bad), null, 'a non-numeric cell invalidates the file');
  assert.strictEqual(parseParticipantCsv(csv.replace('291627', '')), null, 'an empty cell invalidates the file');
  assert.ok(parseParticipantCsv(csv), 'the good file still parses');
}

// BUG-003: a recent 404 is not remembered forever; an old one is
(async () => {
  const { getParticipantHistory, shouldPersistNone } = require('./services/participants');
  assert.strictEqual(shouldPersistNone('2026-10-22', '2026-10-24'), false, 'two days ago: may just be unpublished or a hiccup');
  assert.strictEqual(shouldPersistNone('2026-10-20', '2026-10-24'), true, 'four days ago: a holiday');
  const hash = {};
  const fakeStore = {
    hgetall: async () => ({ ...hash }),
    pipeline: async cmds => { cmds.forEach(([, , d, v]) => { hash[d] = v; }); }
  };
  const goodRows = parseParticipantCsv(csv);
  // 2026-10-23 and 10-22 return 404 (recent); 10-21 and older return data; 10-19 (Mon) is a long-past 404
  const download = async d => (d >= '2026-10-22' ? { status: 'none' } : d === '2026-10-19' ? { status: 'none' } : { status: 'ok', rows: goodRows });
  const days = await getParticipantHistory(3, { storeImpl: fakeStore, download, todayYmd: '2026-10-24' });
  assert.ok(days.length === 3 && days[0].date === '2026-10-21', 'recent 404s are skipped in this response');
  assert.ok(!('2026-10-23' in hash) && !('2026-10-22' in hash), 'recent 404s are NOT stored');
  assert.strictEqual(hash['2026-10-19'], 'none', 'a long-past 404 (five days old) is remembered as a holiday');
  assert.ok(hash['2026-10-21'] && hash['2026-10-21'] !== 'none', 'good days are stored');
  console.log('participant OI checks passed (fetch rules)');
})().catch(e => { console.error(e); process.exit(1); });
