// Paper trading engine for NIFTY index options: orders, fills, charges, margin, P&L and expiry settlement.
//
// Pure: every function takes an account state and a market "book" and returns a NEW state (the input is never changed).
// Nothing here reads the clock, the network or storage, so the trading page, the agent API, the backtester and live
// strategies all get the same answer for the same inputs.
//
// Fill rules (honest, and slightly conservative where the data is thin):
//  - MARKET buys fill at the best ask and sells at the best bid. With an empty book: LTP plus / minus slippage.
//  - A LIMIT order that is marketable on arrival (ask at or below a buy limit) fills at once at the ask (bid for a sell).
//  - Anything else rests, and fills only on a LATER snapshot than the one it was placed against, never on the quote the
//    trader just saw. A resting buy limit fills at the ask once the ask is at or below the limit, or at the limit itself
//    when a trade printed strictly below it (LTP < limit). Sells mirror this.
//  - SL and SL-M trigger when LTP reaches the trigger price, then behave as a limit or market order.
//  - All orders are DAY orders: anything still open at 15:30 IST is cancelled. Positions carry overnight.
//  - Nothing fills while the book is unhealthy (stale NSE copy, old snapshot, or outside market hours).
//  - Expired options cash-settle at intrinsic value against the settlement price (the index close on expiry day).
//
// Margin is an approximation, not SPAN: each short option needs about 9% of spot (less half of how far it is out of the
// money, never below 3.5% of spot) per unit, and a group whose loss at expiry is bounded (a spread) needs at most that loss.
//
// Instrument key: 'NIFTY|28-Oct-2026|25000|CE'. Quantities are units (lots x lot size); orders are placed in lots.

const { tradeCharges, exerciseCharges, RATES } = require('./paperCosts');
const { parseNseTs, strikesFor } = require('./integrity');
const { nseDateToYmd, CLOSE_MIN } = require('./calendar');

const DEFAULTS = {
  lotSize: parseInt(process.env.NIFTY_LOT_SIZE, 10) || 65,
  tick: 0.05,
  startingCapital: 100000,
  maxExpiries: 4,
  maxLotsPerOrder: 20,
  maxOpenOrders: 50,
  slippagePct: 0.01,         // empty book: pay 1% through LTP
  maxBookAgeMs: 3 * 60000,   // older NSE snapshot than this while trading: do not fill
  marginPct: 0.09,
  marginFloorPct: 0.035,
  otmCredit: 0.5,
  rates: RATES
};

const SIDES = new Set(['BUY', 'SELL']);
const ORDER_TYPES = new Set(['MARKET', 'LIMIT', 'SL', 'SL-M']);
const SOURCES = new Set(['manual', 'agent', 'strategy']);
const LIVE = new Set(['OPEN', 'TRIGGERED']);
const MAX_REASON = 500;
const MAX_TAG = 40;
const ORDER_HISTORY = 300;
const TRADE_HISTORY = 2000;
const CURVE_DAYS = 400;
const IST_OFFSET_MS = 330 * 60 * 1000;

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 10000) / 10000;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
const clone = s => structuredClone(s);
const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Round a price onto the tick grid: dir > 0 rounds up, dir < 0 down, 0 to nearest. */
function toTick(x, dir = 0, tick = DEFAULTS.tick) {
  const n = x / tick;
  const k = dir > 0 ? Math.ceil(n - 1e-9) : dir < 0 ? Math.floor(n + 1e-9) : Math.round(n);
  return r2(k * tick);
}
const onTick = (x, tick = DEFAULTS.tick) => Math.abs(x / tick - Math.round(x / tick)) < 1e-6;

// ── instruments ──────────────────────────────────────────────────────────

const instrumentKey = ({ expiry, strike, optionType }) => `NIFTY|${expiry}|${strike}|${optionType}`;

function parseInstrument(key) {
  const m = /^NIFTY\|(\d{2}-[A-Za-z]{3}-\d{4})\|(\d{3,6})\|(CE|PE)$/.exec(String(key || ''));
  return m ? { key: m[0], expiry: m[1], strike: Number(m[2]), optionType: m[3] } : null;
}

/** 15:30 IST on the expiry date, as epoch ms (null for a malformed expiry). */
function expiryCloseMs(expiry) {
  const ymd = nseDateToYmd(expiry);
  return ymd ? Date.parse(`${ymd}T00:00:00Z`) - IST_OFFSET_MS + CLOSE_MIN * 60000 : null;
}

/** 15:30 IST on the IST day of `ms`. */
function sessionCloseMs(ms) {
  return Date.parse(`${istYmd(ms)}T00:00:00Z`) - IST_OFFSET_MS + CLOSE_MIN * 60000;
}

/** The nearest `n` expiries that have not closed yet, from NSE's expiry list. */
function tradableExpiries(allExpiries, nowMs, n = DEFAULTS.maxExpiries) {
  return (allExpiries || [])
    .map(e => ({ e, close: expiryCloseMs(e) }))
    .filter(x => x.close && x.close > nowMs)
    .sort((a, b) => a.close - b.close)
    .slice(0, n)
    .map(x => x.e);
}

const intrinsic = (optionType, strike, spot) => Math.max(0, optionType === 'CE' ? spot - strike : strike - spot);

// ── market book ──────────────────────────────────────────────────────────

function quoteFrom(leg, asOf) {
  if (!leg) return null;
  const num = x => (positive(x) ? x : 0);
  let bid = num(leg.bidprice !== undefined ? leg.bidprice : leg.buyPrice1);
  let ask = num(leg.askPrice !== undefined ? leg.askPrice : leg.sellPrice1);
  if (bid && ask && bid > ask) { bid = 0; ask = 0; } // crossed book: not a price anyone could trade at
  return { ltp: num(leg.lastPrice), bid, ask, iv: num(leg.impliedVolatility), oi: num(leg.openInterest), asOf };
}

/**
 * One NSE option-chain payload (one expiry) as a book: { asOf, spot, stale, expiries, quotes: { key: quote } }.
 * quote: { ltp, bid, ask, iv, oi, asOf }, zero where NSE has no value.
 */
function buildBook(raw, expiry, { stale = false } = {}) {
  const rec = (raw && raw.records) || {};
  const asOf = parseNseTs(rec.timestamp);
  const spot = positive(rec.underlyingValue) ? rec.underlyingValue : null;
  const quotes = {};
  for (const row of strikesFor(raw, expiry)) {
    for (const optionType of ['CE', 'PE']) {
      const q = quoteFrom(row[optionType], asOf);
      if (q) quotes[instrumentKey({ expiry, strike: row.strike, optionType })] = q;
    }
  }
  return { asOf, spot, stale: !!stale, expiries: [expiry], quotes };
}

/** Several single-expiry books as one. Spot comes from the newest; stale if any part is. */
function mergeBooks(books) {
  const list = books.filter(Boolean);
  if (!list.length) return { asOf: null, spot: null, stale: true, expiries: [], quotes: {} };
  const newest = list.reduce((a, b) => ((b.asOf || 0) > (a.asOf || 0) ? b : a));
  return {
    asOf: newest.asOf,
    spot: newest.spot,
    stale: list.some(b => b.stale),
    expiries: list.flatMap(b => b.expiries),
    quotes: Object.assign({}, ...list.map(b => b.quotes))
  };
}

/** Can orders be placed or filled against this book right now? Returns { ok, reason }. */
function bookHealth(book, nowMs, { marketOpen, cfg = DEFAULTS } = {}) {
  if (!marketOpen) return { ok: false, reason: 'MARKET_CLOSED' };
  if (!book || !book.asOf || !book.spot) return { ok: false, reason: 'NO_DATA' };
  if (book.stale) return { ok: false, reason: 'DATA_STALE' };
  if (nowMs - book.asOf > cfg.maxBookAgeMs) return { ok: false, reason: 'DATA_OLD' };
  return { ok: true, reason: null };
}

// ── accounts ─────────────────────────────────────────────────────────────

function newAccount({ id, name, nowMs, startingCapital = DEFAULTS.startingCapital, kind = 'human' }) {
  return {
    v: 1,
    id,
    name: name || id,
    kind,
    createdAt: nowMs,
    startingCapital,
    cash: startingCapital,
    realized: 0,
    chargesPaid: 0,
    seq: 0,
    lastSpot: null,
    positions: {},
    orders: [],
    trades: [],
    curve: []
  };
}

const nextId = (state, prefix) => {
  state.seq += 1;
  return `${prefix}${state.seq}`;
};

// ── margin ───────────────────────────────────────────────────────────────

/** Approximate margin for one naked short unit. */
function nakedUnitMargin(pos, spot, cfg = DEFAULTS) {
  const otm = pos.optionType === 'CE' ? Math.max(0, pos.strike - spot) : Math.max(0, spot - pos.strike);
  return Math.max(cfg.marginPct * spot - cfg.otmCredit * otm, cfg.marginFloorPct * spot);
}

/** Worst value at expiry of one expiry's positions (negative = loss), or -Infinity when the upside loss is unbounded. */
function worstExpiryValue(list) {
  const callSlope = list.filter(p => p.optionType === 'CE').reduce((a, p) => a + p.qty, 0);
  if (callSlope < 0) return -Infinity;
  const points = [0, ...list.map(p => p.strike)];
  return Math.min(...points.map(s => list.reduce((a, p) => a + p.qty * intrinsic(p.optionType, p.strike, s), 0)));
}

/** Margin blocked by open positions: per expiry, the naked estimate, capped at the bounded loss when there is one. */
function marginFor(positions, spot, cfg = DEFAULTS) {
  if (!positive(spot)) return 0;
  const byExpiry = new Map();
  for (const p of Object.values(positions || {})) {
    if (!p.qty) continue;
    if (!byExpiry.has(p.expiry)) byExpiry.set(p.expiry, []);
    byExpiry.get(p.expiry).push(p);
  }
  let total = 0;
  for (const list of byExpiry.values()) {
    const naked = list.filter(p => p.qty < 0).reduce((a, p) => a + -p.qty * nakedUnitMargin(p, spot, cfg), 0);
    if (!naked) continue;
    const worst = worstExpiryValue(list);
    total += worst === -Infinity ? naked : Math.min(naked, Math.max(0, -worst));
  }
  return r2(total);
}

// ── fills ────────────────────────────────────────────────────────────────

function marketPrice(side, q, cfg = DEFAULTS) {
  if (!q) return null;
  if (side === 'BUY') {
    if (q.ask) return q.ask;
    return q.ltp ? toTick(q.ltp * (1 + cfg.slippagePct), +1, cfg.tick) : null;
  }
  if (q.bid) return q.bid;
  return q.ltp ? Math.max(cfg.tick, toTick(q.ltp * (1 - cfg.slippagePct), -1, cfg.tick)) : null;
}

/** Price at which a limit order fills against `q`, or null. `resting` allows the trade-through rule. */
function limitPrice(side, limit, q, resting) {
  if (!q) return null;
  if (side === 'BUY') {
    if (q.ask && q.ask <= limit) return q.ask;
    return resting && q.ltp && q.ltp < limit ? limit : null;
  }
  if (q.bid && q.bid >= limit) return q.bid;
  return resting && q.ltp && q.ltp > limit ? limit : null;
}

/** Apply one fill to positions and cash (mutates `state`, callers pass a clone). Returns the trade record. */
function applyFill(state, { instrument, side, qty, price, charges, at, asOf, orderId = null, kind = 'trade' }) {
  const inst = parseInstrument(instrument);
  const sgn = side === 'BUY' ? 1 : -1;
  const pos = state.positions[instrument] || { instrument, expiry: inst.expiry, strike: inst.strike, optionType: inst.optionType, qty: 0, avgPrice: 0, realized: 0, openedAt: at };
  const q0 = pos.qty;
  let realized = 0;
  if (q0 === 0 || Math.sign(q0) === sgn) {
    pos.avgPrice = r4((Math.abs(q0) * pos.avgPrice + qty * price) / (Math.abs(q0) + qty));
    if (q0 === 0) pos.openedAt = at;
  } else {
    const closing = Math.min(Math.abs(q0), qty);
    realized = (price - pos.avgPrice) * closing * Math.sign(q0);
    if (qty > closing) { pos.avgPrice = price; pos.openedAt = at; } // flipped through zero: the rest opens fresh
  }
  pos.qty = q0 + sgn * qty;
  pos.realized = r2(pos.realized + realized);
  pos.updatedAt = at;
  if (pos.qty === 0) delete state.positions[instrument];
  else state.positions[instrument] = pos;

  state.cash = r2(state.cash - sgn * price * qty - charges.total);
  state.realized = r2(state.realized + realized);
  state.chargesPaid = r2(state.chargesPaid + charges.total);
  const trade = { id: nextId(state, 'T'), orderId, kind, instrument, side, qty, price, charges: charges.total, chargesDetail: charges, realized: r2(realized), at, asOf: asOf || null };
  state.trades.push(trade);
  if (state.trades.length > TRADE_HISTORY) state.trades.splice(0, state.trades.length - TRADE_HISTORY);
  return trade;
}

/** Cash left over after margin. */
const available = (state, spot, cfg = DEFAULTS) => r2(state.cash - marginFor(state.positions, spot, cfg));

/**
 * Would this fill leave the account able to carry its positions? A fill is allowed when free cash stays at or above zero,
 * or when it does not make an already negative balance worse (closing trades are always possible).
 */
function affordable(state, fill, spot, cfg = DEFAULTS) {
  const before = available(state, spot, cfg);
  const trial = clone(state);
  applyFill(trial, { ...fill, charges: tradeCharges(fill.side, fill.price, fill.qty, cfg.rates) });
  const after = available(trial, spot, cfg);
  return { ok: after >= 0 || after >= before, before, after };
}

// ── orders ───────────────────────────────────────────────────────────────

function err(code, message) {
  return { ok: false, error: { code, message } };
}

/** Shape checks that need no market data. Returns { ok, value } or an error. */
function validateOrderInput(input, cfg = DEFAULTS) {
  const o = input || {};
  const inst = parseInstrument(o.instrument);
  if (!inst) return err('BAD_INSTRUMENT', 'instrument must look like NIFTY|28-Oct-2026|25000|CE.');
  if (!SIDES.has(o.side)) return err('BAD_SIDE', 'side must be BUY or SELL.');
  const orderType = o.orderType || 'MARKET';
  if (!ORDER_TYPES.has(orderType)) return err('BAD_ORDER_TYPE', 'orderType must be MARKET, LIMIT, SL or SL-M.');
  if (!Number.isInteger(o.lots) || o.lots < 1 || o.lots > cfg.maxLotsPerOrder) return err('BAD_LOTS', `lots must be a whole number from 1 to ${cfg.maxLotsPerOrder}.`);
  const price = x => positive(x) && x < 1e6 && onTick(x, cfg.tick);
  const needLimit = orderType === 'LIMIT' || orderType === 'SL';
  const needTrigger = orderType === 'SL' || orderType === 'SL-M';
  if (needLimit && !price(o.limitPrice)) return err('BAD_PRICE', `limitPrice must be a positive multiple of ${cfg.tick}.`);
  if (needTrigger && !price(o.triggerPrice)) return err('BAD_PRICE', `triggerPrice must be a positive multiple of ${cfg.tick}.`);
  if (orderType === 'SL' && (o.side === 'BUY' ? o.limitPrice < o.triggerPrice : o.limitPrice > o.triggerPrice)) {
    return err('BAD_PRICE', 'For an SL order the limit must be at or beyond the trigger (above it for a buy, below for a sell).');
  }
  const source = o.source || 'manual';
  if (!SOURCES.has(source)) return err('BAD_SOURCE', 'source must be manual, agent or strategy.');
  if (o.reason !== undefined && (typeof o.reason !== 'string' || o.reason.length > MAX_REASON)) return err('BAD_REASON', `reason must be text of at most ${MAX_REASON} characters.`);
  if (source === 'agent' && !(typeof o.reason === 'string' && o.reason.trim())) return err('REASON_REQUIRED', 'Agent orders must say why (reason).');
  if (o.tag !== undefined && (typeof o.tag !== 'string' || o.tag.length > MAX_TAG)) return err('BAD_TAG', `tag must be text of at most ${MAX_TAG} characters.`);
  let bracket = null;
  if (o.bracket !== undefined && o.bracket !== null) {
    const b = o.bracket;
    if (!b || typeof b !== 'object') return err('BAD_BRACKET', 'bracket must be { target, stop }.');
    if (b.target !== undefined && !price(b.target)) return err('BAD_BRACKET', 'bracket.target must be a positive price on the tick grid.');
    if (b.stop !== undefined && !price(b.stop)) return err('BAD_BRACKET', 'bracket.stop must be a positive price on the tick grid.');
    if (b.target === undefined && b.stop === undefined) return err('BAD_BRACKET', 'bracket needs a target, a stop or both.');
    bracket = { target: b.target === undefined ? null : b.target, stop: b.stop === undefined ? null : b.stop };
  }
  return {
    ok: true,
    value: {
      instrument: inst.key, expiry: inst.expiry, strike: inst.strike, optionType: inst.optionType,
      side: o.side, orderType, lots: o.lots,
      limitPrice: needLimit ? o.limitPrice : null,
      triggerPrice: needTrigger ? o.triggerPrice : null,
      source, reason: typeof o.reason === 'string' ? o.reason.trim() : '', tag: (o.tag && o.tag.trim()) || null, bracket
    }
  };
}

function closeOrder(order, status, at, statusReason = null) {
  order.status = status;
  order.closedAt = at;
  if (statusReason) order.statusReason = statusReason;
}

/** Keep every live order and the most recent closed ones. */
function trimOrders(state) {
  const closed = state.orders.filter(o => !LIVE.has(o.status));
  if (closed.length <= ORDER_HISTORY) return;
  const drop = new Set(closed.slice(0, closed.length - ORDER_HISTORY).map(o => o.id));
  state.orders = state.orders.filter(o => !drop.has(o.id));
}

/** Fill an order (mutates the clone). Handles reduce-only clamping, the funds check, brackets and OCO. Returns the trade or null. */
function executeOrder(state, order, price, { at, asOf, spot, cfg }) {
  let qty = order.qty;
  if (order.reduceOnly) {
    const pos = state.positions[order.instrument];
    const closable = pos && Math.sign(pos.qty) === (order.side === 'BUY' ? -1 : 1) ? Math.abs(pos.qty) : 0;
    if (!closable) { closeOrder(order, 'CANCELLED', at, 'NOTHING_TO_CLOSE'); return null; }
    qty = Math.min(qty, closable);
  }
  const fill = { instrument: order.instrument, side: order.side, qty, price, at, asOf, orderId: order.id };
  if (!affordable(state, fill, spot, cfg).ok) { closeOrder(order, 'REJECTED', at, 'INSUFFICIENT_FUNDS'); return null; }
  const trade = applyFill(state, { ...fill, charges: tradeCharges(order.side, price, qty, cfg.rates) });
  order.filledQty = qty;
  order.fillPrice = price;
  order.filledAt = at;
  closeOrder(order, 'FILLED', at);

  if (order.ocoId) {
    for (const o of state.orders) if (o.ocoId === order.ocoId && o.id !== order.id && LIVE.has(o.status)) closeOrder(o, 'CANCELLED', at, 'OCO_FILLED');
  }
  if (order.bracket) spawnBracket(state, order, qty, { at, asOf, cfg });
  cancelOrphanedExits(state, at);
  return trade;
}

/** After an entry fills, place its target (LIMIT) and stop (SL-M) as reduce-only exits that cancel each other. */
function spawnBracket(state, parent, qty, { at, asOf, cfg }) {
  const side = parent.side === 'BUY' ? 'SELL' : 'BUY';
  const base = {
    instrument: parent.instrument, expiry: parent.expiry, strike: parent.strike, optionType: parent.optionType,
    side, lots: Math.round(qty / cfg.lotSize), qty, lotSize: cfg.lotSize, status: 'OPEN', placedAt: at, placedAsOf: asOf,
    source: parent.source, reason: `Bracket exit for ${parent.id}`, tag: parent.tag, parentId: parent.id, ocoId: parent.id, reduceOnly: true, bracket: null
  };
  if (parent.bracket.target) state.orders.push({ ...base, id: nextId(state, 'O'), orderType: 'LIMIT', limitPrice: parent.bracket.target, triggerPrice: null });
  if (parent.bracket.stop) state.orders.push({ ...base, id: nextId(state, 'O'), orderType: 'SL-M', limitPrice: null, triggerPrice: parent.bracket.stop });
}

/** Reduce-only exits whose position is gone (closed by hand, or settled) have nothing left to do. */
function cancelOrphanedExits(state, at) {
  for (const o of state.orders) {
    if (!o.reduceOnly || !LIVE.has(o.status)) continue;
    const pos = state.positions[o.instrument];
    if (!pos || Math.sign(pos.qty) !== (o.side === 'BUY' ? -1 : 1)) closeOrder(o, 'CANCELLED', at, 'NOTHING_TO_CLOSE');
  }
}

/**
 * Place an order. ctx: { book, nowMs, marketOpen, allowedExpiries, cfg }.
 * Returns { ok: true, state, order, trade } (trade null when it rests) or { ok: false, error, state } (state unchanged).
 */
function placeOrder(input, prev, ctx) {
  const cfg = ctx.cfg || DEFAULTS;
  const checked = validateOrderInput(input, cfg);
  if (!checked.ok) return { ...checked, state: prev };
  const v = checked.value;
  const health = bookHealth(ctx.book, ctx.nowMs, { marketOpen: ctx.marketOpen, cfg });
  if (!health.ok) return { ...err(health.reason, messageFor(health.reason)), state: prev };
  if (!(ctx.allowedExpiries || []).includes(v.expiry)) return { ...err('EXPIRY_NOT_ALLOWED', 'Only the nearest four expiries can be traded.'), state: prev };
  const q = ctx.book.quotes[v.instrument];
  if (!q || !(q.ltp || q.bid || q.ask)) return { ...err('NO_QUOTE', 'No price for this strike right now.'), state: prev };
  if (prev.orders.filter(o => LIVE.has(o.status)).length >= cfg.maxOpenOrders) return { ...err('TOO_MANY_ORDERS', `At most ${cfg.maxOpenOrders} open orders.`), state: prev };

  const ref = v.limitPrice || v.triggerPrice || q.ltp || (v.side === 'BUY' ? q.ask : q.bid);
  if (v.triggerPrice) {
    if (!q.ltp) return { ...err('NO_QUOTE', 'A stop order needs a last traded price to trigger against.'), state: prev };
    const wrongSide = v.side === 'BUY' ? v.triggerPrice <= q.ltp : v.triggerPrice >= q.ltp;
    if (wrongSide) return { ...err('TRIGGER_CROSSED', `The trigger is already crossed (LTP ${q.ltp}). Use a market or limit order.`), state: prev };
  }
  if (v.bracket) {
    const long = v.side === 'BUY';
    if (v.bracket.target && (long ? v.bracket.target <= ref : v.bracket.target >= ref)) return { ...err('BAD_BRACKET', 'The target must be beyond the entry price in the trade direction.'), state: prev };
    if (v.bracket.stop && (long ? v.bracket.stop >= ref : v.bracket.stop <= ref)) return { ...err('BAD_BRACKET', 'The stop must be on the losing side of the entry price.'), state: prev };
  }

  const state = clone(prev);
  const at = ctx.nowMs;
  const order = { id: nextId(state, 'O'), ...v, qty: v.lots * cfg.lotSize, lotSize: cfg.lotSize, status: 'OPEN', placedAt: at, placedAsOf: q.asOf, parentId: null, ocoId: null, reduceOnly: false };
  const now = { at, asOf: q.asOf, spot: ctx.book.spot, cfg };
  state.lastSpot = ctx.book.spot;

  let fillAt = null;
  if (v.orderType === 'MARKET') {
    fillAt = marketPrice(v.side, q, cfg);
    if (!fillAt) return { ...err('NO_QUOTE', 'No price to fill a market order at.'), state: prev };
  } else if (v.orderType === 'LIMIT') {
    fillAt = limitPrice(v.side, v.limitPrice, q, false);
  }
  // Resting orders must be affordable at their own price when placed; they are checked again when they fill.
  const checkPrice = fillAt || v.limitPrice || v.triggerPrice;
  if (!affordable(state, { instrument: v.instrument, side: v.side, qty: order.qty, price: checkPrice, at, orderId: order.id }, ctx.book.spot, cfg).ok) {
    return { ...err('INSUFFICIENT_FUNDS', 'Not enough free cash for this order including margin and charges.'), state: prev };
  }

  state.orders.push(order);
  const trade = fillAt ? executeOrder(state, order, fillAt, now) : null;
  trimOrders(state);
  return { ok: true, state, order: state.orders.find(o => o.id === order.id) || order, trade };
}

function messageFor(code) {
  return {
    MARKET_CLOSED: 'The market is closed. Orders are accepted 09:15 to 15:30 IST on trading days.',
    NO_DATA: 'No option chain data right now.',
    DATA_STALE: 'The option chain is a leftover copy (NSE did not answer). Orders are paused until fresh data arrives.',
    DATA_OLD: 'The latest option chain snapshot is too old to trade on.'
  }[code] || 'Trading is paused.';
}

/** Cancel one live order. */
function cancelOrder(orderId, prev, nowMs) {
  const o = prev.orders.find(x => x.id === orderId);
  if (!o) return { ...err('NOT_FOUND', 'No such order.'), state: prev };
  if (!LIVE.has(o.status)) return { ...err('NOT_OPEN', `Order is already ${o.status.toLowerCase()}.`), state: prev };
  const state = clone(prev);
  const order = state.orders.find(x => x.id === orderId);
  closeOrder(order, 'CANCELLED', nowMs, 'USER');
  return { ok: true, state, order };
}

/**
 * Work every resting order against a newer book. Only quotes newer than the order's own placement snapshot count.
 * Returns { state, trades, changed }.
 */
function matchOrders(prev, book, nowMs, { marketOpen, cfg = DEFAULTS } = {}) {
  if (!bookHealth(book, nowMs, { marketOpen, cfg }).ok) return { state: prev, trades: [], changed: false };
  const state = clone(prev);
  state.lastSpot = book.spot;
  const trades = [];
  let changed = false;
  for (const order of state.orders) {
    if (!LIVE.has(order.status)) continue;
    const q = book.quotes[order.instrument];
    if (!q || !(q.asOf > order.placedAsOf)) continue;
    if (nowMs > sessionCloseMs(order.placedAt)) continue; // expireOrders deals with it
    const ctx = { at: nowMs, asOf: q.asOf, spot: book.spot, cfg };

    if (order.status === 'OPEN' && order.triggerPrice) {
      const hit = q.ltp && (order.side === 'BUY' ? q.ltp >= order.triggerPrice : q.ltp <= order.triggerPrice);
      if (!hit) continue;
      order.status = 'TRIGGERED';
      order.triggeredAt = nowMs;
      changed = true;
    }
    let price = null;
    if (order.orderType === 'SL-M') price = marketPrice(order.side, q, cfg);
    else price = limitPrice(order.side, order.limitPrice, q, true);
    if (!price) continue;
    const trade = executeOrder(state, order, price, ctx);
    changed = true;
    if (trade) trades.push(trade);
  }
  trimOrders(state);
  return { state: changed ? state : prev, trades, changed };
}

/** DAY orders: cancel anything still live after the close of the session it was placed in. */
function expireOrders(prev, nowMs) {
  if (!prev.orders.some(o => LIVE.has(o.status) && nowMs > sessionCloseMs(o.placedAt))) return { state: prev, changed: false };
  const state = clone(prev);
  for (const o of state.orders) if (LIVE.has(o.status) && nowMs > sessionCloseMs(o.placedAt)) closeOrder(o, 'EXPIRED', nowMs, 'END_OF_DAY');
  trimOrders(state);
  return { state, changed: true };
}

/**
 * Cash-settle every position in `expiry` at intrinsic value against `settlementSpot`. Long ITM options pay exercise STT.
 * Returns { state, trades, changed }.
 */
function settleExpiry(prev, expiry, settlementSpot, nowMs, { cfg = DEFAULTS } = {}) {
  const held = Object.values(prev.positions).filter(p => p.expiry === expiry && p.qty);
  if (!held.length || !positive(settlementSpot)) return { state: prev, trades: [], changed: false };
  const state = clone(prev);
  const trades = [];
  for (const p of held) {
    const value = r2(intrinsic(p.optionType, p.strike, settlementSpot));
    const qty = Math.abs(p.qty);
    const side = p.qty > 0 ? 'SELL' : 'BUY';
    const charges = p.qty > 0 && value > 0 ? exerciseCharges(value, qty, cfg.rates) : exerciseCharges(0, 0, cfg.rates);
    trades.push(applyFill(state, { instrument: p.instrument, side, qty, price: value, charges, at: nowMs, kind: 'settlement' }));
  }
  for (const o of state.orders) if (o.expiry === expiry && LIVE.has(o.status)) closeOrder(o, 'CANCELLED', nowMs, 'EXPIRED_CONTRACT');
  state.settlements = [...(state.settlements || []), { expiry, spot: settlementSpot, at: nowMs }].slice(-50);
  return { state, trades, changed: true };
}

// ── valuation ────────────────────────────────────────────────────────────

/** Mark price for a position: LTP, else the mid, else the last mark seen, else cost. */
function markOf(pos, q) {
  if (q && q.ltp) return q.ltp;
  if (q && q.bid && q.ask) return r2((q.bid + q.ask) / 2);
  return pos.lastMark || pos.avgPrice;
}

/** Store the latest marks on the positions so a later view without fresh data still has a value. */
function recordMarks(prev, book) {
  if (!book || !book.asOf) return prev;
  const state = clone(prev);
  for (const p of Object.values(state.positions)) {
    const q = book.quotes[p.instrument];
    if (q && (q.ltp || (q.bid && q.ask))) { p.lastMark = markOf(p, q); p.lastMarkAsOf = q.asOf; }
  }
  if (book.spot) state.lastSpot = book.spot;
  return state;
}

/**
 * Account view: equity, cash, margin, free cash, P&L and each position at its mark.
 * Identity: equity = startingCapital + realized + unrealized - charges.
 */
function summarize(state, book = null, cfg = DEFAULTS) {
  const spot = (book && book.spot) || state.lastSpot;
  const positions = Object.values(state.positions).map(p => {
    const q = book ? book.quotes[p.instrument] : null;
    const mark = markOf(p, q);
    return { ...p, mark, markAsOf: q && (q.ltp || (q.bid && q.ask)) ? q.asOf : p.lastMarkAsOf || null, value: r2(p.qty * mark), unrealized: r2((mark - p.avgPrice) * p.qty) };
  });
  const value = positions.reduce((a, p) => a + p.value, 0);
  const unrealized = positions.reduce((a, p) => a + p.unrealized, 0);
  const margin = marginFor(state.positions, spot, cfg);
  return {
    id: state.id,
    name: state.name,
    kind: state.kind,
    startingCapital: state.startingCapital,
    cash: state.cash,
    equity: r2(state.cash + value),
    margin,
    available: r2(state.cash - margin),
    realized: state.realized,
    unrealized: r2(unrealized),
    charges: state.chargesPaid,
    spot: spot || null,
    asOf: (book && book.asOf) || null,
    positions,
    openOrders: state.orders.filter(o => LIVE.has(o.status))
  };
}

/** Record the day's closing equity (one point per IST day, the latest call wins). */
function recordEquity(prev, equity, nowMs) {
  const ymd = istYmd(nowMs);
  const state = clone(prev);
  const last = state.curve[state.curve.length - 1];
  if (last && last.ymd === ymd) last.equity = equity;
  else state.curve.push({ ymd, equity });
  if (state.curve.length > CURVE_DAYS) state.curve.splice(0, state.curve.length - CURVE_DAYS);
  return state;
}

module.exports = {
  DEFAULTS,
  toTick,
  instrumentKey,
  parseInstrument,
  expiryCloseMs,
  sessionCloseMs,
  tradableExpiries,
  intrinsic,
  buildBook,
  mergeBooks,
  bookHealth,
  newAccount,
  marginFor,
  marketPrice,
  limitPrice,
  applyFill,
  affordable,
  validateOrderInput,
  placeOrder,
  cancelOrder,
  matchOrders,
  expireOrders,
  settleExpiry,
  recordMarks,
  summarize,
  recordEquity,
  isLive: o => LIVE.has(o.status)
};
