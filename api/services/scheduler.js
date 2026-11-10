const calendar = require('./market/calendar');
const instruments = require('./providers/instruments');
const integrity = require('./analytics/integrity');
const forwardLog = require('./analytics/forwardlog');
const { withRetry } = require('./util/retry');
const { refreshHolidays } = require('./market/holidays');
const { fetchRawOptionChain } = require('./market/optionChain');
const { processOptionChainData } = require('./analytics/analytics');

// The work that used to arrive as HTTP pings from an outside cron service, now done by the server itself:
//
//   every minute, 09:00-15:59 IST on trading days
//     - record a snapshot of each index's nearest expiry (history, forward log)
//     - paper trading: fill resting orders, expire day orders, settle expiries, record equity, run deployed strategies
//   every ten minutes the rest of the time
//     - keep the nearest expiries subscribed, so open interest at the previous close is noted before the next open
//   once a day (self-throttled)
//     - refresh the holiday list
//
// Nothing here fetches market data: the jobs read the live feed's state. The timer only decides when to write.

const IST_OFFSET_MS = 330 * 60 * 1000;
const RUN_FROM_MIN = 9 * 60;
const RUN_UNTIL_MIN = 16 * 60;
const IDLE_EVERY_MIN = 10;
const istMinute = ms => { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/** Record one index's nearest expiry (what GET /api/cron/snapshot did). */
async function snapshot(symbol) {
  const liveChain = require('./stream/liveChain');
  // The feed can be mid-reconnect for a moment, so try a few times within the minute.
  const { raw, allExpiries, targetExpiry, stale } = await withRetry(
    async attempt => {
      if (attempt > 1) console.error(`snapshot: retrying ${symbol} (attempt ${attempt})`);
      await liveChain.loadChain(symbol, null, { pin: true }); // the recorder's expiry stays subscribed
      return fetchRawOptionChain(symbol, null);
    },
    { attempts: 3, delayMs: 900, budgetMs: 6500, shouldRetry: e => e.code !== 'BAD_EXPIRY' && e.code !== 'UPSTOX_AUTH' && e.code !== 'UPSTOX_NO_TOKEN' }
  );
  const data = await processOptionChainData(raw, allExpiries, targetExpiry, { symbol }); // saves the snapshot
  // Score the chart's signals and zones against what price did next. Never from data that is stale or fails its own checks.
  let healthy = !stale;
  try { healthy = healthy && !integrity.hasFailure(integrity.verifyProcessed(raw, data, targetExpiry)); } catch (e) { healthy = false; }
  // The forward log scores NIFTY's price chart signals, so only NIFTY snapshots feed it.
  const forward = symbol !== 'NIFTY' ? { skipped: 'nifty-only' } : healthy ? await forwardLog.run(data) : { skipped: 'unhealthy-data' };
  return { symbol, expiry: data.expiry, dataAsOf: data.dataAsOf, forward };
}

/** Paper trading tick (what GET /api/cron/paper did). A failing strategy run must not hide the account tick's result. */
async function paperTick() {
  const paperRoutes = require('../routes/paper');
  const result = await paperRoutes.service().tick();
  let strategies;
  try { strategies = await paperRoutes.live().tick(); } catch (e) { console.error('live strategies tick failed:', e.message); strategies = { error: true }; }
  return { ...result, strategies };
}

/** Outside trading hours: touch the nearest expiries so they stay subscribed and their closing OI is noted. */
async function keepWarm() {
  const liveChain = require('./stream/liveChain');
  for (const symbol of instruments.SYMBOLS) {
    await liveChain.loadChain(symbol, null, { pin: true }).catch(err => {
      if (!['STREAM_DOWN', 'STREAM_NOT_READY'].includes(err.code)) console.error(`keep-warm ${symbol} failed:`, err.message);
    });
  }
}

const defaultJobs = { snapshot, paperTick, keepWarm, refreshHolidays };

function createScheduler({
  jobs = defaultJobs, now = Date.now, symbols = instruments.SYMBOLS, onTick = () => {},
  timers = { setTimeout, clearTimeout }, log = console.error
} = {}) {
  let timer = null;
  let running = false;
  let stopped = true;

  /** One pass. Returns what ran (for tests and the log). Never throws. */
  async function tick() {
    if (running) return { skipped: 'previous run still going' };
    running = true;
    const ran = [];
    const safe = async (name, fn) => {
      try { await fn(); ran.push(name); } catch (err) { log(`scheduler: ${name} failed: ${err.message}`); }
    };
    try {
      const nowMs = now();
      const mins = istMinute(nowMs);
      await safe('holidays', () => jobs.refreshHolidays());
      if (calendar.isTradingDay(nowMs) && mins >= RUN_FROM_MIN && mins < RUN_UNTIL_MIN) {
        for (const symbol of symbols) await safe(`snapshot:${symbol}`, () => jobs.snapshot(symbol));
        // a separate step, after the snapshots, so a slow paper tick can never cost a saved snapshot
        await safe('paper', () => jobs.paperTick());
      } else if (mins % IDLE_EVERY_MIN === 0) {
        await safe('keep-warm', () => jobs.keepWarm());
      }
      onTick(ran);
    } finally {
      running = false;
    }
    return { ran };
  }

  function schedule() {
    if (stopped) return;
    const nowMs = now();
    const wait = 60000 - (nowMs % 60000) + 2000; // two seconds into the next minute
    timer = timers.setTimeout(() => { tick().finally(schedule); }, wait);
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      // straight away, so a restart mid-session does not wait a minute (and the recorder's expiries get subscribed)
      Promise.resolve().then(() => (calendar.isMarketOpenAt(now()) ? tick() : jobs.keepWarm())).catch(() => {}).finally(schedule);
    },
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
      timer = null;
    }
  };
}

module.exports = { createScheduler, snapshot, paperTick, keepWarm };
