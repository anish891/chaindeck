// Strategy lab on the paper trading page: build a rule-based strategy, backtest it on about 60 sessions, save it.
// The form is a view of one strategy object (the same JSON the agent API takes); every edit reads the form back into it.

import { escapeHtml } from './ui-utils.js';

const $ = id => document.getElementById(id);
let deps = null;       // { api, inr, drawChart, chartColors, getAccountId }
let saved = [];
let presets = [];
let current = null;    // { id: string | null, strategy }
let report = null;
let running = false;
let armedDelete = 0;

const CONDITION_LABELS = {
  gap: 'Gap at the open',
  dayMove: 'Move since the open',
  orb: 'Opening range breakout',
  vwap: 'Price vs VWAP',
  prevDay: 'Price vs previous day',
  vix: 'India VIX',
  signal: 'Reversal signal'
};
const CONDITION_DEFAULTS = {
  gap: { op: 'above', pct: 0.3 },
  dayMove: { op: 'above', pct: 0.3 },
  orb: { minutes: 30, direction: 'up' },
  vwap: { position: 'above' },
  prevDay: { level: 'high', position: 'above' },
  vix: { op: 'below', value: 15 },
  signal: { direction: 'bull' }
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const blank = () => ({
  name: 'My strategy',
  interval: '5m',
  entry: { window: { from: '09:30', to: '14:00' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [] },
  legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' }],
  exits: { stopLoss: { unit: 'pct', value: 30 }, target: { unit: 'pct', value: 60 }, exitAt: '15:15', indexMovePts: null }
});
const clone = x => JSON.parse(JSON.stringify(x));

// ── small form helpers ──

const sel = (cls, value, options) => `<select class="${cls}">${options.map(([v, label]) => `<option value="${escapeHtml(v)}"${String(v) === String(value) ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
const numIn = (cls, value, attrs = '') => `<input type="number" class="${cls}" value="${value === null || value === undefined ? '' : escapeHtml(value)}" ${attrs} />`;
const offsetLabel = n => (n === 0 ? 'ATM' : n > 0 ? `ATM+${n}` : `ATM${n}`);

function conditionFields(c) {
  const opSel = sel('lc-op', c.op, [['above', 'above'], ['below', 'below']]);
  switch (c.type) {
    case 'gap': return `${opSel} ${numIn('lc-pct', c.pct, 'step="0.05" min="-10" max="10"')} %`;
    case 'dayMove': return `${opSel} ${numIn('lc-pct', c.pct, 'step="0.05" min="-10" max="10"')} %`;
    case 'orb': return `${sel('lc-direction', c.direction, [['up', 'breaks above'], ['down', 'breaks below']])} the first ${sel('lc-minutes', c.minutes, [[15, '15 min'], [30, '30 min'], [60, '60 min']])}`;
    case 'vwap': return `close ${sel('lc-position', c.position, [['above', 'above'], ['below', 'below']])} VWAP`;
    case 'prevDay': return `close ${sel('lc-position', c.position, [['above', 'above'], ['below', 'below']])} previous day ${sel('lc-level', c.level, [['high', 'high'], ['low', 'low'], ['close', 'close']])}`;
    case 'vix': return `${opSel} ${numIn('lc-value', c.value, 'step="0.5" min="5" max="90"')}`;
    case 'signal': return sel('lc-direction', c.direction, [['bull', 'bullish pattern'], ['bear', 'bearish pattern']]);
    default: return '';
  }
}

function exitRuleFields(prefix, rule) {
  return `${sel(`${prefix}-unit`, rule ? rule.unit : 'none', [['none', 'none'], ['pct', '% of premium'], ['rupees', 'rupees']])} ${numIn(`${prefix}-value`, rule ? rule.value : '', 'min="1" step="1"')}`;
}

// ── render ──

function renderList() {
  const item = (label, action, active, note = '') => `<button class="lab-item${active ? ' active' : ''}" data-click="${action}">${escapeHtml(label)}${note ? ` <span class="pt-muted">${escapeHtml(note)}</span>` : ''}</button>`;
  $('labList').innerHTML = [
    '<div class="pt-label">Saved</div>',
    saved.length ? saved.map(r => item(r.strategy.name, `labLoad:${r.id}`, current && current.id === r.id, r.strategy.interval)).join('') : '<div class="empty-note">Nothing saved yet.</div>',
    '<div class="pt-label lab-gap">Presets</div>',
    presets.map((p, i) => item(p.name, `labPreset:${i}`, false, p.interval)).join(''),
    '<button class="lab-item lab-new" data-click="labNew">New blank strategy</button>'
  ].join('');
}

function renderEditor() {
  const s = current.strategy;
  const e = s.entry, x = s.exits;
  $('labName').value = s.name;
  $('labInterval').value = s.interval;
  $('labFrom').value = e.window.from;
  $('labTo').value = e.window.to;
  $('labMaxTrades').value = e.maxTradesPerDay;
  $('labExitAt').value = x.exitAt;
  $('labMovePts').value = x.indexMovePts === null ? '' : x.indexMovePts;
  $('labDays').innerHTML = DAYS.map((d, i) => `<label class="pt-check"><input type="checkbox" class="lab-day" value="${i + 1}"${e.weekdays.includes(i + 1) ? ' checked' : ''} /> ${d}</label>`).join('');
  $('labConds').innerHTML = e.conditions.length ? e.conditions.map((c, i) => `<div class="lab-row lab-cond" data-type="${c.type}">
      <b>${escapeHtml(CONDITION_LABELS[c.type])}</b> ${conditionFields(c)}
      <button class="pt-small" data-click="labRemoveCond:${i}" aria-label="Remove condition">Remove</button>
    </div>`).join('') : '<div class="empty-note">No conditions: it enters at the first candle of the window every allowed day.</div>';
  $('labLegs').innerHTML = s.legs.map((l, i) => `<div class="lab-row lab-leg">
      ${sel('ll-side', l.side, [['BUY', 'Buy'], ['SELL', 'Sell']])}
      ${numIn('ll-lots', l.lots, 'min="1" max="10" step="1" aria-label="Lots"')} lot
      ${sel('ll-offset', l.strikeOffset, Array.from({ length: 41 }, (_, k) => [k - 20, offsetLabel(k - 20)]))}
      ${sel('ll-type', l.optionType, [['CE', 'CE'], ['PE', 'PE']])}
      ${sel('ll-expiry', l.expiry, [['weekly', 'this week'], ['next', 'next week']])}
      ${s.legs.length > 1 ? `<button class="pt-small" data-click="labRemoveLeg:${i}" aria-label="Remove leg">Remove</button>` : ''}
    </div>`).join('');
  $('labStop').innerHTML = exitRuleFields('ls', x.stopLoss);
  $('labTarget').innerHTML = exitRuleFields('lt', x.target);
  $('labAddLeg').disabled = s.legs.length >= 4;
  $('labDelete').hidden = !current.id;
  $('labDelete').textContent = Date.now() < armedDelete ? 'Confirm delete' : 'Delete';
  $('labSave').textContent = current.id ? 'Save' : 'Save strategy';
  $('labSaveAs').hidden = !current.id;
  $('labError').textContent = '';
}

/** The form, read back into a strategy object. */
function readForm() {
  const num = v => (v === '' || v === null ? null : Number(v));
  const rule = prefix => {
    const unit = document.querySelector(`.${prefix}-unit`).value;
    const value = num(document.querySelector(`.${prefix}-value`).value);
    return unit === 'none' || value === null ? null : { unit, value };
  };
  const conds = [...document.querySelectorAll('.lab-cond')].map(row => {
    const c = { type: row.dataset.type };
    const v = cls => row.querySelector(`.${cls}`);
    if (v('lc-op')) c.op = v('lc-op').value;
    if (v('lc-pct')) c.pct = num(v('lc-pct').value);
    if (v('lc-value')) c.value = num(v('lc-value').value);
    if (v('lc-direction')) c.direction = v('lc-direction').value;
    if (v('lc-position')) c.position = v('lc-position').value;
    if (v('lc-level')) c.level = v('lc-level').value;
    if (v('lc-minutes')) c.minutes = Number(v('lc-minutes').value);
    return c;
  });
  const legs = [...document.querySelectorAll('.lab-leg')].map(row => ({
    side: row.querySelector('.ll-side').value,
    optionType: row.querySelector('.ll-type').value,
    strikeOffset: Number(row.querySelector('.ll-offset').value),
    lots: Number(row.querySelector('.ll-lots').value),
    expiry: row.querySelector('.ll-expiry').value
  }));
  return {
    name: $('labName').value.trim(),
    interval: $('labInterval').value,
    entry: {
      window: { from: $('labFrom').value, to: $('labTo').value },
      weekdays: [...document.querySelectorAll('.lab-day:checked')].map(i => Number(i.value)),
      maxTradesPerDay: Number($('labMaxTrades').value),
      conditions: conds
    },
    legs,
    exits: { stopLoss: rule('ls'), target: rule('lt'), exitAt: $('labExitAt').value, indexMovePts: num($('labMovePts').value) }
  };
}

const syncFromForm = () => { current.strategy = readForm(); };

// ── results ──

const pct = x => `${(x * 100).toFixed(0)}%`;
const VERDICT = {
  edge: ['Looks like an edge', 'pt-pos', 'At least 30 trades, the average trade is positive with 95% confidence, and it beat 95% of random-entry runs. Still a backtest on modelled prices: forward test it before trusting it.'],
  none: ['No clear edge', '', 'Enough trades, but the result is within what chance or random entries produce.'],
  negative: ['Loses money', 'pt-neg', 'The average trade is negative with 95% confidence.'],
  insufficient: ['Not enough trades to tell', 'pt-warnc', 'Fewer than 30 trades. Any number below can be luck either way.']
};

function renderReport() {
  const box = $('labResults');
  if (!report) { box.hidden = true; return; }
  box.hidden = false;
  const r = report, { inr } = deps;
  const [title, cls, explain] = VERDICT[r.verdict] || VERDICT.none;
  const ci = r.expectancyCi ? ` (95%: ${inr(r.expectancyCi.low, true)} to ${inr(r.expectancyCi.high, true)})` : '';
  const base = r.baseline
    ? `Random entries with the same legs and exits averaged ${inr(r.baseline.expectancy, true)} a trade; this strategy beat ${r.baseline.percentile}% of ${r.baseline.runs} such runs.`
    : r.strategy.entry.conditions.length ? 'No baseline (no trades).' : 'No baseline: with no entry conditions the strategy already is the time-only version.';
  $('labVerdict').innerHTML = `<span class="lab-verdict ${cls}">${escapeHtml(title)}</span> <span class="pt-muted">${escapeHtml(explain)}</span>`;
  const card = (label, value, sub = '', c = '') => `<div class="glance-card"><div class="glance-label">${label}</div><div class="glance-big ${c}">${value}</div><div class="glance-line pt-muted">${sub}</div></div>`;
  $('labCards').innerHTML = [
    card('Trades', r.trades, `${r.data.sessions} sessions, ${escapeHtml(r.data.from || '')} to ${escapeHtml(r.data.to || '')}`),
    card('Win rate', pct(r.winRate), `95%: ${pct(r.winRateCi.low)} to ${pct(r.winRateCi.high)}`),
    card('Average trade', inr(r.expectancy, true), escapeHtml(ci.replace(/^ \(|\)$/g, '')), r.expectancy > 0 ? 'bull' : r.expectancy < 0 ? 'bear' : ''),
    card('Total after charges', inr(r.totalNet, true), `charges ${inr(r.totalCharges)}`, r.totalNet > 0 ? 'bull' : r.totalNet < 0 ? 'bear' : ''),
    card('Max drawdown', inr(-r.maxDrawdown), `worst trade ${inr(r.worst, true)}`),
    card('Profit factor', r.profitFactor === null ? 'n/a' : r.profitFactor.toFixed(2), `avg win ${inr(r.avgWin)}, avg loss ${inr(r.avgLoss)}`),
    card('Capital needed', inr(r.capitalNeeded), r.fitsCapital ? `fits ${inr(r.capital)}` : `more than the account's ${inr(r.capital)}`, r.fitsCapital ? '' : 'bear'),
    card('Exits', Object.entries(r.exits).map(([k, v]) => `${v} ${k}`).join(', ') || 'n/a', `average hold ${r.avgMinutes} min`)
  ].join('');
  $('labBaseline').textContent = base;
  const c = deps.chartColors();
  const pts = [{ x: 'Start', y: r.capital }, ...r.curve.map(p => ({ x: p.day, y: p.equity }))];
  deps.drawChart('lab', 'labChart', {
    type: 'line',
    data: { labels: pts.map(p => p.x), datasets: [{ label: 'Equity', data: pts.map(p => p.y), borderColor: r.totalNet >= 0 ? c.bull : c.bear, borderWidth: 2, pointRadius: 0, tension: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => inr(item.parsed.y) } } },
      scales: { x: { ticks: { color: c.text, maxTicksLimit: 8 }, grid: { color: c.grid } }, y: { ticks: { color: c.text, callback: v => `₹${Math.round(v).toLocaleString('en-IN')}` }, grid: { color: c.grid } } }
    }
  });
  const time = t => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  $('labTrades').innerHTML = r.trades ? `<table class="pt-table"><thead><tr><th>Day</th><th>In</th><th>Out</th><th class="right">NIFTY</th><th>Legs (entry to exit)</th><th class="right">Net</th><th>Exit</th></tr></thead><tbody>${r.tradeList.slice().reverse().map(t => `<tr>
      <td>${escapeHtml(t.day)}</td><td>${time(t.entryT)}</td><td>${time(t.exitT)}</td>
      <td class="right">${t.entryIndex.toFixed(0)} to ${t.exitIndex.toFixed(0)}</td>
      <td class="pt-note">${t.legs.map(l => `${escapeHtml(l.label)} ${l.entry.toFixed(2)} to ${l.exit.toFixed(2)}`).join('<br>')}</td>
      <td class="right ${t.net > 0 ? 'pt-pos' : t.net < 0 ? 'pt-neg' : ''}">${inr(t.net, true)}</td><td>${escapeHtml(t.reason)}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty-note">No trades: the conditions never lined up inside the window.</div>';
  $('labAssumptions').innerHTML = r.assumptions.map(a => `<li>${escapeHtml(a)}</li>`).join('');
}

// ── actions ──

async function loadLists() {
  const r = await deps.api('/strategies');
  if (!r.ok) return;
  saved = r.saved;
  presets = r.presets;
  if (!current) current = { id: null, strategy: clone(presets[0] || blank()) };
  renderList();
  renderEditor();
}

export function initLab(d) {
  deps = d;
  ['labName', 'labInterval', 'labFrom', 'labTo', 'labMaxTrades', 'labExitAt', 'labMovePts'].forEach(id => $(id).addEventListener('change', syncFromForm));
}

export function openLab() {
  if (!presets.length) loadLists();
}

export function labRedraw() {
  if (report) renderReport();
}

export function labNew() {
  current = { id: null, strategy: blank() };
  report = null;
  renderList(); renderEditor(); renderReport();
}

export function labPreset(i) {
  const p = presets[Number(i)];
  if (!p) return;
  current = { id: null, strategy: clone(p) };
  report = null;
  renderList(); renderEditor(); renderReport();
}

export function labLoad(id) {
  const row = saved.find(r => r.id === id);
  if (!row) return;
  current = { id: row.id, strategy: clone(row.strategy) };
  report = null;
  renderList(); renderEditor(); renderReport();
}

export function labAddCond() {
  syncFromForm();
  const type = $('labCondType').value;
  if (current.strategy.entry.conditions.length >= 6) { $('labError').textContent = 'At most 6 conditions.'; return; }
  current.strategy.entry.conditions.push({ type, ...CONDITION_DEFAULTS[type] });
  renderEditor();
}

export function labRemoveCond(i) {
  syncFromForm();
  current.strategy.entry.conditions.splice(Number(i), 1);
  renderEditor();
}

export function labAddLeg() {
  syncFromForm();
  if (current.strategy.legs.length >= 4) return;
  current.strategy.legs.push({ side: 'BUY', optionType: 'PE', strikeOffset: 0, lots: 1, expiry: 'weekly' });
  renderEditor();
}

export function labRemoveLeg(i) {
  syncFromForm();
  current.strategy.legs.splice(Number(i), 1);
  renderEditor();
}

export async function labRun() {
  if (running) return;
  syncFromForm();
  running = true;
  const btn = $('labRun');
  btn.disabled = true;
  btn.textContent = 'Running…';
  $('labError').textContent = '';
  const r = await deps.api('/backtest', { method: 'POST', body: { strategy: current.strategy, accountId: deps.getAccountId() || undefined } });
  running = false;
  btn.disabled = false;
  btn.textContent = 'Run backtest';
  if (!r.ok) { $('labError').textContent = r.error || 'Backtest failed.'; return; }
  report = r.report;
  renderReport();
}

async function persist(asNew) {
  syncFromForm();
  $('labError').textContent = '';
  const path = !asNew && current.id ? `/strategies/${encodeURIComponent(current.id)}` : '/strategies';
  const r = await deps.api(path, { method: !asNew && current.id ? 'PUT' : 'POST', body: { strategy: current.strategy } });
  if (!r.ok) { $('labError').textContent = r.error || 'Could not save.'; return; }
  current = { id: r.saved.id, strategy: clone(r.saved.strategy) };
  await loadLists();
}

export function labSave() { return persist(false); }
export function labSaveAs() { return persist(true); }

export async function labDelete() {
  if (!current.id) return;
  if (Date.now() >= armedDelete) {
    armedDelete = Date.now() + 4000;
    renderEditor();
    setTimeout(() => { if (Date.now() >= armedDelete) renderEditor(); }, 4100);
    return;
  }
  armedDelete = 0;
  const r = await deps.api(`/strategies/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
  if (!r.ok) { $('labError').textContent = r.error || 'Could not delete.'; return; }
  current = null;
  report = null;
  await loadLists();
  renderReport();
}

export async function labCopyJson(e) {
  syncFromForm();
  try {
    await navigator.clipboard.writeText(JSON.stringify(current.strategy, null, 2));
    const b = e && e.target;
    if (b) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy as JSON'; }, 1500); }
  } catch (err) {
    $('labError').textContent = 'Copy failed.';
  }
}
