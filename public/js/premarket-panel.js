// Pre-market panel: overnight cues from /api/premarket, shown only in the 120 minutes before the open (07:15-09:15 IST)
// on NSE trading days. DOM built with textContent only. Window logic is pure so api/verify-premarket.js can test it.

const IST_OFFSET_MS = 330 * 60000;
export const PREMARKET_FROM_MIN = 7 * 60 + 15;
export const PREMARKET_TO_MIN = 9 * 60 + 15;

/** True from 07:15 to 09:15 IST on a weekday that is not an NSE holiday (`holidays`: Set of YYYY-MM-DD). */
export function inPremarketWindow(ms, holidays = new Set()) {
  const d = new Date(ms + IST_OFFSET_MS);
  const dow = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && !holidays.has(d.toISOString().slice(0, 10)) && mins >= PREMARKET_FROM_MIN && mins < PREMARKET_TO_MIN;
}

/** Minutes until 09:15 IST from `ms` (0 at or after it). */
export function minutesToOpen(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return Math.max(0, PREMARKET_TO_MIN - (d.getUTCHours() * 60 + d.getUTCMinutes()));
}

const GROUPS = [
  { key: 'usFut', title: 'US futures (trading now)' },
  { key: 'asia', title: 'Asia (trading now)' },
  { key: 'us', title: 'US close' },
  { key: 'macro', title: 'Rupee, commodities, yields' }
];

// India imports most of its oil, so a weaker rupee and dearer crude are coloured as headwinds (red when they rise).
const INVERTED = new Set(['usdinr', 'brent']);

const LEAN_TEXT = {
  positive: { cls: 'up', text: 'Overnight cues lean positive' },
  negative: { cls: 'down', text: 'Overnight cues lean negative' },
  flat: { cls: '', text: 'Overnight cues are mixed or flat' },
  unknown: { cls: '', text: 'Not enough overnight quotes to judge' }
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const price = n => (Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: n < 10 ? 3 : 2 }) : 'n/a');
const pctText = n => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : 'n/a');
const asOfText = ms => {
  if (!Number.isFinite(ms)) return '';
  const opts = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
  const sameDay = new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10) === new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  return sameDay ? new Date(ms).toLocaleTimeString('en-IN', opts) : new Date(ms).toLocaleString('en-IN', { ...opts, weekday: 'short' });
};

function cueRow(item) {
  const row = el('div', 'pm-row');
  const name = el('div', 'pm-name');
  name.append(el('span', '', item.label));
  if (item.asOf) name.append(el('span', 'pm-asof', asOfText(item.asOf)));
  let changeText, cls = '';
  if (item.bps) {
    const bps = Number.isFinite(item.change) ? item.change * 100 : null;
    changeText = bps === null ? 'n/a' : `${bps > 0 ? '+' : ''}${bps.toFixed(0)} bps`;
    cls = bps > 0 ? 'down' : bps < 0 ? 'up' : ''; // higher yields usually weigh on equities
  } else {
    changeText = pctText(item.changePct);
    cls = INVERTED.has(item.key) ? (item.changePct > 0 ? 'down' : item.changePct < 0 ? 'up' : '') // weaker rupee, dearer crude read negative
      : item.changePct > 0 ? 'up' : item.changePct < 0 ? 'down' : '';
  }
  row.append(name, el('span', 'pm-price', item.bps ? `${price(item.price)}%` : price(item.price)), el('span', `pm-chg ${cls}`, changeText));
  return row;
}

/** Render the cues into `host`. `data` is the /api/premarket response (or null while loading / after a failure). */
export function renderPremarket(host, data, { nowMs = Date.now(), error = false } = {}) {
  host.textContent = '';
  if (!data) {
    host.append(el('div', 'empty-note', error ? 'Overnight quotes are unavailable right now.' : 'Loading overnight quotes...'));
    return;
  }
  const items = data.items || [];
  const nifty = items.find(i => i.key === 'nifty');
  const lean = LEAN_TEXT[data.lean && data.lean.label] || LEAN_TEXT.unknown;

  const head = el('div', 'pm-head');
  head.append(el('span', `pm-lean ${lean.cls}`, lean.text));
  if (data.lean && data.lean.count >= 3) {
    head.append(el('span', 'pm-sub', `${data.lean.up} of ${data.lean.count} up, average ${pctText(data.lean.avgPct)} (US futures and Asia)`));
  }
  const mins = minutesToOpen(nowMs);
  head.append(el('span', 'pm-sub', mins > 0 ? `Open in ${mins >= 60 ? `${Math.floor(mins / 60)} h ` : ''}${mins % 60} min` : 'Opening now'));
  host.append(head);

  if (nifty && nifty.price) {
    host.append(el('div', 'pm-nifty', `NIFTY last close ${price(nifty.price)} (${pctText(nifty.changePct)} that session).`));
  }

  const grid = el('div', 'pm-grid');
  GROUPS.forEach(g => {
    const rows = items.filter(i => i.group === g.key);
    if (!rows.length) return;
    const card = el('div', 'pm-card');
    card.append(el('div', 'pm-card-title', g.title));
    rows.forEach(i => card.append(cueRow(i)));
    grid.append(card);
  });
  host.append(grid);
  host.append(el('div', 'xd-fine', `Quotes from Yahoo Finance (delayed, unofficial)${data.stale ? ', last refresh failed so these may be a few minutes old' : ''}. GIFT Nifty has no free source, so this shows how markets moved overnight, not where NIFTY will open.`));
}
