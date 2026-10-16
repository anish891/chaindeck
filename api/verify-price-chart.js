// Tests for the price chart's data loading in public/js/price-chart.js. The module runs in Node with a minimal fake
// DOM; its two imports are replaced with stubs so the chart-analysis request can be controlled from here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const toUrl = src => 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = globalThis;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const elements = { signalsList: { innerHTML: '' } };
globalThis.document = {
  hidden: false,
  documentElement: {},
  getElementById: id => elements[id] || null,
  querySelectorAll: () => []
};

(async () => {
  const requests = [];
  globalThis.__fetchChart = (interval, expiry) => new Promise(resolve => requests.push({ interval, expiry, resolve }));
  const apiStub = toUrl('export const fetchChartAnalysis = (...a) => globalThis.__fetchChart(...a);');
  const utilStub = toUrl(fs.readFileSync(path.join(__dirname, '../public/js/ui-utils.js'), 'utf8'));
  const src = fs.readFileSync(path.join(__dirname, '../public/js/price-chart.js'), 'utf8')
    .replace("'./api-client.js'", `'${apiStub}'`)
    .replace("'./ui-utils.js'", `'${utilStub}'`);
  const chart = await import(toUrl(src));
  const tick = () => new Promise(r => setImmediate(r));
  const payload = interval => ({ interval, source: 'yahoo', volumeSource: 'none', spot: 1, candles: [], zones: [], signals: [], actionZones: [], patterns: [], backtest: null });

  chart.initPriceChart({ getExpiry: () => '13-Oct-2026' });
  chart.refreshPriceChart(true);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].interval, '5m');

  // The user switches to 1d while the 5m request is still loading. The 1d request cannot start yet (one at a time).
  chart.setChartTimeframe('1d');
  assert.strictEqual(requests.length, 1, 'only one request in flight');

  // The 5m answer arrives and is discarded as stale. Before the fix nothing asked for 1d after that, so the chart sat
  // on "Loading" until the next dashboard refresh (up to a minute with the market closed).
  requests[0].resolve(payload('5m'));
  await tick(); await tick();
  assert.strictEqual(requests.length, 2, 'the skipped 1d request is made as soon as the stale one finishes');
  assert.strictEqual(requests[1].interval, '1d');

  requests[1].resolve(payload('1d'));
  await tick(); await tick();
  assert.strictEqual(chart.currentChartSignals().interval, '1d', 'the 1d data is shown');
  assert.strictEqual(requests.length, 2, 'and nothing else is requested');

  // The pattern-history line under a signal was escaped twice, so any "&" or apostrophe in it showed as "&amp;".
  {
    const sig = {
      dir: 'bull', state: 'waiting', confirmed: true, grade: 'strong', score: 80, label: 'Hammer', age: 0,
      evidence: [], trigger: 100, invalidation: 90, target: null, rr: null,
      history: { hitRate: 0.6, baseline: 0.5, horizon: 12, n: 40, ci: { low: 0.45, high: 0.73 }, verdict: 'odd & rare' }
    };
    chart.setChartTimeframe('5m');
    requests[requests.length - 1].resolve({ ...payload('5m'), signals: [sig] });
    await tick(); await tick();
    const html = elements.signalsList.innerHTML;
    assert(html.includes('odd &amp; rare'), 'escaped once');
    assert(!html.includes('&amp;amp;'), 'not escaped twice');
  }

  console.log('price chart loading checks passed');
})().catch(err => { console.error(err); process.exit(1); });
