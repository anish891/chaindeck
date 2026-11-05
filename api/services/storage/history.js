const store = require('./storage');
const { istNow } = require('../market/market');
const { addVolSeries } = require('../analytics/volatility');

// Intraday buffer + session summaries.
//
//   oi:seen:{expiry}:{asOf}   claim key  → exactly one snapshot per NSE update, however many
//                                          clients / cron hits observe it
//   oi:s:{date}:{expiry}      list       → compact series point per snapshot (small, charted whole)
//   oi:k:{expiry}:{t}         string     → per-strike OI/price/IV for that snapshot (read selectively)
//   oi:latest:{expiry}        string     → most recent trading date recorded for the expiry
//   oi:sessions               hash       → date → end-of-day summary (similar sessions, IV history)
//
// Those are NIFTY's keys. Other indices use the same layout under their own prefix (oi:sensex:s:..., oi:sensex:sessions).
//
// Expiry replay reads the same keys back for a past expiry day: the series lives DAY_TTL (14 days), the per-strike
// snapshots STRIKES_TTL (7 days), so the last expiry replays in full and the one before it shows decay only.

const DAY_TTL = 14 * 24 * 3600;
const STRIKES_TTL = 7 * 24 * 3600;
const CLAIM_PENDING_TTL = 120; // seconds a claim holds before the write has succeeded
const SESSION_SAVE_FROM_MINS = 15 * 60 + 20; // IST; last write of the day (≈15:30) wins

const lastRecorded = new Map(); // `${symbol}|${expiry}` -> asOf this instance already handled (skips network)

// Key prefix per index. NIFTY keeps the original 'oi' keys so everything already saved stays readable; any other index
// gets its own namespace ('oi:sensex:...'), so two indices can never mix even if their expiry dates coincide.
const ns = (symbol = 'NIFTY') => (symbol === 'NIFTY' ? 'oi' : `oi:${String(symbol).toLowerCase()}`);
// Strike step per index, for the replay trim (12 strikes either side of spot).
const STRIKE_STEP = { NIFTY: 50, SENSEX: 100 };
const WINDOWS_MIN = { m5: 5, m15: 15, m30: 30 };

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** Points sorted by time with duplicate timestamps removed (two instances can race the same NSE update). */
function sortedUnique(rows) {
  const seen = new Set();
  return rows.map(safeParse).filter(Boolean).sort((a, b) => a.t - b.t).filter(p => (seen.has(p.t) ? false : (seen.add(p.t), true)));
}

function compactPoint(d, t) {
  return {
    t,
    spot: d.spot,
    pcr: d.pcr,
    ntmPcr: d.ntmPcr,
    volPcr: d.volPcr,
    straddle: d.straddlePrice,
    atmIv: d.atmIv,
    ivSkew: d.ivSkew,
    vix: d.vix ? d.vix.last : null,
    maxPain: d.maxPain,
    gexCr: d.gex ? d.gex.totalGexCr : null,
    callOI: d.totalCallOI,
    putOI: d.totalPutOI,
    callChg: d.totalCallChgOI,
    putChg: d.totalPutChgOI,
    fut: d.impliedFuture
  };
}

// [strike, ceOI, peOI, ceChgOI, peChgOI, ceLtp, peLtp, ceIv, peIv]
function compactStrikes(d) {
  return d.strikes.map(s => [
    s.strike,
    s.CE?.openInterest || 0, s.PE?.openInterest || 0,
    s.CE?.changeinOpenInterest || 0, s.PE?.changeinOpenInterest || 0,
    s.CE?.lastPrice || 0, s.PE?.lastPrice || 0,
    s.CE?.impliedVolatility || 0, s.PE?.impliedVolatility || 0
  ]);
}

function buildSessionRecord(d, vector, date) {
  return {
    date,
    closing_pcr: d.pcr,
    gex_regime: d.gex?.gexRegime || null,
    cpr_width_type: d.cpr?.cprType || null,
    feature_vector: vector,
    atm_iv: d.atmIv,
    close: d.spot,
    top_buildup_strikes: [
      { strike: d.maxCallOIStrike, side: 'CE' },
      { strike: d.maxPutOIStrike, side: 'PE' }
    ]
  };
}

async function saveSession(record, symbol = 'NIFTY') {
  await store.hset(`${ns(symbol)}:sessions`, record.date, JSON.stringify(record));
  sessionsCacheFor(symbol).ts = 0;
}

const sessionsCaches = new Map(); // symbol -> { ts, rows }
function sessionsCacheFor(symbol) {
  if (!sessionsCaches.has(symbol)) sessionsCaches.set(symbol, { ts: 0, rows: [] });
  return sessionsCaches.get(symbol);
}

/** Newest first; cached for 5 minutes (it changes once a day). */
async function getSessions(limit = 100, symbol = 'NIFTY') {
  const cache = sessionsCacheFor(symbol);
  if (Date.now() - cache.ts > 5 * 60 * 1000) {
    const all = await store.hgetall(`${ns(symbol)}:sessions`);
    cache.rows = Object.values(all).map(safeParse).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));
    cache.ts = Date.now();
  }
  return cache.rows.slice(0, limit);
}

/**
 * Persist one snapshot per NSE data timestamp. Safe to call on every request:
 * the common path (already recorded) never touches the network.
 */
async function recordSnapshot(d, vector) {
  const symbol = d.symbol || 'NIFTY';
  const p = ns(symbol);
  const memoKey = `${symbol}|${d.expiry}`;
  const asOf = d.dataAsOf || d.fetchedAt;
  if (!asOf || !d.strikes?.length) return { recorded: false, reason: 'no-data' };
  if (lastRecorded.get(memoKey) === asOf) return { recorded: false, reason: 'seen' };

  // The claim is deliberately short-lived until the data is actually written: if the write fails the claim must not
  // keep this minute from being recorded by a retry (or by another instance).
  const claimKey = `${p}:seen:${d.expiry}:${asOf}`;
  const claimed = await store.setNx(claimKey, '1', CLAIM_PENDING_TTL);
  if (!claimed) return { recorded: false, reason: 'claimed-elsewhere' };

  const t = new Date(asOf).getTime();
  const { ymd, mins, isWeekday } = istNow(new Date(asOf));
  const seriesKey = `${p}:s:${ymd}:${d.expiry}`;

  try {
    await store.pipeline([
      ['SET', `${p}:k:${d.expiry}:${t}`, JSON.stringify(compactStrikes(d)), 'EX', STRIKES_TTL],
      ['RPUSH', seriesKey, JSON.stringify(compactPoint(d, t))],
      ['EXPIRE', seriesKey, DAY_TTL],
      ['SET', `${p}:latest:${d.expiry}`, ymd, 'EX', DAY_TTL]
    ]);
  } catch (err) {
    await store.del(claimKey).catch(() => {}); // free the claim so the next attempt can record this snapshot
    throw err;
  }
  lastRecorded.set(memoKey, asOf); // only now is it safe to skip this snapshot next time
  store.set(claimKey, '1', 24 * 3600).catch(() => {}); // data is safe: keep the claim for the full day to dedupe other instances
  if (symbol === 'NIFTY') store.set('oi:lastsnap', String(t), 3 * 24 * 3600).catch(() => {}); // for the snapshot-age monitor endpoint

  if (isWeekday && mins >= SESSION_SAVE_FROM_MINS && vector) {
    await saveSession(buildSessionRecord(d, vector, ymd), symbol);
  }
  return { recorded: true, date: ymd, t };
}

/**
 * Series for the day plus baseline strike snapshots (5m / 15m / 30m earlier, and the open)
 * so the client can compute rate-of-change against *live* data.
 */
async function getIntraday(expiry, date = null, symbol = 'NIFTY') {
  const p = ns(symbol);
  const day = date || await store.get(`${p}:latest:${expiry}`);
  if (!day) return { date: null, expiry, points: [], baselines: {} };

  const rows = await store.lrange(`${p}:s:${day}:${expiry}`, 0, -1);
  // Insertion order is arrival order; two instances racing can append slightly out of order, so sort by time.
  const points = sortedUnique(rows);
  if (points.length === 0) return { date: day, expiry, points: [], baselines: {} };

  const latest = points[points.length - 1];
  const picks = { open: points[0] };
  for (const [name, mins] of Object.entries(WINDOWS_MIN)) {
    const target = latest.t - mins * 60 * 1000;
    let found = null;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].t <= target) { found = points[i]; break; }
    }
    picks[name] = found; // null until enough history has accumulated
  }

  const names = Object.keys(picks).filter(n => picks[n]);
  const strikeRows = names.length
    ? await store.pipeline(names.map(n => ['GET', `${p}:k:${expiry}:${picks[n].t}`]))
    : [];

  const baselines = {};
  names.forEach((n, i) => {
    const strikes = safeParse(strikeRows[i]);
    baselines[n] = {
      ...picks[n],
      strikes: strikes ? Object.fromEntries(strikes.map(r => [r[0], [r[1], r[2]]])) : {}
    };
  });

  return { date: day, expiry, points: addVolSeries(points, expiry), baselines };
}

const REPLAY_FRAME_MIN = 10; // one strike snapshot per 10 minutes is enough to step through the day
const REPLAY_REACH_STRIKES = 12; // strikes either side of spot kept per frame (pin looks out ~2 sigma, gamma 5 strikes)
const REPLAY_LOOKBACK_DAYS = 14; // = DAY_TTL: older series have expired
const NSE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_MS = 330 * 60000;

/** '2026-10-27' -> '27-Oct-2026' (an expiry day's own contract name). */
function ymdToExpiry(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}-${NSE_MONTHS[Number(m) - 1]}-${y}`;
}

/**
 * Past expiry days whose series is still stored, newest first. A day counts when the contract expiring that day was
 * recorded on that day, so holiday-shifted expiries are found without a calendar. Today is left out: it is still live.
 */
async function listExpiryReplays(nowMs = Date.now(), symbol = 'NIFTY') {
  const today = new Date(nowMs + IST_MS).toISOString().slice(0, 10);
  const days = [];
  for (let i = 1; i <= REPLAY_LOOKBACK_DAYS; i++) {
    const ymd = new Date(Date.parse(`${today}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
    const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(ymd);
  }
  const lens = await store.pipeline(days.map(ymd => ['LLEN', `${ns(symbol)}:s:${ymd}:${ymdToExpiry(ymd)}`]));
  return days
    .map((date, i) => ({ date, expiry: ymdToExpiry(date), points: Number(lens[i]) || 0 }))
    .filter(r => r.points > 0)
    .map(r => ({ ...r, strikesKept: nowMs - Date.parse(`${r.date}T10:00:00Z`) < STRIKES_TTL * 1000 }));
}

/** Pick the snapshot closest after each frame mark (09:15, 09:25, ...), at most one per mark. */
function pickReplayFrames(points, minutes = REPLAY_FRAME_MIN) {
  const picks = [];
  let lastMark = null;
  let last = null;
  for (const p of points) {
    const mod = new Date(p.t + IST_MS);
    const mins = mod.getUTCHours() * 60 + mod.getUTCMinutes() + mod.getUTCSeconds() / 60;
    if (mins < 9 * 60 + 15 || mins > 15 * 60 + 30) continue;
    last = p;
    const mark = Math.floor((mins - (9 * 60 + 15)) / minutes);
    if (mark !== lastMark) { picks.push(p); lastMark = mark; }
  }
  if (last && picks[picks.length - 1].t !== last.t) picks.push(last); // always end on the last in-session snapshot
  return picks;
}

/**
 * One past expiry day for the replay: the full series (spot, straddle, max pain, IV, GEX per snapshot) and strike
 * frames every 10 minutes, trimmed to strikes near that frame's spot. Frames whose strike data has expired are left
 * out, so a day older than STRIKES_TTL comes back with points but no frames.
 */
async function getExpiryReplay(expiry, symbol = 'NIFTY') {
  const p = ns(symbol);
  const reach = REPLAY_REACH_STRIKES * (STRIKE_STEP[symbol] || 50);
  const m = /^(\d{2})-([A-Z][a-z]{2})-(\d{4})$/.exec(expiry || '');
  const mi = m ? NSE_MONTHS.indexOf(m[2]) : -1;
  if (mi < 0) return { expiry, date: null, points: [], frames: [] };
  const date = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1]}`;
  const points = sortedUnique(await store.lrange(`${p}:s:${date}:${expiry}`, 0, -1));
  if (!points.length) return { expiry, date, points: [], frames: [] };
  const picks = pickReplayFrames(points);
  const blobs = await store.pipeline(picks.map(pk => ['GET', `${p}:k:${expiry}:${pk.t}`]));
  const frames = [];
  picks.forEach((pk, i) => {
    const rows = safeParse(blobs[i]);
    if (!Array.isArray(rows) || !rows.length) return;
    frames.push({ t: pk.t, strikes: rows.filter(r => Math.abs(r[0] - pk.spot) <= reach) });
  });
  return { expiry, date, points, frames };
}

const COLS = ['strike', 'ceOI', 'peOI', 'ceChg', 'peChg', 'ceLtp', 'peLtp', 'ceIv', 'peIv'];
const rowToObject = r => Object.fromEntries(COLS.map((c, i) => [c, r[i]]));

/**
 * One strike's OI / price / IV across the day, sampled to at most `maxSamples` snapshots
 * (always including the first and last) so a drill-down costs ~60 reads, not ~400.
 */
async function getStrikeHistory(expiry, strike, date = null, maxSamples = 60, symbol = 'NIFTY') {
  const p = ns(symbol);
  const day = date || await store.get(`${p}:latest:${expiry}`);
  if (!day) return { date: null, expiry, strike, samples: [] };

  const rows = await store.lrange(`${p}:s:${day}:${expiry}`, 0, -1);
  const points = sortedUnique(rows);
  if (points.length === 0) return { date: day, expiry, strike, samples: [] };

  const stride = Math.max(1, Math.ceil(points.length / maxSamples));
  const picked = points.filter((_, i) => i % stride === 0);
  if (picked[picked.length - 1] !== points[points.length - 1]) picked.push(points[points.length - 1]);

  const blobs = await store.pipeline(picked.map(pk => ['GET', `${p}:k:${expiry}:${pk.t}`]));
  const samples = [];
  picked.forEach((pk, i) => {
    const table = blobs[i] ? safeParse(blobs[i]) : null;
    const row = table && table.find(r => r[0] === strike);
    if (row) samples.push({ t: pk.t, spot: pk.spot, ...rowToObject(row) });
  });
  return { date: day, expiry, strike, samples };
}

/**
 * Is the per-minute recorder alive? For an uptime monitor (cron-job.org, UptimeRobot) pointed at /api/snapshot-age:
 * while the market is open the last saved snapshot must be less than `maxAgeSec` old, otherwise it reports unhealthy
 * (HTTP 503) so the monitor alerts you. Outside market hours it is always healthy.
 */
function snapshotHealth(lastMs, nowMs = Date.now(), maxAgeSec = 300) {
  const calendar = require('../market/calendar');
  const marketOpen = calendar.isMarketOpenAt(nowMs, { before: 0, after: 5 });
  const ageSec = Number.isFinite(lastMs) ? Math.max(0, Math.round((nowMs - lastMs) / 1000)) : null;
  // The first minutes after the open (or a cold start) have no snapshot yet: allow one full interval before alarming.
  const sinceOpenOk = marketOpen && calendar.tradingMinutesBetween(nowMs - maxAgeSec * 1000, nowMs) < maxAgeSec / 60 - 0.01;
  const healthy = !marketOpen || sinceOpenOk || (ageSec !== null && ageSec <= maxAgeSec);
  return { healthy, marketOpen, ageSec, maxAgeSec };
}

async function getLastSnapshotMs() {
  const v = await store.get('oi:lastsnap');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
  ns,
  snapshotHealth,
  getLastSnapshotMs,
  backend: store.backend,
  configured: store.configured,
  recordSnapshot,
  getIntraday,
  getStrikeHistory,
  listExpiryReplays,
  getExpiryReplay,
  pickReplayFrames,
  ymdToExpiry,
  getSessions,
  saveSession,
  buildSessionRecord
};
