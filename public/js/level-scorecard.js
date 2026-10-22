// "How reliable are these level types?": the measured scorecard behind the ladder's weights.
// Built with textContent only (never HTML strings); the numbers come from the server.
import { fetchLevelScorecard } from './api-client.js';

const REFRESH_MS = 30 * 60 * 1000;
let fetchedAt = 0;
let inflight = false;

const LABELS = {
  prevHigh: 'Previous day high', prevLow: 'Previous day low', prevClose: 'Previous close',
  weekHigh: 'Previous week high', weekLow: 'Previous week low',
  cprPivot: 'CPR pivot', cprEdge: 'CPR top / bottom', pivotR: 'Pivot R1 / R2', pivotS: 'Pivot S1 / S2',
  swingHigh: 'Swing high', swingLow: 'Swing low', vwap: 'VWAP',
  poc: 'Volume point of control', vah: 'Value area high', val: 'Value area low', hvn: 'High volume node', round: 'Round number'
};
const VERDICT = { respected: 'respected more than random', ignored: 'respected less than random', none: 'no clear difference', insufficient: 'too few touches' };
const pc = x => (x === null || x === undefined ? 'n/a' : Math.round(x * 100) + '%');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderLevelScorecard(host, card) {
  host.textContent = '';
  if (!card) { host.append(el('div', 'empty-note', 'Loading the level scorecard...')); return; }
  if (card.unavailable) { host.append(el('div', 'empty-note', 'The scorecard needs candle history and is not available right now.')); return; }

  host.append(el('div', 'panel-note', `Measured on ${card.sessions} sessions of 5 minute candles. A touch is price reaching a level after being clearly on one side; a bounce is moving half an ATR away before closing a quarter ATR through it. Arbitrary price points put through the same test bounced ${pc(card.null.bounceRate)} of the time, so a level type only counts as respected if it clearly beats that. Touches cluster, so the ranges are somewhat optimistic.`));

  const wrap = el('div', 'table-scroll');
  const t = el('table', 'pattern-table');
  const head = el('tr');
  ['Level type', 'Touches', 'Bounce rate', 'Range', 'Verdict', 'Weight in ladder'].forEach(h => head.append(el('th', '', h)));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  Object.entries(card.types)
    .sort(([, a], [, b]) => b.decided - a.decided)
    .forEach(([type, s]) => {
      const tr = el('tr');
      const mult = card.multipliers && card.multipliers[type];
      [
        [LABELS[type] || type, ''],
        [String(s.touches), ''],
        [pc(s.bounceRate), ''],
        [s.decided ? `${pc(s.ci.low)} to ${pc(s.ci.high)}` : 'n/a', ''],
        [VERDICT[s.verdict] || s.verdict, `verdict-${s.verdict === 'respected' ? 'edge' : s.verdict === 'ignored' ? 'negative' : s.verdict}`],
        [mult ? `x${mult}` : 'default', '']
      ].forEach(([text, cls]) => tr.append(el('td', cls, text)));
      tbody.append(tr);
    });
  t.append(thead, tbody);
  wrap.append(t);
  host.append(wrap);
  host.append(el('div', 'panel-note', 'Not measurable here: option OI walls, max pain and the zero-gamma level, because past option chains are not available. They are tracked in the live track record instead.'));
}

export async function refreshLevelScorecard(force = false) {
  const host = document.getElementById('levelScorecard');
  if (!host || inflight || document.hidden) return;
  if (!force && Date.now() - fetchedAt < REFRESH_MS) return;
  inflight = true;
  try {
    renderLevelScorecard(host, await fetchLevelScorecard());
    fetchedAt = Date.now();
  } catch (e) {
    console.error('Level scorecard fetch failed:', e);
    if (!fetchedAt) renderLevelScorecard(host, { unavailable: true });
  } finally {
    inflight = false;
  }
}
