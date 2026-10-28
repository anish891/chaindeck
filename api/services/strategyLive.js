// Live (forward-tested) strategies: a saved strategy deployed to a paper account trades by itself on real NSE prices.
//
// Every cron tick (once a minute while the market is open) each active deployment:
//   - with a position open: marks it at real prices and exits with market orders on the stop, target, index move or
//     exit time, exactly as the backtest rules say
//   - with no position: once per newly CLOSED candle, judges the entry conditions on that candle (same code as the
//     backtest) and, inside the window, enters every leg with a market order at the real ask / bid
// Orders go through the same engine and checks as manual and agent orders (market hours, fresh data, funds, margin),
// marked source 'strategy'. Next to every real fill it records what the backtest's option model would have charged, so
// backtests can be judged against reality.
//
//   pt:deploy           hash    id -> deployment (strategy snapshot, account, status, open position, live trades, log)
//   pt:dlock:{id}       string  short lock so two overlapping ticks never trade the same deployment twice

const crypto = require('crypto');
const B = require('./strategyBacktest');
const engine = require('./paperEngine');
const calendar = require('./calendar');
const { STRIKE_STEP, toMins, LAST_EXIT_MIN } = require('./strategy');

const MAX_DEPLOYMENTS = 10;
const MAX_LIVE_TRADES = 500;
const MAX_LOG = 40;
const LOCK_SEC = 55;
const IST_OFFSET_MS = 330 * 60 * 1000;
const istYmd = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const r2 = x => Math.round(x * 100) / 100;
const safeParse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const codedError = (code, message) => Object.assign(new Error(message), { code });

// ── pure decisions ───────────────────────────────────────────────────────

/** Only candles that have finished by `nowMs` (the last one from a chart feed is usually still forming). */
function closedCandles(candles, interval, nowMs) {
  const bar = B.BAR_MIN[interval] * 60000;
  return (candles || []).filter(c => c.t + bar <= nowMs);
}

/**
 * Is an entry due now? Judged on the last closed candle; the trade would enter at the open of the candle forming now.
 * Returns { due, candleT, why }. `candleT` lets the caller judge each candle only once.
 */
function entryDue(strategy, candles, vix, nowMs) {
  const closed = closedCandles(candles, strategy.interval, nowMs);
  if (closed.length < 2) return { due: false, candleT: null, why: 'not enough candles' };
  const last = closed.length - 1;
  const bar = B.BAR_MIN[strategy.interval] * 60000;
  const candleT = closed[last].t;
  const entryStart = candleT + bar;
  if (nowMs - entryStart >= bar) return { due: false, candleT, why: 'candle data is behind' }; // a stale feed must not trigger late entries
  if (istYmd(entryStart) !== istYmd(candleT)) return { due: false, candleT, why: 'new session' };
  const m = B.istMins(entryStart);
  if (m < toMins(strategy.entry.window.from) || m > toMins(strategy.entry.window.to)) return { due: false, candleT, why: 'outside the entry window' };
  if (!strategy.entry.weekdays.includes(B.istDow(entryStart))) return { due: false, candleT, why: 'not an entry day' };
  const prep = B.prepare(closed, vix, strategy.interval);
  if (!B.conditionsHold(strategy.entry.conditions, closed, prep.ctx[last])) return { due: false, candleT, why: 'conditions not met' };
  return { due: true, candleT, why: 'conditions met', vix: prep.ctx[last].vix };
}

/** The strategy's legs as orders at today's ATM (spot rounded to the 50-point grid) and the tradable expiries. */
function legOrders(strategy, spot, tradable) {
  const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
  return strategy.legs.map(l => {
    const expiry = l.expiry === 'next' ? tradable[1] : tradable[0];
    const strike = atm + l.strikeOffset * STRIKE_STEP;
    return { instrument: expiry ? engine.instrumentKey({ expiry, strike, optionType: l.optionType }) : null, side: l.side, lots: l.lots, optionType: l.optionType, strike, expiry };
  });
}

/** Should the open position be closed now, and why? marks: instrument -> real mark price. */
function exitReason(strategy, open, marks, spot, nowMs) {
  const mins = B.istMins(nowMs);
  if (istYmd(nowMs) !== open.day) return 'late'; // still open from an earlier session (data was down at the exit time)
  if (mins >= Math.min(toMins(strategy.exits.exitAt), LAST_EXIT_MIN)) return 'time';
  let pnl = 0;
  for (const l of open.legs) {
    const mark = marks[l.instrument];
    if (!(mark > 0)) return null; // cannot judge without a price for every leg
    pnl += (l.side === 'BUY' ? 1 : -1) * l.qty * (mark - l.entry);
  }
  if (open.stopRs !== null && pnl <= -open.stopRs) return 'stop';
  if (strategy.exits.indexMovePts && spot && Math.abs(spot - open.entrySpot) >= strategy.exits.indexMovePts) return 'index';
  if (open.targetRs !== null && pnl >= open.targetRs) return 'target';
  return null;
}

/** Money values for the stop and target, from the real entry fills (same rule as the backtest). */
function thresholds(strategy, legs) {
  const net = Math.abs(legs.reduce((a, l) => a + (l.side === 'BUY' ? 1 : -1) * l.entry * l.qty, 0));
  const rs = r => (!r ? null : r.unit === 'rupees' ? r.value : r2((r.value / 100) * net));
  return { stopRs: rs(strategy.exits.stopLoss), targetRs: rs(strategy.exits.target) };
}

/** What the backtest model would price this leg at (no spread), for the model-vs-real comparison. */
function modelLeg(leg, spot, nowMs, vix, entryT) {
  const expiryMs = engine.expiryCloseMs(leg.expiry);
  if (!expiryMs || !(vix > 0) || !(spot > 0)) return null;
  const m = { optionType: leg.optionType, strike: leg.strike, expiryMs, t0: entryT, T0: Math.max(0, (expiryMs - entryT) / (365 * 24 * 3600 * 1000)), tradingMin0: calendar.tradingMinutesBetween(entryT, expiryMs) };
  return r2(B.modelPrice(m, spot, nowMs, vix));
}

/** Live results in the backtest's shape, plus how far the model's premiums were from the real fills. */
function liveReport(deployment, capital) {
  const trades = deployment.trades || [];
  const s = B.stats(trades.map(t => ({ ...t, minutes: Math.round((t.exitT - t.entryT) / 60000) })), capital);
  const gaps = [];
  for (const t of trades) for (const l of t.legs) if (l.modelEntry > 0) gaps.push((l.entry - l.modelEntry) / l.modelEntry);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const absMean = gaps.length ? gaps.reduce((a, b) => a + Math.abs(b), 0) / gaps.length : null;
  return {
    ...s,
    model: {
      legs: gaps.length,
      meanGapPct: mean === null ? null : r2(mean * 100),
      meanAbsGapPct: absMean === null ? null : r2(absMean * 100),
      modelNet: r2(trades.reduce((a, t) => a + (t.modelNet || 0), 0)),
      note: 'Gap = real entry fill against the backtest model\'s price for the same leg at the same moment. Positive means real premiums were dearer than the model.'
    }
  };
}

// ── service ──────────────────────────────────────────────────────────────

/**
 * deps: store, accounts (paperAccounts service), loadLive (interval) => { candles, vix, stale }, now
 */
function createLiveService({ store, accounts, loadLive, now = Date.now }) {
  const all = async () => Object.values(await store.hgetall('pt:deploy')).map(safeParse).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  const save = d => store.hset('pt:deploy', d.id, JSON.stringify(d));
  const log = (d, text) => { d.log = [...(d.log || []), { at: now(), text }].slice(-MAX_LOG); };

  async function list() {
    return all();
  }

  async function get(id) {
    const d = (await all()).find(x => x.id === id);
    if (!d) throw codedError('NOT_FOUND', 'No such deployment.');
    return d;
  }

  async function deploy({ strategy, strategyId = null, accountId }) {
    await accounts.getSummary(accountId); // the account must exist
    const live = (await all()).filter(d => d.status !== 'stopped');
    if (live.length >= MAX_DEPLOYMENTS) throw codedError('TOO_MANY_DEPLOYMENTS', `At most ${MAX_DEPLOYMENTS} running deployments. Stop one first.`);
    if (live.some(d => d.accountId === accountId)) throw codedError('ACCOUNT_IN_USE', 'Another strategy is already running on that account. Use a separate account per strategy so results stay apart.');
    const d = {
      id: `d-${crypto.randomBytes(4).toString('hex')}`,
      strategyId,
      strategy,
      accountId,
      status: 'active',
      createdAt: now(),
      day: null,
      tradesToday: 0,
      lastCandleT: null,
      open: null,
      trades: [],
      log: []
    };
    log(d, `Deployed to account ${accountId}.`);
    await save(d);
    return d;
  }

  async function setStatus(id, status) {
    if (!['active', 'paused', 'stopped'].includes(status)) throw codedError('BAD_STATUS', 'status must be active, paused or stopped.');
    const d = await get(id);
    if (d.status === 'stopped' && status !== 'stopped') throw codedError('STOPPED', 'A stopped deployment cannot be restarted. Deploy the strategy again.');
    // stopping with a position open closes it first (on the next tick if the market is shut now)
    d.status = status === 'stopped' && d.open ? 'stopping' : status;
    log(d, d.status === 'stopping' ? 'Stop requested: closing the open position first.' : `Status: ${status}.`);
    await save(d);
    if (d.status === 'stopping') await tick({ only: id });
    return get(id);
  }

  async function remove(id) {
    const d = await get(id);
    if (d.status !== 'stopped') throw codedError('NOT_STOPPED', 'Stop the deployment before deleting it.');
    await store.hdel('pt:deploy', id);
  }

  /** Place one market order for the deployment. Returns the engine result. */
  function order(d, input, reason) {
    return accounts.placeOrder(d.accountId, { ...input, orderType: 'MARKET', source: 'strategy', reason: `${d.strategy.name}: ${reason}`, tag: d.strategy.name.slice(0, 40) }, { strategy: { deploymentId: d.id, name: d.strategy.name } });
  }

  async function closePosition(d, why, spot, vix) {
    const t = now();
    const out = [];
    for (const l of d.open.legs) {
      if (l.exit !== undefined) { out.push(l); continue; } // already closed on an earlier attempt
      const res = await order(d, { instrument: l.instrument, side: l.side === 'BUY' ? 'SELL' : 'BUY', lots: l.lots }, `exit (${why})`);
      if (!res.ok || !res.trade) {
        log(d, `Exit of ${l.instrument} failed (${res.error ? res.error.code : 'no fill'}). Will retry next tick.`);
        return false;
      }
      l.exit = res.trade.price;
      l.exitCharges = res.trade.charges;
      l.modelExit = modelLeg(l, spot, t, vix, d.open.entryT);
      out.push(l);
    }
    const legs = d.open.legs;
    const gross = legs.reduce((a, l) => a + (l.side === 'BUY' ? 1 : -1) * l.qty * (l.exit - l.entry), 0);
    const charges = legs.reduce((a, l) => a + l.entryCharges + l.exitCharges, 0);
    const modelOk = legs.every(l => l.modelEntry > 0 && l.modelExit !== null);
    d.trades = [...d.trades, {
      day: d.open.day,
      entryT: d.open.entryT,
      exitT: t,
      reason: why,
      entryIndex: d.open.entrySpot,
      exitIndex: spot || null,
      legs: legs.map(l => ({ instrument: l.instrument, side: l.side, qty: l.qty, entry: l.entry, exit: l.exit, modelEntry: l.modelEntry, modelExit: l.modelExit })),
      gross: r2(gross),
      charges: r2(charges),
      net: r2(gross - charges),
      modelNet: modelOk ? r2(legs.reduce((a, l) => a + (l.side === 'BUY' ? 1 : -1) * l.qty * (l.modelExit - l.modelEntry), 0)) : null
    }].slice(-MAX_LIVE_TRADES);
    log(d, `Closed (${why}): net ${r2(gross - charges)}.`);
    d.open = null;
    return true;
  }

  async function openPosition(d, spot, vix, tradable) {
    const t = now();
    const wanted = legOrders(d.strategy, spot, tradable);
    if (wanted.some(w => !w.instrument)) { log(d, 'Entry skipped: the expiry it needs is not tradable.'); return; }
    const filled = [];
    for (const w of wanted) {
      const res = await order(d, { instrument: w.instrument, side: w.side, lots: w.lots }, 'entry');
      if (!res.ok || !res.trade) {
        log(d, `Entry of ${w.instrument} refused (${res.error ? res.error.code : 'no fill'}).`);
        // never leave half a structure on: undo the legs already filled
        for (const f of filled) await order(d, { instrument: f.instrument, side: f.side === 'BUY' ? 'SELL' : 'BUY', lots: f.lots }, 'undo partial entry');
        return;
      }
      filled.push({ ...w, qty: res.trade.qty, entry: res.trade.price, entryCharges: res.trade.charges, modelEntry: modelLeg(w, spot, t, vix, t) });
    }
    d.open = { day: istYmd(t), entryT: t, entrySpot: spot, legs: filled, ...thresholds(d.strategy, filled) };
    d.tradesToday += 1;
    log(d, `Entered ${filled.map(f => `${f.side} ${f.strike} ${f.optionType}`).join(', ')} at NIFTY ${spot}.`);
  }

  /** One pass over every running deployment. opts.only limits it to one deployment. */
  async function tick({ only = null } = {}) {
    const t = now();
    const running = (await all()).filter(d => ['active', 'stopping'].includes(d.status) && (!only || d.id === only));
    let entered = 0, exited = 0;
    for (const d0 of running) {
      const lock = `pt:dlock:${d0.id}`;
      if (!(await store.setNx(lock, '1', LOCK_SEC))) continue;
      try {
        const d = (await all()).find(x => x.id === d0.id) || d0; // fresh copy under the lock
        const before = JSON.stringify(d);
        if (d.day !== istYmd(t)) { d.day = istYmd(t); d.tradesToday = 0; }
        const { summary } = await accounts.getSummary(d.accountId);
        const spot = summary.spot;
        let live = null;
        try { live = await loadLive(d.strategy.interval); } catch (e) { live = null; }
        const vixNow = live && live.vix.length ? live.vix[live.vix.length - 1].c : null;

        if (d.open) {
          const marks = Object.fromEntries(summary.positions.map(p => [p.instrument, p.mark]));
          const gone = d.open.legs.some(l => l.exit === undefined && !summary.positions.some(p => p.instrument === l.instrument));
          if (gone) {
            log(d, 'A leg was closed outside the strategy; the strategy stops tracking this position.');
            d.open = null;
          } else {
            const why = d.status === 'stopping' ? 'stopped' : exitReason(d.strategy, d.open, marks, spot, t);
            if (why && await closePosition(d, why, spot, vixNow)) exited += 1;
          }
        } else if (d.status === 'active' && live && !live.stale && d.tradesToday < d.strategy.entry.maxTradesPerDay) {
          const sig = entryDue(d.strategy, live.candles, live.vix, t);
          if (sig.candleT && sig.candleT !== d.lastCandleT) {
            d.lastCandleT = sig.candleT;
            if (sig.due) {
              const { allowed } = await accounts.loadBook([]);
              await openPosition(d, spot, sig.vix || vixNow, allowed);
              if (d.open) entered += 1;
            }
          }
        }
        if (d.status === 'stopping' && !d.open) { d.status = 'stopped'; log(d, 'Stopped.'); }
        if (JSON.stringify(d) !== before) await save(d); // most minutes change nothing
      } catch (e) {
        console.error(`live strategy ${d0.id}:`, e.message);
      } finally {
        await store.del(lock);
      }
    }
    return { deployments: running.length, entered, exited };
  }

  return { list, get, deploy, setStatus, remove, tick, report: (d, capital) => liveReport(d, capital) };
}

module.exports = { closedCandles, entryDue, legOrders, exitReason, thresholds, modelLeg, liveReport, createLiveService, MAX_DEPLOYMENTS };
