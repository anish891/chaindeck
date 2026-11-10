const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const protobuf = require('protobufjs');
const stream = require('../api/services/stream/upstoxStream');

// The Upstox stream module against a fake socket and a fake clock: no network.

const T = stream._timing;
const settle = () => new Promise(r => setImmediate(r)); // let the async authorize and queued microtasks run

class FakeSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.frames = [];
    this.pings = 0;
    FakeSocket.all.push(this);
  }
  open() { this.readyState = 1; this.emit('open'); }
  send(buf) { this.frames.push(JSON.parse(buf.toString())); }
  ping() { this.pings += 1; }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1000); }
  terminate() { this.terminated = true; this.close(); }
  drop() { this.readyState = 3; this.emit('close', 1006); }
}
FakeSocket.all = [];
const lastSocket = () => FakeSocket.all[FakeSocket.all.length - 1];

function fakeClock() {
  let t = 1000000;
  let id = 0;
  const jobs = new Map();
  const add = (fn, ms, every) => { id += 1; jobs.set(id, { fn, at: t + ms, every }); return id; };
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, 0),
      clearTimeout: i => jobs.delete(i),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearInterval: i => jobs.delete(i)
    },
    pending: () => [...jobs.values()].filter(j => !j.every).map(j => j.at - t),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [jid, job] = next;
        t = job.at;
        if (job.every) job.at += job.every; else jobs.delete(jid);
        job.fn();
      }
      t = end;
    }
  };
}

function setup(extra = {}) {
  FakeSocket.all = [];
  const clock = fakeClock();
  let authorizeCalls = 0;
  const opts = {
    WebSocketImpl: FakeSocket, timers: clock.timers, now: clock.now, random: () => 0.5, log: () => {},
    authorize: async () => { authorizeCalls += 1; return `wss://feed.example/${authorizeCalls}`; },
    decode: buf => JSON.parse(buf.toString()),
    ...extra
  };
  return { clock, opts, calls: () => authorizeCalls };
}

const msg = obj => Buffer.from(JSON.stringify(obj));
const methods = sock => sock.frames.map(f => `${f.method}:${f.data.mode || '-'}:${f.data.instrumentKeys.join(',')}`);

(async () => {
  // ── protobuf: a real encoded message decodes and flattens ──
  {
    const root = protobuf.loadSync(path.join(__dirname, '../api/services/stream/MarketDataFeed.proto'));
    const Type = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
    const bytes = Type.encode(Type.fromObject({
      type: 'live_feed',
      currentTs: 1794218970000,
      feeds: {
        'NSE_FO|1': {
          requestMode: 'full_d5',
          fullFeed: { marketFF: {
            ltpc: { ltp: 120.5, ltt: 1794218970000, ltq: 65, cp: 110 },
            marketLevel: { bidAskQuote: [{ bidQ: 65, bidP: 120.4, askQ: 130, askP: 120.6 }] },
            optionGreeks: { delta: 0.52, theta: -9.1, gamma: 0.0004, vega: 11.2, rho: 1.1 },
            marketOHLC: { ohlc: [{ interval: '1d', open: 100, high: 130, low: 95, close: 120.5, vol: 5000, ts: 1794162600000 }] },
            atp: 118.2, vtt: 5000, oi: 228085, iv: 0.134, tbq: 100, tsq: 200
          } }
        },
        'NSE_INDEX|Nifty 50': { requestMode: 'ltpc', ltpc: { ltp: 25044.65, ltt: 1794220200000, cp: 24986.4 } }
      }
    })).finish();
    const decoded = stream.decodeFeed(Buffer.from(bytes));
    assert.strictEqual(decoded.type, 'live_feed');
    const opt = stream.toTick('NSE_FO|1', decoded.feeds['NSE_FO|1'], 5);
    assert.deepStrictEqual(
      { mode: opt.mode, ltp: opt.ltp, ltt: opt.ltt, cp: opt.cp, oi: opt.oi, iv: opt.iv, vtt: opt.vtt, delta: opt.greeks.delta, bid: opt.depth[0].bidP, dayHigh: opt.ohlc['1d'].high, receivedAt: opt.receivedAt },
      { mode: 'full', ltp: 120.5, ltt: 1794218970000, cp: 110, oi: 228085, iv: 0.134, vtt: 5000, delta: 0.52, bid: 120.4, dayHigh: 130, receivedAt: 5 }
    );
    const idx = stream.toTick('NSE_INDEX|Nifty 50', decoded.feeds['NSE_INDEX|Nifty 50'], 5);
    assert.strictEqual(idx.mode, 'ltpc');
    assert.strictEqual(idx.cp, 24986.4);
    assert.strictEqual(idx.oi, undefined, 'an ltpc tick carries no open interest');
    assert.strictEqual(stream.toTick('X', { requestMode: 'ltpc' }, 5), null, 'an entry without a price is dropped');
  }

  // ── subscribe before the socket exists; frames go out on open ──
  {
    const { opts, calls } = setup();
    const feed = stream.createMarketFeed(opts);
    const states = [];
    feed.on('status', s => states.push(s.status));
    feed.subscribe(['A', 'B', 'A'], 'full');
    feed.subscribe('V', 'ltpc');
    feed.start();
    await settle();
    assert.strictEqual(calls(), 1);
    assert.strictEqual(lastSocket().url, 'wss://feed.example/1');
    assert.deepStrictEqual(lastSocket().frames, [], 'nothing is sent before the socket opens');
    assert.strictEqual(feed.getState().stale, true);
    lastSocket().open();
    assert.deepStrictEqual(methods(lastSocket()), ['sub:ltpc:V', 'sub:full:A,B']);
    assert.deepStrictEqual(states, ['connecting', 'connected']);
    assert.strictEqual(feed.getState().stale, false);
    assert.deepStrictEqual(feed.getState().subscriptions, { ltpc: 1, option_greeks: 0, full: 2 });

    // ticks: stored, emitted as one batch, and unknown keys ignored
    const batches = [];
    feed.on('ticks', t => batches.push(t.map(x => x.key)));
    let info = null;
    feed.on('marketInfo', i => { info = i; });
    lastSocket().emit('message', msg({ marketInfo: { segmentStatus: { NSE_FO: 'NORMAL_OPEN' } } }), true);
    lastSocket().emit('message', msg({ feeds: {
      A: { requestMode: 'full_d5', fullFeed: { marketFF: { ltpc: { ltp: 10, ltt: 1, ltq: 1, cp: 9 }, oi: 500 } } },
      V: { requestMode: 'ltpc', ltpc: { ltp: 17.4, ltt: 1, cp: 18 } },
      STRANGER: { requestMode: 'ltpc', ltpc: { ltp: 1, ltt: 1, cp: 1 } }
    } }), true);
    assert.deepStrictEqual(info.segmentStatus, { NSE_FO: 'NORMAL_OPEN' });
    assert.deepStrictEqual(feed.marketInfo().segmentStatus, { NSE_FO: 'NORMAL_OPEN' });
    assert.deepStrictEqual(batches, [['A', 'V']]);
    assert.strictEqual(feed.get('A').oi, 500);
    assert.strictEqual(feed.get('STRANGER'), null);
    assert.ok(feed.getState().lastTickAt);
    lastSocket().emit('message', Buffer.from('not json'), true); // an undecodable message is skipped, not fatal
    assert.strictEqual(feed.get('A').ltp, 10);

    // a second, richer request for V upgrades it; dropping it downgrades; dropping the last reference unsubscribes
    lastSocket().frames.length = 0;
    const offFullV = feed.subscribe('V', 'full');
    await settle();
    assert.deepStrictEqual(methods(lastSocket()), ['change_mode:full:V']);
    offFullV();
    offFullV(); // idempotent
    await settle();
    assert.deepStrictEqual(methods(lastSocket()).slice(1), ['change_mode:ltpc:V']);
    lastSocket().frames.length = 0;
    const offC = feed.subscribe('C', 'option_greeks');
    offC(); // subscribed and dropped in the same turn: nothing is sent at all
    await settle();
    assert.deepStrictEqual(lastSocket().frames, []);
    feed.stop();
  }

  // ── subscription limits ──
  {
    const { opts } = setup();
    const feed = stream.createMarketFeed(opts);
    const keys = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const offFull = feed.subscribe(keys(2000, 'F'), 'full'); // one mode alone: 2000 allowed
    assert.throws(() => feed.subscribe('F-extra', 'full'), e => e.code === 'STREAM_LIMIT');
    assert.throws(() => feed.subscribe('L1', 'ltpc'), e => e.code === 'STREAM_LIMIT', 'mixing modes lowers full to 1500');
    assert.deepStrictEqual(feed.getState().subscriptions, { ltpc: 0, option_greeks: 0, full: 2000 }, 'a refused subscribe leaves nothing behind');
    offFull();
    feed.subscribe(keys(1500, 'F'), 'full');
    feed.subscribe(keys(2000, 'L'), 'ltpc');
    assert.throws(() => feed.subscribe('L-extra', 'ltpc'), e => e.code === 'STREAM_LIMIT');
    assert.throws(() => feed.subscribe('X', 'depth'), e => e.code === 'STREAM_BAD_MODE');

    // large subscriptions are split into frames of 500 keys
    feed.start();
    await settle();
    lastSocket().open();
    assert.deepStrictEqual(lastSocket().frames.map(f => `${f.data.mode}:${f.data.instrumentKeys.length}`), ['ltpc:500', 'ltpc:500', 'ltpc:500', 'ltpc:500', 'full:500', 'full:500', 'full:500']);
    feed.stop();
  }

  // ── reconnect: backoff with jitter, a fresh authorize each time, everything resubscribed ──
  {
    const { opts, clock, calls } = setup();
    const feed = stream.createMarketFeed(opts);
    const states = [];
    feed.on('status', s => states.push(s.status));
    feed.subscribe(['A', 'B'], 'full');
    feed.start();
    await settle();
    lastSocket().open();
    lastSocket().emit('message', msg({ feeds: { A: { requestMode: 'ltpc', ltpc: { ltp: 10, ltt: 1, cp: 9 } } } }), true);

    lastSocket().drop();
    assert.strictEqual(feed.getState().status, 'reconnecting');
    assert.strictEqual(feed.getState().stale, true);
    assert.strictEqual(feed.get('A').ltp, 10, 'the last known value survives the drop');
    assert.deepStrictEqual(clock.pending(), [750], 'first retry: between 0.5 s and 1 s (random = 0.5)');
    clock.advance(750);
    await settle();
    assert.strictEqual(calls(), 2, 'the authorized URL is single use, so each attempt authorizes again');
    assert.strictEqual(lastSocket().url, 'wss://feed.example/2');

    // the retry fails before any data arrives: the wait doubles each time, up to the cap
    const waits = [];
    for (let i = 0; i < 7; i += 1) {
      lastSocket().drop();
      waits.push(clock.pending()[0]);
      clock.advance(waits[waits.length - 1]);
      await settle();
    }
    assert.deepStrictEqual(waits, [1500, 3000, 6000, 12000, 22500, 22500, 22500], 'ceiling 2, 4, 8, 16, 30, 30, 30 s');

    lastSocket().open();
    assert.deepStrictEqual(methods(lastSocket()), ['sub:full:A,B'], 'subscriptions are replayed on the new connection');
    assert.strictEqual(feed.getState().status, 'connected');
    lastSocket().emit('message', msg({ feeds: {} }), true); // data resets the backoff
    lastSocket().drop();
    assert.deepStrictEqual(clock.pending(), [750]);
    assert.strictEqual(states[0], 'connecting');
    assert.ok(!states.slice(1).includes('connecting'), 'after the first connection every wait is shown as reconnecting');

    // stop: closes, and never reconnects
    feed.stop();
    assert.deepStrictEqual(clock.pending(), []);
    assert.strictEqual(feed.getState().status, 'stopped');
    const sockets = FakeSocket.all.length;
    clock.advance(120000);
    await settle();
    assert.strictEqual(FakeSocket.all.length, sockets);
  }

  // ── a quiet connection is pinged, then dropped ──
  {
    const { opts, clock } = setup();
    const feed = stream.createMarketFeed(opts);
    feed.start();
    await settle();
    const sock = lastSocket();
    sock.open();
    clock.advance(T.PING_AFTER_MS);
    assert.strictEqual(sock.pings, 0);
    clock.advance(T.HEARTBEAT_MS);
    assert.strictEqual(sock.pings, 1, 'quiet for over 20 s: ping');
    sock.emit('pong');
    clock.advance(T.PING_AFTER_MS);
    assert.ok(!sock.terminated, 'a pong counts as life');
    sock.emit('ping'); // the server's own ping counts too
    clock.advance(T.PING_AFTER_MS);
    assert.ok(!sock.terminated);
    clock.advance(T.STALE_AFTER_MS);
    assert.ok(sock.terminated, 'no data and no pong for 45 s: dropped');
    assert.strictEqual(feed.getState().status, 'reconnecting');
    feed.stop();
  }

  // ── a rejected token: auth_failed, slow retry, retryNow ──
  {
    let reject = true;
    const { opts, clock } = setup();
    const feed = stream.createMarketFeed({ ...opts, authorize: async () => {
      if (reject) throw Object.assign(new Error('token rejected'), { code: 'UPSTOX_AUTH' });
      return 'wss://feed.example/ok';
    } });
    feed.start();
    await settle();
    assert.deepStrictEqual([feed.getState().status, feed.getState().reason], ['auth_failed', 'UPSTOX_AUTH']);
    assert.strictEqual(FakeSocket.all.length, 0);
    assert.deepStrictEqual(clock.pending(), [T.AUTH_RETRY_MS]);
    clock.advance(T.AUTH_RETRY_MS);
    await settle();
    assert.strictEqual(feed.getState().status, 'auth_failed', 'still refused: the status does not flicker');
    reject = false;
    feed.retryNow();
    await settle();
    lastSocket().open();
    assert.strictEqual(feed.getState().status, 'connected');
    assert.strictEqual(feed.getState().reason, null);
    assert.deepStrictEqual(clock.pending(), [], 'retryNow cancelled the pending slow retry');
    feed.stop();

    // any other authorize failure is an ordinary retry with backoff
    const s2 = setup();
    const feed2 = stream.createMarketFeed({ ...s2.opts, authorize: async () => { throw Object.assign(new Error('timeout'), { code: 'UPSTOX_TIMEOUT' }); } });
    feed2.start();
    await settle();
    assert.strictEqual(feed2.getState().status, 'reconnecting');
    assert.deepStrictEqual(s2.clock.pending(), [750]);
    feed2.stop();
  }

  // ── a slow authorize from before stop() must not open a socket afterwards ──
  {
    let release;
    const { opts } = setup();
    const feed = stream.createMarketFeed({ ...opts, authorize: () => new Promise(r => { release = r; }) });
    feed.start();
    feed.stop();
    release('wss://feed.example/late');
    await settle();
    assert.strictEqual(FakeSocket.all.length, 0);
  }

  // ── portfolio stream and the combined handle ──
  {
    const { opts } = setup();
    const both = stream.createUpstoxStream({ ...opts, portfolio: true });
    assert.ok(both.portfolio);
    const updates = [];
    both.portfolio.on('update', u => updates.push(u));
    both.start();
    await settle();
    assert.strictEqual(FakeSocket.all.length, 2, 'one socket per feed, both owned here');
    FakeSocket.all.forEach(s => s.open());
    FakeSocket.all[1].emit('message', Buffer.from(JSON.stringify({ update_type: 'order', order_id: '1', status: 'complete' })), false);
    FakeSocket.all[1].emit('message', Buffer.from('{broken'), false);
    assert.deepStrictEqual(updates, [{ update_type: 'order', order_id: '1', status: 'complete' }]);
    assert.strictEqual(both.getState().market.status, 'connected');
    assert.strictEqual(both.getState().portfolio.status, 'connected');
    both.stop();
    assert.ok(FakeSocket.all.every(s => s.readyState === 3));
    assert.strictEqual(stream.createUpstoxStream(opts).portfolio, null, 'off unless asked for');
  }

  console.log('stream checks passed');
})().catch(e => { console.error(e); process.exit(1); });
