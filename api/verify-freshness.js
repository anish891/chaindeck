const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/freshness.js'), 'utf8');
  const { freshness, formatAge, candleLagSec, THRESHOLDS } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

  // colours follow the age while the market is open
  assert.strictEqual(freshness('chain', 30).level, 'ok');
  assert.strictEqual(freshness('chain', THRESHOLDS.chain.warn).level, 'warn');
  assert.strictEqual(freshness('chain', THRESHOLDS.chain.bad - 1).level, 'warn');
  assert.strictEqual(freshness('chain', THRESHOLDS.chain.bad).level, 'bad');
  assert.strictEqual(freshness('chain', 240).level, 'bad', 'the 4 minute stall you saw is red, not a quiet chip');

  // a leftover copy is always red, even if it is young, and says so
  const s = freshness('candles', 20, { stale: true });
  assert.strictEqual(s.level, 'bad');
  assert(/^stale /.test(s.text));
  assert.strictEqual(freshness('chain', 20, { stale: true, open: false }).level, 'bad', 'stale is red outside hours too');

  // closed market: neutral, not alarming
  assert.strictEqual(freshness('chain', 99999, { open: false }).level, 'idle');
  // missing data
  assert.deepStrictEqual(freshness('saved', 0, { hasData: false }), { level: 'bad', text: 'no data' });
  assert.deepStrictEqual(freshness('saved', 0, { hasData: false, open: false }), { level: 'idle', text: 'no data' });
  assert.strictEqual(freshness('chain', NaN).level, 'idle');
  assert.throws(() => freshness('nope', 1), /Unknown feed/);

  assert.strictEqual(formatAge(45), '45s');
  assert.strictEqual(formatAge(120), '2m');
  assert.strictEqual(formatAge(7200), '2.0h');
  assert.strictEqual(formatAge(-1), 'n/a');

  // candle lag: how far the latest bar's END is behind the clock
  const t0 = Date.UTC(2026, 9, 12, 4, 0);
  assert.strictEqual(candleLagSec({ lastBarT: t0 }, '5m', t0 + 2 * 60000), 0, 'a forming bar is current');
  assert.strictEqual(candleLagSec({ lastBarT: t0 }, '5m', t0 + 5 * 60000 + 130000), 130);
  assert.strictEqual(candleLagSec({ lastBarT: t0 }, '15m', t0 + 15 * 60000 + 60000), 60);
  assert.strictEqual(candleLagSec({ lastBarT: t0 }, '1d', t0), null, 'daily candles have no lag measure');
  assert.strictEqual(candleLagSec(null, '5m', t0), null);

  console.log('freshness checks passed');
})().catch(e => { console.error(e); process.exit(1); });
