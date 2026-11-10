// Developer tool (not part of the server): re-download the index constituent lists and rewrite
// api/services/providers/constituents.json. Run it when an index is rebalanced (about twice a year), then commit.
//
//   node scripts/refresh-constituents.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const BASE = 'https://www.niftyindices.com/IndexConstituent/';
const OUT = path.join(__dirname, '../api/services/providers/constituents.json');

// index name (as used in services/market/market.js) -> CSV file
const FILES = {
  'NIFTY 50': 'ind_nifty50list.csv',
  'NIFTY BANK': 'ind_niftybanklist.csv',
  'NIFTY PRIVATE BANK': 'ind_nifty_privatebanklist.csv',
  'NIFTY PSU BANK': 'ind_niftypsubanklist.csv',
  'NIFTY FINANCIAL SERVICES': 'ind_niftyfinancelist.csv',
  'NIFTY IT': 'ind_niftyitlist.csv',
  'NIFTY AUTO': 'ind_niftyautolist.csv',
  'NIFTY FMCG': 'ind_niftyfmcglist.csv',
  'NIFTY PHARMA': 'ind_niftypharmalist.csv',
  'NIFTY HEALTHCARE INDEX': 'ind_niftyhealthcarelist.csv',
  'NIFTY METAL': 'ind_niftymetallist.csv',
  'NIFTY ENERGY': 'ind_niftyenergylist.csv',
  'NIFTY OIL & GAS': 'ind_niftyoilgaslist.csv',
  'NIFTY REALTY': 'ind_niftyrealtylist.csv',
  'NIFTY MEDIA': 'ind_niftymedialist.csv',
  'NIFTY CONSUMER DURABLES': 'ind_niftyconsumerdurableslist.csv',
  'NIFTY INFRASTRUCTURE': 'ind_niftyinfralist.csv'
};

const ISIN_RE = /^IN[A-Z0-9]{9}\d$/;

/** CSV text -> list of ISINs, or null if the file does not look like a constituent list. */
function parseConstituentCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const col = lines[0].split(',').map(h => h.trim().toLowerCase()).findIndex(h => h.startsWith('isin'));
  if (col === -1) return null;
  const isins = [];
  for (const line of lines.slice(1)) {
    const v = (line.split(',')[col] || '').trim().toUpperCase();
    if (ISIN_RE.test(v) && !isins.includes(v)) isins.push(v);
  }
  return isins.length ? isins : null;
}

(async () => {
  const lists = {};
  for (const [name, file] of Object.entries(FILES)) {
    const res = await fetch(BASE + file, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    lists[name] = res.ok ? parseConstituentCsv(await res.text()) : null;
    console.log(`${name}: ${lists[name] ? `${lists[name].length} stocks` : `FAILED (${res.status})`}`);
  }
  if (Object.values(lists).some(v => !v)) throw new Error('Some lists failed; constituents.json was left unchanged.');
  const asOf = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(OUT, `${JSON.stringify({ asOf, source: 'niftyindices.com index constituent CSV files', lists }, null, 1)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (as of ${asOf})`);
})().catch(err => { console.error(err.message); process.exit(1); });
