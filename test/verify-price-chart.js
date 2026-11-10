// Tests for the price chart's data loading in public/js/price-chart.js. The module runs in Node with a minimal fake
// DOM; its imports are replaced with stubs so the chart-analysis request can be controlled from here.
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
  // The chart no longer fetches: it asks the stream to push an analysis (watch) and draws what arrives (onChartPush).
  const utilStub = toUrl(fs.readFileSync(path.join(__dirname, '../public/js/ui-utils.js'), 'utf8'));
  const raw = fs.readFileSync(path.join(__dirname, '../public/js/price-chart.js'), 'utf8');
  assert(!/\bfetch\(|api-client/.test(raw), 'price-chart.js makes no HTTP request');
  const src = raw
    .replace("'./ui-utils.js'", `'${utilStub}'`)
    .replace("'./conditional-stats.js'", `'${toUrl(fs.readFileSync(path.join(__dirname, '../public/js/conditional-stats.js'), 'utf8'))}'`);
  const chart = await import(toUrl(src));
  const payload = interval => ({ ok: true, interval, source: 'upstox', volumeSource: 'none', spot: 1, candles: [], zones: [], signals: [], actionZones: [], patterns: [], backtest: null });
  const push = (interval, extra = {}) => chart.onChartPush({ type: 'chart', interval, payload: { ...payload(interval), ...extra } });

  const watched = [];
  chart.initPriceChart({ getExpiry: () => '13-Oct-2026', watch: (interval, expiry) => watched.push(`${interval}|${expiry}`) });
  chart.refreshPriceChart();
  chart.refreshPriceChart();
  assert.deepStrictEqual(watched, ['5m|13-Oct-2026'], 'one subscription per timeframe and expiry, however often the page asks');

  // The user switches to 1d before the 5m analysis arrives: the subscription moves at once, and the late 5m push is ignored.
  chart.setChartTimeframe('1d');
  assert.deepStrictEqual(watched, ['5m|13-Oct-2026', '1d|13-Oct-2026']);
  push('5m');
  assert.strictEqual(chart.currentChartSignals(), null, 'an answer for the timeframe the user left is not drawn');
  push('1d');
  assert.strictEqual(chart.currentChartSignals().interval, '1d', 'the 1d data is shown');
  // a failed build never wipes a chart that is already on screen
  chart.onChartPush({ type: 'chart', interval: '1d', payload: { ok: false, error: 'Error building chart analysis' } });
  assert.strictEqual(chart.currentChartSignals().interval, '1d');
  assert.strictEqual(watched.length, 2, 'and nothing else is requested: the server pushes the next one');

  // The pattern-history line under a signal was escaped twice, so any "&" or apostrophe in it showed as "&amp;".
  {
    const sig = {
      dir: 'bull', state: 'waiting', confirmed: true, grade: 'strong', score: 80, label: 'Hammer', age: 0,
      evidence: [], trigger: 100, invalidation: 90, target: null, rr: null,
      history: { hitRate: 0.6, baseline: 0.5, horizon: 12, n: 40, ci: { low: 0.45, high: 0.73 }, verdict: 'odd & rare' }
    };
    chart.setChartTimeframe('5m');
    push('5m', { signals: [sig] });
    const html = elements.signalsList.innerHTML;
    assert(html.includes('odd &amp; rare'), 'escaped once');
    assert(!html.includes('&amp;amp;'), 'not escaped twice');
  }

  console.log('price chart loading checks passed');
})().catch(err => { console.error(err); process.exit(1); });
