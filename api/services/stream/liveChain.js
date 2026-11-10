const upstox = require('../providers/upstox');
const instruments = require('../providers/instruments');
const calendar = require('../market/calendar');
const storage = require('../storage/storage');
const { toChainRaw } = require('../providers/upstoxAdapter');

// One expiry of an index's option chain, built from the live feed (upstoxStream) instead of a REST call.
// Resolves to the same { raw, allExpiries, targetExpiry } the REST loader did, so analytics, integrity, history, alerts
// and paper trading are unchanged. Checked live against /v2/option/chain: price, OI, volume, close and best bid/ask
// match contract for contract; the feed's IV is a fraction (0.1599) where REST sent a percentage (15.99).
//
// Two things the feed cannot supply:
//
//   The contract list (expiries, strikes, instrument keys, lot size). There is no stream for it, and nothing can be
//   subscribed without it, so it is the one REST lookup here: once at first use, then once per IST day (or when the
//   nearest expiry has passed, or an unknown expiry is asked for).
//
//   Previous-session open interest, which "change in OI" is measured against. The feed only has current OI. Between
//   sessions (after the close, before the next open) current OI *is* the previous close, so that is when it is noted
//   down, per contract, and saved to storage. A server that was not running between two sessions has no baseline for
//   the second one: change in OI is then left out (shown as unknown) rather than guessed.

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86400000;
const READY_WAIT_MS = 4000;          // first request for an expiry: how long to wait for its snapshot to arrive
const READY_COVERAGE = 0.8;          // share of contracts that must have a tick before the chain is served
const IDLE_MS = 5 * 60 * 1000;       // an expiry nobody has asked for in this long is unsubscribed
const SWEEP_MS = 60 * 1000;
const FORCED_REFRESH_GAP_MS = 10 * 60 * 1000;
const BASELINE_TTL_SEC = 10 * 24 * 3600;
const CAPTURE_UNTIL_MIN = 9 * 60 + 14;   // IST: before this, OI is still the previous session's close
const CAPTURE_FROM_MIN = 15 * 60 + 45;   // IST: after this, OI is this session's close

// Upstox reports option open interest and volume in units (lots x lot size); ChainDeck counts contracts.
const OI_IN_UNITS = String(process.env.UPSTOX_OI_IN_UNITS || 'true').toLowerCase() !== 'false';

const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMinute = ms => { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function tradingDayFrom(ymd, step) {
  let d = ymd;
  for (let i = 0; i < 15; i += 1) {
    d = addDays(d, step);
    if (calendar.isTradingDayYmd(d)) return d;
  }
  return d;
}

/**
 * Where `nowMs` sits relative to trading sessions:
 *   session   the trading day whose change in OI is on show (the latest one that has opened)
 *   capture   the trading day the current OI is the baseline for, or null while a session is running
 */
function sessionClock(nowMs) {
  const today = istYmd(nowMs);
  const mins = istMinute(nowMs);
  const trading = calendar.isTradingDayYmd(today);
  const session = trading && mins >= calendar.OPEN_MIN ? today : tradingDayFrom(today, -1);
  let capture = null;
  if (trading && mins < CAPTURE_UNTIL_MIN) capture = today;
  else if (!trading || mins >= CAPTURE_FROM_MIN) capture = tradingDayFrom(today, 1);
  return { session, capture };
}

function chainError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Contract rows -> Map(expiry 'DD-Mon-YYYY' -> [{ strike, CE: key, PE: key }] sorted by strike). */
function groupContracts(rows) {
  const byExpiry = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.instrument_key !== 'string' || !['CE', 'PE'].includes(r.instrument_type)) continue;
    const expiry = instruments.ymdToNseDate(instruments.expiryYmd(r.expiry));
    const strike = Number(r.strike_price);
    if (!expiry || !Number.isFinite(strike)) continue;
    if (!byExpiry.has(expiry)) byExpiry.set(expiry, new Map());
    const strikes = byExpiry.get(expiry);
    if (!strikes.has(strike)) strikes.set(strike, { strike });
    strikes.get(strike)[r.instrument_type] = r.instrument_key;
  }
  const out = new Map();
  for (const [expiry, strikes] of byExpiry) out.set(expiry, [...strikes.values()].sort((a, b) => a.strike - b.strike));
  return out;
}

function createLiveChain({
  feed, get = upstox.get, store = storage, now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  readyWaitMs = READY_WAIT_MS, log = console.error
}) {
  const contracts = new Map(); // symbol -> { day, ts, expiries, lotSize, byExpiry }
  const loading = new Map();   // symbol -> Promise (one contract lookup at a time per index)
  const entries = new Map();   // `${symbol}|${expiry}` -> { symbol, expiry, strikes, keys, off, lastUsed, pinned, baseline, saved }
  const underlying = new Map(); // symbol -> unsubscribe
  let sweeper = null;

  function freshContracts(symbol, nowMs) {
    const hit = contracts.get(symbol);
    if (!hit || hit.day !== istYmd(nowMs)) return null;
    const nearest = instruments.nseDateToYmd(hit.expiries[0]);
    return nearest && nearest >= istYmd(nowMs) ? hit : null;
  }

  async function contractsFor(symbol, { force = false } = {}) {
    const nowMs = now();
    const hit = freshContracts(symbol, nowMs);
    if (hit && !(force && nowMs - hit.ts > FORCED_REFRESH_GAP_MS)) return hit;
    if (loading.has(symbol)) return loading.get(symbol);
    const cfg = instruments.getIndex(symbol);
    const p = (async () => {
      const rows = await get('/v2/option/contract', { instrument_key: cfg.underlyingKey });
      const parsed = instruments.parseContracts(rows, nowMs);
      if (!parsed.expiries.length) throw new Error(`Upstox listed no open expiries for ${cfg.symbol}`);
      const value = { day: istYmd(nowMs), ts: nowMs, expiries: parsed.expiries, lotSize: parsed.lotSize, byExpiry: groupContracts(rows) };
      contracts.set(symbol, value);
      return value;
    })().finally(() => loading.delete(symbol));
    loading.set(symbol, p);
    return p;
  }

  const baselineKey = e => `oibase:${e.symbol}:${instruments.nseDateToYmd(e.expiry)}`;

  async function loadBaseline(entry) {
    try {
      const saved = JSON.parse((await store.get(baselineKey(entry))) || 'null');
      if (saved && saved.sessions && typeof saved.sessions === 'object') return saved.sessions;
    } catch (err) {
      log(`OI baseline read failed (${entry.symbol} ${entry.expiry}): ${err.message}`);
    }
    return {};
  }

  /** Between sessions: note current OI as the baseline for the session about to start. Saved only when it changed. */
  function captureBaseline(entry, clock) {
    if (!clock.capture) return;
    const oi = {};
    let n = 0;
    for (const key of entry.keys) {
      const t = feed.get(key);
      if (t && Number.isFinite(t.oi)) { oi[key] = t.oi; n += 1; }
    }
    if (n < entry.keys.length * READY_COVERAGE) return; // a half-arrived snapshot is not a baseline
    entry.baseline[clock.capture] = oi;
    for (const day of Object.keys(entry.baseline).sort().slice(0, -2)) delete entry.baseline[day]; // this session's and the next
    const text = JSON.stringify({ sessions: entry.baseline });
    if (text === entry.saved) return;
    entry.saved = text;
    Promise.resolve(store.set(baselineKey(entry), text, BASELINE_TTL_SEC)).catch(err => {
      entry.saved = null;
      log(`OI baseline write failed (${entry.symbol} ${entry.expiry}): ${err.message}`);
    });
  }

  function sweep() {
    const nowMs = now();
    const today = istYmd(nowMs);
    for (const [id, e] of entries) {
      const expired = instruments.nseDateToYmd(e.expiry) < today; // a pinned expiry is released once it has passed
      if (!expired && (e.pinned || nowMs - e.lastUsed < IDLE_MS)) continue;
      e.off();
      entries.delete(id);
    }
  }

  async function ensure(symbol, expiry, strikes, { pin = false } = {}) {
    const id = `${symbol}|${expiry}`;
    let entry = entries.get(id);
    if (!entry) {
      const keys = strikes.flatMap(s => [s.CE, s.PE]).filter(Boolean);
      // Subscribing can throw STREAM_LIMIT: drop idle expiries first so a busy day does not wedge on old subscriptions.
      let off;
      try { off = feed.subscribe(keys, 'full'); } catch (err) {
        if (err.code !== 'STREAM_LIMIT') throw err;
        for (const [oid, e] of [...entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
          if (e.pinned) continue;
          e.off();
          entries.delete(oid);
          try { off = feed.subscribe(keys, 'full'); break; } catch (again) { if (again.code !== 'STREAM_LIMIT') throw again; }
        }
        if (!off) throw err;
      }
      entry = { symbol, expiry, strikes, keys, off, lastUsed: now(), pinned: pin, baseline: {}, saved: null };
      entries.set(id, entry);
      entry.baselineLoad = loadBaseline(entry).then(sessions => { entry.baseline = { ...sessions, ...entry.baseline }; });
      if (!sweeper) {
        sweeper = timers.setInterval(sweep, SWEEP_MS);
        if (sweeper && typeof sweeper.unref === 'function') sweeper.unref();
      }
    }
    if (pin) entry.pinned = true;
    entry.lastUsed = now();
    if (!underlying.has(symbol)) underlying.set(symbol, feed.subscribe(instruments.getIndex(symbol).underlyingKey, 'full'));
    await entry.baselineLoad;
    return entry;
  }

  const coverage = entry => entry.keys.reduce((n, k) => n + (feed.get(k) ? 1 : 0), 0) / (entry.keys.length || 1);

  /** Resolves once the index and most of the expiry's contracts have a tick, or after `readyWaitMs`. */
  function waitReady(entry, underlyingKey) {
    const ready = () => Boolean(feed.get(underlyingKey)) && coverage(entry) >= READY_COVERAGE;
    if (ready()) return Promise.resolve();
    return new Promise(resolve => {
      let off = () => {};
      const timer = timers.setTimeout(() => { off(); resolve(); }, readyWaitMs);
      off = feed.on('ticks', () => {
        if (!ready()) return;
        timers.clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  function side(key, baseline) {
    const t = key ? feed.get(key) : null;
    if (!t) return null;
    const best = (t.depth && t.depth[0]) || {};
    return {
      instrument_key: key,
      market_data: {
        ltp: t.ltp, volume: t.vtt, oi: t.oi, close_price: t.cp,
        bid_price: best.bidP, bid_qty: best.bidQ, ask_price: best.askP, ask_qty: best.askQ,
        prev_oi: baseline ? baseline[key] : undefined
      },
      // fraction -> percent, as the REST chain reported it (0 stays 0: Upstox has no IV for that contract)
      option_greeks: { iv: Number.isFinite(t.iv) ? Number((t.iv * 100).toFixed(2)) : undefined }
    };
  }

  /**
   * @param symbol      'NIFTY' | 'SENSEX'
   * @param expiryDate  'DD-Mon-YYYY', or null for the nearest expiry
   * @param pin         keep this expiry subscribed even when nobody asks for it (the recorder's expiries)
   */
  async function loadChain(symbol = 'NIFTY', expiryDate = null, { pin = false } = {}) {
    const cfg = instruments.getIndex(symbol);
    let list = await contractsFor(cfg.symbol);
    // A requested expiry missing from today's list may be newly listed: look once more before refusing it.
    if (expiryDate && !list.byExpiry.has(expiryDate)) list = await contractsFor(cfg.symbol, { force: true });
    const targetExpiry = expiryDate || list.expiries[0];
    const strikes = list.expiries.includes(targetExpiry) ? list.byExpiry.get(targetExpiry) : null;
    if (!strikes || !strikes.length) throw chainError('BAD_EXPIRY', `Unknown expiry ${targetExpiry}`);

    // The feed is started once, by the server (api/index.js). Subscribing before that is fine: it is replayed on connect.
    const entry = await ensure(cfg.symbol, targetExpiry, strikes, { pin });
    if (['idle', 'stopped'].includes(feed.getState().status)) throw chainError('STREAM_DOWN', 'live feed is not running');
    await waitReady(entry, cfg.underlyingKey);

    const state = feed.getState();
    const index = feed.get(cfg.underlyingKey);
    if (state.status === 'auth_failed') throw chainError('UPSTOX_AUTH', 'Upstox rejected the token for the live feed');
    // Down, or not caught up yet: fail, so the caller serves its last good copy flagged stale. Never a half-built chain.
    if (state.stale) throw chainError('STREAM_DOWN', `live feed is ${state.status}`);
    if (!index || coverage(entry) < READY_COVERAGE) throw chainError('STREAM_NOT_READY', 'live feed has not delivered this expiry yet');

    const nowMs = now();
    const clock = sessionClock(nowMs);
    captureBaseline(entry, clock);
    const baseline = entry.baseline[clock.session] || null;
    const ymd = instruments.nseDateToYmd(targetExpiry);
    const rows = strikes.map(s => ({
      expiry: ymd,
      strike_price: s.strike,
      underlying_spot_price: index.ltp,
      call_options: side(s.CE, baseline),
      put_options: side(s.PE, baseline)
    }));
    const lot = list.lotSize || cfg.lotSize;
    // The index's last trade time is the exchange clock: it stops when the market (or the feed) stops, so the freshness
    // checks keep meaning something. Never later than now.
    const asOfMs = index.ltt > 0 ? Math.min(index.ltt, nowMs) : nowMs;
    const raw = toChainRaw(rows, { expiries: list.expiries, asOfMs, quantityPerContract: OI_IN_UNITS ? lot : 1 });
    raw.asOfSource = index.ltt > 0 ? 'last_trade' : 'fetch';
    raw.oiBaseline = baseline ? clock.session : null;
    return { raw, allExpiries: list.expiries, targetExpiry };
  }

  return {
    loadChain,
    /** Expiries from today's contract list (null before the first lookup), for a fast unknown-expiry check. */
    knownExpiries(symbol = 'NIFTY') {
      const hit = freshContracts(symbol, now());
      return hit ? hit.expiries : null;
    },
    /** The lot size in force: Upstox's live value if known, else the configured one. */
    lotSizeFor(symbol = 'NIFTY') {
      const hit = freshContracts(symbol, now());
      return (hit && hit.lotSize) || instruments.getIndex(symbol).lotSize;
    },
    /** Map(instrument key -> [strike, 'CE' | 'PE']) of a subscribed expiry, or null. Lets ticks be matched to table cells. */
    legIndex(symbol, expiry) {
      const e = entries.get(`${symbol}|${expiry}`);
      if (!e) return null;
      const index = new Map();
      for (const s of e.strikes) {
        if (s.CE) index.set(s.CE, [s.strike, 'CE']);
        if (s.PE) index.set(s.PE, [s.strike, 'PE']);
      }
      return index;
    },
    subscribed: () => [...entries.values()].map(e => ({ symbol: e.symbol, expiry: e.expiry, contracts: e.keys.length, pinned: e.pinned })),
    sweep,
    stop() {
      timers.clearInterval(sweeper);
      sweeper = null;
      for (const e of entries.values()) e.off();
      entries.clear();
      for (const off of underlying.values()) off();
      underlying.clear();
    }
  };
}

let shared = null;
/** The process-wide live chain, on the shared stream. */
function live() {
  if (!shared) shared = createLiveChain({ feed: require('./upstoxStream').getStream().market });
  return shared;
}

module.exports = {
  createLiveChain, live, sessionClock, groupContracts, OI_IN_UNITS,
  loadChain: (symbol, expiry, opts) => live().loadChain(symbol, expiry, opts),
  knownExpiries: symbol => live().knownExpiries(symbol),
  lotSizeFor: symbol => live().lotSizeFor(symbol),
  legIndex: (symbol, expiry) => live().legIndex(symbol, expiry)
};
