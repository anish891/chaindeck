// Index constituents (ISIN codes) for breadth: how many stocks in NIFTY 50, and in each sector index, are up or down.
// Upstox quotes stocks by ISIN (NSE_EQ|<ISIN>) but has no "advances/declines" for an index, so ChainDeck counts them itself.
//
// The lists are a file in the repo (constituents.json), not a download: the server fetches nothing over HTTP for them.
// They change about twice a year; run `node scripts/refresh-constituents.js` then and commit the result.

const data = require('./constituents.json');

/** { 'NIFTY 50': [isin, ...], 'NIFTY BANK': [...], ... } */
const getConstituents = () => data.lists;

module.exports = { getConstituents, asOf: data.asOf };
