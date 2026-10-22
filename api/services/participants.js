const fetch = require('node-fetch');
const store = require('./storage');
const { istNow } = require('./market');

// Participant-wise open interest (FII / DII / Pro / Client) from NSE's end-of-day archive file.
// NSE publishes one CSV per trading day in the evening. A day's file never changes, so parsed
// days are kept in one hash (pa:days, date -> JSON) and fetched from NSE only once.
// Holidays and not-yet-published days come back 404 and are remembered as "none" (past days only).

const HASH_KEY = 'pa:days';
const PARTICIPANTS = ['FII', 'DII', 'Pro', 'Client'];
const FETCH_TIMEOUT_MS = 6000;
const MAX_LOOKBACK_DAYS = 21; // calendar days scanned to find enough trading days
const MEMO_TTL_MS = 10 * 60 * 1000;

const COLUMNS = {
  'future index long': 'futIdxLong',
  'future index short': 'futIdxShort',
  'future stock long': 'futStkLong',
  'future stock short': 'futStkShort',
  'option index call long': 'optIdxCallLong',
  'option index put long': 'optIdxPutLong',
  'option index call short': 'optIdxCallShort',
  'option index put short': 'optIdxPutShort',
  'total long contracts': 'totalLong',
  'total short contracts': 'totalShort'
};

let memo = { ts: 0, key: null, value: null };

const csvUrl = ymd => {
  const [y, m, d] = ymd.split('-');
  return `https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_${d}${m}${y}.csv`;
};

/** Parse NSE's participant OI CSV into { FII: {...}, DII: {...}, Pro: {...}, Client: {...} }, or null. */
function parseParticipantCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex(l => /^client type,/i.test(l));
  if (headerIdx === -1) return null;
  const header = lines[headerIdx].split(',').map(h => h.trim().toLowerCase());
  const out = {};
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = line.split(',').map(c => c.trim());
    const who = PARTICIPANTS.find(p => p.toLowerCase() === (cells[0] || '').toLowerCase());
    if (!who) continue;
    const row = {};
    let bad = false;
    header.forEach((h, i) => {
      const key = COLUMNS[h];
      if (!key) return;
      // A malformed cell makes the whole file unusable. The old code turned it into 0, which silently shows a wrong position.
      if (!/^-?\d+(\.\d+)?$/.test(cells[i] || '')) { bad = true; return; }
      row[key] = Number(cells[i]);
    });
    if (bad) return null;
    out[who] = row;
  }
  return PARTICIPANTS.every(p => out[p]) ? out : null;
}

async function downloadDay(ymd) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(csvUrl(ymd), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (res.status === 404) return { status: 'none' };
    if (!res.ok) return { status: 'error' };
    const rows = parseParticipantCsv(await res.text());
    return rows ? { status: 'ok', rows } : { status: 'error' };
  } catch (err) {
    console.error('participant OI download failed:', ymd, err.message);
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Weekdays (IST) from `todayYmd` back `MAX_LOOKBACK_DAYS` calendar days, newest first. */
function candidateDates(todayYmd) {
  const [y, m, d] = todayYmd.split('-').map(Number);
  const dates = [];
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(dt.toISOString().slice(0, 10));
  }
  return dates;
}

/** Net and percentage views of one participant's day, the numbers traders actually read. */
function summarize(row) {
  const futNet = row.futIdxLong - row.futIdxShort;
  const futTotal = row.futIdxLong + row.futIdxShort;
  return {
    ...row,
    futIdxNet: futNet,
    futIdxLongPct: futTotal > 0 ? Number(((row.futIdxLong / futTotal) * 100).toFixed(1)) : null,
    optIdxCallNet: row.optIdxCallLong - row.optIdxCallShort,
    optIdxPutNet: row.optIdxPutLong - row.optIdxPutShort
  };
}

/**
 * The last `count` published trading days, newest first:
 * [{ date, FII: {...}, DII: {...}, Pro: {...}, Client: {...} }]
 */
/**
 * A 404 for a PAST day is permanent only once enough time has passed that "not published yet" and "CDN hiccup" are ruled
 * out: NSE publishes the evening of the trading day, so a 404 older than NONE_PERSIST_DAYS means a holiday.
 */
const NONE_PERSIST_DAYS = 4;
function shouldPersistNone(ymd, todayYmd) {
  const age = (Date.parse(`${todayYmd}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86400000;
  return age >= NONE_PERSIST_DAYS;
}

async function getParticipantHistory(count = 10, { storeImpl = store, download = downloadDay, todayYmd = null } = {}) {
  const today = todayYmd || istNow().ymd;
  const memoKey = `${today}|${count}`;
  if (memo.value && memo.key === memoKey && Date.now() - memo.ts < MEMO_TTL_MS && !todayYmd) return memo.value;

  const cached = await storeImpl.hgetall(HASH_KEY).catch(() => ({}));
  const dates = candidateDates(today);
  const missing = dates.filter(d => !cached[d]);
  const fetched = await Promise.all(missing.map(async d => [d, await download(d)]));

  const writes = [];
  for (const [d, res] of fetched) {
    if (res.status === 'ok') {
      cached[d] = JSON.stringify(res.rows);
      writes.push(['HSET', HASH_KEY, d, cached[d]]);
    } else if (res.status === 'none' && d !== today) {
      cached[d] = 'none'; // not published (yet): skip it for this response either way
      if (shouldPersistNone(d, today)) writes.push(['HSET', HASH_KEY, d, 'none']); // only a long-past 404 is a real holiday
    }
  }
  if (writes.length) await storeImpl.pipeline(writes).catch(err => console.error('participant OI cache write failed:', err.message));

  const days = [];
  for (const d of dates) {
    if (days.length >= count) break;
    if (!cached[d] || cached[d] === 'none') continue;
    let rows;
    try { rows = JSON.parse(cached[d]); } catch (e) { continue; }
    const day = { date: d };
    PARTICIPANTS.forEach(p => { day[p] = summarize(rows[p]); });
    days.push(day);
  }

  if (!todayYmd) memo = { ts: Date.now(), key: memoKey, value: days };
  return days;
}

module.exports = { shouldPersistNone, getParticipantHistory, parseParticipantCsv, candidateDates, summarize, PARTICIPANTS };
