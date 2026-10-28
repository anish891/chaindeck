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

module.exports = { whoOf, accountAnalytics, drawdown, cell, toCsv, tradesCsv, ordersCsv };
