// The page's one connection to the server, and the store the UI reads the connection state from.
// Both the dashboard and the paper app use this module; nothing else in the browser opens a socket or polls.
//
//   const stream = createStream();                    // connects, reconnects with backoff, resubscribes
//   stream.watch({ type: 'chain', symbol, expiry });  // one subscription per channel; replayed after every reconnect
//   stream.on('chain', msg => ...);                   // messages by type: chain, ticks, paper, deployments, minute, error
//   stream.subscribe(state => ...);                   // connection state changes
//   stream.getState()   -> { status, stale, reason, lastTickAt, lastMessageAt, segments }
//
// status is what the user is told:
//   'connecting'    first connection in progress
//   'connected'     the socket is open and the server's Upstox feed is live
//   'reconnecting'  either link is down and being retried; values on screen are the last known ones (stale = true)
//   'auth'          Upstox rejected the server's token: it has to be replaced (stale = true)
//   'offline'       the browser has no network (stale = true)
// There is no HTTP fallback: while stale, the page keeps the last values and marks them.

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15000;
const QUIET_MS = 15000; // the server sends its status every 5 s; three missed in a row means the socket is dead
const CHECK_MS = 5000;

export function deriveStatus({ everConnected, socketOpen, online, feed }) {
  if (!online) return 'offline';
  if (!socketOpen) return everConnected ? 'reconnecting' : 'connecting';
  if (!feed) return 'connecting';
  if (feed.status === 'connected') return 'connected';
  if (feed.status === 'auth_failed') return 'auth';
  return 'reconnecting';
}

export function createStream({
  path = '/ws',
  url = null,
  WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null,
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  now = Date.now,
  random = Math.random,
  timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id), setInterval: (f, ms) => setInterval(f, ms), clearInterval: id => clearInterval(id) }
} = {}) {
  const listeners = new Set();
  const handlers = new Map(); // message type -> Set(fn)
  const watching = new Map(); // channel -> subscription message
  let ws = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let everConnected = false;
  let feed = null;
  let lastMessageAt = 0;
  let state = null;

  const target = () => {
    if (url) return url;
    const loc = win.location;
    return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${path}`;
  };
  const online = () => !(win && win.navigator && win.navigator.onLine === false);
  const socketOpen = () => Boolean(ws && ws.readyState === 1);

  function compute() {
    const status = deriveStatus({ everConnected, socketOpen: socketOpen(), online: online(), feed });
    return {
      status,
      stale: status !== 'connected',
      reason: feed ? feed.reason || null : null,
      lastTickAt: feed ? feed.lastTickAt || null : null,
      lastMessageAt: lastMessageAt || null,
      segments: feed ? feed.segments || null : null
    };
  }

  function publish() {
    const next = compute();
    if (state && next.status === state.status && next.lastTickAt === state.lastTickAt && next.reason === state.reason && next.lastMessageAt === state.lastMessageAt) return;
    state = next;
    for (const fn of [...listeners]) { try { fn(state); } catch (e) { console.error(e); } }
  }

  function emit(type, msg) {
    const set = handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) { try { fn(msg); } catch (e) { console.error(e); } }
  }

  function rawSend(msg) {
    if (!socketOpen()) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    attempt += 1;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    retryTimer = timers.setTimeout(() => { retryTimer = null; connect(); }, ceiling / 2 + random() * (ceiling / 2));
  }

  function connect() {
    if (closed || ws || !WebSocketImpl || !win) return; // nothing to connect with (rendered outside a browser)
    let sock;
    try { sock = new WebSocketImpl(target()); } catch (e) { scheduleRetry(); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      everConnected = true;
      lastMessageAt = now();
      for (const msg of watching.values()) rawSend(msg); // everything watched is asked for again
      publish();
    };
    sock.onmessage = ev => {
      if (ws !== sock) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      lastMessageAt = now();
      attempt = 0;
      if (msg.type === 'status') feed = msg;
      else if (msg.type === 'ticks' && feed) feed = { ...feed, lastTickAt: msg.t };
      emit(msg.type, msg);
      publish();
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      publish();
      scheduleRetry();
    };
    publish();
  }

  function retryNow() {
    if (closed || socketOpen()) return;
    timers.clearTimeout(retryTimer);
    retryTimer = null;
    if (ws) { const dead = ws; ws = null; try { dead.close(); } catch (e) { /* already closed */ } }
    connect();
  }

  // a socket that has gone quiet without closing (sleeping laptop, dropped Wi-Fi) is replaced
  const watchdog = !WebSocketImpl || !win ? null : timers.setInterval(() => {
    if (socketOpen() && now() - lastMessageAt > QUIET_MS) {
      const dead = ws;
      ws = null;
      try { dead.close(); } catch (e) { /* already closed */ }
      publish();
      scheduleRetry();
    }
  }, CHECK_MS);

  const onOnline = () => { publish(); retryNow(); };
  const onOffline = () => publish();
  const onVisible = () => { if (doc && !doc.hidden) retryNow(); };
  if (win && win.addEventListener) {
    win.addEventListener('online', onOnline);
    win.addEventListener('offline', onOffline);
  }
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisible);

  state = compute();
  connect();

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    /** Watch a channel ({ type: 'chain' | 'paper' | 'deployments', ... }). Replaces what that channel watched before. */
    watch(msg) {
      watching.set(msg.type, msg);
      rawSend(msg);
    },
    unwatch(channel) {
      if (!watching.delete(channel)) return;
      rawSend({ type: 'stop', channel });
    },
    send: rawSend,
    retryNow,
    close() {
      closed = true;
      timers.clearTimeout(retryTimer);
      timers.clearInterval(watchdog);
      if (win && win.removeEventListener) {
        win.removeEventListener('online', onOnline);
        win.removeEventListener('offline', onOffline);
      }
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisible);
      const sock = ws;
      ws = null;
      if (sock) { try { sock.close(); } catch (e) { /* already closed */ } }
      listeners.clear();
      handlers.clear();
    }
  };
}

/** What the status indicator says for each state. */
export const STATUS_TEXT = {
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Reconnecting… showing last known values',
  auth: 'Upstox token rejected',
  offline: 'Offline · showing last known values'
};

/** '10:15:07' in the viewer's local time, or '' when there has been no tick. */
export function tickTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
