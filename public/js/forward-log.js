// "Live track record": how the chart's signals and zones actually did after they were shown. Recorded by the cron job,
// scored against later candles. Built with textContent only (never HTML strings), so nothing from the network can inject markup.
import { fetchForwardLog } from './api-client.js';

const REFRESH_MS = 5 * 60 * 1000;
let fetchedAt = 0;
let inflight = false;

const VERDICT = { edge: 'edge so far', none: 'no clear edge', negative: 'worse than chance', insufficient: 'too few trades' };
const pc = x => (x === null || x === undefined ? 'n/a' : Math.round(x * 100) + '%');
const hm = t => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const day = t => new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(cells, cls) {
  const tr = el('tr', cls);
  cells.forEach(c => tr.append(el('td', c.cls || '', c.text)));
  return tr;
}

function winRow(label, s) {
  const range = s.decided ? `${pc(s.ci.low)} to ${pc(s.ci.high)}` : 'n/a';
  return row([
    { text: label },
    { text: String(s.decided) },
    { text: pc(s.winRate) },
    { text: range },
    { text: s.avgR === null ? 'n/a' : (s.avgR > 0 ? '+' : '') + s.avgR + 'R' },
    { text: VERDICT[s.verdict] || s.verdict, cls: `verdict-${s.verdict}` }
  ]);
}

function holdRow(label, s) {
  const range = s.decided ? `${pc(s.ci.low)} to ${pc(s.ci.high)}` : 'n/a';
  return row([
    { text: label },
    { text: String(s.decided) },
    { text: pc(s.holdRate) },
    { text: range },
    { text: `${s.untouched} untouched` },
    { text: VERDICT[s.verdict] || s.verdict, cls: `verdict-${s.verdict}` }
  ]);
}

function table(headers, rows) {
  const wrap = el('div', 'table-scroll');
  const t = el('table', 'pattern-table');
  const head = el('tr');
  headers.forEach(h => head.append(el('th', '', h)));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  rows.forEach(r => tbody.append(r));
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}

const OUTCOME = { win: 'won', loss: 'stopped out', flat: 'flat', held: 'held', broke: 'broke', inconclusive: 'no clear result' };

export function renderForwardLog(host, log) {
  host.textContent = '';
  if (!log) { host.append(el('div', 'timeline-empty', 'Loading the live record...')); return; }
  if (log.persistent === false) {
    host.append(el('div', 'timeline-empty', 'The live record needs storage (Upstash) so the per-minute job can save it.'));
    return;
  }
  const st = log.stats;
  if (!st || (st.signals.recorded === 0 && st.zones.recorded === 0)) {
    host.append(el('div', 'timeline-empty', 'Nothing recorded yet. The per-minute job saves each confirmed signal and zone during market hours and scores it afterwards.'));
    return;
  }
  const s = st.signals, z = st.zones;
  host.append(el('div', 'panel-note', `Recording since ${day(log.since)}. Signals: ${s.recorded} saved, ${s.overall.decided} decided (won or stopped out), ${s.neverTriggered} never triggered, ${s.open} still open. A fair coin wins 50% of decided trades, so a result is only called an edge with ${st.minSamples} or more decided trades and a range that clears 50%.`));

  const sigRows = [winRow('All signals', s.overall)];
  [['Grade ', s.byGrade], ['', s.byOptions], ['', s.byVolume]].forEach(([prefix, group]) => {
    Object.entries(group).sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => sigRows.push(winRow(prefix + k, v)));
  });
  host.append(el('div', 'panel-note', 'Signals (1R target, stop at the invalidation level)'));
  host.append(table(['Group', 'Decided', 'Win rate', 'Range', 'Avg result', 'Verdict'], sigRows));

  const zoneRows = [holdRow('All zones', z.overall)];
  [z.bySide, z.byEvidence].forEach(group => Object.entries(group).forEach(([k, v]) => zoneRows.push(holdRow(k === 'buy' ? 'Buying zones' : k === 'sell' ? 'Selling zones' : k, v))));
  host.append(el('div', 'panel-note', `Zones (held = price moved 1 ATR away before closing through). ${z.recorded} saved, ${z.open} open.`));
  host.append(table(['Group', 'Decided', 'Hold rate', 'Range', 'Not touched', 'Verdict'], zoneRows));

  if (log.recent && log.recent.length) {
    host.append(el('div', 'panel-note', 'Latest results'));
    const list = el('ul', 'signal-evidence');
    log.recent.slice(0, 10).forEach(e => {
      const what = e.kind === 'zone'
        ? `${e.side === 'buy' ? 'Buying' : 'Selling'} zone ${Math.round(e.low)} to ${Math.round(e.high)}`
        : `${e.label} (${e.dir === 'bull' ? 'bullish' : 'bearish'}, ${e.interval})`;
      const r = Number.isFinite(e.rMultiple) ? ` ${e.rMultiple > 0 ? '+' : ''}${e.rMultiple}R` : '';
      list.append(el('li', '', `${day(e.t)} ${hm(e.t)}  ${what}: ${OUTCOME[e.outcome] || e.outcome}${r}`));
    });
    host.append(list);
  }
}

export async function refreshForwardLog(force = false) {
  const host = document.getElementById('forwardLog');
  if (!host || inflight || document.hidden) return;
  if (!force && Date.now() - fetchedAt < REFRESH_MS) return;
  inflight = true;
  try {
    renderForwardLog(host, await fetchForwardLog());
    fetchedAt = Date.now();
  } catch (e) {
    console.error('Forward log fetch failed:', e);
    if (!fetchedAt) renderForwardLog(host, { persistent: true, stats: null });
  } finally {
    inflight = false;
  }
}
