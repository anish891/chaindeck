// Paper trading API (owner only). Mounted at /api/paper.
//
//   GET    /session                      { configured, signedIn }
//   POST   /session                      { secret } -> sets the session cookie
//   DELETE /session                      signs out
//   GET    /market?expiry=               option chain for the order ticket (nearest four expiries)
//   GET    /accounts                     list (creates the default account on first use)
//   POST   /accounts                     { id, name, startingCapital }
//   GET    /accounts/:id                 summary, orders, trades, equity curve
//   POST   /accounts/:id/orders          place an order
//   POST   /accounts/:id/orders/preview  what an order would do, nothing saved
//   DELETE /accounts/:id/orders/:orderId cancel
//   POST   /accounts/:id/reset           start over with the same capital
//   DELETE /accounts/:id                 remove the account
//   GET    /accounts/:id/keys            agent API keys (never the keys themselves)
//   POST   /accounts/:id/keys            { label, scope } -> the new key, shown once
//   DELETE /accounts/:id/keys/:keyId     revoke
//   POST   /accounts/:id/agents          { paused } pause or resume agent trading on the account
//   GET    /strategies                   saved strategies and the presets
//   POST   /strategies                   { strategy } save a new one
//   PUT    /strategies/:sid              { strategy } replace a saved one
//   DELETE /strategies/:sid              remove
//   POST   /backtest                     { strategy, accountId? } backtest on 60 sessions (capital from the account)
//   /v1/...                              the agent API (routes/paperAgent.js), authenticated by agent key instead

const express = require('express');
const { rateLimit, requirePaperOwner, isPaperOwner, paperSignIn, paperSignOutCookie, paperSecret, isProduction, isPlausibleExpiry, sendError } = require('../security');
const { defaultService, ID_RE } = require('../services/paperAccounts');
const { defaultStrategyService } = require('../services/paperStrategies');

const router = express.Router();
const signInLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'paper-signin' });
const TICK_EVERY_MS = 15 * 1000; // an open page also works resting orders, so fills do not wait for the cron job

let service = null;
const svc = () => service || (service = defaultService());
let strategyService = null;
const strategies = () => strategyService || (strategyService = defaultStrategyService());
const backtestLimit = rateLimit({ windowMs: 60 * 1000, max: 20, name: 'paper-backtest' });
let lastTick = 0;

/** Test hook: swap in a service built on a fake store and feed. */
router.setService = s => { service = s; lastTick = 0; };
router.service = svc;
router.setStrategyService = s => { strategyService = s; };

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(express.json({ limit: '8kb' }));

const STATUS = {
  NOT_FOUND: 404, BUSY: 409, EXISTS: 409, TOO_MANY_ACCOUNTS: 409, TOO_MANY_KEYS: 409,
  BAD_ID: 400, BAD_CAPITAL: 400, BAD_NAME: 400, BAD_LABEL: 400, BAD_SCOPE: 400, BAD_STRATEGY: 400, TOO_MANY_STRATEGIES: 409
};

/** Known, user-facing errors keep their message; anything else is logged and hidden. */
function fail(res, err, context) {
  if (err && err.code && STATUS[err.code]) return res.status(STATUS[err.code]).json({ ok: false, code: err.code, error: err.message });
  return sendError(res, 502, context, err);
}

const validId = (req, res, next) => (ID_RE.test(req.params.id) ? next() : res.status(400).json({ ok: false, error: 'Bad account id.' }));

// ── session ──

router.get('/session', (req, res) => {
  res.json({ ok: true, configured: !!paperSecret() || !isProduction(), signedIn: isPaperOwner(req), needsSecret: !!paperSecret() });
});

router.post('/session', signInLimit, (req, res) => {
  if (!paperSecret()) {
    return isProduction()
      ? res.status(503).json({ ok: false, error: 'Paper trading is disabled until PAPER_SECRET is configured.' })
      : res.json({ ok: true, signedIn: true });
  }
  const cookie = paperSignIn(req.body && req.body.secret);
  if (!cookie) return res.status(401).json({ ok: false, error: 'That secret is not right.' });
  res.set('Set-Cookie', cookie);
  res.json({ ok: true, signedIn: true });
});

router.delete('/session', (req, res) => {
  res.set('Set-Cookie', paperSignOutCookie());
  res.json({ ok: true, signedIn: false });
});

// the agent API authenticates with its own keys, so it sits before the owner gate
router.use('/v1', require('./paperAgent')(svc, strategies));

// everything below is owner only
router.use(requirePaperOwner);

// ── market ──

router.get('/market', async (req, res) => {
  const { expiry } = req.query;
  if (expiry !== undefined && !isPlausibleExpiry(expiry)) return res.status(400).json({ ok: false, error: 'expiry must look like 03-Nov-2026.' });
  try {
    res.json({ ok: true, ...(await svc().market(expiry || null)) });
  } catch (err) {
    return fail(res, err, 'Error loading paper market');
  }
});

// ── accounts ──

router.get('/accounts', async (req, res) => {
  try {
    let accounts = await svc().listAccounts();
    if (!accounts.length) {
      await svc().createAccount({ id: 'main', name: 'My account' });
      accounts = await svc().listAccounts();
    }
    res.json({ ok: true, accounts });
  } catch (err) {
    return fail(res, err, 'Error listing paper accounts');
  }
});

router.post('/accounts', async (req, res) => {
  const b = req.body || {};
  try {
    const state = await svc().createAccount({ id: b.id, name: b.name, startingCapital: b.startingCapital === undefined ? undefined : Number(b.startingCapital) });
    res.status(201).json({ ok: true, account: { id: state.id, name: state.name } });
  } catch (err) {
    return fail(res, err, 'Error creating paper account');
  }
});

router.get('/accounts/:id', validId, async (req, res) => {
  try {
    if (Date.now() - lastTick > TICK_EVERY_MS) {
      lastTick = Date.now();
      await svc().tick().catch(e => console.error('paper tick from page failed:', e.message));
    }
    const { summary, state } = await svc().getSummary(req.params.id);
    res.json({
      ok: true,
      agentsPaused: !!state.agentsPaused,
      summary,
      orders: state.orders.slice(-150).reverse(),
      trades: state.trades.slice(-150).reverse(),
      curve: state.curve,
      settlements: state.settlements || [],
      createdAt: state.createdAt
    });
  } catch (err) {
    return fail(res, err, 'Error reading paper account');
  }
});

router.post('/accounts/:id/orders/preview', validId, async (req, res) => {
  try {
    res.json(await svc().previewOrder(req.params.id, { ...req.body, source: 'manual' }));
  } catch (err) {
    return fail(res, err, 'Error previewing paper order');
  }
});

router.post('/accounts/:id/orders', validId, async (req, res) => {
  try {
    const out = await svc().placeOrder(req.params.id, { ...req.body, source: 'manual' });
    if (!out.ok) return res.status(422).json({ ok: false, code: out.error.code, error: out.error.message });
    res.status(201).json({ ok: true, order: out.order, trade: out.trade });
  } catch (err) {
    return fail(res, err, 'Error placing paper order');
  }
});

router.delete('/accounts/:id/orders/:orderId', validId, async (req, res) => {
  if (!/^O\d{1,9}$/.test(req.params.orderId)) return res.status(400).json({ ok: false, error: 'Bad order id.' });
  try {
    const out = await svc().cancelOrder(req.params.id, req.params.orderId);
    if (!out.ok) return res.status(422).json({ ok: false, code: out.error.code, error: out.error.message });
    res.json({ ok: true, order: out.order });
  } catch (err) {
    return fail(res, err, 'Error cancelling paper order');
  }
});

router.post('/accounts/:id/reset', validId, async (req, res) => {
  try {
    await svc().resetAccount(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    return fail(res, err, 'Error resetting paper account');
  }
});

router.delete('/accounts/:id', validId, async (req, res) => {
  try {
    await svc().deleteAccount(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    return fail(res, err, 'Error deleting paper account');
  }
});

// ── agent keys and the pause switch ──

router.get('/accounts/:id/keys', validId, async (req, res) => {
  try {
    res.json({ ok: true, keys: await svc().listKeys(req.params.id) });
  } catch (err) {
    return fail(res, err, 'Error listing agent keys');
  }
});

router.post('/accounts/:id/keys', validId, async (req, res) => {
  const b = req.body || {};
  try {
    const { token, key } = await svc().createKey(req.params.id, { label: b.label, scope: b.scope || 'trade' });
    res.status(201).json({ ok: true, token, key });
  } catch (err) {
    return fail(res, err, 'Error creating agent key');
  }
});

router.delete('/accounts/:id/keys/:keyId', validId, async (req, res) => {
  if (!/^[0-9a-f]{8}$/.test(req.params.keyId)) return res.status(400).json({ ok: false, error: 'Bad key id.' });
  try {
    res.json({ ok: true, key: await svc().revokeKey(req.params.id, req.params.keyId) });
  } catch (err) {
    return fail(res, err, 'Error revoking agent key');
  }
});

router.post('/accounts/:id/agents', validId, async (req, res) => {
  if (typeof (req.body || {}).paused !== 'boolean') return res.status(400).json({ ok: false, error: 'paused must be true or false.' });
  try {
    await svc().setAgentsPaused(req.params.id, req.body.paused);
    res.json({ ok: true, paused: req.body.paused });
  } catch (err) {
    return fail(res, err, 'Error updating agent switch');
  }
});

// ── strategies and backtests ──

router.get('/strategies', async (req, res) => {
  try {
    res.json({ ok: true, saved: await strategies().list(), presets: strategies().presets() });
  } catch (err) {
    return fail(res, err, 'Error listing strategies');
  }
});

router.post('/strategies', async (req, res) => {
  try {
    res.status(201).json({ ok: true, saved: await strategies().save((req.body || {}).strategy) });
  } catch (err) {
    return fail(res, err, 'Error saving strategy');
  }
});

router.put('/strategies/:sid', async (req, res) => {
  try {
    res.json({ ok: true, saved: await strategies().save((req.body || {}).strategy, req.params.sid) });
  } catch (err) {
    return fail(res, err, 'Error saving strategy');
  }
});

router.delete('/strategies/:sid', async (req, res) => {
  try {
    await strategies().remove(req.params.sid);
    res.json({ ok: true });
  } catch (err) {
    return fail(res, err, 'Error deleting strategy');
  }
});

router.post('/backtest', backtestLimit, async (req, res) => {
  const b = req.body || {};
  try {
    let capital;
    if (b.accountId !== undefined) {
      if (!ID_RE.test(String(b.accountId))) return res.status(400).json({ ok: false, error: 'Bad account id.' });
      capital = (await svc().getSummary(b.accountId)).summary.startingCapital;
    }
    res.json({ ok: true, report: await strategies().backtest(b.strategy, { capital }) });
  } catch (err) {
    return fail(res, err, 'Error running backtest');
  }
});

// malformed JSON and other body errors: answer in JSON, not Express's HTML page
router.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ ok: false, error: err.type === 'entity.too.large' ? 'Request too large.' : 'Malformed JSON.' });
  }
  return next(err);
});

module.exports = router;
