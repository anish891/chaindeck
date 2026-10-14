// UI wiring and export-compatibility checks (static; no browser needed).
//  1. Every data-click / data-change in index.html resolves to a real action in app.js (a typo makes a button dead).
//  2. The export menu and its three actions exist.
//  3. No CSS/JS uses colour syntax that html2canvas (the Snapshot export) cannot parse: one such value anywhere on the
//     page makes the whole snapshot fail with "unsupported color function".
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('public/index.html');
const app = read('public/js/app.js');

// ── 1. actions referenced by the page exist ──
const actionsBlock = /const ACTIONS = \{([\s\S]*?)\n\};/.exec(app);
assert(actionsBlock, 'ACTIONS map not found in app.js');
const known = new Set([...actionsBlock[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*(?::|,|$)/gm)].map(m => m[1]));
assert(known.size >= 10, `expected the ACTIONS map to list the page actions, found ${known.size}`);

const used = new Map(); // name -> where
for (const m of html.matchAll(/data-(click|change)="([^"]+)"/g)) {
  for (const item of m[2].split(/\s+/).filter(Boolean)) {
    const name = item.split(':')[0];
    if (!used.has(name)) used.set(name, m[1]);
  }
}
assert(used.size > 0, 'no data-click/data-change attributes found');
const dead = [...used.keys()].filter(n => !known.has(n));
assert.deepStrictEqual(dead, [], `these page actions have no handler in ACTIONS (the buttons would do nothing): ${dead.join(', ')}`);

// each action in the map must be a real function declared or imported in app.js
for (const name of known) {
  if (['fetchNow', 'toggleAlertsDrawer'].includes(name)) continue; // wrapped lambdas
  assert(new RegExp(`(function\\s+${name}\\b|import\\s*\\{[^}]*\\b${name}\\b)`).test(app), `ACTIONS.${name} is not defined or imported in app.js`);
}

// ── 2. export menu ──
assert(/id="exportDropdown"/.test(html) && /id="exportMenu"/.test(html), 'export dropdown missing');
for (const act of ['toggleExportMenu', 'exportCSV', 'exportPDF', 'takeSnapshot']) {
  assert(used.has(act), `the page must wire ${act}`);
}
assert(/id="btnPDF"/.test(html) && /id="btnSnapshot"/.test(html));

// ── 3. html2canvas-safe colours ──
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const modern = /(color-mix|oklch|oklab|lch|lab|hwb|light-dark)\(|[\s:(,]color\(/;
for (const f of ['public/css/styles.css', ...fs.readdirSync(path.join(root, 'public/js')).filter(n => n.endsWith('.js')).map(n => 'public/js/' + n), 'public/index.html']) {
  const lines = stripComments(read(f)).split('\n');
  lines.forEach((l, i) => {
    assert(!modern.test(l), `${f}:${i + 1} uses a colour function html2canvas cannot parse, which breaks the Snapshot export: ${l.trim().slice(0, 100)}`);
  });
}

// ── 4. PDF report: the things that produced a blank / clipped / half-empty PDF ──
{
  const start = app.indexOf('function buildPdfReportElement');
  assert(start > 0, 'buildPdfReportElement not found');
  const end = app.indexOf('\nexport function toggleExportMenu', start) > 0 ? app.indexOf('\nexport function toggleExportMenu', start) : app.length;
  const fn = app.slice(start, start + 12000);
  const head = fn.slice(0, fn.indexOf('container.innerHTML'));
  // html2pdf renders a clone inside its own container; an absolutely positioned child takes no space, so the
  // container (and every page) came out 0px tall: a "successful" export that was completely blank.
  assert(!/position:\s*(absolute|fixed)/.test(head), 'the PDF report element must stay in normal flow (absolute/fixed positioning makes the PDF blank)');
  assert(!/left:\s*-?\d{3,}px/.test(head), 'do not hide the report by pushing it off-screen on the element itself; use a wrapper');
  // html2pdf lays the clone out as wide as the page (746px portrait), so a fixed wider width is clipped
  assert(/width:\s*100%/.test(head) && !/width:\s*\d+px/.test(head), 'the report must be width:100%, not a fixed pixel width');
  assert(/jsPDF:\s*\{[^}]*orientation:\s*'portrait'/.test(app), 'portrait keeps the report on one page');
  // field names must match what the API sends (a mismatch printed "n/a" / blank in the PDF)
  assert(/gex\.totalGexCr/.test(fn) && !/gex\.netGexCr/.test(fn), 'PDF must read gex.totalGexCr');
  assert(/cpr\.cprType/.test(fn) && !/cpr\.type\b/.test(fn), 'PDF must read cpr.cprType');
  const css = read('public/css/styles.css');
  assert(/\.pdf-export-report table\s*\{[^}]*min-width:\s*0/.test(css), 'the report table must override the global min-width: 860px or it is clipped on the page');
}

console.log('✓ ui wiring OK (every data-click/data-change has a handler; export menu wired; snapshot-safe colours)');
