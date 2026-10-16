// Tests for the option-chain buildup labels in public/js/charts.js (a browser ES module with no imports,
// loaded through a data: URL like the alert-rule tests).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const load = async () => {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/charts.js'), 'utf8');
    // a unique comment gives each load its own module instance (fresh tick history)
    return import('data:text/javascript;base64,' + Buffer.from(src + `\n// ${Math.random()}`).toString('base64'));
  };

  // 1. Re-rendering the same snapshot (sorting, toggling Greeks) must not count as new ticks.
  //    Before the fix every render pushed a duplicate, so a few sort clicks flushed the real history.
  {
    const { getSmoothedBuildup } = await load();
    const E = '13-Oct-2026';
    getSmoothedBuildup(22500, 1000, 100, true, 0, 0, E);           // snapshot 1
    const bd = getSmoothedBuildup(22500, 1200, 110, true, 0, 0, E); // snapshot 2: OI up, price up
    assert.strictEqual(bd.label, 'LONG BUILD');
    for (let i = 0; i < 10; i++) getSmoothedBuildup(22500, 1200, 110, true, 0, 0, E); // ten re-renders of snapshot 2
    assert.strictEqual(getSmoothedBuildup(22500, 1200, 110, true, 0, 0, E).label, 'LONG BUILD',
      're-renders keep the trend from snapshot 1 to 2 instead of collapsing it to FLAT');
  }

  // 2. The same strike on another expiry is a different contract: its history must not mix in.
  {
    const { getSmoothedBuildup } = await load();
    getSmoothedBuildup(22500, 50000, 200, true, 0, 0, '13-Oct-2026');
    // switch to a far expiry where this strike has far less OI and a higher price: comparing across
    // contracts would read as "OI fell, price rose" = SHORT COV
    const bd = getSmoothedBuildup(22500, 9000, 260, true, 1500, 12, '27-Oct-2026');
    assert.strictEqual(bd.label, 'LONG BUILD', 'first sight of the new contract uses its own day change (OI +, price +)');
  }

  // 3. Unchanged classification rules
  {
    const { buildupSingle } = await load();
    assert.strictEqual(buildupSingle(10, 5, true).label, 'LONG BUILD');
    assert.strictEqual(buildupSingle(10, -5, true).label, 'SHORT BUILD');
    assert.strictEqual(buildupSingle(-10, 5, true).label, 'SHORT COV');
    assert.strictEqual(buildupSingle(-10, -5, true).label, 'LONG UNWD');
  }

  console.log('buildup checks passed');
})().catch(err => { console.error(err); process.exit(1); });
