// Paper trading accounts: storage, locking, market data and the per-minute tick around the pure engine (paperEngine.js).
//
//   pt:index          hash    id -> { id, name, kind, createdAt, active } (active = has positions or live orders)
//   pt:acct:{id}      string  the whole account state as JSON (small: capped order and trade history)
//   pt:lock:{id}      string  short-lived lock so a page request and the cron tick never write over each other
//   pt:settle:{expiry} string settlement price used for that expiry (so every account settles at the same price)
//   pt:keys           hash    keyId -> agent API key record (only a SHA-256 of the key is stored, never the key)
//   pt:q:{keyId}:...  string  order counters per key per minute and per day (fixed windows)
//   pt:idem:{keyId}:{k} string the result of an agent request sent with an Idempotency-Key, kept a day
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
const AGENT = { ordersPerMinute: 10, ordersPerDay: 300, keysPerAccount: 5, backtestsPerMinute: 5 };
const KEY_RE = /^cdp_([0-9a-f]{8})_([0-9a-f]{48})$/;
const IDEM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SCOPES = new Set(['read', 'trade']);
const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
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
      state: { ...engine.newAccount({ id: state.id, name: state.name, nowMs: now(), startingCapital: state.startingCapital, kind: state.kind }), agentsPaused: !!state.agentsPaused }
    }));
    return out.state;
  }

  async function deleteAccount(id) {
    await withAccount(id, () => null);
    await store.del(acctKey(id));
    await store.hdel('pt:index', id);
    for (const k of await listKeys(id)) if (!k.revokedAt) await revokeKey(id, k.keyId); // a key must never outlive its account
  }

  /** Account summary at current prices (read only; no lock). */
  async function getSummary(id) {
    const state = await load(id);
    let book = null;
    try { book = (await loadBook(heldExpiries(state))).book; } catch (e) { book = null; }
    return { summary: engine.summarize(state, book, cfg), state };
  }

  /**
   * Place an order. `agent` ({ keyId, label }) marks it as an agent's: it needs a reason and respects the pause switch.
   * `strategy` ({ deploymentId, name }) marks it as a live strategy's.
   */
  async function placeOrder(id, input, { agent = null, strategy = null } = {}) {
    const inst = engine.parseInstrument(input && input.instrument);
    const { book, allowed } = await loadBook(inst ? [inst.expiry] : []);
    return withAccount(id, state => {
      if (agent && state.agentsPaused) return { ok: false, error: { code: 'AGENTS_PAUSED', message: 'The owner has paused agent trading on this account.' }, state };
      const t = now();
      const out = engine.placeOrder({ ...input, source: agent ? 'agent' : input && input.source }, state, { book, nowMs: t, marketOpen: isMarketOpen(t), allowedExpiries: allowed, cfg });
      if (!out.ok) return out;
      const next = engine.recordMarks(out.state, book);
      if (agent) {
        // the order and any bracket exits it spawned remember which key placed them
        for (const o of next.orders) if (o.id === out.order.id || o.parentId === out.order.id) o.agent = { keyId: agent.keyId, label: agent.label };
      }
      if (strategy) {
        for (const o of next.orders) if (o.id === out.order.id) o.strategy = { deploymentId: strategy.deploymentId, name: strategy.name };
      }
      return { ...out, state: next, order: next.orders.find(o => o.id === out.order.id) || out.order };
    });
  }

  async function setAgentsPaused(id, paused) {
    return withAccount(id, state => ({ ok: true, state: { ...state, agentsPaused: !!paused } }));
  }

  // ── agent API keys ──

  const publicKey = k => ({ keyId: k.keyId, accountId: k.accountId, label: k.label, scope: k.scope, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null, revokedAt: k.revokedAt || null });

  async function allKeys() {
    return Object.values(await store.hgetall('pt:keys')).map(safeParse).filter(Boolean);
  }

  async function listKeys(accountId) {
    return (await allKeys()).filter(k => k.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt).map(publicKey);
  }

  /** New key for an account. The key itself is returned once and only its hash is kept. */
  async function createKey(accountId, { label, scope = 'trade' } = {}) {
    await load(accountId);
    if (typeof label !== 'string' || !label.trim() || label.length > 40) throw codedError('BAD_LABEL', 'Give the key a name of up to 40 characters, for example Claude.');
    if (!SCOPES.has(scope)) throw codedError('BAD_SCOPE', 'scope must be read or trade.');
    const live = (await allKeys()).filter(k => k.accountId === accountId && !k.revokedAt);
    if (live.length >= AGENT.keysPerAccount) throw codedError('TOO_MANY_KEYS', `At most ${AGENT.keysPerAccount} active keys per account. Revoke one first.`);
    const keyId = crypto.randomBytes(4).toString('hex');
    const token = `cdp_${keyId}_${crypto.randomBytes(24).toString('hex')}`;
    const record = { keyId, accountId, label: label.trim(), scope, createdAt: now(), lastUsedAt: null, revokedAt: null, hash: sha256hex(token) };
    await store.hset('pt:keys', keyId, JSON.stringify(record));
    return { token, key: publicKey(record) };
  }

  async function revokeKey(accountId, keyId) {
    const record = (await allKeys()).find(k => k.keyId === keyId && k.accountId === accountId);
    if (!record) throw codedError('NOT_FOUND', 'No such key.');
    if (!record.revokedAt) {
      record.revokedAt = now();
      await store.hset('pt:keys', keyId, JSON.stringify(record));
    }
    return publicKey(record);
  }

  /** The key's record for a valid, unrevoked key; null otherwise. Constant-time on the secret part. */
  async function authenticate(token) {
    const m = KEY_RE.exec(String(token || ''));
    if (!m) return null;
    const record = (await allKeys()).find(k => k.keyId === m[1]);
    if (!record || record.revokedAt) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sha256hex(token), 'hex'), Buffer.from(record.hash, 'hex'))) return null;
    const t = now();
    if (!record.lastUsedAt || t - record.lastUsedAt > 5 * 60000) { // at most one write per key every 5 minutes
      record.lastUsedAt = t;
      await store.hset('pt:keys', record.keyId, JSON.stringify(record)).catch(() => {});
    }
    return publicKey(record);
  }

  /** Count one order attempt against the key's per-minute and per-day allowance. Throws RATE_LIMITED when over. */
  async function consumeOrderQuota(keyId) {
    const t = now();
    const perMinute = await store.incr(`pt:q:${keyId}:m:${Math.floor(t / 60000)}`, 120);
    if (perMinute > AGENT.ordersPerMinute) throw codedError('RATE_LIMITED', `At most ${AGENT.ordersPerMinute} order requests a minute per key.`);
    const perDay = await store.incr(`pt:q:${keyId}:d:${istYmd(t)}`, 2 * 86400);
    if (perDay > AGENT.ordersPerDay) throw codedError('RATE_LIMITED', `At most ${AGENT.ordersPerDay} order requests a day per key.`);
  }

  /** Count one backtest run against the key's per-minute allowance (backtests are CPU work, so they get their own, lower one). */
  async function consumeBacktestQuota(keyId) {
    const n = await store.incr(`pt:q:${keyId}:bt:${Math.floor(now() / 60000)}`, 120);
    if (n > AGENT.backtestsPerMinute) throw codedError('RATE_LIMITED', `At most ${AGENT.backtestsPerMinute} backtests a minute per key.`);
  }

  /**
   * Run `fn` at most once per (key, Idempotency-Key): a retried request gets the first answer back instead of placing a
   * second order. Without an idempotency key it simply runs. Only results that `keep` accepts are remembered (placed
   * orders): a refused order releases the key, so the same request can be retried once it can succeed.
   */
  async function idempotent(keyId, idemKey, fn, { keep = () => true } = {}) {
    if (idemKey === undefined || idemKey === null || idemKey === '') return fn();
    if (!IDEM_RE.test(idemKey)) throw codedError('BAD_IDEMPOTENCY_KEY', 'Idempotency-Key: 1 to 64 letters, digits or _ . : -');
    const k = `pt:idem:${keyId}:${idemKey}`;
    const claimed = await store.setNx(k, JSON.stringify({ pending: true }), 60);
    if (!claimed) {
      const seen = safeParse(await store.get(k));
      if (!seen || seen.pending) throw codedError('IN_PROGRESS', 'A request with this Idempotency-Key is still being handled.');
      return { ...seen.result, replayed: true };
    }
    try {
      const result = await fn();
      if (keep(result)) await store.set(k, JSON.stringify({ result }), 86400);
      else await store.del(k);
      return result;
    } catch (e) {
      await store.del(k);
      throw e;
    }
  }

  async function cancelOrder(id, orderId) {
    return withAccount(id, state => engine.cancelOrder(orderId, state, now()));
  }

  /** What placing this order would do (fill price, charges, free cash after), without saving anything. */
  async function previewOrder(id, input) {
    const state = await load(id);
    const inst = engine.parseInstrument(input && input.instrument);
    const { book, allowed } = await loadBook(inst ? [inst.expiry] : []);
    const t = now();
    const before = engine.summarize(state, book, cfg);
    const out = engine.placeOrder(input, state, { book, nowMs: t, marketOpen: isMarketOpen(t), allowedExpiries: allowed, cfg });
    if (!out.ok) return { ok: false, error: out.error, availableBefore: before.available };
    const after = engine.summarize(out.state, book, cfg);
    return {
      ok: true,
      resting: !out.trade,
      fill: out.trade ? { price: out.trade.price, qty: out.trade.qty, charges: out.trade.charges } : null,
      availableBefore: before.available,
      availableAfter: after.available,
      marginAfter: after.margin
    };
  }

  /** Option chain for the order ticket: the tradable expiries and strikes around the money for one of them. */
  async function market(expiry, { width = 12 } = {}) {
    let m = await loadBook(expiry ? [expiry] : []);
    const exp = expiry && m.allowed.includes(expiry) ? expiry : m.allowed[0];
    if (exp && !m.book.expiries.includes(exp)) m = await loadBook([exp]);
    const t = now();
    const { book } = m;
    const byStrike = new Map();
    for (const [key, q] of Object.entries(book.quotes)) {
      const inst = engine.parseInstrument(key);
      if (!inst || inst.expiry !== exp) continue;
      const row = byStrike.get(inst.strike) || { strike: inst.strike, CE: null, PE: null };
      row[inst.optionType] = { ltp: q.ltp, bid: q.bid, ask: q.ask, iv: q.iv, oi: q.oi };
      byStrike.set(inst.strike, row);
    }
    const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    let atm = 0;
    rows.forEach((r, i) => { if (Math.abs(r.strike - book.spot) < Math.abs(rows[atm].strike - book.spot)) atm = i; });
    const strikes = rows.slice(Math.max(0, atm - width), atm + width + 1);
    const marketOpen = isMarketOpen(t);
    return {
      asOf: book.asOf,
      spot: book.spot,
      marketOpen,
      health: engine.bookHealth(book, t, { marketOpen, cfg }),
      expiries: m.allowed,
      expiry: exp || null,
      lotSize: cfg.lotSize,
      atmStrike: rows[atm] ? rows[atm].strike : null,
      strikes
    };
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
    await store.set('pt:lasttick', String(t), 600);
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
    // Only lock and rewrite an account that has something to do this minute: live orders to work or expire, a contract to
    // settle, or today's closing equity still to record. Holding positions alone needs nothing until the close.
    const needsWork = st => st && (
      st.orders.some(engine.isLive) ||
      Object.values(st.positions).some(p => due.includes(p.expiry)) ||
      (afterClose && (!st.curve.length || st.curve[st.curve.length - 1].ymd !== istYmd(t)))
    );
    let fills = 0, settled = 0;
    for (const [n, a] of accounts.entries()) {
      if (!needsWork(states[n])) continue;
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
          // one equity point per trading day, written from the close onward
          const last = s.curve[s.curve.length - 1];
          if (afterClose && (!last || last.ymd !== istYmd(t) || changed)) {
            s = engine.recordEquity(s, engine.summarize(s, market && market.book, cfg).equity, t);
            changed = true;
          }
          // marks ride along with a real change; on their own they are not worth a write every minute
          return changed ? { state: market ? engine.recordMarks(s, market.book) : s } : null;
        });
      } catch (e) {
        console.error(`paper tick: account ${a.id} failed:`, e.message);
      }
    }
    return { accounts: accounts.length, fills, settled, dataOk: !!market && !market.book.stale };
  }

  /** When any tick last ran (the cron job's, or a page's), in epoch ms; 0 if not within the last 10 minutes. */
  async function lastTickAt() {
    return Number(await store.get('pt:lasttick')) || 0;
  }

  return {
    lastTickAt, listAccounts, createAccount, resetAccount, deleteAccount, getSummary, placeOrder, previewOrder, cancelOrder, market, tick, loadBook, settlementPrice,
    setAgentsPaused, listKeys, createKey, revokeKey, authenticate, consumeOrderQuota, consumeBacktestQuota, idempotent
  };
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

module.exports = { createService, defaultService, ID_RE, AGENT };
