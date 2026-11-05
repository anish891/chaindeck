// Runs every test/verify-*.js, each in its own Node process (as the old `a && b && ...` chain did), and stops at the
// first failure. Picking the files up by name means a new test file can never be left out of `npm test` by accident.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(n => /^verify-[a-z0-9-]+\.js$/.test(n)).sort();
if (!files.length) {
  console.error('No test files found in test/.');
  process.exit(1);
}

const started = Date.now();
for (const name of files) {
  const r = spawnSync(process.execPath, [path.join(dir, name)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${name} failed (exit ${r.status === null ? r.signal : r.status})`);
    process.exit(r.status || 1);
  }
}
console.log(`\n✓ ${files.length} test files passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
