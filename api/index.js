const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });
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

// Per-IP ceiling for all API calls: generous for a dashboard polling every few seconds, tight for abuse.
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ChainDeck running on http://localhost:${PORT}`);
  });
}

module.exports = app;
