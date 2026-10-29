const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });
const express = require('express');
const { securityHeaders, rateLimit } = require('./security');

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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ChainDeck running on http://localhost:${PORT}`);
  });
}

module.exports = app;
