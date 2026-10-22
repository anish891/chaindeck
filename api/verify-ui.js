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

// ── 4. PDF report: built from the live dashboard (same information as the Snapshot), and the traps that made it
//       blank / clipped / sliced ──
{
  const grab = name => {
    const i = app.indexOf(name);
    assert(i > 0, `${name} not found in app.js`);
    return app.slice(i, i + 5500);
  };
  const build = grab('function buildDashboardReport');
  const mark = grab('function markAvoidBreaks');
  const css = read('public/css/styles.css');
  const rule = sel => {
    const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : '';
  };

  assert(!app.includes('buildPdfReportElement'), 'the old hand-built summary report must be gone (the PDF mirrors the dashboard)');
  // content: clones the dashboard sections, so every panel (including future ones) is included
  assert(/document\.body\.children/.test(build) && /cloneNode\(true\)/.test(build), 'the report must clone the live dashboard sections');
  assert(/position === 'fixed'/.test(build), 'fixed overlays, drawers and the footer must be skipped');
  // a cloned <canvas> is blank, so charts must be swapped for images or the PDF has empty chart areas
  assert(/querySelectorAll\('canvas'\)/.test(build) && /toDataURL/.test(build), 'charts must be converted to images (cloned canvases are blank)');
  assert(/querySelectorAll\('select'\)/.test(build) && /querySelectorAll\('button/.test(build), 'dropdowns become text and buttons are dropped');
  assert(/details/.test(build) && /\.open = true/.test(build), 'collapsed "Advanced analytics" must be opened');
  assert(/data-theme', 'light'/.test(build), 'the report uses the light print palette');
  // layout traps
  const root = rule('.pdf-export-report');
  assert(root && !/position:\s*(absolute|fixed)/.test(root), 'the report root must stay in normal flow (absolute/fixed makes the PDF blank)');
  assert(/width:\s*100%/.test(root) && !/[^-]width:\s*\d+px/.test(root), 'the report must be width:100%, not a fixed pixel width (clipped otherwise)');
  assert(/overflow:\s*visible/.test(rule('.pdf-export-report .table-wrap')) && /max-height:\s*none/.test(rule('.pdf-export-report .table-wrap')), 'the option chain must not be height/scroll limited in the report');
  assert(/min-width:\s*0/.test(rule('.pdf-export-report table')), 'the report tables must override the global min-width: 860px');
  // pagination
  assert(/jsPDF:\s*\{[^}]*orientation:\s*'landscape'/.test(app), 'landscape keeps the dashboard layout');
  const pagebreak = (/^\s*pagebreak:\s*\{.*\}\s*$/m.exec(app) || [''])[0];
  assert(pagebreak, 'html2pdf pagebreak option not found');
  assert(pagebreak.includes("'.pdf-avoid'") && !pagebreak.includes('avoid-all'), "cards are kept whole via .pdf-avoid (not 'avoid-all', which leaves huge gaps)");
  assert(/display === 'grid'/.test(mark), 'grids must be kept together (a page-break spacer cannot hold back a single grid item)');
  assert(/previous\.style\.pageBreakBefore/.test(build), 'the option chain starts on its own page, keeping its heading with the table');
  assert(/markAvoidBreaks\(reportContainer\)/.test(app) && /width: 1074px/.test(app), 'avoid-marking must run on the attached report at the page width (1074px)');
}

// ── 5. price chart: vendored library, exports, and safe rendering ──
{
  const chartJs = read('public/js/price-chart.js');
  assert(/id="priceChart"/.test(html), 'chart container missing');
  assert(/<script src="\/vendor\/lightweight-charts\.standalone\.production\.js"><\/script>/.test(html), 'the vendored (same-origin) Lightweight Charts build must be loaded');
  assert(fs.existsSync(path.join(root, 'public/vendor/LICENSE-lightweight-charts.md')), 'the Apache-2.0 licence must ship with the vendored build');
  assert(/attributionLogo:\s*true/.test(chartJs), 'Lightweight Charts requires its attribution to stay visible');
  assert(/takeScreenshot\(/.test(chartJs), 'the chart is several stacked canvases; exports must use the library screenshot');
  // a cloned DOM chart is blank: the report must skip its canvases and substitute the screenshot
  assert(/closest\('#priceChart'\)/.test(app) && /chartScreenshot\(\)/.test(app), 'the PDF report must replace the price chart with a screenshot');
  assert(/import \{[^}]*escapeHtml[^}]*\} from '\.\/ui-utils\.js'/.test(chartJs), 'network-derived strings must be escaped before they reach innerHTML');
  // Every ${...} in the panel templates that is NOT wrapped in escapeHtml() must be on this reviewed list: numbers the
  // server computed, fixed labels and class names. Adding another forces a look at whether it can carry text from the network.
  {
    const panels = chartJs.slice(chartJs.indexOf('// ── panels'), chartJs.indexOf('// ── public API'));
    const bare = new Set();
    for (const m of panels.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) if (!/^escapeHtml\(/.test(m[1])) bare.add(m[1]);
    const reviewed = new Set(["Math.max(4, Math.min(100, z.strength))","Math.round(z.high)","Math.round(z.low)","Math.round(z.mid)","VERDICT_TEXT[h.verdict] || h.verdict","bt.candles.toLocaleString('en-IN')","bt.horizon","bt.sessions","dir","e.against ? 'against' : e.neutral ? 'neutral' : ''","evidence","h.horizon","h.n","hidden ? ` (${hidden} weaker pattern${hidden > 1 ? 's' : ''} hidden.)` : ''","kind","kindLabel","p.dir === 'bull' ? 'Bullish' : 'Bearish'","p.dir === 'bull' ? 'bull' : 'bear'","p.n","pc(h.baseline)","pc(h.ci.high)","pc(h.ci.low)","pc(h.hitRate)","pc(p.baseline)","pc(p.hitRate)","rows","s.age === 0 ? 'latest candle' : s.age + ' candle' + (s.age > 1 ? 's' : '') + ' ago'","s.dir === 'bull' ? 'Bullish reversal' : 'Bearish reversal'","s.rr ? ` (about ${escapeHtml(String(s.rr))}R)` : ''","s.score","side","tgt","why","z.distancePct > 0 ? '+' : ''","z.evidence.map(e => `<li><em>${escapeHtml(e.family)}</em> ${escapeHtml(e.text)}</li>`).join('')","z.families.length","z.families.length >= 3 ? 'strong' : 'moderate'","z.held","z.side === 'buy' ? 'Buying interest' : 'Selling interest'","z.strength","z.touches"]);
    // historyLine() builds plain text, so its verdict is exempt above: that is only safe while every use is escaped once
    const historyUses = [...chartJs.matchAll(/historyLine\(/g)].length - 1; // minus the definition
    const escapedUses = [...chartJs.matchAll(/escapeHtml\(historyLine\(/g)].length;
    assert.strictEqual(escapedUses, historyUses, 'historyLine() returns plain text: every use must be wrapped in escapeHtml()');
    const unreviewed = [...bare].filter(x => !reviewed.has(x));
    assert.deepStrictEqual(unreviewed, [], 'unescaped expressions in chart panel templates need review: ' + unreviewed.join(' | '));
  }
  for (const id of ['levelLadder', 'signalsList', 'actionZones', 'patternStats', 'chartNote', 'chartLegend']) {
    assert(new RegExp(`id="${id}"`).test(html), `#${id} missing from the page`);
  }
  for (const key of ['priceChart', 'levelLadder', 'signals', 'actionZones', 'patternStats']) {
    assert(html.includes(`data-explain="${key}"`), `explain popover for ${key} not wired in the page`);
    assert(new RegExp(`\\n  ${key}: \\{\\n    en:`).test(read('public/js/explain.js')) && new RegExp(`\\n  ${key}: \\{[\\s\\S]*?hi: \\[`).test(read('public/js/explain.js')), `explain text (English and Hindi) missing for ${key}`);
  }
}

// ── sorted column indicator: the .sort-asc / .sort-desc styles must actually be applied by sortTable ──
{
  const css = read('public/css/styles.css');
  assert(/\.sort-asc::after/.test(css) && /\.sort-desc::after/.test(css), 'sort arrow styles exist');
  const sortFn = /export function sortTable\(col\) \{([\s\S]*?)\n\}/.exec(app);
  assert(sortFn && /renderSortIndicator\(\)/.test(sortFn[1]), 'sortTable updates the header indicator');
  assert(/classList\.toggle\('sort-asc'/.test(app) && /classList\.toggle\('sort-desc'/.test(app), 'header gets sort-asc / sort-desc');
  assert(/aria-sort/.test(app), 'aria-sort is set for screen readers');
}

// ── help buttons: every data-explain key on the page has an entry (unknown keys are skipped silently, losing the button) ──
{
  const explainJs = read('public/js/explain.js');
  const defined = new Set([...explainJs.matchAll(/^  ([A-Za-z]+): \{$/gm)].map(m => m[1]));
  const usedKeys = new Set([...html.matchAll(/data-explain="([^"]+)"/g)].map(m => m[1]));
  const missing = [...usedKeys].filter(k => !defined.has(k));
  assert.deepStrictEqual(missing, [], 'data-explain keys with no explanation: ' + missing.join(', '));
  for (const k of defined) assert(new RegExp(`  ${k}: \\{\\n    en: \\[`).test(explainJs) && new RegExp(`${k}: \\{[\\s\\S]*?\\n    hi: \\[`).test(explainJs), `${k} needs both en and hi text`);
}

// ── 6. feed freshness badges ──
{
  for (const id of ['freshChain', 'freshCandles', 'freshSaved']) assert(new RegExp(`id="${id}"`).test(html), `#${id} badge missing from the key strip`);
  assert(/renderFreshness\(\);\s*\}/.test(app.slice(app.indexOf('function updateAge'), app.indexOf('function updateAge') + 700)), 'updateAge must refresh the badges every second');
  assert(/stale:\s*!!\(currentData && currentData\.feed/.test(app), 'the NSE badge must reflect the server\'s stale flag');
}

// ── 7. forward log panel ──
{
  const fl = read('public/js/forward-log.js');
  assert(/id="forwardLog"/.test(html) && html.includes('data-explain="forwardLog"'), 'forward log panel missing');
  assert(!/innerHTML/.test(fl), 'forward-log.js builds DOM with textContent only (its data comes from storage)');
  assert(/refreshForwardLog\(\)/.test(app), 'the page must refresh the forward log');
  assert(/\n  forwardLog: \{\n    en:/.test(read('public/js/explain.js')), 'explain text for forwardLog missing');
}

// ── 8. level scorecard panel ──
{
  const sc = read('public/js/level-scorecard.js');
  assert(/id="levelScorecard"/.test(html) && html.includes('data-explain="levelScorecard"'), 'level scorecard panel missing');
  assert(!/innerHTML/.test(sc), 'level-scorecard.js builds DOM with textContent only');
  assert(/refreshLevelScorecard\(\)/.test(app), 'the page must load the level scorecard');
  assert(/\n  levelScorecard: \{\n    en:/.test(read('public/js/explain.js')), 'explain text for levelScorecard missing');
}

// ── 9. chart arrows are filtered, not one per detection ──
{
  const chartJs = read('public/js/price-chart.js');
  assert(/!pt\.notable/.test(chartJs), 'markers must default to the notable patterns only');
  assert(/data-layer="allPatterns"/.test(html), 'the raw "show every pattern" switch must exist');
  assert(/LAYER_DEFAULTS = \{[^}]*allPatterns:\s*false/.test(chartJs), 'every pattern must be OFF by default');
}

console.log('✓ ui wiring OK (every data-click/data-change has a handler; export menu wired; snapshot-safe colours)');
