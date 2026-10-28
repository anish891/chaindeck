// Paper trading accounts: storage, locking, market data and the per-minute tick around the pure engine (paperEngine.js).
//
//   pt:index          hash    id -> { id, name, kind, createdAt, active } (active = has positions or live orders)
//   pt:acct:{id}      string  the whole account state as JSON (small: capped order and trade history)
//   pt:lock:{id}      string  short-lived lock so a page request and the cron tick never write over each other
//   pt:settle:{expiry} string settlement price used for that expiry (so every account settles at the same price)
//
// Upstash cost: a write is lock + get + set + hset + del (5 commands). The tick only opens accounts that are active.

const crypto = require('crypto');
const engine = require('./paperEngine');
const calendar = require('./calendar');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const LOCK_TTL_SEC = 10;
const LOCK_TRIES = 20;
const LOCK_WAIT_MS = 150;
const SETTLE_AFTER_MS = 15 * 60000; // settle 15 minutes after the expiry close, once the official close is published
const MAX_ACCOUNTS = 20;
const IST_OFFSET_MS = 330 * 60 * 1000;
const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

const safeParse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * deps:
 *   store        storage.js-compatible (get, set, setNx, del, hset, hgetall, hdel)
 *   loadRaw      (expiry | null) => { raw, allExpiries, targetExpiry, stale }   (nse.fetchRawNSEOptionChain)
 *   loadSettle   (expiry) => settlement spot or null                             (daily close on the expiry date)
 *   now          () => epoch ms
 *   isMarketOpen (ms) => boolean
 */
function createService({ store, loadRaw, loadSettle, now = Date.now, isMarketOpen = ms => calendar.isMarketOpenAt(ms), cfg = engine.DEFAULTS }) {
  const acctKey = id => `pt:acct:${id}`;
  const lockKey = id => `pt:lock:${id}`;

  // ── storage ──

  async function listAccounts() {
    const all = await store.hgetall('pt:index');
    return Object.values(all).map(safeParse).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  }

  async function load(id) {
    const state = safeParse(await store.get(acctKey(id)));
    if (!state) throw codedError('NOT_FOUND', 'No such paper account.');
    return state;
  }

  async function save(state) {
    const active = Object.keys(state.positions).length > 0 || state.orders.some(engine.isLive);
    await store.set(acctKey(state.id), JSON.stringify(state));
    await store.hset('pt:index', state.id, JSON.stringify({ id: state.id, name: state.name, kind: state.kind, createdAt: state.createdAt, active }));
  }

  /** Run `fn(state)` under the account lock; save whatever state it returns (or nothing when it returns null). */
  async function withAccount(id, fn) {
    const token = crypto.randomBytes(8).toString('hex');
    let got = false;
    for (let i = 0; i < LOCK_TRIES && !got; i++) {
      got = await store.setNx(lockKey(id), token, LOCK_TTL_SEC);
      if (!got) await sleep(LOCK_WAIT_MS);
    }
    if (!got) throw codedError('BUSY', 'The account is busy. Try again.');
    try {
      const state = await load(id);
      const out = await fn(state);
      if (out && out.state && out.state !== state) await save(out.state);
      return out;
    } finally {
      if ((await store.get(lockKey(id))) === token) await store.del(lockKey(id));
    }
  }

  // ── market data ──

  /** Books for the given expiries plus the tradable list. Unknown or expired expiries are skipped, not fetched. */
  async function loadBook(expiries = []) {
    const first = await loadRaw(null);
    const t = now();
    const allowed = engine.tradableExpiries(first.allExpiries, t, cfg.maxExpiries);
    const wanted = [...new Set(expiries)].filter(e => allowed.includes(e) && e !== first.targetExpiry);
    const rest = await Promise.all(wanted.map(e => loadRaw(e).then(r => engine.buildBook(r.raw, e, { stale: r.stale })).catch(() => null)));
    const book = engine.mergeBooks([engine.buildBook(first.raw, first.targetExpiry, { stale: first.stale }), ...rest]);
    // a requested expiry that failed to load must not look like "no orders to fill": mark the whole book stale
    if (rest.some(b => b === null)) book.stale = true;
    return { book, allowed, allExpiries: first.allExpiries };
  }

  const heldExpiries = state => [...new Set([...Object.values(state.positions).map(p => p.expiry), ...state.orders.filter(engine.isLive).map(o => o.expiry)])];

  // ── account actions ──

  async function createAccount({ id, name, startingCapital = cfg.startingCapital, kind = 'human' }) {
    if (!ID_RE.test(String(id || ''))) throw codedError('BAD_ID', 'Account id: lowercase letters, digits and dashes, up to 24 characters.');
    if (!Number.isFinite(startingCapital) || startingCapital < 10000 || startingCapital > 1e8) throw codedError('BAD_CAPITAL', 'Starting capital must be between 10,000 and 10,00,00,000.');
    if (name !== undefined && (typeof name !== 'string' || name.length > 40)) throw codedError('BAD_NAME', 'Name must be at most 40 characters.');
    const existing = await listAccounts();
    if (existing.some(a => a.id === id)) throw codedError('EXISTS', 'That account id is taken.');
    if (existing.length >= MAX_ACCOUNTS) throw codedError('TOO_MANY_ACCOUNTS', `At most ${MAX_ACCOUNTS} paper accounts.`);
    const state = engine.newAccount({ id, name, nowMs: now(), startingCapital: Math.round(startingCapital), kind });
    await save(state);
    return state;
  }

  async function resetAccount(id) {
    const out = await withAccount(id, state => ({
      state: engine.newAccount({ id: state.id, name: state.name, nowMs: now(), startingCapital: state.startingCapital, kind: state.kind })
    }));
    return out.state;
  }

  async function deleteAccount(id) {
    await withAccount(id, () => null);
    await store.del(acctKey(id));
    await store.hdel('pt:index', id);
  }

  /** Account summary at current prices (read only; no lock). */
  async function getSummary(id) {
    const state = await load(id);
    let book = null;
    try { book = (await loadBook(heldExpiries(state))).book; } catch (e) { book = null; }
    return { summary: engine.summarize(state, book, cfg), state };
  }

  async function placeOrder(id, input) {
    const inst = engine.parseInstrument(input && input.instrument);
    const { book, allowed } = await loadBook(inst ? [inst.expiry] : []);
    return withAccount(id, state => {
      const t = now();
      const out = engine.placeOrder(input, state, { book, nowMs: t, marketOpen: isMarketOpen(t), allowedExpiries: allowed, cfg });
      return out.ok ? { ...out, state: engine.recordMarks(out.state, book) } : out;
    });
  }

  async function cancelOrder(id, orderId) {
    return withAccount(id, state => engine.cancelOrder(orderId, state, now()));
  }

  // ── settlement ──

  /** One settlement price per expiry, shared by every account. */
  async function settlementPrice(expiry) {
    const saved = await store.get(`pt:settle:${expiry}`);
    if (saved && Number(saved) > 0) return Number(saved);
    const px = await loadSettle(expiry).catch(() => null);
    if (!(px > 0)) return null;
    await store.set(`pt:settle:${expiry}`, String(px), 90 * 24 * 3600);
    return px;
  }

  // ── per-minute tick ──

  /**
   * Fill resting orders, expire DAY orders, settle expired contracts and record the day's equity, for every active
   * account. Safe to run as often as you like: every step is idempotent for the same book.
   */
  async function tick() {
    const t = now();
    const accounts = (await listAccounts()).filter(a => a.active);
    if (!accounts.length) return { accounts: 0, fills: 0, settled: 0 };
    const states = await Promise.all(accounts.map(a => load(a.id).catch(() => null)));
    const expiries = [...new Set(states.filter(Boolean).flatMap(heldExpiries))];
    let market = null;
    try { market = await loadBook(expiries); } catch (e) { market = null; }

    // expiries whose close has passed (and settlement window has opened) and that someone still holds
    const due = expiries.filter(e => { const c = engine.expiryCloseMs(e); return c && t >= c + SETTLE_AFTER_MS; });
    const prices = {};
    for (const e of due) prices[e] = await settlementPrice(e);

    const marketOpen = isMarketOpen(t);
    const afterClose = t >= engine.sessionCloseMs(t) && calendar.isTradingDay(t);
    let fills = 0, settled = 0;
    for (const a of accounts) {
      try {
        await withAccount(a.id, state => {
          let s = state;
          let changed = false;
          if (market) {
            const m = engine.matchOrders(s, market.book, t, { marketOpen, cfg });
            if (m.changed) { s = m.state; changed = true; fills += m.trades.length; }
          }
          const ex = engine.expireOrders(s, t);
          if (ex.changed) { s = ex.state; changed = true; }
          for (const e of due) {
            const st = engine.settleExpiry(s, e, prices[e], t, { cfg });
            if (st.changed) { s = st.state; changed = true; settled += st.trades.length; }
          }
          if (market) s = engine.recordMarks(s, market.book);
          // one equity point per trading day, written from the close onward
          const last = s.curve[s.curve.length - 1];
          if (afterClose && (!last || last.ymd !== istYmd(t) || changed)) {
            s = engine.recordEquity(s, engine.summarize(s, market && market.book, cfg).equity, t);
            changed = true;
          }
          return changed || s !== state ? { state: s } : null;
        });
      } catch (e) {
        console.error(`paper tick: account ${a.id} failed:`, e.message);
      }
    }
    return { accounts: accounts.length, fills, settled, dataOk: !!market && !market.book.stale };
  }

  return { listAccounts, createAccount, resetAccount, deleteAccount, getSummary, placeOrder, cancelOrder, tick, loadBook, settlementPrice };
}

/** The service wired to real storage, NSE and Yahoo. */
function defaultService() {
  const store = require('./storage');
  const { fetchRawNSEOptionChain } = require('./nse');
  const candles = require('./candles');
  const loadSettle = async expiry => {
    const ymd = calendar.nseDateToYmd(expiry);
    const { candles: daily } = await candles.getCandles('1d');
    const bar = (daily || []).find(c => candles.istDay(c.t) === ymd);
    return bar ? bar.c : null;
  };
  return createService({ store, loadRaw: e => fetchRawNSEOptionChain('NIFTY', e), loadSettle });
}

module.exports = { createService, defaultService, ID_RE };
