const assert = require('assert');
const A = require('../api/services/paper/paperAnalytics');

// Expectancy by setup: round trips credited to the setup that opened them, net of charges, with honest sample sizes.

let tid = 0;
const MIN = 60000;
const T0 = Date.UTC(2026, 10, 2, 4, 0);
const order = (id, extra = {}) => ({ id, source: 'manual', tag: null, ...extra });
const fill = (orderId, instrument, side, qty, at, realized = 0, charges = 10, kind = 'order') => ({ id: `T${++tid}`, orderId, kind, instrument, side, qty, price: 100, charges, realized, at: T0 + at * MIN });
const stats = (orders, trades) => A.setupStats({ orders, trades });
const row = (rows, label) => rows.find(r => r.label === label);

// 1. the setup is the ENTRY's tag: an untagged exit, and an expiry settlement, are credited to it
{
  const orders = [order('O1', { tag: 'Breakout' }), order('O2'), order('O3', { tag: 'Breakout' })];
  const rows = stats(orders, [
    fill('O1', 'A', 'BUY', 65, 0),
    fill('O2', 'A', 'SELL', 65, 30, 1000),            // exit by an untagged order: +1000, charges 10 + 10
    fill('O3', 'B', 'SELL', 65, 60),                  // a short entry
    fill(null, 'B', 'BUY', 65, 200, -400, 5, 'settlement') // settled at expiry at a loss
  ]);
  assert.strictEqual(rows.length, 1, 'no "Untagged" row appears for the exit order');
  const b = rows[0];
  assert.deepStrictEqual([b.label, b.trades, b.wins, b.losses, b.open], ['Breakout', 2, 1, 1, 0]);
  assert.strictEqual(b.avgWin, 980, 'net of the entry and exit charges');
  assert.strictEqual(b.avgLoss, -415);
  assert.strictEqual(b.expectancy, 282.5, '(980 - 415) / 2');
  assert.strictEqual(b.net, 565);
  assert.strictEqual(b.expectancy, Math.round((b.winRate * b.avgWin + (1 - b.winRate) * b.avgLoss) * 100) / 100, 'win rate x avg win + loss rate x avg loss');
}

// 2. a two-leg spread opened in the same minute under one setup is ONE trade, judged on its combined result
{
  const orders = [order('O1', { tag: 'Bull spread' }), order('O2', { tag: 'bull spread' }), order('O3'), order('O4')];
  const rows = stats(orders, [
    fill('O1', 'LONG', 'BUY', 65, 0), fill('O2', 'SHORT', 'SELL', 65, 0.5),
    fill('O3', 'LONG', 'SELL', 65, 40, 900), fill('O4', 'SHORT', 'BUY', 65, 40, -500)
  ]);
  const s = rows[0];
  assert.deepStrictEqual([rows.length, s.trades, s.wins, s.losses], [1, 1, 1, 0], 'one winning trade, not one win and one loss; tags match whatever the capitals');
  assert.strictEqual(s.net, 360, '900 - 500 - four fills of charges');
  // the same setup a minute later is a separate trade
  const two = stats(orders, [fill('O1', 'LONG', 'BUY', 65, 0), fill('O2', 'LONG', 'BUY', 65, 5), fill('O3', 'LONG', 'SELL', 130, 40, 200)]);
  assert.strictEqual(two[0].trades, 2);
}

// 3. scaling out is still one trade; a trade is counted only when fully closed
{
  const orders = [order('O1', { tag: 'Scalp' }), order('O2'), order('O3')];
  const partial = stats(orders, [fill('O1', 'A', 'BUY', 130, 0, 0, 20), fill('O2', 'A', 'SELL', 65, 10, 300)]);
  assert.deepStrictEqual([partial[0].trades, partial[0].open, partial[0].expectancy], [0, 1, null], 'half closed: still open, no statistics yet');
  const done = stats(orders, [fill('O1', 'A', 'BUY', 130, 0, 0, 20), fill('O2', 'A', 'SELL', 65, 10, 300), fill('O3', 'A', 'SELL', 65, 20, -100)]);
  assert.deepStrictEqual([done[0].trades, done[0].wins, done[0].net], [1, 1, 160], 'two exits, one result: 300 - 100 - 40 charges');
}

// 4. first in, first out across setups; a fill that closes and reverses is split by quantity
{
  const orders = [order('O1', { tag: 'A-setup' }), order('O2', { tag: 'B-setup' }), order('O3'), order('O4', { tag: 'Reversal' }), order('O5')];
  const rows = stats(orders, [
    fill('O1', 'X', 'BUY', 65, 0), fill('O2', 'X', 'BUY', 65, 10),
    fill('O3', 'X', 'SELL', 65, 20, 500),            // closes the oldest lot: A-setup
    fill('O4', 'X', 'SELL', 130, 30, -200, 20),      // closes B-setup (65) and opens a 65 short under Reversal
    fill('O5', 'X', 'BUY', 65, 40, 650)
  ]);
  assert.strictEqual(row(rows, 'A-setup').net, 480);
  assert.strictEqual(row(rows, 'B-setup').net, -220, 'the whole -200 belongs to the lots it closed, plus entry 10 and half the exit charges');
  assert.strictEqual(row(rows, 'Reversal').net, 630, '650 - half of the reversing fill\'s charges - its own exit charges');
}

// 5. untagged orders are each their own trade; strategies are named; unmatched closes are set apart, not guessed
{
  const orders = [order('O1'), order('O2'), order('O3'), order('O4'), order('S1', { source: 'strategy', tag: 'ORB', strategy: { deploymentId: 'd1', name: 'ORB' } }), order('S2', { source: 'strategy', strategy: { deploymentId: 'd1', name: 'ORB' } })];
  const rows = stats(orders, [
    fill('O1', 'A', 'BUY', 65, 0), fill('O2', 'B', 'BUY', 65, 0.2), fill('O3', 'A', 'SELL', 65, 9, 100), fill('O4', 'B', 'SELL', 65, 9, -100),
    fill('S1', 'C', 'BUY', 65, 20), fill('S2', 'C', 'SELL', 65, 50, 250),
    fill('GONE', 'Z', 'SELL', 65, 60, 700)             // closes something opened before the kept history
  ]);
  assert.deepStrictEqual([row(rows, 'Untagged').trades, row(rows, 'Untagged').wins, row(rows, 'Untagged').losses], [2, 1, 1], 'two untagged orders in the same minute stay two trades');
  assert.deepStrictEqual([row(rows, 'ORB').trades, row(rows, 'ORB').net], [1, 230]);
  assert.strictEqual(row(rows, 'Opened before the kept history').trades, 1);
}

// 6. sample size: flagged, with an interval on the win rate instead of a bare percentage
{
  assert.deepStrictEqual(A.wilson(3, 3), { low: 0.44, high: 1 }, '3 wins out of 3 is not a 100% setup');
  assert.deepStrictEqual(A.wilson(60, 100), { low: 0.5, high: 0.69 });
  assert.deepStrictEqual(A.wilson(0, 0), { low: null, high: null });
  const many = n => {
    const orders = [], trades = [];
    for (let i = 0; i < n; i += 1) { orders.push(order(`I${i}`, { tag: 'Many' }), order(`X${i}`)); trades.push(fill(`I${i}`, 'M', 'BUY', 65, i * 10, 0, 0), fill(`X${i}`, 'M', 'SELL', 65, i * 10 + 5, i % 2 ? 100 : -50, 0)); }
    return stats(orders, trades)[0];
  };
  assert.strictEqual(many(5).sample, 'few');
  assert.strictEqual(many(30).sample, 'early');
  const big = many(100);
  assert.deepStrictEqual([big.sample, big.trades, big.winRate, big.avgWin, big.avgLoss, big.expectancy], ['ok', 100, 0.5, 100, -50, 25]);
  // a trade that only paid charges is a loss, not a draw
  const flat = stats([order('O1', { tag: 'Flat' }), order('O2')], [fill('O1', 'A', 'BUY', 65, 0), fill('O2', 'A', 'SELL', 65, 5, 0)]);
  assert.deepStrictEqual([flat[0].losses, flat[0].avgLoss], [1, -20]);
}

// 7. part of the account analytics; an account with no trades has no rows
{
  const out = A.accountAnalytics({ id: 'a', name: 'A', startingCapital: 100000, realized: 0, chargesPaid: 0, orders: [], trades: [], curve: [] }, { equity: 100000, unrealized: 0 });
  assert.deepStrictEqual(out.bySetup, []);
}

console.log('expectancy by setup checks passed');
