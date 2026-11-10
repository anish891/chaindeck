const path = require('path');
const { EventEmitter } = require('events');
const protobuf = require('protobufjs');
const upstox = require('../providers/upstox');

// The one place that opens Upstox WebSockets. Nothing else in the app may open a socket to Upstox.
//
//   market     Market Data Feed v3 (protobuf): subscribe by instrument key and mode, latest tick per key
//   portfolio  Portfolio Stream (JSON): order / position / holding updates. Off unless asked for: ChainDeck's paper
//              trading is simulated, so nothing here reads real orders.
//
// Both run on the same connection loop:
//   authorize (the only HTTP call: it turns the access token into a single-use wss:// URL) -> connect -> on close,
//   wait (exponential backoff with jitter) -> authorize again -> connect -> resubscribe everything.
// A connection that has gone quiet is pinged, and dropped if it stays quiet. A rejected token is reported as
// `auth_failed` (the UI asks for a new token) and retried slowly. There is no HTTP fallback: while the socket is down
// the last known values stay available and `getState().stale` is true.

const PROTO_PATH = path.join(__dirname, 'MarketDataFeed.proto');
const FEED_TYPE = 'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse';

// Keys per connection (Upstox, normal plan): `alone` when every subscription uses one mode, `combined` when modes are mixed.
const LIMITS = {
  ltpc: { alone: 5000, combined: 2000 },
  option_greeks: { alone: 3000, combined: 2000 },
  full: { alone: 2000, combined: 1500 }
};
const MODE_RANK = { ltpc: 1, option_greeks: 2, full: 3 };
const MODES = Object.keys(MODE_RANK);
const WIRE_MODE = { ltpc: 'ltpc', option_greeks: 'option_greeks', full_d5: 'full', full_d30: 'full' };

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const AUTH_RETRY_MS = 5 * 60 * 1000; // a rejected token will not fix itself quickly; still retried in case the 401 was transient
const HEARTBEAT_MS = 10000;
const PING_AFTER_MS = 20000;         // quiet this long: ask the server for a pong
const STALE_AFTER_MS = 45000;        // still quiet: the connection is dead, drop it and reconnect
const SUB_CHUNK = 500;               // instrument keys per request frame
const OPEN = 1;

const AUTH_CODES = new Set(['UPSTOX_AUTH', 'UPSTOX_NO_TOKEN']);
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

function streamError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

let feedType = null;
/** Decode one binary Market Data Feed message into a plain object (numbers for int64, names for enums). */
function decodeFeed(buf) {
  if (!feedType) feedType = protobuf.loadSync(PROTO_PATH).lookupType(FEED_TYPE);
  return feedType.toObject(feedType.decode(buf), { longs: Number, enums: String, defaults: true });
}

/**
 * One instrument's feed entry, flattened:
 *   { key, mode, receivedAt, ltp, ltt, ltq, cp }                       every mode (cp = previous close)
 *   + { oi, iv, vtt, greeks, depth }                                   option_greeks (depth = best bid/ask only)
 *   + { atp, tbq, tsq, depth (5 levels), ohlc: { '1d', 'I1' } }        full (an index has only ohlc)
 * Upstox sends 0 for a value it does not have (e.g. iv on a deep in-the-money option), so 0 means "unknown" there.
 * null when the entry carries no price at all.
 */
function toTick(key, feed, receivedAt) {
  const full = feed.fullFeed ? (feed.fullFeed.marketFF || feed.fullFeed.indexFF) : null;
  const src = full || feed.firstLevelWithGreeks || null;
  const ltpc = feed.ltpc || (src && src.ltpc) || null;
  if (!ltpc) return null;
  const tick = { key, mode: WIRE_MODE[feed.requestMode] || 'ltpc', receivedAt, ltp: ltpc.ltp, ltt: ltpc.ltt, ltq: ltpc.ltq, cp: ltpc.cp };
  if (!src) return tick;
  for (const f of ['oi', 'iv', 'vtt', 'atp', 'tbq', 'tsq']) if (src[f] !== undefined && src[f] !== null) tick[f] = src[f];
  if (src.optionGreeks) tick.greeks = src.optionGreeks;
  if (src.marketLevel) tick.depth = src.marketLevel.bidAskQuote || [];
  else if (src.firstDepth) tick.depth = [src.firstDepth];
  if (src.marketOHLC) {
    tick.ohlc = {};
    for (const c of src.marketOHLC.ohlc || []) tick.ohlc[c.interval] = c;
  }
  return tick;
}

/**
 * Keeps one WebSocket alive. `authorize()` resolves to a fresh wss:// URL for every attempt.
 * Statuses: idle -> connecting -> connected -> reconnecting -> connected ... ; auth_failed; stopped.
 */
function connectionLoop({
  name, authorize, onOpen, onMessage, onStatus,
  WebSocketImpl, timers = realTimers, now = Date.now, random = Math.random, log = console.error
}) {
  let status = 'idle';
  let reason = null;
  let ws = null;
  let stopped = true;
  let attempt = 0;        // failed attempts since the last message; drives the backoff
  let generation = 0;     // bumps on every connect and on stop, so a slow authorize from an old attempt is ignored
  let reconnectTimer = null;
  let heartbeat = null;
  let lastActivity = 0;
  let connectedAt = 0;

  function setStatus(next, why = null) {
    if (status === next && reason === why) return;
    status = next;
    reason = why;
    onStatus(status, reason);
  }

  function backoffMs() {
    attempt += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return ceiling / 2 + random() * (ceiling / 2); // jitter: between half and all of the ceiling
  }

  function schedule(ms) {
    timers.clearTimeout(reconnectTimer);
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; connect(); }, ms);
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref(); // never the reason a process stays alive
  }

  function stopHeartbeat() {
    timers.clearInterval(heartbeat);
    heartbeat = null;
  }

  function startHeartbeat(sock) {
    stopHeartbeat();
    heartbeat = timers.setInterval(() => {
      const quiet = now() - lastActivity;
      if (quiet > STALE_AFTER_MS) {
        log(`${name}: no data or pong for ${Math.round(quiet / 1000)} s, dropping the connection`);
        try { sock.terminate(); } catch (e) { /* the close handler reconnects */ }
      } else if (quiet > PING_AFTER_MS) {
        try { sock.ping(); } catch (e) { /* a dead socket is caught by the stale check */ }
      }
    }, HEARTBEAT_MS);
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  async function connect() {
    if (stopped) return;
    const mine = ++generation;
    if (status !== 'auth_failed') setStatus(connectedAt || attempt ? 'reconnecting' : 'connecting');
    let url;
    try {
      url = await authorize();
    } catch (err) {
      if (stopped || mine !== generation) return;
      if (AUTH_CODES.has(err.code)) {
        log(`${name}: authorize refused (${err.code})`);
        setStatus('auth_failed', err.code);
        schedule(AUTH_RETRY_MS);
      } else {
        log(`${name}: authorize failed: ${err.message}`);
        setStatus('reconnecting');
        schedule(backoffMs());
      }
      return;
    }
    if (stopped || mine !== generation) return;

    const sock = new WebSocketImpl(url, { followRedirects: true });
    ws = sock;
    const touch = () => { if (ws === sock) lastActivity = now(); };
    sock.on('open', () => {
      if (ws !== sock) return;
      lastActivity = connectedAt = now();
      setStatus('connected');
      startHeartbeat(sock);
      onOpen();
    });
    sock.on('message', (data, isBinary) => {
      if (ws !== sock) return;
      lastActivity = now();
      attempt = 0; // only real data resets the backoff, so an accept-then-drop server is not hammered
      onMessage(data, isBinary);
    });
    sock.on('ping', touch); // ws answers with a pong by itself
    sock.on('pong', touch);
    sock.on('error', err => log(`${name}: socket error: ${err && err.message}`)); // 'close' always follows
    sock.on('close', () => {
      if (ws !== sock) return;
      ws = null;
      stopHeartbeat();
      if (stopped) return;
      setStatus('reconnecting');
      schedule(backoffMs());
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      generation += 1;
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopHeartbeat();
      const sock = ws;
      ws = null;
      if (sock) { try { sock.close(1000); } catch (e) { /* already gone */ } }
      setStatus('stopped');
    },
    /** Try again now instead of waiting out the backoff (e.g. after the token was replaced). */
    retryNow() {
      if (stopped || ws) return;
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connect();
    },
    send(payload) {
      if (!ws || ws.readyState !== OPEN) return false;
      ws.send(payload);
      return true;
    },
    isOpen: () => Boolean(ws && ws.readyState === OPEN),
    state: () => ({ status, reason, connectedAt: connectedAt || null, lastActivityAt: lastActivity || null })
  };
}

const defaultMarketAuthorize = async () => wssUrl(await upstox.get('/v3/feed/market-data-feed/authorize'));
const defaultPortfolioAuthorize = async () => wssUrl(await upstox.get('/v2/feed/portfolio-stream-feed/authorize', { update_types: ['order', 'position', 'holding'] }));

function wssUrl(data) {
  const url = data && data.authorized_redirect_uri;
  if (typeof url !== 'string' || !url.startsWith('wss://')) throw streamError('STREAM_BAD_AUTHORIZE', 'authorize did not return a wss:// URL');
  return url;
}

/**
 * Market Data Feed v3.
 *   subscribe(keys, mode) -> unsubscribe()   reference counted; a key wanted in several modes gets the richest one
 *   get(key) / on('ticks', ticks => ...)     latest tick per key / every batch as it arrives
 *   on('status', state => ...)               connection changes
 *   on('marketInfo', info => ...)            exchange segment status (open, closed, pre-open)
 */
function createMarketFeed({ authorize = defaultMarketAuthorize, WebSocketImpl = require('ws'), decode = decodeFeed, timers, now = Date.now, random, log = console.error } = {}) {
  const emitter = new EventEmitter();
  const refs = new Map();   // key -> { ltpc, option_greeks, full } reference counts
  const sent = new Map();   // key -> mode the server currently has (emptied on every new connection)
  const latest = new Map(); // key -> last tick
  let marketInfo = null;
  let lastTickAt = null;
  let syncQueued = false;
  let seq = 0;

  const modeOf = counts => MODES.reduce((best, m) => (counts[m] > 0 && (!best || MODE_RANK[m] > MODE_RANK[best]) ? m : best), null);

  function desired() {
    const want = new Map();
    for (const [key, counts] of refs) {
      const mode = modeOf(counts);
      if (mode) want.set(key, mode);
    }
    return want;
  }

  function countByMode(want) {
    const counts = { ltpc: 0, option_greeks: 0, full: 0 };
    for (const mode of want.values()) counts[mode] += 1;
    return counts;
  }

  function checkLimits(want) {
    const counts = countByMode(want);
    const mixed = MODES.filter(m => counts[m] > 0).length > 1;
    for (const m of MODES) {
      const limit = mixed ? LIMITS[m].combined : LIMITS[m].alone;
      if (counts[m] > limit) throw streamError('STREAM_LIMIT', `${counts[m]} ${m} subscriptions exceed the limit of ${limit} per connection`);
    }
  }

  const frame = (method, mode, instrumentKeys) => {
    seq += 1;
    const data = method === 'unsub' ? { instrumentKeys } : { mode, instrumentKeys };
    return Buffer.from(JSON.stringify({ guid: `cd-${seq}`, method, data }));
  };

  function sendChunks(method, mode, keys) {
    for (let i = 0; i < keys.length; i += SUB_CHUNK) {
      if (!loop.send(frame(method, mode, keys.slice(i, i + SUB_CHUNK)))) return false;
    }
    return true;
  }

  /** Bring the server's subscriptions in line with what is wanted: unsubscribe first (frees room), then change, then add. */
  function sync() {
    if (!loop.isOpen()) return;
    const want = desired();
    const drop = [...sent.keys()].filter(k => !want.has(k));
    if (drop.length && sendChunks('unsub', null, drop)) for (const k of drop) sent.delete(k);
    for (const mode of MODES) {
      const change = [];
      const add = [];
      for (const [key, m] of want) {
        if (m !== mode) continue;
        if (!sent.has(key)) add.push(key);
        else if (sent.get(key) !== mode) change.push(key);
      }
      if (change.length && sendChunks('change_mode', mode, change)) for (const k of change) sent.set(k, mode);
      if (add.length && sendChunks('sub', mode, add)) for (const k of add) sent.set(k, mode);
    }
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => { syncQueued = false; sync(); }); // several subscribe calls in one turn become one set of frames
  }

  function onMessage(data, isBinary) {
    if (isBinary === false) return; // the feed is binary; nothing else is expected
    let msg;
    try {
      msg = decode(data);
    } catch (err) {
      log(`market feed: undecodable message (${err.message})`);
      return;
    }
    if (msg.marketInfo) {
      marketInfo = msg.marketInfo;
      emitter.emit('marketInfo', marketInfo);
    }
    const receivedAt = now();
    const ticks = [];
    for (const [key, feed] of Object.entries(msg.feeds || {})) {
      if (!refs.has(key)) continue; // a late message for something just unsubscribed
      const tick = toTick(key, feed, receivedAt);
      if (!tick) continue;
      latest.set(key, tick);
      ticks.push(tick);
    }
    if (ticks.length) {
      lastTickAt = receivedAt;
      emitter.emit('ticks', ticks);
    }
  }

  const getState = () => {
    const s = loop.state();
    const counts = countByMode(desired());
    return { ...s, stale: s.status !== 'connected', lastTickAt, subscriptions: counts };
  };

  const loop = connectionLoop({
    name: 'market feed', authorize, WebSocketImpl, timers, now, random, log,
    onOpen: () => { sent.clear(); sync(); },
    onMessage,
    onStatus: () => emitter.emit('status', getState())
  });

  function subscribe(keys, mode = 'ltpc') {
    if (!MODE_RANK[mode]) throw streamError('STREAM_BAD_MODE', `Unknown mode ${mode}`);
    const list = [...new Set((Array.isArray(keys) ? keys : [keys]).filter(k => typeof k === 'string' && k))];
    const bump = by => {
      for (const key of list) {
        const counts = refs.get(key) || { ltpc: 0, option_greeks: 0, full: 0 };
        counts[mode] += by;
        if (modeOf(counts)) refs.set(key, counts);
        else { refs.delete(key); latest.delete(key); }
      }
    };
    bump(1);
    try {
      checkLimits(desired());
    } catch (err) {
      bump(-1);
      throw err;
    }
    queueSync();
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      bump(-1);
      queueSync();
    };
  }

  return {
    start: loop.start,
    stop: loop.stop,
    retryNow: loop.retryNow,
    subscribe,
    get: key => latest.get(key) || null,
    marketInfo: () => marketInfo,
    getState,
    on: (event, fn) => { emitter.on(event, fn); return () => emitter.off(event, fn); }
  };
}

/** Portfolio Stream: emits each JSON update ({ update_type: 'order' | 'position' | 'holding', ... }) as 'update'. */
function createPortfolioFeed({ authorize = defaultPortfolioAuthorize, WebSocketImpl = require('ws'), timers, now = Date.now, random, log = console.error } = {}) {
  const emitter = new EventEmitter();
  let lastUpdateAt = null;
  const getState = () => {
    const s = loop.state();
    return { ...s, stale: s.status !== 'connected', lastUpdateAt };
  };
  const loop = connectionLoop({
    name: 'portfolio stream', authorize, WebSocketImpl, timers, now, random, log,
    onOpen: () => {}, // nothing to send: the update types are chosen at authorize time
    onMessage: data => {
      let update;
      try { update = JSON.parse(data.toString()); } catch (err) { log('portfolio stream: unreadable message'); return; }
      lastUpdateAt = now();
      emitter.emit('update', update);
    },
    onStatus: () => emitter.emit('status', getState())
  });
  return {
    start: loop.start,
    stop: loop.stop,
    retryNow: loop.retryNow,
    getState,
    on: (event, fn) => { emitter.on(event, fn); return () => emitter.off(event, fn); }
  };
}

/** Both feeds behind one handle. `portfolio` is null unless asked for. */
function createUpstoxStream({ portfolio = false, ...opts } = {}) {
  const market = createMarketFeed(opts);
  const port = portfolio ? createPortfolioFeed(opts) : null;
  return {
    market,
    portfolio: port,
    start() { market.start(); if (port) port.start(); },
    stop() { market.stop(); if (port) port.stop(); },
    getState: () => ({ market: market.getState(), portfolio: port ? port.getState() : null })
  };
}

let shared = null;
/** The process-wide stream (created on first use, not started). UPSTOX_PORTFOLIO_STREAM=true adds the portfolio feed. */
function getStream() {
  if (!shared) shared = createUpstoxStream({ portfolio: String(process.env.UPSTOX_PORTFOLIO_STREAM || '').toLowerCase() === 'true' });
  return shared;
}

module.exports = {
  getStream, createUpstoxStream, createMarketFeed, createPortfolioFeed,
  decodeFeed, toTick, LIMITS,
  _timing: { BACKOFF_BASE_MS, BACKOFF_MAX_MS, AUTH_RETRY_MS, HEARTBEAT_MS, PING_AFTER_MS, STALE_AFTER_MS }
};
