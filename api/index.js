const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });
const http = require('http');
const express = require('express');
const { securityHeaders, rateLimit, PUBLIC_ERRORS } = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by'); // don't advertise the framework
app.use(securityHeaders);

// Paper trading app (owner only: every call it makes needs the owner session). It is a built React app in public/paper.
// The old static page lived at /paper.html; bookmarks to it still work.
app.get('/paper.html', (req, res) => res.redirect(308, '/paper'));
app.get('/paper', (req, res) => res.sendFile(path.join(__dirname, '../public/paper/index.html')));

// Serve static frontend files (same origin as the API, so no CORS is needed or allowed)
app.use(express.static(path.join(__dirname, '../public')));

// Per-IP ceiling for all API calls: generous for a dashboard, tight for abuse.
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 240, name: 'api' }));

// Mount API routes
const apiRoutes = require('./routes');
app.use('/api', apiRoutes);

// An API path nobody handles answers in the API's own shape, not Express's HTML page.
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

// Last resort for anything a route did not catch (a malformed URL, a body-parser error, a bug). Express's own handler
// would send the stack trace whenever NODE_ENV is not "production"; this one logs it and sends a generic message.
// eslint-disable-next-line no-unused-vars -- Express recognises an error handler by its four arguments
app.use((err, req, res, next) => {
  if (res.headersSent) return req.socket.destroy();
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('unhandled request error:', err && err.stack ? err.stack : err);
  return res.status(status).json({ ok: false, error: PUBLIC_ERRORS[status] || PUBLIC_ERRORS[400] });
});

/**
 * The long-running parts: the Upstox stream, the browser socket and the per-minute scheduler. They need a process that
 * stays up, so they start only when this file is run (`npm start`), never when the app is merely imported (tests).
 */
function startServer(port = PORT) {
  const { getStream } = require('./services/stream/upstoxStream');
  const liveChain = require('./services/stream/liveChain');
  const candles = require('./services/market/candles');
  const { createGateway } = require('./services/stream/gateway');
  const { createScheduler } = require('./services/scheduler');
  const { chainView, chartView, CHART_INTERVALS } = require('./services/market/chainView');
  const { isPaperOwner, clientIp } = require('./middleware/security');
  const paperRoutes = require('./routes/paper');

  // This process holds the market data socket and every browser's socket. A promise nobody awaited must not take all of
  // that down (Node's default is to exit), so it is logged instead.
  process.on('unhandledRejection', err => console.error('unhandled rejection:', err && err.stack ? err.stack : err));
  paperRoutes.loadSessionEpoch(); // so a session ended by "sign out everywhere" stays ended across a restart

  const stream = getStream();
  const server = http.createServer(app);
  const gateway = createGateway({
    feed: stream.market, chainView, chartView, chartIntervals: CHART_INTERVALS, paperViews: paperRoutes.views, legIndex: liveChain.legIndex,
    isOwner: isPaperOwner, accountIdRe: paperRoutes.ID_RE, clientIp
  });
  const scheduler = createScheduler({
    onTick: ran => {
      if (ran.some(name => name.startsWith('snapshot'))) gateway.minuteTicked();
      if (ran.includes('paper')) gateway.paperTicked();
    }
  });

  stream.market.on('status', s => console.log(`upstox feed: ${s.status}${s.reason ? ` (${s.reason})` : ''}`));
  gateway.attach(server);
  candles.startLive();
  stream.start();
  scheduler.start();
  server.listen(port, () => console.log(`ChainDeck running on http://localhost:${port}`));

  let closing = false;
  const shutdown = signal => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: closing sockets`);
    scheduler.stop();
    gateway.close();
    candles.stopLive();
    liveChain.live().stop();
    stream.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); // open keep-alive connections must not hold the exit
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { server, gateway, scheduler, stream, shutdown };
}

if (require.main === module) startServer();

module.exports = app;
module.exports.startServer = startServer;
