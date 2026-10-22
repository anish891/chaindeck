// Every browser module must parse as an ES module, and every server file as CommonJS. A single stray quote in a long text
// table (explain.js) once broke the whole page and no other test noticed, because the tests read these files as text.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const browser = fs.readdirSync(path.join(root, 'public/js')).filter(n => n.endsWith('.js')).map(n => path.join(root, 'public/js', n));
assert(browser.length >= 15, 'browser modules found');

// ES-module parse (no execution) in a child process, because vm.SourceTextModule needs a flag.
const script = `
  const fs = require('fs'), vm = require('vm');
  const bad = [];
  for (const f of JSON.parse(process.argv[1])) {
    try { new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f }); }
    catch (e) { bad.push(f.split('/').pop() + ': ' + e.message); }
  }
  console.log(JSON.stringify(bad));
`;
const out = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', script, JSON.stringify(browser)], { encoding: 'utf8' });
const bad = JSON.parse(out.trim().split('\n').pop());
assert.deepStrictEqual(bad, [], `browser modules with syntax errors: ${bad.join(' | ')}`);

// CommonJS parse for the server (and these test scripts)
const server = ['api', 'api/services', 'api/routes'].flatMap(d => fs.readdirSync(path.join(root, d)).filter(n => n.endsWith('.js')).map(n => path.join(root, d, n)));
for (const f of server) {
  try { new (require('vm').Script)(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(f, 'utf8').replace(/^#!.*/, '')}\n})`, { filename: f }); }
  catch (e) { assert.fail(`${path.relative(root, f)}: ${e.message}`); }
}
console.log(`syntax OK (${browser.length} browser modules, ${server.length} server files)`);
