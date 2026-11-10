const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createGateway } = require('../api/services/stream/gateway');
const { createScheduler } = require('../api/services/scheduler');
const calendar = require('../api/services/market/calendar');

// The browser socket (a real ws server on a local port, a fake feed behind it) and the in-process scheduler. No network
// beyond localhost.

const wait = ms => new Promise(r => setTimeout(r, ms));

function fakeFeed() {
  const em = new EventEmitter();
  const state = { status: 'connected', stale: false, reason: null, lastTickAt: 111 };
  return {
    state,
    getState: () => ({ ...state }),
    marketInfo: () => ({ segmentStatus: { NSE_FO: 'NORMAL_OPEN' } }),
    on: (ev, fn) => { em.on(ev, fn); return () => em.off(ev, fn); },
    emit: (ev, v) => em.emit(ev, v),
    listeners: ev => em.listenerCount(ev)
  };
}

/** A manual clock for setInterval: nothing fires unless the test says so. */
function manualTimers() {
  const jobs = [];
  return {
    setInterval: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; },
    clearInterval: () => {},
    fire: ms => jobs.filter(j => j.ms === ms).forEach(j => j.fn())
  };
}

function client(port, path = '/ws', headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Origin: `http://127.0.0.1:${port}`, ...headers } });
  const inbox = [];
  ws.on('message', d => inbox.push(JSON.parse(d.toString())));
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return { ws, inbox, opened, say: m => ws.send(JSON.stringify(m)), of: type => inbox.filter(m => m.type === type) };
}

(async () => {
  // ── gateway ─────────────────────────────────────────────────────────
  {
    const feed = fakeFeed();
    const timers = manualTimers();
    const built = [];
    let failChain = null;
    const chainView = async (symbol, expiry) => {
      built.push(`${symbol}|${expiry}`);
      if (failChain) throw failChain;
      return { symbol, expiry: expiry || '17-Nov-2026', spot: 25000, strikes: [] };
    };
    const legIndex = (symbol, expiry) => (expiry === '17-Nov-2026' ? new Map([['K1', [25000, 'CE']], ['K2', [25000, 'PE']]]) : null);
    let owner = false;
    const reads = [];
    const paperViews = {
      market: async (expiry, symbol) => { reads.push('market'); return { ok: true, symbol, spot: 25000 }; },
      account: async id => { reads.push(`account:${id}`); if (id === 'missing') throw Object.assign(new Error('No such paper account.'), { code: 'NOT_FOUND' }); return { ok: true, summary: { id } }; },
      deployments: async () => ({ ok: true, deployments: [] })
    };
    const errors = [];
    const gateway = createGateway({ feed, chainView, paperViews, legIndex, isOwner: () => owner, accountIdRe: /^[a-z0-9-]{1,32}$/, timers, log: m => errors.push(m) });
    const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    gateway.attach(server);
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;

    // only /ws (and the paper path), only the same origin
    await assert.rejects(client(port, '/other').opened, /403/);
    await assert.rejects(client(port, '/ws', { Origin: 'http://evil.example' }).opened, /403/, 'another site cannot open the socket');

    const a = client(port);
    await a.opened;
    await wait(30);
    assert.deepStrictEqual(a.of('status')[0], { type: 'status', status: 'connected', stale: false, reason: null, lastTickAt: 111, serverTime: a.of('status')[0].serverTime, segments: { NSE_FO: 'NORMAL_OPEN' } }, 'the connection state arrives first');

    // watching a chain: the full payload at once, the same one GET /api/option-chain returns
    a.say({ type: 'chain', symbol: 'nifty' });
    await wait(40);
    assert.deepStrictEqual(a.of('chain')[0], { type: 'chain', symbol: 'NIFTY', expiry: null, payload: { ok: true, data: { symbol: 'NIFTY', expiry: '17-Nov-2026', spot: 25000, strikes: [] } } });

    // ticks are batched: many ticks, one message per flush, the latest price per contract, unknown keys ignored
    feed.emit('ticks', [{ key: 'K1', ltp: 101 }, { key: 'NSE_INDEX|Nifty 50', ltp: 25010 }, { key: 'OTHER', ltp: 1 }]);
    feed.emit('ticks', [{ key: 'K1', ltp: 102 }, { key: 'K2', ltp: 55 }]);
    assert.strictEqual(a.of('ticks').length, 0, 'nothing is sent per tick');
    timers.fire(250);
    await wait(30);
    assert.strictEqual(a.of('ticks').length, 1);
    const t = a.of('ticks')[0];
    assert.deepStrictEqual([t.symbol, t.spot, t.legs], ['NIFTY', 25010, [[25000, 'CE', 102], [25000, 'PE', 55]]]);
    timers.fire(250);
    await wait(20);
    assert.strictEqual(a.of('ticks').length, 1, 'no ticks, no message');

    // a second viewer of the same chain shares the build; the periodic push reaches both
    const b = client(port);
    await b.opened;
    b.say({ type: 'chain', symbol: 'NIFTY', expiry: null });
    await wait(40);
    const before = built.length;
    const [hadA, hadB] = [a.of('chain').length, b.of('chain').length];
    timers.fire(5000);
    await wait(40);
    assert.strictEqual(built.length, before + 1, 'one build for both viewers');
    assert.deepStrictEqual([a.of('chain').length, b.of('chain').length], [hadA + 1, hadB + 1]);

    // feed status changes are pushed to everyone, with the stale flag
    Object.assign(feed.state, { status: 'reconnecting', stale: true });
    feed.emit('status', feed.getState());
    await wait(30);
    assert.deepStrictEqual([a.of('status').pop().status, b.of('status').pop().stale], ['reconnecting', true]);
    Object.assign(feed.state, { status: 'auth_failed', stale: true, reason: 'UPSTOX_AUTH' });
    feed.emit('status', feed.getState());
    await wait(30);
    assert.strictEqual(a.of('status').pop().reason, 'UPSTOX_AUTH', 'the page can ask for a new token');

    // errors: a known one is named, anything else is hidden (the detail stays in the server log)
    failChain = Object.assign(new Error('Unknown expiry 24-Nov-2026'), { code: 'BAD_EXPIRY' });
    b.say({ type: 'chain', symbol: 'SENSEX', expiry: '24-Nov-2026' });
    await wait(40);
    assert.deepStrictEqual(b.of('chain').pop().payload, { ok: false, error: 'Unknown expiry.', code: 'BAD_EXPIRY' });
    failChain = new Error('secret upstream detail at 10.0.0.1');
    timers.fire(5000);
    await wait(40);
    assert.deepStrictEqual(a.of('chain').pop().payload, { ok: false, error: 'Error fetching option chain' });
    assert.ok(errors.some(e => /secret upstream detail/.test(e)));
    failChain = null;
    b.say({ type: 'chain', symbol: 'BANKNIFTY' });
    b.say({ type: 'chain', symbol: 'NIFTY', expiry: '<script>' });
    b.ws.send('not json');
    await wait(40);
    assert.strictEqual(b.of('error').filter(e => e.code === 'BAD_REQUEST').length, 2, 'bad input is refused, and never echoed');
    assert.ok(!JSON.stringify(b.inbox).includes('<script>'));

    // paper channels are owner only
    a.say({ type: 'paper', accountId: 'main', symbol: 'NIFTY' });
    a.say({ type: 'deployments', on: true });
    await wait(40);
    assert.strictEqual(a.of('error').filter(e => e.code === 'SIGNED_OUT').length, 2);
    assert.deepStrictEqual(reads, [], 'nothing was read for a signed-out page');
    owner = true;
    a.say({ type: 'paper', accountId: '../etc', symbol: 'NIFTY' });
    a.say({ type: 'paper', accountId: 'main', symbol: 'NIFTY' });
    await wait(40);
    assert.strictEqual(a.of('error').pop().code, 'BAD_REQUEST');
    assert.deepStrictEqual(a.of('paper')[0], { type: 'paper', accountId: 'main', symbol: 'NIFTY', expiry: null, market: { ok: true, symbol: 'NIFTY', spot: 25000 }, account: { ok: true, summary: { id: 'main' } } }, 'the message says which account and index it answers');
    reads.length = 0;
    timers.fire(5000);
    await wait(40);
    assert.deepStrictEqual(reads, ['market'], 'the market is pushed often; the account (a storage read) only every 15 s');
    a.say({ type: 'refresh' });
    await wait(40);
    assert.ok(reads.includes('account:main'), 'after placing an order the page asks for the account at once');
    reads.length = 0;
    gateway.paperTicked();
    await wait(40);
    assert.ok(reads.includes('account:main'), 'and the engine tick pushes it without being asked');
    a.say({ type: 'paper', accountId: 'missing', symbol: 'NIFTY' });
    await wait(40);
    assert.deepStrictEqual(a.of('paper').pop().account, { ok: false, code: 'NOT_FOUND', error: 'No such paper account.' });
    a.say({ type: 'deployments', on: true });
    await wait(40);
    assert.deepStrictEqual(a.of('deployments')[0].payload, { ok: true, deployments: [] });

    // the paper app's order ticket: price changes only, no analytics build
    {
      const c = client(port, '/api/paper/ws');
      await c.opened;
      const builtNow = built.length;
      c.say({ type: 'ticks', symbol: 'NIFTY', expiry: '17-Nov-2026' });
      c.say({ type: 'ticks', symbol: 'NIFTY' });
      await wait(40);
      assert.strictEqual(c.of('error').pop().code, 'BAD_REQUEST', 'a ticks subscription names its expiry');
      feed.emit('ticks', [{ key: 'K2', ltp: 60 }, { key: 'NSE_INDEX|Nifty 50', ltp: 25020 }]);
      timers.fire(250);
      await wait(30);
      assert.deepStrictEqual([c.of('ticks')[0].expiry, c.of('ticks')[0].spot, c.of('ticks')[0].legs], ['17-Nov-2026', 25020, [[25000, 'PE', 60]]]);
      timers.fire(5000);
      await wait(30);
      assert.strictEqual(c.of('chain').length, 0, 'no chain is built or sent for a ticks-only viewer');
      assert.strictEqual(built.filter(x => x === 'NIFTY|17-Nov-2026').length, 0);
      assert.ok(built.length >= builtNow);
      c.ws.close();
      await wait(40);
    }

    // leaving: the chain nobody watches is no longer built
    a.say({ type: 'stop', channel: 'chain' });
    b.ws.close();
    await wait(60);
    const builtBefore = built.length;
    timers.fire(5000);
    await wait(30);
    assert.strictEqual(built.length, builtBefore);
    assert.strictEqual(gateway.clientCount(), 1);

    gateway.close();
    assert.strictEqual(feed.listeners('ticks'), 0, 'the feed listeners are removed on shutdown');
    await new Promise(r => server.close(r));
  }

  // ── scheduler ───────────────────────────────────────────────────────
  {
    const IST = 330 * 60000;
    const at = (ymd, h, m) => Date.parse(`${ymd}T00:00:00Z`) - IST + (h * 60 + m) * 60000;
    let clock = at('2026-11-05', 10, 0); // a Thursday, mid-session
    const calls = [];
    let failSnapshot = false;
    const jobs = {
      refreshHolidays: async () => { calls.push('holidays'); },
      snapshot: async s => { calls.push(`snapshot:${s}`); if (failSnapshot && s === 'NIFTY') throw new Error('feed down'); },
      paperTick: async () => { calls.push('paper'); },
      keepWarm: async () => { calls.push('keep-warm'); }
    };
    const ticked = [];
    const waits = [];
    const timers = { setTimeout: (fn, ms) => { waits.push(ms); return 1; }, clearTimeout: () => {} };
    const sched = createScheduler({ jobs, now: () => clock, symbols: ['NIFTY', 'SENSEX'], onTick: ran => ticked.push(ran), timers, log: () => {} });

    assert.deepStrictEqual((await sched.tick()).ran, ['holidays', 'snapshot:NIFTY', 'snapshot:SENSEX', 'paper'], 'in session: record both indices, then the paper engine');
    assert.deepStrictEqual(ticked[0], ['holidays', 'snapshot:NIFTY', 'snapshot:SENSEX', 'paper']);

    // one failing job never stops the others
    calls.length = 0; failSnapshot = true;
    assert.deepStrictEqual((await sched.tick()).ran, ['holidays', 'snapshot:SENSEX', 'paper']);
    assert.deepStrictEqual(calls, ['holidays', 'snapshot:NIFTY', 'snapshot:SENSEX', 'paper']);
    failSnapshot = false;

    // the window is 09:00-15:59 IST on trading days, as the cron schedule was
    for (const [h, m, expect] of [[8, 59, false], [9, 0, true], [15, 59, true], [16, 0, false]]) {
      clock = at('2026-11-05', h, m); calls.length = 0;
      await sched.tick();
      assert.strictEqual(calls.includes('paper'), expect, `${h}:${String(m).padStart(2, '0')}`);
    }
    // outside it: nothing is recorded; every ten minutes the nearest expiries are kept subscribed
    clock = at('2026-11-05', 20, 10); calls.length = 0;
    await sched.tick();
    assert.deepStrictEqual(calls, ['holidays', 'keep-warm']);
    clock = at('2026-11-05', 20, 11); calls.length = 0;
    await sched.tick();
    assert.deepStrictEqual(calls, ['holidays']);
    clock = at('2026-11-07', 10, 0); calls.length = 0; // Saturday
    await sched.tick();
    assert.deepStrictEqual(calls, ['holidays', 'keep-warm']);
    assert.ok(calendar.isHoliday('2026-11-10'));
    clock = at('2026-11-10', 10, 0); calls.length = 0; // a trading holiday
    await sched.tick();
    assert.ok(!calls.includes('paper') && !calls.some(c => c.startsWith('snapshot')));

    // a run that is still going is not started twice
    clock = at('2026-11-05', 10, 0);
    let release;
    jobs.paperTick = () => new Promise(r => { release = r; });
    const slow = sched.tick();
    await wait(10);
    assert.deepStrictEqual(await sched.tick(), { skipped: 'previous run still going' });
    release();
    await slow;

    // timing: two seconds into each minute
    clock = at('2026-11-05', 10, 0) + 30000;
    jobs.paperTick = async () => {};
    sched.start();
    await wait(20);
    assert.deepStrictEqual(waits, [32000]);
    sched.stop();
  }

  console.log('gateway and scheduler checks passed');
})().catch(e => { console.error(e); process.exit(1); });
