// The paper trading app (React + TypeScript, built by Vite into public/paper).
// What this covers: the pure logic and the API client, every screen rendered on the server with fixture data, the rules the
// source must follow (no raw HTML, one network door, no third-party code), the built files, and the owner-only entry point
// on the dashboard. Nothing here needs a browser or the network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadPaperUi } = require('./lib/paperUi');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const walk = d => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

(async () => {
  const U = await loadPaperUi();
  const html = (C, props) => U.renderToStaticMarkup(U.createElement(C, props));
  const noop = () => {};

  // ── formatting ──
  assert.strictEqual(U.inr(1234.5), '₹1,234.50');
  assert.strictEqual(U.inr(-1234.5, true), '-₹1,234.50');
  assert.strictEqual(U.inr(1234.5, true), '+₹1,234.50');
  assert.strictEqual(U.inr(null), 'n/a'); assert.strictEqual(U.inr(NaN), 'n/a');
  assert.strictEqual(U.inr(1234567.891), '₹12,34,567.89', 'Indian digit grouping');
  assert.strictEqual(U.inrWhole(-1499.6), '-₹1,500');
  assert.strictEqual(U.px(0), 'n/a'); assert.strictEqual(U.px(12.3), '12.30');
  assert.strictEqual(U.pnlClass(5), 'pt-pos'); assert.strictEqual(U.pnlClass(-5), 'pt-neg'); assert.strictEqual(U.pnlClass(0), '');
  assert.strictEqual(U.pctText(0.456), '46%'); assert.strictEqual(U.pctText(null), 'n/a');
  assert.deepStrictEqual(U.instParts('NIFTY|03-Nov-2026|22700|PE'), { expiry: '03-Nov-2026', strike: 22700, optionType: 'PE' });
  assert.strictEqual(U.instLabel('NIFTY|03-Nov-2026|22700|CE'), '03 Nov 22700 CE');
  assert.strictEqual(U.instrumentKey('03-Nov-2026', 22700, 'CE'), 'NIFTY|03-Nov-2026|22700|CE');
  assert.strictEqual(U.todayIst(Date.UTC(2026, 9, 28, 20, 0)), '2026-10-29', '20:00 UTC is already the next day in India');
  assert.strictEqual(U.expiryCloseMs('03-Nov-2026'), Date.UTC(2026, 10, 3, 10, 0), '15:30 IST is 10:00 UTC');
  assert.strictEqual(U.statusText({ status: 'CANCELLED', statusReason: 'OCO_FILLED' }), 'cancelled (other leg filled)');
  assert.strictEqual(U.statusText({ status: 'FILLED' }), 'filled');
  assert.strictEqual(U.byText({ agent: { label: 'Claude' } }), 'Claude (agent)'); assert.strictEqual(U.byText({ source: 'strategy' }), 'strategy'); assert.strictEqual(U.byText({}), 'you');
  assert.strictEqual(U.shortExpiry('03-Nov-2026'), '03 Nov');

  // ── ticket logic ──
  const form = (o = {}) => ({ ...U.emptyForm(), ...o });
  const sel = { instrument: 'NIFTY|03-Nov-2026|22700|CE', side: 'BUY' };
  assert.deepStrictEqual(U.buildOrder(form(), sel), { instrument: sel.instrument, side: 'BUY', lots: 1, orderType: 'MARKET' });
  const lim = U.buildOrder(form({ type: 'LIMIT', limit: '101.456', lots: '3', note: '  why  ' }), sel);
  assert.strictEqual(lim.limitPrice, 101.46); assert.strictEqual(lim.lots, 3); assert.strictEqual(lim.reason, 'why');
  assert.strictEqual(lim.triggerPrice, undefined, 'a plain limit order has no trigger');
  const sl = U.buildOrder(form({ type: 'SL', limit: '99', trigger: '100' }), { ...sel, side: 'SELL' });
  assert.strictEqual(sl.limitPrice, 99); assert.strictEqual(sl.triggerPrice, 100); assert.strictEqual(sl.side, 'SELL');
  assert.strictEqual(U.buildOrder(form({ type: 'SL-M', trigger: '100', limit: '5' }), sel).limitPrice, undefined, 'SL-M ignores the limit field');
  assert.deepStrictEqual(U.buildOrder(form({ bracket: true, target: '150', stop: '' }), sel).bracket, { target: 150 });
  assert.strictEqual(U.buildOrder(form({ bracket: true, target: '', stop: '' }), sel).bracket, undefined, 'an empty bracket is not sent');
  assert.strictEqual(U.buildOrder(form({ bracket: false, target: '150' }), sel).bracket, undefined);
  const market = {
    asOf: Date.UTC(2026, 9, 28, 6, 0), spot: 22712, marketOpen: true, health: { ok: true }, expiries: ['03-Nov-2026', '10-Nov-2026'], expiry: '03-Nov-2026', lotSize: 65, atmStrike: 22700,
    strikes: [22650, 22700, 22750].map(k => ({ strike: k, CE: { ltp: 100 + (22700 - k) / 5, bid: 99, ask: 101, iv: 12 }, PE: { ltp: 90, bid: 89, ask: 91, iv: 13 } }))
  };
  assert.strictEqual(U.quoteFor(market, 'NIFTY|03-Nov-2026|22700|CE').ltp, 100);
  assert.strictEqual(U.quoteFor(market, 'NIFTY|10-Nov-2026|22700|CE'), null, 'another expiry is not in the loaded chain');
  assert.strictEqual(U.quoteFor(market, 'NIFTY|03-Nov-2026|99999|CE'), null);
  assert.strictEqual(U.quoteFor(null, 'x'), null);

  // ── strategy helpers ──
  assert.deepStrictEqual(U.defaultCondition('vix'), { type: 'vix', op: 'below', value: 15 });
  assert.strictEqual(U.CONDITION_ORDER.length, 7); assert(U.CONDITION_ORDER.every(t => U.CONDITION_LABELS[t] && U.defaultCondition(t).type === t));
  assert.deepStrictEqual(U.exitRule('pct', 30), { unit: 'pct', value: 30 });
  assert.strictEqual(U.exitRule('none', 30), null); assert.strictEqual(U.exitRule('pct', null), null); assert.strictEqual(U.exitRule('rupees', NaN), null);
  assert.strictEqual(U.numOrNull(''), null); assert.strictEqual(U.numOrNull(' '), null); assert.strictEqual(U.numOrNull('-1.5'), -1.5); assert.strictEqual(U.numOrNull('abc'), null);
  const b1 = U.blankStrategy(), b2 = U.cloneStrategy(b1);
  b2.legs[0].lots = 9; assert.strictEqual(b1.legs[0].lots, 1, 'cloning is deep');
  assert.strictEqual(U.offsetLabel(0), 'ATM'); assert.strictEqual(U.offsetLabel(3), 'ATM+3'); assert.strictEqual(U.offsetLabel(-2), 'ATM-2');
  assert(['edge', 'none', 'negative', 'insufficient'].every(v => U.VERDICT_TEXT[v] && U.VERDICT_TEXT[v].length === 3));

  // ── chart axis ticks ──
  assert.deepStrictEqual(U.niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepStrictEqual(U.niceTicks(-50, 150, 4), [-50, 0, 50, 100, 150]);
  assert.deepStrictEqual(U.niceTicks(5, 5), [5]); assert.deepStrictEqual(U.niceTicks(NaN, 5), []);
  assert(U.niceTicks(-3, 3).includes(0), 'zero is always a tick when it is in range');

  // ── agent prompt ──
  const prompt = U.agentPrompt('https://example.test', 'cdp_abcd1234_tok');
  assert(prompt.includes('https://example.test/api/paper/v1') && prompt.includes('Authorization: Bearer cdp_abcd1234_tok') && /reason/.test(prompt) && /Idempotency-Key/.test(prompt) && /AGENTS_PAUSED/.test(prompt));

  // ── payoff (same maths the server test pins; here: the module's contract) ──
  const ps = U.payoffSeries([{ strike: 22700, optionType: 'CE', qty: 65, avgPrice: 100, iv: 12 }], { spot: 22700, expiryMs: Date.now() + 7 * 864e5, nowMs: Date.now() });
  assert(ps.xs.length > 100 && ps.atExpiry.length === ps.xs.length && ps.today.length === ps.xs.length && ps.xs.every((x, i) => i === 0 || x >= ps.xs[i - 1]));
  assert.strictEqual(U.payoffSeries([], { spot: 1, expiryMs: 0, nowMs: 0 }), null);

  // ── API client: one door to the server ──
  {
    const calls = [];
    let reply = { status: 200, body: { ok: true, x: 1 } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (reply === 'network') throw new TypeError('network down');
      return { status: reply.status, json: async () => reply.body };
    };
    let signedOut = 0;
    U.setSignedOutHandler(() => { signedOut += 1; });
    try {
      let r = await U.api('/accounts');
      assert.strictEqual(r.ok, true); assert.strictEqual(r.x, 1); assert.strictEqual(r.status, 200);
      assert.strictEqual(calls[0].url, '/api/paper/accounts'); assert.strictEqual(calls[0].init.method, 'GET'); assert.strictEqual(calls[0].init.credentials, 'same-origin');
      assert.strictEqual(calls[0].init.body, undefined);
      r = await U.api('/accounts/a/orders', { method: 'POST', body: { lots: 1 } });
      assert.strictEqual(calls[1].init.method, 'POST'); assert.strictEqual(calls[1].init.headers['Content-Type'], 'application/json'); assert.strictEqual(calls[1].init.body, '{"lots":1}');
      r = await U.api('/session', { method: 'DELETE' });
      assert.strictEqual(calls[2].init.body, '{}', 'a body-less write still sends JSON (the server rejects other types)');
      reply = { status: 422, body: { ok: false, code: 'INSUFFICIENT_FUNDS', error: 'Not enough cash.' } };
      r = await U.api('/x', { method: 'POST' });
      assert.deepStrictEqual([r.ok, r.status, r.error, r.code], [false, 422, 'Not enough cash.', 'INSUFFICIENT_FUNDS']);
      assert.strictEqual(signedOut, 0);
      reply = { status: 401, body: { ok: false, code: 'SIGNED_OUT', error: 'Sign in to use paper trading.' } };
      r = await U.api('/accounts');
      assert.strictEqual(r.ok, false); assert.strictEqual(signedOut, 1, 'a SIGNED_OUT answer shows the sign-in form');
      reply = { status: 401, body: { ok: false, error: 'That secret is not right.' } };
      await U.api('/session', { method: 'POST', body: { secret: 'x' } });
      assert.strictEqual(signedOut, 1, 'a wrong secret at sign-in is not a sign-out');
      reply = { status: 200, body: { ok: false, error: { code: 'MARKET_CLOSED', message: 'The market is closed.' } } };
      r = await U.api('/accounts/a/orders/preview', { method: 'POST', body: {} });
      assert.deepStrictEqual([r.ok, r.error, r.code], [false, 'The market is closed.', 'MARKET_CLOSED'], 'the preview answers with an error object: its message must reach the screen');
      reply = 'network';
      r = await U.api('/accounts');
      assert.deepStrictEqual([r.ok, r.status], [false, 0]); assert(/reach the server/.test(r.error));
      reply = { status: 500, body: {} };
      r = await U.api('/accounts');
      assert.strictEqual(r.ok, false); assert(r.error, 'an error always has a message');
    } finally {
      globalThis.fetch = realFetch;
      U.setSignedOutHandler(null);
    }
  }

  // ── screens, rendered with fixture data ──
  const pos = { instrument: 'NIFTY|03-Nov-2026|22700|CE', expiry: '03-Nov-2026', strike: 22700, optionType: 'CE', qty: 130, avgPrice: 100, mark: 110, unrealized: 1300, realized: -250 };
  const order = (o = {}) => ({ id: 'O1', instrument: pos.instrument, side: 'BUY', lots: 2, orderType: 'LIMIT', limitPrice: 95, triggerPrice: null, status: 'OPEN', placedAt: Date.UTC(2026, 9, 28, 5, 0), ...o });
  const account = {
    agentsPaused: false,
    summary: { id: 'main', name: 'My account', startingCapital: 100000, cash: 85000, equity: 101300, margin: 12000, available: 73000, realized: -250, unrealized: 1300, charges: 80, spot: 22712, asOf: market.asOf, positions: [pos], openOrders: [order()] },
    orders: [order({ id: 'O2', status: 'FILLED', fillPrice: 96, reason: 'breakout <b>retest</b>', agent: { keyId: 'abcd1234', label: 'Claude' } }), order({ id: 'O3', status: 'CANCELLED', statusReason: 'END_OF_DAY' })],
    trades: [{ at: Date.UTC(2026, 9, 28, 5, 1), instrument: pos.instrument, side: 'BUY', qty: 130, price: 100, charges: 80, realized: 0, kind: 'fill', orderId: 'O2' }],
    curve: [{ ymd: '2026-10-26', equity: 100500 }, { ymd: '2026-10-27', equity: 101000 }]
  };

  {
    const strip = html(U.Strip, { account, market });
    assert(strip.includes('₹73,000.00') && strip.includes('22,712'), 'free cash and NIFTY are shown');
    assert(strip.includes('+₹1,300.00 (1.30%)'), 'total and percentage against starting capital');
    assert(!strip.includes('Charges') && !strip.includes('Realised') && !strip.includes('Margin used'), 'the strip keeps only what a trader checks at a glance');
    assert.strictEqual(html(U.Strip, { account: null, market }), '<div class="keystrip"></div>');
    assert.strictEqual(U.previousClose(account, Date.UTC(2026, 9, 28, 6, 0)), 101000, "the previous close is the last recorded day before today");
    assert.strictEqual(U.previousClose({ ...account, curve: [] }), 100000, 'a new account falls back to its starting capital');
    assert(html(U.Strip, { account, market: { ...market, health: { ok: false, reason: 'DATA_OLD' } } }).includes('ks-val stale'), 'stale prices are flagged in the strip');
    assert(!html(U.Strip, { account, market: { ...market, health: { ok: false, reason: 'MARKET_CLOSED' } } }).includes('ks-val stale'), 'a closed market is not "stale"');
  }
  {
    const held = new Set([pos.instrument]);
    const chain = html(U.Chain, { market, held, onPick: noop, onExpiry: noop });
    assert(chain.includes('03 Nov') && chain.includes('10 Nov') && /seg-btn active[^>]*>03 Nov/.test(chain), 'expiry buttons, the current one active');
    assert((chain.match(/<tr class="pt-atm"/g) || []).length === 1 && /pt-atm"><td[^>]*>.*?22700/.test(chain.replace(/\n/g, '')), 'exactly the ATM row is marked');
    assert((chain.match(/pt-px held/g) || []).length === 1 && chain.includes('aria-label="Trade 22700 CE (you hold this)"'), 'only the held contract is dotted');
    assert(chain.includes('aria-label="Trade 22650 PE"'), 'every price is a labelled button');
    assert(/>100\.00<\/button>/.test(chain), 'the price itself is the button');
    assert(!chain.includes('Bid / Ask') && !/>B<\/button>/.test(chain), 'the chain is just calls, strike and puts');
    assert(chain.includes('Lot size 65') && chain.includes('Tap a price to buy or sell'));
    assert(chain.includes('pt-itm'), 'in-the-money cells are shaded');
    assert(html(U.Chain, { market: null, held, onPick: noop, onExpiry: noop }).includes('Option chain unavailable'));
    assert(html(U.Chain, { market: { ...market, strikes: [] }, held, onPick: noop, onExpiry: noop }).includes('No strikes for this expiry'));
  }
  {
    const sheet = sel => html(U.OrderSheet, { accountId: 'main', market, selection: sel, onSide: noop, onClose: noop, onPlaced: noop });
    assert.strictEqual(sheet({ instrument: null, side: 'BUY', nonce: 0 }), '', 'no sheet before a price is tapped');
    const picked = sheet({ instrument: pos.instrument, side: 'SELL', nonce: 1 });
    assert(picked.includes('role="dialog"') && picked.includes('NIFTY 03 Nov 22700 CE') && picked.includes('Price 100.00') && picked.includes('Sell 1 lot') && picked.includes('pt-primary pt-wide pt-sell'));
    assert(/pt-side pt-side-sell on/.test(picked) && !/pt-side-buy on/.test(picked), 'the chosen side is highlighted, and only that one');
    assert(picked.includes('(65 qty)') && picked.includes('aria-label="One lot more"'), 'lots have a stepper and show the quantity');
    assert(!picked.includes('Limit price') && !picked.includes('Trigger price') && !picked.includes('Target price'), 'the first screen has no price fields and no advanced options');
    assert(picked.includes('More options') && !picked.includes('Stop limit'), 'stop orders, target and note stay behind More options');
    assert(sheet({ instrument: pos.instrument, side: 'BUY', nonce: 1 }).includes('Buy 1 lot') && sheet({ instrument: pos.instrument, side: 'BUY', nonce: 1 }).includes('pt-buy'));
  }
  {
    const hostile = { ...account, orders: [order({ id: 'O9', reason: '<img src=x onerror=alert(1)>', agent: { keyId: 'abcd1234', label: '<script>x</script>' } })] };
    const b = tab => html(U.Blotter, { account: hostile, accountId: 'main', lotSize: 65, tab, onTab: noop, onChanged: noop });
    const positions = b('positions');
    assert(positions.includes('03 Nov 22700 CE') && positions.includes('+2 (130)') && positions.includes('+₹1,300.00') && positions.includes('Exit'), 'a position shows lots, quantity, P&L and an exit button');
    assert(positions.includes('Total P&amp;L') && !positions.includes('Booked'), 'positions show one total, not a column of booked P&L');
    const orders = b('orders');
    assert(orders.includes('Waiting to fill') && orders.includes('Cancel') && orders.includes('O1') && orders.includes('History'), 'orders shows what is waiting, then the history');
    const history = orders;
    assert(history.includes('&lt;img src=x onerror=alert(1)&gt;') && history.includes('&lt;script&gt;x&lt;/script&gt;'), 'text from orders and agents is escaped');
    assert(!/<img src=x/.test(history) && !/<script>/.test(history));
    assert(b('trades').includes('130') && b('trades').includes('80.00'));
    assert(html(U.Blotter, { account: { ...account, summary: { ...account.summary, positions: [] } }, accountId: 'main', lotSize: 65, tab: 'positions', onTab: noop, onChanged: noop }).includes('No open positions.'));
    assert(html(U.Blotter, { account: null, accountId: 'main', lotSize: 65, tab: 'positions', onTab: noop, onChanged: noop }).includes('Loading'));
    assert(html(U.Blotter, { account, accountId: 'main', lotSize: 65, tab: 'orders', onTab: noop, onChanged: noop }).includes('Claude (agent)'));
    assert(html(U.Blotter, { account, accountId: 'main', lotSize: 65, tab: 'positions', onTab: noop, onChanged: noop }).match(/seg-btn/g).length === 3, 'three tabs: positions, orders, trades');
  }
  {
    const pay = html(U.PayoffPanel, { account, market });
    assert(pay.includes('<svg') && /Breakeven \d+/.test(pay) && pay.includes('max loss'), 'an open position draws its payoff with breakeven and max loss');
    assert(html(U.PayoffPanel, { account: { ...account, summary: { ...account.summary, positions: [] } }, market }).includes('Open a position to see its payoff.'));
    const eq = html(U.EquityPanel, { account });
    assert(eq.includes('<svg') && eq.includes('Account equity over time'));
    assert(html(U.EquityPanel, { account: null }).includes('pt-chart'));
  }
  {
    const acc = html(U.AccountsPanel, { accounts: [{ id: 'main', name: 'My account' }], accountId: 'main', account, onAccountsChanged: noop, onAccountChanged: noop });
    assert(acc.includes('My account') && acc.includes('Agent trading: on') && acc.includes('Create account') && acc.includes('Create key'));
    assert(!acc.includes('>Delete<'), 'the only account cannot be deleted');
    const two = html(U.AccountsPanel, { accounts: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', active: true }], accountId: 'a', account: { ...account, agentsPaused: true }, onAccountsChanged: noop, onAccountChanged: noop });
    assert((two.match(/>Delete</g) || []).length === 2 && two.includes('has open positions or orders') && two.includes('Agent trading: paused') && two.includes('pt-paused'));
  }
  {
    const base = { verdict: 'none', strategy: U.blankStrategy(), trades: 2, data: { sessions: 60, from: '2026-08-01', to: '2026-10-28' }, winRate: 0.5, winRateCi: { low: 0.1, high: 0.9 }, expectancy: 120, expectancyCi: { low: -50, high: 290 }, totalNet: 240, totalCharges: 60, maxDrawdown: 100, worst: -80, profitFactor: 1.5, avgWin: 200, avgLoss: 100, capitalNeeded: 9000, fitsCapital: true, capital: 100000, exits: { target: 1, time: 1 }, avgMinutes: 90, curve: [{ day: '2026-10-01', equity: 100100 }, { day: '2026-10-02', equity: 100240 }], tradeList: [{ day: '2026-10-01', entryT: Date.UTC(2026, 9, 1, 4), exitT: Date.UTC(2026, 9, 1, 6), entryIndex: 22000, exitIndex: 22050, legs: [{ label: 'BUY 22000 CE', entry: 100, exit: 130 }], net: 140, reason: 'target' }, { day: '2026-10-02', entryT: Date.UTC(2026, 9, 2, 4), exitT: Date.UTC(2026, 9, 2, 6), entryIndex: 22100, exitIndex: 22080, legs: [{ label: 'BUY 22100 CE', entry: 100, exit: 90 }], net: -20, reason: 'time' }], baseline: { expectancy: 30, percentile: 71, runs: 50 }, assumptions: ['Modelled prices <b>only</b>'] };
    const rep = v => html(U.Report, { r: { ...base, verdict: v } });
    for (const [v, title] of [['edge', 'Looks like an edge'], ['none', 'No clear edge'], ['negative', 'Loses money'], ['insufficient', 'Not enough trades to tell']]) assert(rep(v).includes(title), `verdict ${v}`);
    const out = rep('none');
    assert(out.includes('beat 71% of 50 such runs') && out.includes('50%') && out.includes('+₹120.00') && out.includes('fits ₹1,00,000.00'));
    const tbl = out.slice(out.indexOf('<table'));
    assert(tbl.indexOf('2026-10-02') < tbl.indexOf('2026-10-01'), 'the trade list is newest first');
    assert(out.includes('Modelled prices &lt;b&gt;only&lt;/b&gt;'), 'assumptions are escaped');
    assert(html(U.Report, { r: { ...base, fitsCapital: false } }).includes('more than the account'), 'a strategy that needs more than the account holds says so');
    assert(html(U.Report, { r: { ...base, trades: 0, tradeList: [], baseline: null } }).includes('No trades: the conditions never lined up'));
    assert(html(U.Report, { r: { ...base, baseline: null } }).includes('No baseline: with no entry conditions'));
  }
  {
    const dep = (o = {}) => ({ id: 'd-1', status: 'active', accountId: 'main', accountName: 'My <i>account</i>', strategy: U.blankStrategy(), day: '2026-10-28', tradesToday: 1, open: { entryT: Date.UTC(2026, 9, 28, 4), entrySpot: 22700, legs: [{ side: 'BUY', strike: 22700, optionType: 'CE', entry: 100 }], stopRs: 1950, targetRs: 3900 }, trades: [{ day: '2026-10-27', entryT: 1, exitT: 2, reason: 'target', net: 500, modelNet: 450 }], log: [{ at: Date.UTC(2026, 9, 28, 4), text: 'Entered' }], report: { trades: 1, winRate: 1, expectancy: 500, totalNet: 500, model: { meanGapPct: 2.5, meanAbsGapPct: 3, note: 'n' } }, ...o });
    const d = s => html(U.Deployments, { deployments: [dep({ status: s })], error: '', onStatus: noop, onDelete: noop });
    assert(d('active').includes('>Pause<') && d('active').includes('>Stop<') && !d('active').includes('>Resume<'));
    assert(d('paused').includes('>Resume<') && d('paused').includes('>Stop<'));
    assert(d('stopped').includes('>Delete<') && !d('stopped').includes('>Stop<') && !d('stopped').includes('>Pause<'));
    assert(!d('stopping').includes('>Stop<') && !d('stopping').includes('>Pause<'), 'a strategy that is stopping offers no buttons');
    const a = d('active');
    assert(a.includes('+2.5% (avg size 3%)') && a.includes('Open since') && a.includes('stop -₹1,950.00') && a.includes('target ₹3,900.00') && a.includes('1/1'));
    assert(a.includes('My &lt;i&gt;account&lt;/i&gt;') && !a.includes('<i>account'), 'account names are escaped');
    assert(html(U.Deployments, { deployments: [], error: 'boom', onStatus: noop, onDelete: noop }).includes('Nothing deployed') && html(U.Deployments, { deployments: [], error: 'boom', onStatus: noop, onDelete: noop }).includes('boom'));
  }
  {
    const ed = html(U.StrategyEditor, { strategy: { ...U.blankStrategy(), entry: { ...U.blankStrategy().entry, conditions: [U.defaultCondition('gap'), U.defaultCondition('orb')] } }, onChange: noop, error: 'bad rule', onError: noop });
    assert(ed.includes('Gap at the open') && ed.includes('Opening range breakout') && ed.includes('bad rule') && ed.includes('Add condition'));
    assert((ed.match(/Remove condition/g) || []).length === 2);
    assert(!ed.includes('Remove leg'), 'a single leg cannot be removed');
    const four = U.blankStrategy(); four.legs = [0, 1, 2, 3].map(() => U.newLeg());
    const e4 = html(U.StrategyEditor, { strategy: four, onChange: noop, error: '', onError: noop });
    assert((e4.match(/Remove leg/g) || []).length === 4 && /<button[^>]*disabled[^>]*>Add leg/.test(e4), 'at most four legs');
    assert(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].every(d => ed.includes(d)));
  }
  {
    assert(html(U.Perf, { accountId: 'main', active: true }).includes('Loading'), 'before the first answer arrives');
    assert(html(U.App, {}).includes('Connecting…'), 'the app starts by checking the session');
    assert(html(U.LineChart, { xs: [], series: [], yFormat: String, label: 'empty' }).includes('pt-chart'), 'an empty chart renders without throwing');
  }

  // ── rules the source must follow ──
  const srcFiles = walk('paper-app/src').filter(f => /\.(ts|tsx)$/.test(f) && !/test-entry/.test(f));
  assert(srcFiles.length >= 20, 'source files found');
  const allSrc = srcFiles.map(f => [f, read(f)]);
  for (const [f, text] of allSrc) {
    assert(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(text), `${f}: no raw HTML or code injection (React escapes text, keep it that way)`);
    assert(!/https?:\/\//.test(text.replace(/https?:\/\/(www\.w3\.org)/g, '')), `${f}: no third-party URLs`);
    assert(!/—/.test(text), `${f}: no em dashes`);
    assert(!/\p{Extended_Pictographic}/u.test(text.replace(/[©®™]/g, '')), `${f}: no emoji`);
    if (!/\/api\.ts$/.test(f)) assert(!/\bfetch\(/.test(text), `${f}: network calls go through api.ts only`);
    if (!/\/theme\.ts$/.test(f)) assert(!/localStorage|sessionStorage/.test(text), `${f}: storage goes through theme.ts only (it must never break the page)`);
  }
  assert(/'\/api\/paper/.test(read('paper-app/src/api.ts')) || /`\/api\/paper/.test(read('paper-app/src/api.ts')), 'the client talks only to /api/paper');
  assert(!/PAPER_SECRET|CRON_SECRET/.test(allSrc.map(x => x[1]).join('')), 'no secret names in the client');

  // ── the built app ──
  {
    const index = read('public/paper/index.html');
    assert(/<div id="root">/.test(index));
    assert.strictEqual((index.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi) || []).length, 0, 'no inline scripts (the CSP forbids them)');
    assert.strictEqual((index.match(/\son[a-z]+="/gi) || []).length, 0, 'no inline event handlers');
    assert.strictEqual((index.match(/<style\b/gi) || []).length, 0, 'no inline style blocks');
    const refs = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
    assert(refs.every(r => r.startsWith('/')), `only same-origin assets: ${refs.join(', ')}`);
    for (const r of refs.filter(r => r.startsWith('/paper/'))) assert(fs.existsSync(path.join(root, 'public', r)), `${r} exists`);
    const files = fs.readdirSync(path.join(root, 'public/paper/assets'));
    const js = files.filter(f => f.endsWith('.js'));
    assert.strictEqual(js.length, 1, 'one script bundle');
    const bundle = read(`public/paper/assets/${js[0]}`);
    const hosts = [...new Set((bundle.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map(h => h.replace(/^https?:\/\//, '').toLowerCase()))].filter(h => !/^(www\.w3\.org|react\.dev|reactjs\.org|legacy\.reactjs\.org)$/.test(h));
    assert.deepStrictEqual(hosts, [], `the bundle names no other hosts (it may only mention React's own docs and the SVG namespace): ${hosts.join(', ')}`);
    assert(/\/api\/paper/.test(bundle), 'the bundle talks to /api/paper');
  }
  // The committed bundle is exactly what the source builds to (so a deploy never serves stale code). `npm run build:paper` fixes it.
  {
    const prevEnv = process.env.NODE_ENV;
    const { build } = await import('vite');
    const out = await build({ configFile: path.join(root, 'paper-app/vite.config.mjs'), logLevel: 'silent', build: { write: false, outDir: path.join(root, 'public/paper') } });
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    const outputs = (Array.isArray(out) ? out : [out]).flatMap(o => o.output);
    for (const o of outputs) {
      const disk = path.join(root, 'public/paper', o.fileName);
      assert(fs.existsSync(disk), `public/paper/${o.fileName} is missing: run npm run build:paper`);
      const want = o.type === 'chunk' ? o.code : typeof o.source === 'string' ? o.source : Buffer.from(o.source).toString();
      assert.strictEqual(fs.readFileSync(disk, 'utf8'), want, `public/paper/${o.fileName} is out of date: run npm run build:paper`);
    }
    const onDisk = walk('public/paper').map(f => f.replace(/^public\/paper\//, '')).sort();
    assert.deepStrictEqual(onDisk, outputs.map(o => o.fileName).sort(), 'no leftover files in public/paper');
  }

  // ── the old static page is gone; the dashboard entry is an owner-only button ──
  for (const f of ['public/paper.html', 'public/js/paper.js', 'public/js/paper-lab.js', 'public/js/paper-perf.js', 'public/js/paper-payoff.js', 'public/css/paper.css']) assert(!fs.existsSync(path.join(root, f)), `${f} was replaced by the React app and must not come back`);
  {
    const dash = read('public/index.html');
    const btn = /<button[^>]*id="paperBtn"[^>]*>/.exec(dash);
    assert(btn, 'the dashboard has a Paper trading button');
    assert(/\shidden[\s>]/.test(btn[0]), 'the button starts hidden: nobody sees it until the owner session is confirmed');
    assert(/data-click="openPaper"/.test(btn[0]));
    assert(!/paper\.html/.test(dash) && !/href="\/paper/.test(dash), 'there is no public link to the paper page on the dashboard');
    const app = read('public/js/app.js');
    assert(/fetch\('\/api\/paper\/session'/.test(app) && /btn\.hidden = !\(s && s\.ok && s\.signedIn\)/.test(app), 'the button shows only when the server says the owner is signed in');
    assert(/catch \(e\) \{\s*btn\.hidden = true;/.test(app), 'any failure keeps it hidden');
    assert(/openPaper,?\s*\n\};/.test(app) && /window\.location\.assign\('\/paper'\)/.test(app));
    assert(/\.nav-link\[hidden\]\s*\{\s*display:\s*none/.test(read('public/css/styles.css')), 'the hidden attribute actually hides the button');
    const vercel = JSON.parse(read('vercel.json'));
    const srcs = vercel.routes.map(r => r.src);
    assert(srcs.indexOf('/paper/?') > 0 && srcs.indexOf('/paper/?') < srcs.indexOf('/(.*)', 1), '/paper is routed to the app before the catch-all');
    assert(vercel.routes.find(r => r.src === '/paper.html').status === 308, 'the old URL redirects permanently');
    assert(vercel.routes[0].headers && vercel.routes[0].continue === true, 'the security headers route is still first');
    const owner = read('api/security.js');
    assert(/function requirePaperOwner/.test(owner) && /router\.use\(requirePaperOwner\)/.test(read('api/routes/paper.js')), 'every /api/paper route except the sign-in and the agent API sits behind the owner gate');
  }

  console.log('paper trading app OK (logic, API client, every screen, source rules, built bundle, owner-only dashboard button)');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
