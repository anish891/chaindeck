const { WebSocketServer } = require('ws');
const instruments = require('../providers/instruments');
const { isPlausibleExpiry } = require('../../middleware/security');

// The browser's one socket to the server (same origin, path /ws; /api/paper/ws for the paper app). Everything live reaches the page through it; the
// page never talks to Upstox and never sees the token.
//
// Page -> server (JSON):
//   { type: 'chain', symbol, expiry | null }            watch one option chain (the dashboard)
//   { type: 'ticks', symbol, expiry }                   only the price changes of one expiry (the paper app's order ticket)
//   { type: 'chart', interval, expiry | null }          watch the price chart's candles, levels and signals
//   { type: 'paper', accountId, symbol, expiry | null } watch the paper market and one account (owner only)
//   { type: 'deployments', on }                         watch live strategies (owner only)
//   { type: 'refresh' }                                 send the paper account again now (after placing an order)
//   { type: 'stop', channel }                           stop watching 'chain' | 'ticks' | 'chart' | 'paper' | 'deployments'
//
// Server -> page:
//   { type: 'status', status, stale, reason, lastTickAt, serverTime, segments }   feed connection; on change and every 5 s
//   { type: 'chain', symbol, expiry, payload }     payload = what GET /api/option-chain returns; about every 5 s
//   { type: 'ticks', symbol, expiry, t, spot, legs: [[strike, 'CE' | 'PE', ltp], ...] }   changed prices, at most every 250 ms
//   { type: 'chart', interval, payload }           payload = what GET /api/chart-analysis returns; every 15 s
//   { type: 'paper', accountId, symbol, expiry, market?, account? }   payloads of GET /api/paper/market and /api/paper/accounts/:id
//   { type: 'deployments', payload }               payload of GET /api/paper/deployments
//   { type: 'minute', t }                          the per-minute recorder ran: saved history has a new point
//   { type: 'error', channel, code, error }
//
// Pushes are batched on timers, so a burst of ticks costs one small message per 250 ms, not one per tick.

const CHAIN_MS = 5000;     // analytics are recomputed at most this often anyway
const TICK_MS = 250;
const CHART_MS = 15000;
const PAPER_MS = 5000;
const ACCOUNT_MS = 15000;  // an account read costs storage commands; orders only change on the minute or on the user's action
const STATUS_MS = 5000;
const PING_MS = 30000;
const MAX_CLIENTS = 16;
const OPEN = 1;
// The paper app connects under /api/paper because its session cookie is scoped to that path.
const PATHS = new Set(['/ws', '/api/paper/ws']);

function createGateway({
  feed, chainView, chartView = null, chartIntervals = new Set(['5m', '15m', '1d']), paperViews, legIndex, isOwner, accountIdRe,
  timers = { setInterval, clearInterval }, now = Date.now, log = console.error
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set();
  const groups = new Map();   // `${symbol}|${expiry || ''}` -> { symbol, expiry, resolved, legs, dirty: Map, spot, lastBuilt }
  let route = new Map();      // instrument key -> [{ group, strike, side }]  (index keys: side 'SPOT')
  const handles = [];
  let offTicks = null;
  let offStatus = null;

  const send = (client, msg) => {
    if (client.ws.readyState !== OPEN) return;
    try { client.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch (err) { log(`gateway: send failed: ${err.message}`); }
  };

  function statusMessage() {
    const s = feed.getState();
    const info = feed.marketInfo && feed.marketInfo();
    return { type: 'status', status: s.status, stale: s.stale, reason: s.reason || null, lastTickAt: s.lastTickAt || null, serverTime: now(), segments: info ? info.segmentStatus || null : null };
  }
  const broadcastStatus = () => { const text = JSON.stringify(statusMessage()); for (const c of clients) send(c, text); };

  const groupId = (symbol, expiry) => `${symbol}|${expiry || ''}`;
  const chainWatchers = id => [...clients].filter(c => c.chain === id);
  const watchers = id => [...clients].filter(c => c.chain === id || c.ticks === id); // everyone who gets this group's price changes
  const newGroup = (symbol, expiry) => ({ symbol, expiry, resolved: null, legs: null, dirty: new Map(), spot: null, touched: false, building: false });

  function rebuildRoutes() {
    const next = new Map();
    const add = (key, entry) => { if (!next.has(key)) next.set(key, []); next.get(key).push(entry); };
    for (const group of groups.values()) {
      add(instruments.getIndex(group.symbol).underlyingKey, { group, side: 'SPOT' });
      if (group.legs) for (const [key, [strike, side]] of group.legs) add(key, { group, strike, side });
    }
    route = next;
  }

  function dropUnwatchedGroups() {
    let changed = false;
    for (const id of groups.keys()) if (!watchers(id).length) { groups.delete(id); changed = true; }
    if (changed) rebuildRoutes();
  }

  function chainError(err) {
    if (err && err.code === 'BAD_EXPIRY') return { ok: false, error: 'Unknown expiry.', code: 'BAD_EXPIRY' };
    if (err && (err.code === 'UPSTOX_AUTH' || err.code === 'UPSTOX_NO_TOKEN')) return { ok: false, error: 'The Upstox token was rejected.', code: 'AUTH' };
    log(`gateway: chain build failed: ${err && err.message}`);
    return { ok: false, error: 'Error fetching option chain' }; // upstream detail stays in the server log
  }

  async function pushChain(group) {
    if (group.building || !chainWatchers(groupId(group.symbol, group.expiry)).length) return;
    group.building = true;
    let payload;
    try {
      payload = { ok: true, data: await chainView(group.symbol, group.expiry) };
    } catch (err) {
      payload = chainError(err);
    } finally {
      group.building = false;
    }
    if (payload.ok && payload.data.expiry !== group.resolved) {
      group.resolved = payload.data.expiry;
      group.legs = legIndex(group.symbol, group.resolved);
      rebuildRoutes();
    }
    const text = JSON.stringify({ type: 'chain', symbol: group.symbol, expiry: group.expiry, payload });
    for (const c of chainWatchers(groupId(group.symbol, group.expiry))) send(c, text);
  }

  function onTicks(ticks) {
    for (const tick of ticks) {
      const targets = route.get(tick.key);
      if (!targets) continue;
      for (const t of targets) {
        if (t.side === 'SPOT') t.group.spot = tick.ltp;
        else t.group.dirty.set(tick.key, [t.strike, t.side, tick.ltp]);
        t.group.touched = true;
      }
    }
  }

  function flushTicks() {
    for (const group of groups.values()) {
      if (!group.legs && group.resolved) { // the expiry was not subscribed upstream yet when this group was made
        group.legs = legIndex(group.symbol, group.resolved);
        if (group.legs) rebuildRoutes();
      }
      if (!group.touched) continue;
      group.touched = false;
      const legs = [...group.dirty.values()];
      group.dirty.clear();
      const text = JSON.stringify({ type: 'ticks', symbol: group.symbol, expiry: group.expiry, t: now(), spot: group.spot, legs });
      for (const c of watchers(groupId(group.symbol, group.expiry))) send(c, text);
    }
  }

  const failure = (err, fallback) => (err && err.code && err.message && /^[A-Z_]+$/.test(err.code) && !/^(UPSTOX|STREAM)/.test(err.code)
    ? { ok: false, code: err.code, error: err.message }
    : (log(`gateway: ${fallback}: ${err && err.message}`), { ok: false, error: fallback }));

  async function pushPaper(client, { account = false } = {}) {
    const p = client.paper;
    if (!p) return;
    const msg = { type: 'paper', accountId: p.accountId, symbol: p.symbol, expiry: p.expiry };
    try { msg.market = await paperViews.market(p.expiry, p.symbol); } catch (err) { msg.market = failure(err, 'Error loading paper market'); }
    if (account || now() - p.accountAt >= ACCOUNT_MS) {
      p.accountAt = now();
      try { msg.account = await paperViews.account(p.accountId); } catch (err) { msg.account = failure(err, 'Error reading paper account'); }
    }
    if (client.paper === p) send(client, msg);
  }

  async function pushChart(client) {
    const c = client.chart;
    if (!c || !chartView) return;
    let payload;
    try { payload = { ok: true, ...(await chartView(c.interval, c.expiry)) }; } catch (err) { log(`gateway: chart build failed: ${err && err.message}`); payload = { ok: false, error: 'Error building chart analysis' }; }
    if (client.chart === c) send(client, { type: 'chart', interval: c.interval, payload });
  }

  async function pushDeployments(client) {
    if (!client.deployments) return;
    let payload;
    try { payload = await paperViews.deployments(); } catch (err) { payload = failure(err, 'Error listing deployments'); }
    send(client, { type: 'deployments', payload });
  }

  function onMessage(client, text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const owner = () => {
      if (isOwner(client.req)) return true;
      send(client, { type: 'error', channel: m.type, code: 'SIGNED_OUT', error: 'Sign in to use paper trading.' });
      return false;
    };
    const symbol = instruments.isSymbol(m.symbol || 'NIFTY') ? String(m.symbol || 'NIFTY').toUpperCase() : null;
    const expiry = m.expiry === undefined || m.expiry === null || m.expiry === '' ? null : m.expiry;
    const badTarget = !symbol || (expiry !== null && !isPlausibleExpiry(expiry));

    if (m.type === 'chain') {
      if (badTarget) return send(client, { type: 'error', channel: 'chain', code: 'BAD_REQUEST', error: 'Unknown index or expiry.' });
      const id = groupId(symbol, expiry);
      client.chain = id;
      if (!groups.has(id)) groups.set(id, newGroup(symbol, expiry));
      dropUnwatchedGroups();
      rebuildRoutes();
      pushChain(groups.get(id));
    } else if (m.type === 'ticks') {
      if (badTarget || expiry === null) return send(client, { type: 'error', channel: 'ticks', code: 'BAD_REQUEST', error: 'Unknown index or expiry.' });
      const id = groupId(symbol, expiry);
      client.ticks = id;
      if (!groups.has(id)) groups.set(id, { ...newGroup(symbol, expiry), resolved: expiry, legs: legIndex(symbol, expiry) });
      dropUnwatchedGroups();
      rebuildRoutes();
    } else if (m.type === 'chart') {
      if (!chartIntervals.has(m.interval) || (expiry !== null && !isPlausibleExpiry(expiry))) return send(client, { type: 'error', channel: 'chart', code: 'BAD_REQUEST', error: 'Unknown interval or expiry.' });
      client.chart = { interval: m.interval, expiry };
      pushChart(client);
    } else if (m.type === 'paper') {
      if (!owner()) return undefined;
      if (badTarget || !accountIdRe.test(String(m.accountId || ''))) return send(client, { type: 'error', channel: 'paper', code: 'BAD_REQUEST', error: 'Unknown account, index or expiry.' });
      client.paper = { accountId: m.accountId, symbol, expiry, accountAt: 0 };
      pushPaper(client, { account: true });
    } else if (m.type === 'deployments') {
      if (!owner()) return undefined;
      client.deployments = m.on !== false;
      pushDeployments(client);
    } else if (m.type === 'refresh') {
      if (client.paper && owner()) pushPaper(client, { account: true });
      if (client.deployments) pushDeployments(client);
    } else if (m.type === 'stop') {
      if (m.channel === 'chain') { client.chain = null; dropUnwatchedGroups(); }
      else if (m.channel === 'ticks') { client.ticks = null; dropUnwatchedGroups(); }
      else if (m.channel === 'chart') client.chart = null;
      else if (m.channel === 'paper') client.paper = null;
      else if (m.channel === 'deployments') client.deployments = false;
    }
    return undefined;
  }

  wss.on('connection', (ws, req) => {
    const client = { ws, req, chain: null, ticks: null, chart: null, paper: null, deployments: false, alive: true };
    clients.add(client);
    send(client, statusMessage());
    ws.on('message', (data, isBinary) => { if (!isBinary) onMessage(client, data.toString()); });
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => { clients.delete(client); dropUnwatchedGroups(); });
  });

  function every(ms, fn) {
    const h = timers.setInterval(fn, ms);
    if (h && typeof h.unref === 'function') h.unref();
    handles.push(h);
  }

  return {
    /** Serve /ws on this HTTP server. Anything else asking to upgrade, or another origin, is refused. */
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        const path = String(req.url || '').split('?')[0];
        const origin = req.headers.origin;
        let sameOrigin = true;
        if (origin) { try { sameOrigin = new URL(origin).host === req.headers.host; } catch (e) { sameOrigin = false; } }
        if (!PATHS.has(path) || !sameOrigin || clients.size >= MAX_CLIENTS) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      });
      offTicks = feed.on('ticks', onTicks);
      offStatus = feed.on('status', broadcastStatus);
      every(TICK_MS, flushTicks);
      every(CHAIN_MS, () => { for (const g of groups.values()) pushChain(g); });
      every(CHART_MS, () => { for (const c of clients) pushChart(c); });
      every(PAPER_MS, () => { for (const c of clients) pushPaper(c); });
      every(ACCOUNT_MS, () => { for (const c of clients) pushDeployments(c); });
      every(STATUS_MS, broadcastStatus);
      every(PING_MS, () => {
        for (const c of clients) {
          if (!c.alive) { c.ws.terminate(); continue; }
          c.alive = false;
          try { c.ws.ping(); } catch (e) { /* closing */ }
        }
      });
    },
    /** The per-minute scheduler just ran: saved history has a new point. Pages re-read what they show from it. */
    minuteTicked() {
      const text = JSON.stringify({ type: 'minute', t: now() });
      for (const c of clients) send(c, text);
    },
    /** The paper engine just ran: accounts and deployments may have changed. */
    paperTicked() {
      for (const c of clients) { pushPaper(c, { account: true }); pushDeployments(c); }
    },
    clientCount: () => clients.size,
    _internals: { onMessage, onTicks, flushTicks, pushChain, groups, clients, wss },
    close() {
      for (const h of handles) timers.clearInterval(h);
      handles.length = 0;
      if (offTicks) offTicks();
      if (offStatus) offStatus();
      for (const c of clients) { try { c.ws.close(1001); } catch (e) { /* gone */ } }
      clients.clear();
      wss.close();
    }
  };
}

module.exports = { createGateway, CHAIN_MS, TICK_MS };
