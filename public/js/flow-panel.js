// Renders the Smart Money Flow panel body and the "At a glance" cards. DOM built with textContent only: strike numbers and
// summaries come from the network, so nothing here ever goes through innerHTML.

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const num = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : 'n/a');
const oi = n => {
  const a = Math.abs(n), sign = n < 0 ? '-' : '+';
  return a >= 1e5 ? `${sign}${(a / 1e5).toFixed(1)}L` : `${sign}${(a / 1e3).toFixed(0)}k`;
};
const dist = p => (Math.abs(p) < 0.05 ? 'at the money' : `${Math.abs(p).toFixed(2)}% ${p > 0 ? 'above' : 'below'} spot`);

const VERDICT = {
  bullish: { text: 'Buying pressure', cls: 'bull' },
  bearish: { text: 'Selling pressure', cls: 'bear' },
  mixed: { text: 'Mixed', cls: 'mixed' },
  quiet: { text: 'Quiet', cls: 'quiet' }
};

function itemRow(i) {
  const row = el('div', 'flow-item');
  const top = el('div', 'flow-item-top');
  top.append(el('strong', '', num(i.strike)), el('span', 'flow-item-what', `${i.label} ${oi(i.delta)}`));
  row.append(top);
  const sub = el('div', 'flow-item-sub', `${dist(i.distancePct)}; ${i.meaning}`);
  row.append(sub);
  if (i.level) row.append(el('div', 'flow-item-level', `At ${i.level.kind} zone ${num(i.level.low)} to ${num(i.level.high)} (strength ${i.level.strength})`));
  return row;
}

function column(title, cls, list, emptyText) {
  const col = el('div', `flow-col ${cls}`);
  col.append(el('div', 'flow-col-title', title));
  if (!list.length) { col.append(el('div', 'flow-col-empty', emptyText)); return col; }
  list.slice(0, 3).forEach(i => col.append(itemRow(i)));
  if (list.length > 3) col.append(el('div', 'flow-col-more', `+${list.length - 3} more`));
  return col;
}

/** ctx: { window: '5m' | 'recent' | null, marketOpen: bool } */
export function renderFlowPanel(host, flow, ctx = {}) {
  host.textContent = '';
  const v = VERDICT[flow.verdict] || VERDICT.quiet;
  const head = el('div', 'flow-verdictbar');
  head.append(el('span', `flow-verdict ${v.cls}`, v.text));
  head.append(el('span', 'flow-headline', ctx.window ? flow.headline : ctx.marketOpen ? 'Needs about 5 minutes of saved snapshots to measure OI moves' : 'Market closed: flow resumes when trading opens'));
  host.append(head);

  const meter = el('div', 'flow-meter');
  meter.append(el('span', 'flow-meter-mid'));
  const mark = el('span', `flow-meter-mark ${v.cls}`);
  mark.style.left = `${Math.max(2, Math.min(98, 50 + flow.score / 2))}%`;
  meter.append(mark);
  const scale = el('div', 'flow-meter-scale');
  scale.append(el('span', '', 'Selling'), el('span', '', ctx.window ? `Last ${ctx.window === '5m' ? '5 minutes' : 'few minutes'}` : ''), el('span', '', 'Buying'));
  host.append(meter, scale);

  if (flow.count === 0) {
    const why = !ctx.window ? '' : ctx.marketOpen ? 'No strike has added or removed enough open interest to count. This is normal for most minutes.' : 'The market is closed. Flow resumes when trading opens.';
    if (why) host.append(el('div', 'empty-note', why));
  } else {
    const cols = el('div', 'flow-cols');
    cols.append(
      column('Supporting price (buying)', 'bull', flow.bullish, 'None right now'),
      column('Pressing price (selling)', 'bear', flow.bearish, 'None right now')
    );
    host.append(cols);
  }

  if (flow.heavy.length) {
    const heavy = el('div', 'flow-heavy');
    heavy.append(el('span', 'flow-heavy-label', 'Heavy contract activity'));
    flow.heavy.slice(0, 5).forEach(h => heavy.append(el('span', `flow-chip-lite ${h.intensity === 'CRITICAL' ? 'crit' : ''}`, `${num(h.strike)} ${h.optionType}`)));
    host.append(heavy);
  }
}

/**
 * "At a glance": four plain cards so the first screen answers "where is price, what is near it, what do options say and
 * who is pushing". inputs: { d, flow, levels: { above, below } | null }
 */
export function renderGlance(host, { d, flow, levels }) {
  host.textContent = '';
  if (!d) return;
  const card = (label, big, bigCls, lines) => {
    const c = el('div', 'glance-card');
    c.append(el('div', 'glance-label', label), el('div', `glance-big ${bigCls || ''}`, big));
    lines.forEach(([text, cls]) => c.append(el('div', `glance-line ${cls || ''}`, text)));
    return c;
  };

  // 1. price
  const day = d.day;
  const chg = day && Number.isFinite(day.percentChange) ? day.percentChange : null;
  host.append(card('NIFTY', num(d.spot), chg === null ? '' : chg >= 0 ? 'bull' : 'bear', [
    [chg === null ? 'Day change n/a' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% today`, chg === null ? '' : chg >= 0 ? 'bull' : 'bear'],
    [day && Number.isFinite(day.low) && Number.isFinite(day.high) ? `Range ${num(day.low)} to ${num(day.high)}` : '', 'muted']
  ].filter(l => l[0])));

  // 2. nearest levels: the chart's strongest zones if loaded, else the biggest OI walls
  const up = levels && levels.above, down = levels && levels.below;
  const lines = [];
  if (up) lines.push([`Resistance ${num(up.mid)} (${up.distancePct > 0 ? '+' : ''}${up.distancePct}%), strength ${up.strength}`, 'bear']);
  else if (Number.isFinite(d.maxCallOIStrike)) lines.push([`Call wall ${num(d.maxCallOIStrike)}`, 'bear']);
  if (down) lines.push([`Support ${num(down.mid)} (${down.distancePct}%), strength ${down.strength}`, 'bull']);
  else if (Number.isFinite(d.maxPutOIStrike)) lines.push([`Put wall ${num(d.maxPutOIStrike)}`, 'bull']);
  let big = 'n/a';
  if (up && down) big = `${num(down.mid)} to ${num(up.mid)}`;
  else if (Number.isFinite(d.maxPutOIStrike) && Number.isFinite(d.maxCallOIStrike)) big = `${num(d.maxPutOIStrike)} to ${num(d.maxCallOIStrike)}`;
  host.append(card('Nearest support and resistance', big, '', lines));

  // 3. options bias in plain words
  const pcr = Number.isFinite(d.pcr) ? d.pcr : null;
  const zone = pcr === null ? null : pcr > 1.2 ? 'bull' : pcr < 0.8 ? 'bear' : 'neutral';
  const zoneText = { bull: 'Leaning bullish', bear: 'Leaning bearish', neutral: 'Neutral', null: 'n/a' }[zone];
  host.append(card('Options say', zoneText, zone === 'bull' ? 'bull' : zone === 'bear' ? 'bear' : '', [
    [pcr === null ? '' : `PCR ${pcr.toFixed(2)} (above 1.2 bullish, below 0.8 bearish)`, 'muted'],
    [Number.isFinite(d.maxPain) ? `Max pain ${num(d.maxPain)}` : '', 'muted'],
    [d.compositeRegime && d.compositeRegime.regimeLabel ? d.compositeRegime.regimeLabel : '', 'muted']
  ].filter(l => l[0])));

  // 4. flow
  const v = VERDICT[flow.verdict] || VERDICT.quiet;
  host.append(card('Smart money flow', v.text, v.cls === 'quiet' || v.cls === 'mixed' ? '' : v.cls, [
    [flow.count ? flow.headline : 'No strike is moving enough right now', 'muted']
  ]));
}
