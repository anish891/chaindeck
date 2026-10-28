// Paper trading API for AI agents (Claude or any other). Mounted at /api/paper/v1.
//
// An agent authenticates with `Authorization: Bearer cdp_...`, a key the owner creates for ONE paper account on the
// paper page. The key decides the account; an agent can never see or touch another one. Keys are read-only or trade.
//
// Rules an agent cannot get around:
//  - every order needs a `reason`, kept in the journal next to the order
//  - at most 10 order requests a minute and 300 a day per key, plus a request ceiling for reads
//  - an `Idempotency-Key` header makes a retried order safe (the first answer is replayed, nothing is placed twice)
//  - the owner can pause agent trading on the account, or revoke the key, at any time
//  - the same engine and checks as the page: market hours, fresh data only, funds and margin, nearest four expiries

const express = require('express');
const { paperSecret, isProduction, isPlausibleExpiry, sendError } = require('../security');
const { fetchRawNSEOptionChain } = require('../services/nse');
const { processOptionChainData } = require('../services/analytics');
const integrity = require('../services/integrity');
const { AGENT } = require('../services/paperAccounts');
const { accountAnalytics } = require('../services/paperAnalytics');

const READS_PER_MINUTE = 120;

const STATUS = {
  NOT_FOUND: 404, BUSY: 409, IN_PROGRESS: 409, RATE_LIMITED: 429, BAD_IDEMPOTENCY_KEY: 400, BAD_STRATEGY: 400
};

/** Small fixed-window limiter keyed by the agent key (per instance; the order quota itself is shared via storage). */
function perKeyLimiter(max, windowMs = 60000) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 1000) hits.clear();
    let h = hits.get(req.agent.keyId);
    if (!h || h.resetAt <= now) { h = { n: 0, resetAt: now + windowMs }; hits.set(req.agent.keyId, h); }
    h.n += 1;
    if (h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: `At most ${max} requests a minute per key.` });
    }
    return next();
  };
}

/** Compact market context from the dashboard's analytics: what the page shows, as numbers. Not a forecast. */
async function marketContext() {
  const { raw, allExpiries, targetExpiry, stale } = await fetchRawNSEOptionChain('NIFTY', null);
  const d = await processOptionChainData(raw, allExpiries, targetExpiry);
  let checksOk = false;
  try { checksOk = !integrity.hasFailure(integrity.verifyProcessed(raw, d, targetExpiry)); } catch (e) { checksOk = false; }
  const rg = d.compositeRegime || {};
  return {
    asOf: d.dataAsOf,
    dataOk: !stale && checksOk,
    spot: d.spot,
    day: d.day,
    expiry: d.expiry,
    daysToExpiry: d.dteDays,
    atmStrike: d.atm,
    impliedFuture: d.impliedFuture,
    pcr: d.pcr,
    nearTheMoneyPcr: d.ntmPcr,
    volumePcr: d.volPcr,
    atmIv: d.atmIv,
    ivSkew: d.ivSkew,
    vix: d.vix,
    maxPain: d.maxPain,
    largestCallOiStrike: d.maxCallOIStrike,
    largestPutOiStrike: d.maxPutOIStrike,
    walls: d.walls,
    straddle: d.straddleDetails ? {
      price: d.straddleDetails.straddlePrice,
      expectedMove: d.straddleDetails.expectedMove,
      oneSigmaLower: d.straddleDetails.oneSigmaLower,
      oneSigmaUpper: d.straddleDetails.oneSigmaUpper
    } : null,
    gex: d.gex ? { netCr: d.gex.totalGexCr, zeroGammaLevel: d.gex.zeroGammaLevel, regime: d.gex.gexRegime } : null,
    cpr: d.cpr ? { pivot: d.cpr.pivot, top: d.cpr.tc, bottom: d.cpr.bc, r1: d.cpr.r1, r2: d.cpr.r2, s1: d.cpr.s1, s2: d.cpr.s2, width: d.cpr.cprType } : null,
    regime: { label: rg.regimeLabel || null, bias: rg.tacticalBias || null, drivers: rg.primaryDrivers || [] },
    note: 'Descriptive readings of the option chain, the same numbers the dashboard shows. They are not forecasts.'
  };
}

function docs(agent) {
  return {
    ok: true,
    name: 'ChainDeck paper trading API',
    version: 'v1',
    you: { account: agent.accountId, key: agent.keyId, label: agent.label, scope: agent.scope },
    money: 'Simulated. Prices are real NSE option prices, delayed about a minute. Nothing here reaches a broker.',
    instruments: 'NIFTY index options in the nearest four expiries. Instrument id: NIFTY|<expiry DD-Mon-YYYY>|<strike>|<CE or PE>, e.g. NIFTY|03-Nov-2026|25000|CE. Lot size is in /market.',
    hours: 'Orders are accepted 09:15 to 15:30 IST on NSE trading days, and only while the price feed is fresh.',
    fills: [
      'MARKET buys fill at the ask and sells at the bid (empty book: last price plus or minus 1%).',
      'A LIMIT order that is marketable fills at once at the ask (buy) or bid (sell); otherwise it waits.',
      'Waiting orders fill only on a newer NSE snapshot (about once a minute), never on the quote you just saw.',
      'SL and SL-M trigger when the last traded price reaches triggerPrice.',
      'All orders are day orders, cancelled at 15:30. Positions carry overnight and expired options cash-settle at intrinsic value.',
      'Charges are a discount broker\'s (brokerage, STT, exchange, SEBI, stamp duty, GST). Margin for short options is an estimate.'
    ],
    rules: [
      'Every order needs a reason (up to 500 characters). It is shown to the owner in the journal.',
      `At most ${AGENT.ordersPerMinute} order requests a minute and ${AGENT.ordersPerDay} a day per key; ${READS_PER_MINUTE} requests a minute overall.`,
      'Send an Idempotency-Key header (1 to 64 of A-Z a-z 0-9 _ . : -) with POST /orders so a retry never places a second order. A placed order replays for 24 hours; a refused one does not, so it can be retried.',
      'The owner can pause agent trading or revoke your key at any time. AGENTS_PAUSED means stop trading.'
    ],
    endpoints: {
      'GET /api/paper/v1': 'this document',
      'GET /api/paper/v1/account': 'cash, equity, margin, free cash, P&L, positions, open orders',
      'GET /api/paper/v1/market?expiry=DD-Mon-YYYY': 'tradable expiries, spot, lot size, health, and strikes near the money with ltp / bid / ask / iv / oi',
      'GET /api/paper/v1/context': 'market readings from the dashboard: PCR, max pain, OI walls, IV, VIX, GEX, CPR, regime, dataOk',
      'GET /api/paper/v1/positions': 'open positions at current marks',
      'GET /api/paper/v1/orders?status=open|all&limit=50': 'orders, newest first',
      'GET /api/paper/v1/orders/:id': 'one order',
      'GET /api/paper/v1/trades?limit=50': 'fills and expiry settlements, newest first',
      'POST /api/paper/v1/orders/preview': 'same body as POST /orders; says what would happen, places nothing (trade scope)',
      'POST /api/paper/v1/orders': 'place an order (trade scope)',
      'DELETE /api/paper/v1/orders/:id': 'cancel a waiting order (trade scope)',
      'GET /api/paper/v1/analytics': 'your account performance: return, drawdown, win rate, and results split by who traded and by tag',
      'GET /api/paper/v1/strategies/presets': 'example strategies in the backtest format',
      'POST /api/paper/v1/backtest': `{ strategy } backtest on about 60 sessions of history, at most ${AGENT.backtestsPerMinute} a minute (any scope)`
    },
    strategy: {
      format: '{ name, interval: 5m|15m, entry: { window: { from: HH:MM, to: HH:MM }, weekdays: [1..5], maxTradesPerDay: 1..5, conditions: [...] }, legs: [ { side, optionType, strikeOffset (strikes from ATM, 50 points each), lots, expiry: weekly|next } ], exits: { stopLoss: { unit: pct|rupees, value } | null, target: same | null, exitAt: HH:MM (by 15:25), indexMovePts: number | null } }',
      conditions: {
        gap: '{ type: gap, op: above|below, pct } open against previous close',
        dayMove: '{ type: dayMove, op: above|below, pct } close against today\'s open',
        orb: '{ type: orb, minutes: 15|30|60, direction: up|down } close beyond the completed opening range',
        vwap: '{ type: vwap, position: above|below }',
        prevDay: '{ type: prevDay, level: high|low|close, position: above|below }',
        vix: '{ type: vix, op: above|below, value }',
        signal: '{ type: signal, direction: bull|bear } a notable reversal pattern on that candle'
      },
      honesty: 'Option prices in backtests are MODELLED from India VIX (no historical option quotes exist here). A verdict of edge needs 30+ trades, a positive expectancy interval and beating 95% of random-entry runs; most strategies will say insufficient or none.'
    },
    order: {
      instrument: 'NIFTY|03-Nov-2026|25000|CE',
      side: 'BUY | SELL',
      lots: 'whole number, 1 to 20',
      orderType: 'MARKET (default) | LIMIT | SL | SL-M',
      limitPrice: 'LIMIT and SL, on the 0.05 grid',
      triggerPrice: 'SL and SL-M, on the 0.05 grid',
      bracket: 'optional { target, stop } premium prices; after the fill they become exits that cancel each other',
      reason: 'required: why you are placing this order',
      tag: 'optional label, up to 40 characters (e.g. a strategy name)'
    },
    errors: 'JSON { ok: false, code, error }. 401 bad key, 403 read-only key, 422 order refused (code says why: MARKET_CLOSED, DATA_STALE, DATA_OLD, INSUFFICIENT_FUNDS, NO_QUOTE, EXPIRY_NOT_ALLOWED, TRIGGER_CROSSED, BAD_*, AGENTS_PAUSED), 429 slow down.'
  };
}

/** @param svc () => paper service (shared with the owner routes) */
module.exports = function agentRouter(svc, strategies) {
  const router = express.Router();
  const readLimit = perKeyLimiter(READS_PER_MINUTE);

  const fail = (res, err, context) => {
    if (err && err.code && STATUS[err.code]) return res.status(STATUS[err.code]).json({ ok: false, code: err.code, error: err.message });
    return sendError(res, 502, context, err);
  };
  const refused = (res, out) => res.status(422).json({ ok: false, code: out.error.code, error: out.error.message });

  router.use(async (req, res, next) => {
    if (!paperSecret() && isProduction()) return res.status(503).json({ ok: false, error: 'Paper trading is disabled until PAPER_SECRET is configured.' });
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    try {
      req.agent = m ? await svc().authenticate(m[1]) : null;
    } catch (err) {
      return fail(res, err, 'Error checking agent key');
    }
    if (!req.agent) return res.status(401).json({ ok: false, code: 'BAD_KEY', error: 'Send Authorization: Bearer <your cdp_ key>. The key may be wrong or revoked.' });
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return res.status(415).json({ ok: false, error: 'Send JSON.' });
    return next();
  });
  router.use(readLimit);
  const tradeScope = (req, res, next) => (req.agent.scope === 'trade' ? next() : res.status(403).json({ ok: false, code: 'READ_ONLY_KEY', error: 'This key can read but not trade.' }));
  const id = req => req.agent.accountId;

  router.get('/', (req, res) => res.json(docs(req.agent)));

  router.get('/account', async (req, res) => {
    try {
      const { summary, state } = await svc().getSummary(id(req));
      res.json({ ok: true, account: { ...summary, agentsPaused: !!state.agentsPaused, limits: { ordersPerMinute: AGENT.ordersPerMinute, ordersPerDay: AGENT.ordersPerDay } } });
    } catch (err) {
      return fail(res, err, 'Agent: error reading account');
    }
  });

  router.get('/market', async (req, res) => {
    const { expiry } = req.query;
    if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 03-Nov-2026.' });
    try {
      res.json({ ok: true, ...(await svc().market(expiry || null)) });
    } catch (err) {
      return fail(res, err, 'Agent: error loading market');
    }
  });

  router.get('/context', async (req, res) => {
    try {
      res.json({ ok: true, context: await marketContext() });
    } catch (err) {
      return fail(res, err, 'Agent: error building context');
    }
  });

  router.get('/positions', async (req, res) => {
    try {
      const { summary } = await svc().getSummary(id(req));
      res.json({ ok: true, positions: summary.positions });
    } catch (err) {
      return fail(res, err, 'Agent: error reading positions');
    }
  });

  const limitOf = q => Math.min(200, Math.max(1, parseInt(q, 10) || 50));

  router.get('/orders', async (req, res) => {
    const status = req.query.status || 'all';
    if (!['open', 'all'].includes(status)) return res.status(400).json({ ok: false, error: 'status must be open or all.' });
    try {
      const { state } = await svc().getSummary(id(req));
      let list = state.orders.slice().reverse();
      if (status === 'open') list = list.filter(o => o.status === 'OPEN' || o.status === 'TRIGGERED');
      res.json({ ok: true, orders: list.slice(0, limitOf(req.query.limit)) });
    } catch (err) {
      return fail(res, err, 'Agent: error reading orders');
    }
  });

  router.get('/orders/:orderId', async (req, res) => {
    if (!/^O\d{1,9}$/.test(req.params.orderId)) return res.status(400).json({ ok: false, error: 'Bad order id.' });
    try {
      const { state } = await svc().getSummary(id(req));
      const order = state.orders.find(o => o.id === req.params.orderId);
      if (!order) return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'No such order (old orders drop out of history).' });
      res.json({ ok: true, order });
    } catch (err) {
      return fail(res, err, 'Agent: error reading order');
    }
  });

  router.get('/trades', async (req, res) => {
    try {
      const { state } = await svc().getSummary(id(req));
      res.json({ ok: true, trades: state.trades.slice().reverse().slice(0, limitOf(req.query.limit)) });
    } catch (err) {
      return fail(res, err, 'Agent: error reading trades');
    }
  });

  router.get('/analytics', async (req, res) => {
    try {
      const { summary, state } = await svc().getSummary(id(req));
      res.json({ ok: true, analytics: accountAnalytics(state, summary) });
    } catch (err) {
      return fail(res, err, 'Agent: error building analytics');
    }
  });

  router.get('/strategies/presets', (req, res) => res.json({ ok: true, presets: strategies().presets() }));

  // Backtests only read market history, so read-only keys may run them too.
  router.post('/backtest', async (req, res) => {
    try {
      await svc().consumeBacktestQuota(req.agent.keyId);
      const { summary } = await svc().getSummary(id(req));
      res.json({ ok: true, report: await strategies().backtest((req.body || {}).strategy, { capital: summary.startingCapital }) });
    } catch (err) {
      return fail(res, err, 'Agent: error running backtest');
    }
  });

  router.post('/orders/preview', tradeScope, async (req, res) => {
    try {
      res.json(await svc().previewOrder(id(req), { ...req.body, source: 'agent' }));
    } catch (err) {
      return fail(res, err, 'Agent: error previewing order');
    }
  });

  router.post('/orders', tradeScope, async (req, res) => {
    try {
      const out = await svc().idempotent(req.agent.keyId, req.headers['idempotency-key'], async () => {
        await svc().consumeOrderQuota(req.agent.keyId);
        const placed = await svc().placeOrder(id(req), req.body || {}, { agent: req.agent });
        return placed.ok
          ? { status: 201, body: { ok: true, order: placed.order, trade: placed.trade } }
          : { status: 422, body: { ok: false, code: placed.error.code, error: placed.error.message } };
      }, { keep: result => result.status === 201 });
      if (out.replayed) res.set('Idempotent-Replayed', 'true');
      res.status(out.status).json(out.body);
    } catch (err) {
      return fail(res, err, 'Agent: error placing order');
    }
  });

  router.delete('/orders/:orderId', tradeScope, async (req, res) => {
    if (!/^O\d{1,9}$/.test(req.params.orderId)) return res.status(400).json({ ok: false, error: 'Bad order id.' });
    try {
      const out = await svc().cancelOrder(id(req), req.params.orderId);
      if (!out.ok) return refused(res, out);
      res.json({ ok: true, order: out.order });
    } catch (err) {
      return fail(res, err, 'Agent: error cancelling order');
    }
  });

  return router;
};
