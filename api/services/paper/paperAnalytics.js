// Performance analytics for paper accounts, and CSV export. Pure functions of the stored account state.
//
// Who traded is read from the order behind each fill: you (manual), an agent (by key label), a live strategy (by name),
// or the exchange (expiry settlement). Fills whose order has aged out of the kept order history show as "older orders".
// "Closes" are fills that booked profit or loss (they reduced a position); win rate and averages are over those.

const r2 = x => Math.round(x * 100) / 100;

function whoOf(trade, orders) {
  if (trade.kind === 'settlement') return { key: 'expiry', label: 'Expiry settlement' };
  const o = orders.get(trade.orderId);
  if (!o) return { key: 'older', label: 'Older orders' };
  if (o.agent) return { key: `agent:${o.agent.keyId}`, label: `${o.agent.label} (agent)` };
  if (o.source === 'strategy') {
    const name = (o.strategy && o.strategy.name) || o.tag || 'strategy';
    return { key: `strategy:${name}`, label: `${name} (strategy)` };
  }
  return { key: 'you', label: 'You' };
}

function bucket(label) {
  return { label, fills: 0, closes: 0, wins: 0, losses: 0, realized: 0, charges: 0, net: 0 };
}

function add(b, t) {
  b.fills += 1;
  b.charges = r2(b.charges + t.charges);
  if (t.realized) {
    b.closes += 1;
    if (t.realized > 0) b.wins += 1; else b.losses += 1;
    b.realized = r2(b.realized + t.realized);
  }
  b.net = r2(b.realized - b.charges);
}

/** Largest fall from a running peak, over the daily closing equity plus the current equity. */
function drawdown(startingCapital, curve, equityNow) {
  let peak = startingCapital, maxDd = 0, maxDdPct = 0;
  for (const e of [...curve.map(p => p.equity), equityNow]) {
    peak = Math.max(peak, e);
    if (peak - e > maxDd) { maxDd = peak - e; maxDdPct = (peak - e) / peak; }
  }
  return { maxDrawdown: r2(maxDd), maxDrawdownPct: r2(maxDdPct * 100) };
}

// ── expectancy by setup ──
//
// A setup is why a trade was taken: the tag on the order that OPENED the position (a live strategy's orders carry the
// strategy's name). The exit does not need a tag: whatever closes a position, including expiry settlement, is credited to
// the setup that opened it.
//
// One trade = the opening fills of one setup in the same minute (so both legs of a spread are one result, not a win and a
// loss), followed until every lot it opened is closed. Untagged orders are each their own trade. Its result is what it
// booked minus the charges on its entry and exit fills, so every figure here is net of costs.
//
// Fills are matched first in, first out per instrument. The engine books profit at the average cost, so each unit a
// fill closes carries the same profit; splitting a closing fill across the lots it consumes by quantity is exact.

const UNTAGGED = 'Untagged';
const UNKNOWN = 'Opened before the kept history';
const FEW = 30;    // below this many closed trades the numbers say very little
const ENOUGH = 100;

function setupOf(order) {
  if (!order) return { key: 'unknown', label: UNKNOWN, group: null };
  if (order.source === 'strategy') {
    const name = (order.strategy && order.strategy.name) || order.tag || 'strategy';
    return { key: `strategy:${name}`, label: name, group: (order.strategy && order.strategy.deploymentId) || name };
  }
  if (order.tag) return { key: `tag:${order.tag.toLowerCase()}`, label: order.tag, group: order.tag.toLowerCase() };
  return { key: 'untagged', label: UNTAGGED, group: null };
}

/** 95% Wilson interval for a win rate: honest about small samples, unlike the bare percentage. */
function wilson(wins, n) {
  if (!n) return { low: null, high: null };
  const z = 1.96, p = wins / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: r2(Math.max(0, mid - half)), high: r2(Math.min(1, mid + half)) };
}

function setupStats(state) {
  const orders = new Map(state.orders.map(o => [o.id, o]));
  const lots = new Map();    // instrument -> [{ qty (signed, remaining), entry }] oldest first
  const entries = new Map(); // entry id -> { setup, open (units still open), pnl, closedAt }
  const sign = t => (t.side === 'BUY' ? 1 : -1);

  for (const t of [...state.trades].sort((a, b) => a.at - b.at)) {
    const queue = lots.get(t.instrument) || [];
    lots.set(t.instrument, queue);
    const dir = sign(t);
    let left = t.qty;
    const perUnitCharges = t.qty ? t.charges / t.qty : 0;
    const closable = queue.filter(l => Math.sign(l.qty) === -dir).reduce((a, l) => a + Math.abs(l.qty), 0);
    const closing = Math.min(left, closable);
    const perUnitRealized = closing ? t.realized / closing : 0;

    // 1. this fill closes older lots, oldest first
    while (left > 0 && queue.length && Math.sign(queue[0].qty) === -dir) {
      const lot = queue[0];
      const take = Math.min(left, Math.abs(lot.qty));
      lot.qty += dir * take;
      left -= take;
      const e = lot.entry;
      e.pnl += take * (perUnitRealized - perUnitCharges);
      e.open -= take;
      if (e.open <= 0) e.closedAt = t.at;
      if (lot.qty === 0) queue.shift();
    }
    // A closing fill with nothing to match: its opening fill has aged out of the kept history.
    if (left > 0 && t.realized && !closing) {
      const id = `unknown|${t.id}`;
      entries.set(id, { setup: setupOf(null), open: 0, pnl: t.realized - t.charges, closedAt: t.at });
      left = 0;
    }
    // 2. whatever is left opens a new lot under this order's setup
    if (left > 0) {
      const setup = t.kind === 'settlement' ? setupOf(null) : setupOf(orders.get(t.orderId));
      const id = setup.group ? `${setup.key}|${setup.group}|${Math.floor(t.at / 60000)}` : `${setup.key}|${t.orderId || t.id}`;
      if (!entries.has(id)) entries.set(id, { setup, open: 0, pnl: 0, closedAt: null });
      const e = entries.get(id);
      e.open += left;
      e.closedAt = null;
      e.pnl -= left * perUnitCharges;
      queue.push({ qty: dir * left, entry: e });
    }
  }

  const by = new Map();
  for (const e of entries.values()) {
    if (!by.has(e.setup.key)) by.set(e.setup.key, { label: e.setup.label, results: [], open: 0 });
    const b = by.get(e.setup.key);
    if (e.open > 0) b.open += 1; else b.results.push(e.pnl);
  }
  return [...by.values()].map(b => {
    const n = b.results.length;
    const wins = b.results.filter(x => x > 0);
    const losses = b.results.filter(x => x <= 0); // a trade that only paid charges is a loss
    const net = b.results.reduce((a, x) => a + x, 0);
    const ci = wilson(wins.length, n);
    return {
      label: b.label,
      trades: n,
      open: b.open,
      wins: wins.length,
      losses: losses.length,
      winRate: n ? r2(wins.length / n) : null,
      winRateLow: ci.low,
      winRateHigh: ci.high,
      avgWin: wins.length ? r2(wins.reduce((a, x) => a + x, 0) / wins.length) : null,
      avgLoss: losses.length ? r2(losses.reduce((a, x) => a + x, 0) / losses.length) : null,
      expectancy: n ? r2(net / n) : null, // average net result per closed trade = win rate x avg win + loss rate x avg loss
      net: r2(net),
      sample: n < FEW ? 'few' : n < ENOUGH ? 'early' : 'ok'
    };
  }).sort((a, b) => b.trades - a.trades || b.open - a.open || a.label.localeCompare(b.label));
}

/** Analytics for one account. summary: paperEngine.summarize output (equity at current marks). */
function accountAnalytics(state, summary) {
  const orders = new Map(state.orders.map(o => [o.id, o]));
  const byWho = new Map();
  const byTag = new Map();
  const all = bucket('All');
  for (const t of state.trades) {
    const who = whoOf(t, orders);
    if (!byWho.has(who.key)) byWho.set(who.key, bucket(who.label));
    add(byWho.get(who.key), t);
    const o = orders.get(t.orderId);
    const tag = (o && o.tag) || null;
    if (tag) {
      if (!byTag.has(tag)) byTag.set(tag, bucket(tag));
      add(byTag.get(tag), t);
    }
    add(all, t);
  }
  const closes = state.trades.filter(t => t.realized);
  const winsSum = closes.filter(t => t.realized > 0).reduce((a, t) => a + t.realized, 0);
  const lossSum = -closes.filter(t => t.realized < 0).reduce((a, t) => a + t.realized, 0);
  const days = state.curve.map((p, i) => ({ ymd: p.ymd, change: r2(p.equity - (i ? state.curve[i - 1].equity : state.startingCapital)) }));
  return {
    id: state.id,
    name: state.name,
    startingCapital: state.startingCapital,
    equity: summary.equity,
    returnPct: r2(((summary.equity - state.startingCapital) / state.startingCapital) * 100),
    realized: state.realized,
    unrealized: summary.unrealized,
    charges: state.chargesPaid,
    chargesPctOfGross: closes.length && Math.abs(state.realized) > 0 ? r2((state.chargesPaid / Math.abs(state.realized)) * 100) : null,
    fills: state.trades.length,
    closes: closes.length,
    winRate: closes.length ? r2(closes.filter(t => t.realized > 0).length / closes.length) : null,
    avgWin: closes.some(t => t.realized > 0) ? r2(winsSum / closes.filter(t => t.realized > 0).length) : null,
    avgLoss: closes.some(t => t.realized < 0) ? r2(-lossSum / closes.filter(t => t.realized < 0).length) : null,
    profitFactor: lossSum > 0 ? r2(winsSum / lossSum) : null,
    ...drawdown(state.startingCapital, state.curve, summary.equity),
    tradingDays: days.length,
    bestDay: days.length ? days.reduce((a, b) => (b.change > a.change ? b : a)) : null,
    worstDay: days.length ? days.reduce((a, b) => (b.change < a.change ? b : a)) : null,
    byWho: [...byWho.values()].sort((a, b) => b.fills - a.fills),
    byTag: [...byTag.values()].sort((a, b) => b.fills - a.fills),
    bySetup: setupStats(state),
    totals: all,
    historyNote: state.trades.length >= 2000 ? 'Only the most recent 2000 fills are kept.' : null
  };
}

// ── CSV ──

/** One CSV cell. Text that a spreadsheet would run as a formula (= + - @ and control characters) is prefixed with '. */
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  return [columns.map(c => cell(c.label)).join(','), ...rows.map(r => columns.map(c => cell(c.get(r))).join(','))].join('\r\n') + '\r\n';
}

const iso = ms => (ms ? new Date(ms).toISOString() : '');

function tradesCsv(state) {
  const orders = new Map(state.orders.map(o => [o.id, o]));
  return toCsv([
    { label: 'time_utc', get: t => iso(t.at) },
    { label: 'trade_id', get: t => t.id },
    { label: 'order_id', get: t => t.orderId },
    { label: 'kind', get: t => t.kind },
    { label: 'instrument', get: t => t.instrument },
    { label: 'side', get: t => t.side },
    { label: 'qty', get: t => t.qty },
    { label: 'price', get: t => t.price },
    { label: 'charges', get: t => t.charges },
    { label: 'realized', get: t => t.realized },
    { label: 'by', get: t => whoOf(t, orders).label },
    { label: 'tag', get: t => (orders.get(t.orderId) || {}).tag || '' },
    { label: 'reason', get: t => (orders.get(t.orderId) || {}).reason || '' }
  ], state.trades);
}

function ordersCsv(state) {
  return toCsv([
    { label: 'placed_utc', get: o => iso(o.placedAt) },
    { label: 'order_id', get: o => o.id },
    { label: 'instrument', get: o => o.instrument },
    { label: 'side', get: o => o.side },
    { label: 'lots', get: o => o.lots },
    { label: 'qty', get: o => o.qty },
    { label: 'type', get: o => o.orderType },
    { label: 'limit', get: o => o.limitPrice },
    { label: 'trigger', get: o => o.triggerPrice },
    { label: 'status', get: o => o.status },
    { label: 'status_reason', get: o => o.statusReason || '' },
    { label: 'fill_price', get: o => o.fillPrice },
    { label: 'filled_utc', get: o => iso(o.filledAt) },
    { label: 'source', get: o => o.source },
    { label: 'agent', get: o => (o.agent ? o.agent.label : '') },
    { label: 'strategy', get: o => (o.strategy ? o.strategy.name : '') },
    { label: 'tag', get: o => o.tag || '' },
    { label: 'reason', get: o => o.reason || '' }
  ], state.orders);
}

module.exports = { whoOf, setupStats, wilson, accountAnalytics, drawdown, cell, toCsv, tradesCsv, ordersCsv };
