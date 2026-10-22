// "When do patterns work?": the conditional backtest by time of day, day type and level context.
// Built with textContent only (never HTML strings); the numbers come from the server.

const TITLES = { time: 'By time of day', dayType: 'By kind of day so far', level: 'By level context' };
const BUCKETS = {
  time: { open: 'First hour', midday: 'Midday', close: 'Last hour' },
  dayType: { trending: 'Trending day', ranging: 'Ranging day', early: 'Too early to tell' },
  level: { stacked: 'At stacked levels', single: 'At one level', open: 'In open space' }
};
const ORDER = { time: ['open', 'midday', 'close'], dayType: ['trending', 'ranging', 'early'], level: ['stacked', 'single', 'open'] };
const VERDICT = { edge: 'better than usual', none: 'no clear difference', negative: 'worse than usual', insufficient: 'too few' };
const pc = x => (x === null || x === undefined ? 'n/a' : Math.round(x * 100) + '%');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderConditionalStats(host, conditional) {
  host.textContent = '';
  if (!conditional) return; // daily candles have no time-of-day, and history may be unavailable
  let flagged = 0;
  const tables = [];
  for (const dim of Object.keys(TITLES)) {
    const dimData = conditional.dims[dim] || {};
    const rows = [];
    for (const bucket of ORDER[dim]) {
      const byDir = dimData[bucket];
      if (!byDir) continue;
      for (const dir of ['bull', 'bear']) {
        const s = byDir[dir];
        if (!s) continue;
        if (s.verdict === 'edge' || s.verdict === 'negative') flagged += 1;
        const tr = el('tr');
        [
          [BUCKETS[dim][bucket], ''],
          [dir === 'bull' ? 'Bullish' : 'Bearish', dir === 'bull' ? 'bull' : 'bear'],
          [String(s.n), ''],
          [pc(s.hitRate), ''],
          [`${pc(s.baseline)} (${s.baselineN} candles)`, ''],
          [VERDICT[s.verdict] || s.verdict, `verdict-${s.verdict}`]
        ].forEach(([text, cls]) => tr.append(el('td', cls, text)));
        rows.push(tr);
      }
    }
    if (!rows.length) continue;
    const wrap = el('div', 'table-scroll');
    const t = el('table', 'pattern-table');
    const head = el('tr');
    ['Condition', 'Direction', 'Patterns', 'Hit rate', 'Any candle', 'Verdict'].forEach(h => head.append(el('th', '', h)));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    rows.forEach(r => tbody.append(r));
    t.append(thead, tbody);
    wrap.append(t);
    tables.push([TITLES[dim], wrap]);
  }
  host.append(el('div', 'panel-note', `When do reversal patterns work? The same history, split by conditions known when the pattern completed. Each row compares the pattern's hit rate with how often ANY candle in the same condition moved that way. ${flagged ? `${flagged} condition${flagged > 1 ? 's' : ''} stand out and move the signal score.` : 'Nothing stands out: in every condition the patterns do about as well as chance, so no condition changes the signal score.'} Only the notable pattern types are counted. Rows with fewer than ${30} patterns are never called either way.`));
  tables.forEach(([title, wrap]) => { host.append(el('div', 'panel-note', title)); host.append(wrap); });
}
