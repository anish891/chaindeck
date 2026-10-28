// Saved strategies and backtest runs for paper trading.
//
//   pt:strategies   hash   id -> { id, strategy, createdAt, updatedAt }   (owner's saved strategies, at most 50)
//
// Backtests are pure computation on cached candles (candles.getBacktestData), so the same strategy on the same data is
// answered from a small in-memory cache.

const crypto = require('crypto');
const { validateStrategy, PRESETS } = require('./strategy');
const { runBacktest } = require('./strategyBacktest');

const MAX_STRATEGIES = 50;
const MAX_TRADES_RETURNED = 300;
const CACHE_SIZE = 20;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const safeParse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const codedError = (code, message) => Object.assign(new Error(message), { code });
const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'strategy';

/** deps: store (storage.js-like), loadData (interval) => { candles, vix, fetchedAt }, now () => ms */
function createStrategyService({ store, loadData, now = Date.now }) {
  const cache = new Map();

  async function list() {
    const rows = Object.values(await store.hgetall('pt:strategies')).map(safeParse).filter(Boolean);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Save (create, or replace when `id` is given and exists). Returns the saved row. */
  async function save(input, id = null) {
    const checked = validateStrategy(input);
    if (!checked.ok) throw codedError(checked.error.code, checked.error.message);
    const rows = await list();
    if (id !== null && !ID_RE.test(id)) throw codedError('BAD_ID', 'Bad strategy id.');
    const existing = id ? rows.find(r => r.id === id) : null;
    if (id && !existing) throw codedError('NOT_FOUND', 'No such strategy.');
    if (!existing && rows.length >= MAX_STRATEGIES) throw codedError('TOO_MANY_STRATEGIES', `At most ${MAX_STRATEGIES} saved strategies.`);
    const t = now();
    const newId = existing ? existing.id : `${slug(checked.value.name)}-${crypto.randomBytes(2).toString('hex')}`;
    const row = { id: newId, strategy: checked.value, createdAt: existing ? existing.createdAt : t, updatedAt: t };
    await store.hset('pt:strategies', newId, JSON.stringify(row));
    return row;
  }

  async function remove(id) {
    if (!ID_RE.test(String(id || ''))) throw codedError('BAD_ID', 'Bad strategy id.');
    const rows = await list();
    if (!rows.some(r => r.id === id)) throw codedError('NOT_FOUND', 'No such strategy.');
    await store.hdel('pt:strategies', id);
  }

  /** Validate and backtest a strategy. opts: { capital } (to judge whether it fits the account). */
  async function backtest(input, { capital } = {}) {
    const checked = validateStrategy(input);
    if (!checked.ok) throw codedError(checked.error.code, checked.error.message);
    const strategy = checked.value;
    const data = await loadData(strategy.interval);
    const key = `${data.fetchedAt}|${capital || ''}|${JSON.stringify(strategy)}`;
    if (cache.has(key)) return { ...cache.get(key), cached: true };
    const report = runBacktest(strategy, data, { capital });
    const out = {
      ...report,
      tradesTruncated: report.tradeList.length > MAX_TRADES_RETURNED,
      tradeList: report.tradeList.slice(-MAX_TRADES_RETURNED),
      ranAt: now(),
      dataFetchedAt: data.fetchedAt || null
    };
    cache.set(key, out);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return out;
  }

  return { list, save, remove, backtest, presets: () => PRESETS.map(p => validateStrategy(p).value) };
}

function defaultStrategyService() {
  const store = require('./storage');
  const candles = require('./candles');
  return createStrategyService({ store, loadData: interval => candles.getBacktestData(interval) });
}

module.exports = { createStrategyService, defaultStrategyService };
