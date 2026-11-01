// Before the Open: the server's Yahoo quote parsing, lean and caching (api/services/premarket.js), and the browser's
// 07:15-09:15 window and render pass (public/js/premarket-panel.js) on a minimal fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pm = require('./services/premarket');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const load = f => import('data:text/javascript;base64,' + Buffer.from(read(f)).toString('base64'));
const ist = s => Date.parse(`${s}+05:30`);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

const meta = (price, prev) => ({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev, regularMarketTime: 1793500000 } }] } });
// Fake Yahoo: each symbol moves by the given percent; a missing symbol fails.
const fakeFetch = moves => async url => {
  const sym = decodeURIComponent(/chart\/([^?]+)/.exec(url)[1]);
  if (!(sym in moves)) throw new Error('network');
  return { json: async () => meta(100 * (1 + moves[sym] / 100), 100) };
};

(async () => {
  // ── parsing ──
  assert.deepStrictEqual(pm.parseQuote(meta(110, 100)), { price: 110, prevClose: 100, asOf: 1793500000000 });
  assert.strictEqual(pm.parseQuote({ chart: { result: null, error: { description: 'x' } } }), null);
  assert.strictEqual(pm.parseQuote(meta(0, 100)), null, 'a zero price is no quote');
  assert.strictEqual(pm.parseQuote(meta(100, null)), null, 'no previous close, no change');

  // ── lean: average of US futures and Asia, 0.3% either way ──
  const item = (pct, lean = true) => ({ lean, changePct: pct });
  assert.strictEqual(pm.cueLean([item(1), item(0.5), item(-0.2)]).label, 'positive');
  assert.strictEqual(pm.cueLean([item(-1), item(-0.5), item(0.2)]).label, 'negative');
  assert.strictEqual(pm.cueLean([item(0.2), item(-0.1), item(0.1)]).label, 'flat');
  assert.strictEqual(pm.cueLean([item(5), item(5)]).label, 'unknown', 'fewer than 3 overnight markets: no lean');
  assert.strictEqual(pm.cueLean([item(5, false), item(5, false), item(5, false)]).label, 'unknown', 'US close and macro do not count');
  const l = pm.cueLean([item(1), item(-1), item(2)]);
  assert.strictEqual(l.up, 2); assert.strictEqual(l.down, 1); near(l.avgPct, 0.667, 0.001, 'average');

  // ── build: one failing symbol does not sink the panel, all failing does ──
  const moves = Object.fromEntries(pm.CUES.map(c => [c.symbol, 1]));
  delete moves['^KS11'];
  const built = await pm.buildCues(fakeFetch(moves));
  const kospi = built.items.find(i => i.key === 'kospi');
  assert.strictEqual(kospi.price, null, 'a failed quote shows as n/a');
  near(built.items.find(i => i.key === 'es').changePct, 1, 1e-9, 'change vs previous close');
  assert.strictEqual(built.lean.count, 4, 'the failed market is left out of the lean');
  await assert.rejects(pm.buildCues(fakeFetch({})), /no pre-market quotes/);

  // ── cache: 2 minutes fresh, stale copy up to 15 minutes when Yahoo fails, then the error ──
  pm.clearCache();
  const t0 = Date.now();
  const first = await pm.getPremarket({ fetchImpl: fakeFetch(moves), nowMs: t0 });
  assert.strictEqual(first.stale, false);
  let calls = 0;
  const counting = async url => { calls += 1; return fakeFetch(moves)(url); };
  await pm.getPremarket({ fetchImpl: counting, nowMs: t0 + 60000 });
  assert.strictEqual(calls, 0, 'served from cache within 2 minutes');
  assert.strictEqual((await pm.getPremarket({ fetchImpl: fakeFetch({}), nowMs: t0 + 5 * 60000 })).stale, true, 'stale copy on failure');
  await assert.rejects(pm.getPremarket({ fetchImpl: fakeFetch({}), nowMs: t0 + 20 * 60000 }), /no pre-market quotes/, 'too old to show');
  pm.clearCache();

  // ── window: 120 minutes before the open on trading days ──
  const P = await load('public/js/premarket-panel.js');
  const holidays = new Set(['2026-11-10']);
  assert.strictEqual(P.inPremarketWindow(ist('2026-11-02T07:14:59'), holidays), false, 'not before 07:15');
  assert.strictEqual(P.inPremarketWindow(ist('2026-11-02T07:15:00'), holidays), true);
  assert.strictEqual(P.inPremarketWindow(ist('2026-11-02T09:14:00'), holidays), true);
  assert.strictEqual(P.inPremarketWindow(ist('2026-11-02T09:15:00'), holidays), false, 'gone at the open');
  assert.strictEqual(P.inPremarketWindow(ist('2026-11-01T08:00:00'), holidays), false, 'not on a Sunday');
  assert.strictEqual(P.inPremarketWindow(ist('2026-11-10T08:00:00'), holidays), false, 'not on an NSE holiday');
  assert.strictEqual(P.PREMARKET_TO_MIN - P.PREMARKET_FROM_MIN, 120);
  assert.strictEqual(P.minutesToOpen(ist('2026-11-02T07:15:00')), 120);
  assert.strictEqual(P.minutesToOpen(ist('2026-11-02T10:00:00')), 0);

  // ── render on a fake DOM: every state without throwing, no innerHTML ──
  const make = tag => {
    const node = {
      tag, className: '', children: [], _text: '',
      append(...kids) { kids.forEach(k => node.children.push(typeof k === 'string' ? { _text: k, children: [] } : k)); },
      get textContent() { return node._text + node.children.map(c => c.textContent ?? c._text).join(''); },
      set textContent(v) { node.children = []; node._text = String(v); }
    };
    return node;
  };
  global.document = { createElement: make };
  const host = make('div');
  P.renderPremarket(host, null);
  assert(/Loading/.test(host.textContent));
  P.renderPremarket(host, null, { error: true });
  assert(/unavailable/.test(host.textContent));
  P.renderPremarket(host, built, { nowMs: ist('2026-11-02T08:30:00') });
  const text = host.textContent;
  assert(/lean positive/.test(text) && /Open in 45 min/.test(text), text.slice(0, 200));
  assert(/S&P 500 futures/.test(text) && /\+1\.00%/.test(text) && /n\/a/.test(text), 'rows show the change and n/a for a failed quote');
  assert(/GIFT Nifty has no free source/.test(text), 'says plainly it is not an opening estimate');
  assert(!/innerHTML/.test(read('public/js/premarket-panel.js')), 'textContent only');

  // ── page wiring ──
  const html = read('public/index.html');
  assert(/<div id="premarketSection" class="section" hidden>/.test(html), 'hidden until the window opens');
  assert(/inPremarketWindow\(now, nseHolidays\)/.test(read('public/js/app.js')), 'the page fetches only inside the window');

  console.log('pre-market checks passed');
})().catch(e => { console.error(e); process.exit(1); });
