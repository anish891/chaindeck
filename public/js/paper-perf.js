// Performance view on the paper trading page: every account side by side, then the selected account split by who
// traded (you, each agent, each live strategy, expiry settlement) and by tag, with CSV downloads.

import { escapeHtml } from './ui-utils.js';

const $ = id => document.getElementById(id);
let deps = null; // { api, inr, getAccountId }

export function initPerf(d) {
  deps = d;
}

const pctText = x => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const cls = x => (x > 0 ? 'pt-pos' : x < 0 ? 'pt-neg' : '');

function bucketTable(rows, first) {
  const { inr } = deps;
  if (!rows.length) return '<div class="empty-note">Nothing yet.</div>';
  return `<table class="pt-table"><thead><tr><th>${first}</th><th class="right">Fills</th><th class="right">Closes</th><th class="right">Win rate</th><th class="right">Booked</th><th class="right">Charges</th><th class="right">Net</th></tr></thead><tbody>${rows.map(b => `<tr>
    <td>${escapeHtml(b.label)}</td><td class="right">${b.fills}</td><td class="right">${b.closes}</td>
    <td class="right">${b.closes ? pctText(b.wins / b.closes) : 'n/a'}</td>
    <td class="right ${cls(b.realized)}">${inr(b.realized, true)}</td><td class="right">${inr(b.charges)}</td>
    <td class="right ${cls(b.net)}">${inr(b.net, true)}</td>
  </tr>`).join('')}</tbody></table>`;
}

export async function loadPerf() {
  const { inr } = deps;
  const id = deps.getAccountId();
  const [cmp, an] = await Promise.all([deps.api('/compare'), id ? deps.api(`/accounts/${encodeURIComponent(id)}/analytics`) : Promise.resolve({ ok: false })]);
  if (cmp.ok) {
    $('perfCompare').innerHTML = `<table class="pt-table"><thead><tr><th>Account</th><th>Traded by</th><th class="right">Equity</th><th class="right">Return</th><th class="right">Max drawdown</th><th class="right">Closes</th><th class="right">Win rate</th><th class="right">Profit factor</th><th class="right">Charges</th></tr></thead><tbody>${cmp.accounts.map(a => `<tr${a.id === id ? ' class="pt-atm"' : ''}>
      <td><b>${escapeHtml(a.name)}</b></td><td class="pt-note">${escapeHtml(a.traders.join(', ') || 'nobody yet')}</td>
      <td class="right">${inr(a.equity)}</td><td class="right ${cls(a.returnPct)}">${a.returnPct > 0 ? '+' : ''}${a.returnPct.toFixed(2)}%</td>
      <td class="right">${a.maxDrawdownPct ? `-${a.maxDrawdownPct.toFixed(2)}%` : '0%'}</td>
      <td class="right">${a.closes}</td><td class="right">${pctText(a.winRate)}</td>
      <td class="right">${a.profitFactor === null ? 'n/a' : a.profitFactor.toFixed(2)}</td><td class="right">${inr(a.charges)}</td>
    </tr>`).join('')}</tbody></table>`;
  }
  if (!an.ok) return;
  const x = an.analytics;
  $('perfName').textContent = x.name;
  $('perfCsvTrades').href = `/api/paper/accounts/${encodeURIComponent(x.id)}/export?kind=trades`;
  $('perfCsvOrders').href = `/api/paper/accounts/${encodeURIComponent(x.id)}/export?kind=orders`;
  const card = (label, value, sub = '', c = '') => `<div class="glance-card"><div class="glance-label">${label}</div><div class="glance-big ${c}">${value}</div><div class="glance-line pt-muted">${sub}</div></div>`;
  $('perfCards').innerHTML = [
    card('Return', `${x.returnPct > 0 ? '+' : ''}${x.returnPct.toFixed(2)}%`, `equity ${inr(x.equity)} from ${inr(x.startingCapital)}`, x.returnPct > 0 ? 'bull' : x.returnPct < 0 ? 'bear' : ''),
    card('Max drawdown', x.maxDrawdown ? inr(-x.maxDrawdown) : inr(0), `${x.maxDrawdownPct.toFixed(2)}% from the peak`),
    card('Win rate', pctText(x.winRate), `${x.closes} closing fills`),
    card('Profit factor', x.profitFactor === null ? 'n/a' : x.profitFactor.toFixed(2), `avg win ${x.avgWin === null ? 'n/a' : inr(x.avgWin)}, avg loss ${x.avgLoss === null ? 'n/a' : inr(x.avgLoss)}`),
    card('Charges', inr(x.charges), x.chargesPctOfGross === null ? 'nothing booked yet' : `${x.chargesPctOfGross.toFixed(0)}% of booked P&L`),
    card('Best day', x.bestDay ? inr(x.bestDay.change, true) : 'n/a', x.bestDay ? x.bestDay.ymd : `${x.tradingDays} days recorded`, x.bestDay && x.bestDay.change > 0 ? 'bull' : ''),
    card('Worst day', x.worstDay ? inr(x.worstDay.change, true) : 'n/a', x.worstDay ? x.worstDay.ymd : 'closing equity is recorded after 15:30', x.worstDay && x.worstDay.change < 0 ? 'bear' : ''),
    card('Open P&L', inr(x.unrealized, true), `booked ${inr(x.realized, true)}`, cls(x.unrealized) === 'pt-pos' ? 'bull' : cls(x.unrealized) === 'pt-neg' ? 'bear' : '')
  ].join('');
  $('perfWho').innerHTML = bucketTable(x.byWho, 'Who');
  $('perfTags').innerHTML = x.byTag.length ? bucketTable(x.byTag, 'Tag') : '<div class="empty-note">No tagged orders yet. Live strategies tag their orders with the strategy name, and agents can send a tag.</div>';
  $('perfNote').textContent = ['Win rate and averages count fills that closed (part of) a position; charges are counted on every fill.', x.historyNote].filter(Boolean).join(' ');
}
