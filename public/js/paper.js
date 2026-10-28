// Paper trading page: sign in, option chain, order ticket, blotter, payoff and equity.
// Talks only to /api/paper (owner only). All state lives on the server; this page just renders it.

import { escapeHtml, hmIst } from './ui-utils.js';
import { setIconText, themeIcon } from './icons.js';
import { payoffSeries } from './paper-payoff.js';

const $ = id => document.getElementById(id);
const OPEN_POLL_MS = 5000;
const CLOSED_POLL_MS = 60000;
const PREVIEW_DELAY_MS = 350;

let accounts = [];
let accountId = null;
let account = null;       // GET /accounts/:id
let market = null;        // GET /market
let expiry = null;
let tab = 'positions';
let ticket = { instrument: null, side: 'BUY' };
let pollTimer = null;
let previewTimer = null;
let charts = { payoff: null, equity: null };
let confirmArm = null;    // { key, until } for two-step confirm buttons

try { accountId = localStorage.getItem('paper_account'); } catch (e) { /* storage unavailable */ }
try { tab = localStorage.getItem('paper_tab') || 'positions'; } catch (e) { /* ignore */ }

// ── formatting ──

const inr = (x, signed = false) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  const s = Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${x < 0 ? '-' : signed && x > 0 ? '+' : ''}₹${s}`;
};
const inrWhole = x => `${x < 0 ? '-' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;
const px = x => (x ? Number(x).toFixed(2) : 'n/a');
const pnlClass = x => (x > 0 ? 'pt-pos' : x < 0 ? 'pt-neg' : '');
const instParts = key => {
  const [, exp, strike, type] = String(key).split('|');
  return { expiry: exp, strike: Number(strike), optionType: type };
};
const instLabel = key => {
  const p = instParts(key);
  return `${p.expiry.slice(0, 6).replace('-', ' ')} ${p.strike} ${p.optionType}`;
};
const lotSize = () => (market && market.lotSize) || 65;
const timeOf = t => (t ? hmIst(t) : 'n/a');
const dayTime = t => (t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : 'n/a');
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ── network ──

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  let res, json;
  try {
    res = await fetch(`/api/paper${path}`, opts);
    json = await res.json();
  } catch (e) {
    return { ok: false, status: 0, error: 'Could not reach the server.' };
  }
  if (res.status === 401 && json.code === 'SIGNED_OUT') showLogin();
  return { status: res.status, ...json };
}

// ── theme (same setting as the dashboard) ──

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('themeSelect').value = theme;
  setIconText($('themeIcon'), themeIcon(theme), '');
  if (account) { renderPayoff(); renderEquity(); }
}
function onThemeChange() {
  const v = $('themeSelect').value;
  try { localStorage.setItem('oi_tracker_theme', v); } catch (e) { /* ignore */ }
  applyTheme(v);
}

// ── sign in ──

function showLogin() {
  stopPolling();
  $('ptApp').hidden = true;
  $('ptLogin').hidden = false;
  $('ptSignOut').hidden = true;
  $('ptManageBtn').hidden = true;
  $('ptAccountSelect').disabled = true;
  setStatus('Signed out', false);
  setTimeout(() => $('ptSecret').focus(), 0);
}

async function signIn() {
  const secret = $('ptSecret').value;
  if (!secret) return;
  $('ptLoginError').textContent = '';
  const r = await api('/session', { method: 'POST', body: { secret } });
  if (!r.ok) { $('ptLoginError').textContent = r.error || 'Sign in failed.'; return; }
  $('ptSecret').value = '';
  start();
}

async function signOut() {
  await api('/session', { method: 'DELETE' });
  showLogin();
}

// ── status ──

const REASONS = {
  MARKET_CLOSED: 'Market closed. Orders are accepted 09:15 to 15:30 IST on trading days.',
  NO_DATA: 'No option chain data right now.',
  DATA_STALE: 'NSE did not answer, so prices are a leftover copy. Orders and fills are paused until fresh data arrives.',
  DATA_OLD: 'The latest NSE snapshot is more than 3 minutes old. Orders and fills are paused.'
};

function setStatus(text, ok) {
  $('ptStatus').textContent = text;
  $('ptDot').classList.toggle('error', !ok);
}

function renderStatus() {
  const h = market && market.health;
  if (!market) { setStatus('No market data', false); return; }
  if (h && h.ok) setStatus('Trading open', true);
  else setStatus(h && h.reason === 'MARKET_CLOSED' ? 'Market closed' : 'Trading paused', false);
  const banner = $('ptBanner');
  const showBanner = h && !h.ok && h.reason !== 'MARKET_CLOSED';
  banner.hidden = !showBanner;
  banner.textContent = showBanner ? REASONS[h.reason] || 'Trading is paused.' : '';
}

// ── data loading ──

async function start() {
  $('ptLogin').hidden = true;
  $('ptApp').hidden = false;
  const s = await api('/session');
  $('ptSignOut').hidden = !s.needsSecret;
  $('ptManageBtn').hidden = false;
  await loadAccounts();
  await refresh();
}

async function loadAccounts() {
  const r = await api('/accounts');
  if (!r.ok) return;
  accounts = r.accounts;
  if (!accounts.some(a => a.id === accountId)) accountId = accounts[0] ? accounts[0].id : null;
  const sel = $('ptAccountSelect');
  sel.innerHTML = accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('');
  sel.value = accountId || '';
  sel.disabled = accounts.length < 2;
  renderAccountList();
}

async function refresh() {
  stopPolling();
  if (!accountId) return;
  const [m, a] = await Promise.all([api(`/market${expiry ? `?expiry=${encodeURIComponent(expiry)}` : ''}`), api(`/accounts/${encodeURIComponent(accountId)}`)]);
  if (a.status === 401 || m.status === 401) return;
  if (m.ok) {
    market = m;
    expiry = m.expiry;
  } else {
    market = null;
  }
  if (a.ok) account = a;
  renderAll();
  const open = market && market.marketOpen;
  pollTimer = setTimeout(refresh, open ? OPEN_POLL_MS : CLOSED_POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function renderAll() {
  renderStatus();
  renderStrip();
  renderChain();
  renderTicket(false);
  renderBlotter();
  renderPayoffOptions();
  renderPayoff();
  renderEquity();
}

// ── account strip ──

function previousClose() {
  if (!account) return null;
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const prior = account.curve.filter(p => p.ymd < today);
  return prior.length ? prior[prior.length - 1].equity : account.summary.startingCapital;
}

function setVal(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `ks-val ${cls}`.trim();
}

function renderStrip() {
  if (!account) return;
  const s = account.summary;
  const day = s.equity - previousClose();
  const total = s.equity - s.startingCapital;
  setVal('psEquity', inr(s.equity));
  setVal('psDay', inr(day, true), pnlClass(day));
  setVal('psTotal', `${inr(total, true)} (${((total / s.startingCapital) * 100).toFixed(2)}%)`, pnlClass(total));
  setVal('psUnreal', inr(s.unrealized, true), pnlClass(s.unrealized));
  setVal('psReal', inr(s.realized, true), pnlClass(s.realized));
  setVal('psCharges', inr(s.charges));
  setVal('psMargin', inr(s.margin));
  setVal('psFree', inr(s.available), s.available < 0 ? 'pt-neg' : '');
  setVal('psSpot', market && market.spot ? market.spot.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'n/a');
  setVal('psAsOf', market && market.asOf ? dayTime(market.asOf) : 'n/a', market && market.health && !market.health.ok && market.health.reason !== 'MARKET_CLOSED' ? 'stale' : '');
}

// ── option chain ──

function renderChain() {
  const seg = $('ptExpirySeg');
  $('ptLot').textContent = market ? market.lotSize : 'n/a';
  if (!market) {
    seg.innerHTML = '';
    $('ptChainBody').innerHTML = '<tr><td colspan="7" class="empty-note">Option chain unavailable right now.</td></tr>';
    return;
  }
  seg.innerHTML = market.expiries.map(e => `<button class="seg-btn${e === expiry ? ' active' : ''}" data-click="setExpiry:${escapeHtml(e)}">${escapeHtml(e.slice(0, 6).replace('-', ' '))}</button>`).join('');
  const held = new Set(Object.keys(positionsByKey()));
  const btns = (strike, type) => {
    const key = `NIFTY|${expiry}|${strike}|${type}`;
    const sel = ticket.instrument === key;
    return `<span class="pt-bs${held.has(key) ? ' held' : ''}">`
      + `<button class="pt-b${sel && ticket.side === 'BUY' ? ' on' : ''}" data-click="pick:${strike}-${type}-BUY" title="Buy ${strike} ${type}">B</button>`
      + `<button class="pt-s${sel && ticket.side === 'SELL' ? ' on' : ''}" data-click="pick:${strike}-${type}-SELL" title="Sell ${strike} ${type}">S</button></span>`;
  };
  const leg = (q, f) => (q && q[f] ? q[f].toFixed(2) : 'n/a');
  const book = q => (q && (q.bid || q.ask) ? `${leg(q, 'bid')} / ${leg(q, 'ask')}` : 'n/a');
  $('ptChainBody').innerHTML = market.strikes.map(r => {
    const atm = r.strike === market.atmStrike;
    const itmCall = market.spot > r.strike, itmPut = market.spot < r.strike;
    return `<tr class="${atm ? 'pt-atm' : ''}">
      <td class="right muted pt-book${itmCall ? ' pt-itm' : ''}">${book(r.CE)}</td>
      <td class="right${itmCall ? ' pt-itm' : ''}">${leg(r.CE, 'ltp')}</td>
      <td class="center">${r.CE ? btns(r.strike, 'CE') : ''}</td>
      <td class="center pt-strike">${r.strike}</td>
      <td class="center">${r.PE ? btns(r.strike, 'PE') : ''}</td>
      <td class="right${itmPut ? ' pt-itm' : ''}">${leg(r.PE, 'ltp')}</td>
      <td class="right muted pt-book${itmPut ? ' pt-itm' : ''}">${book(r.PE)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty-note">No strikes for this expiry.</td></tr>';
}

function setExpiry(e) {
  expiry = e;
  refresh();
}

function quoteFor(key) {
  if (!market || !key) return null;
  const p = instParts(key);
  if (p.expiry !== market.expiry) return null;
  const row = market.strikes.find(r => r.strike === p.strike);
  return row ? row[p.optionType] : null;
}

// ── order ticket ──

function pick(arg) {
  const [strike, type, side] = String(arg).split('-');
  ticket = { instrument: `NIFTY|${expiry}|${strike}|${type}`, side };
  $('tkResult').textContent = '';
  const q = quoteFor(ticket.instrument);
  if (q && q.ltp) $('tkLimit').value = q.ltp.toFixed(2);
  renderChain();
  renderTicket(true);
  // stacked layout: the ticket sits below the chain, so bring it into view
  if (window.matchMedia('(max-width: 1100px)').matches) document.querySelector('.pt-ticket').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setSide(side) {
  ticket.side = side;
  renderChain();
  renderTicket(true);
}

function ticketChanged() {
  renderTicket(true);
}

function readTicket() {
  const type = $('tkType').value;
  const num = id => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined; };
  const order = { instrument: ticket.instrument, side: ticket.side, lots: parseInt($('tkLots').value, 10), orderType: type };
  if (type === 'LIMIT' || type === 'SL') order.limitPrice = num('tkLimit');
  if (type === 'SL' || type === 'SL-M') order.triggerPrice = num('tkTrigger');
  if ($('tkBracket').checked) {
    const target = num('tkTarget'), stop = num('tkStop');
    if (target !== undefined || stop !== undefined) order.bracket = { ...(target !== undefined && { target }), ...(stop !== undefined && { stop }) };
  }
  const note = $('tkNote').value.trim();
  if (note) order.reason = note;
  return order;
}

function renderTicket(withPreview) {
  const type = $('tkType').value;
  $('tkLimitRow').hidden = !(type === 'LIMIT' || type === 'SL');
  $('tkTriggerRow').hidden = !(type === 'SL' || type === 'SL-M');
  $('tkBracketRows').hidden = !$('tkBracket').checked;
  $('tkBuy').classList.toggle('active', ticket.side === 'BUY');
  $('tkSell').classList.toggle('active', ticket.side === 'SELL');
  $('tkPlace').className = `pt-primary ${ticket.side === 'SELL' ? 'pt-sell' : 'pt-buy'}`;
  const inst = $('tkInst');
  if (!ticket.instrument) {
    inst.textContent = 'Pick a strike from the chain.';
    $('tkPlace').disabled = true;
    $('tkPlace').textContent = 'Place order';
    return;
  }
  const q = quoteFor(ticket.instrument);
  inst.innerHTML = `<b>NIFTY ${escapeHtml(instLabel(ticket.instrument))}</b>`
    + (q ? ` <span class="pt-muted">LTP ${px(q.ltp)} · bid ${px(q.bid)} · ask ${px(q.ask)}</span>` : '');
  const lots = parseInt($('tkLots').value, 10) || 0;
  $('tkPlace').textContent = `${ticket.side === 'BUY' ? 'Buy' : 'Sell'} ${lots} lot${lots === 1 ? '' : 's'} (${lots * lotSize()} qty)`;
  $('tkPlace').disabled = false;
  if (withPreview) schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, PREVIEW_DELAY_MS);
}

async function preview() {
  if (!ticket.instrument || !accountId) return;
  const el = $('tkPreview');
  const r = await api(`/accounts/${encodeURIComponent(accountId)}/orders/preview`, { method: 'POST', body: readTicket() });
  if (!r.ok) {
    el.className = 'pt-preview pt-warn';
    el.textContent = r.error && r.error.message ? r.error.message : r.error || 'Cannot check this order.';
    return;
  }
  el.className = 'pt-preview';
  const free = `Free cash after: ${inr(r.availableAfter)}${r.marginAfter ? ` (margin ${inr(r.marginAfter)})` : ''}.`;
  el.textContent = r.fill
    ? `Fills now at ${px(r.fill.price)} for ${inr(r.fill.price * r.fill.qty)}, charges ${inr(r.fill.charges)}. ${free}`
    : `Waits until the price is reached, then fills on a newer snapshot. ${free}`;
}

async function placeOrder() {
  if (!ticket.instrument) return;
  const btn = $('tkPlace');
  btn.disabled = true;
  const r = await api(`/accounts/${encodeURIComponent(accountId)}/orders`, { method: 'POST', body: readTicket() });
  btn.disabled = false;
  const out = $('tkResult');
  if (!r.ok) {
    out.className = 'pt-result pt-warn';
    out.textContent = r.error || 'Order refused.';
    return;
  }
  out.className = 'pt-result pt-okmsg';
  const verb = r.order.side === 'BUY' ? 'Bought' : 'Sold';
  out.textContent = r.trade
    ? `${verb} ${r.order.lots} lot${r.order.lots === 1 ? '' : 's'} of ${instLabel(r.order.instrument)} at ${px(r.trade.price)}.`
    : `Order ${r.order.id} is waiting (${r.order.orderType}).`;
  $('tkNote').value = '';
  $('tkPreview').textContent = '';
  await refresh();
  schedulePreview();
}

// ── blotter ──

function positionsByKey() {
  const out = {};
  for (const p of (account && account.summary.positions) || []) out[p.instrument] = p;
  return out;
}

function setTab(t) {
  tab = t;
  try { localStorage.setItem('paper_tab', t); } catch (e) { /* ignore */ }
  renderBlotter();
}

const statusText = o => {
  const why = { INSUFFICIENT_FUNDS: 'not enough free cash', NOTHING_TO_CLOSE: 'position already closed', OCO_FILLED: 'other leg filled', END_OF_DAY: 'end of day', EXPIRED_CONTRACT: 'contract expired', USER: 'by you' }[o.statusReason];
  return `${o.status.toLowerCase()}${why ? ` (${why})` : ''}`;
};

function renderBlotter() {
  for (const [t, id] of [['positions', 'tabPositions'], ['open', 'tabOpen'], ['history', 'tabHistory'], ['trades', 'tabTrades']]) $(id).classList.toggle('active', tab === t);
  const el = $('ptBlotter');
  if (!account) { el.innerHTML = '<div class="empty-note">Loading…</div>'; return; }
  const empty = text => `<div class="empty-note">${text}</div>`;
  const s = account.summary;

  if (tab === 'positions') {
    if (!s.positions.length) { el.innerHTML = empty('No open positions.'); return; }
    const rows = s.positions.map(p => `<tr>
      <td>${escapeHtml(instLabel(p.instrument))}</td>
      <td class="right ${p.qty > 0 ? 'pt-pos' : 'pt-neg'}">${p.qty > 0 ? '+' : ''}${p.qty / lotSize()} (${p.qty})</td>
      <td class="right">${px(p.avgPrice)}</td>
      <td class="right">${px(p.mark)}</td>
      <td class="right ${pnlClass(p.unrealized)}">${inr(p.unrealized, true)}</td>
      <td class="right ${pnlClass(p.realized)}">${inr(p.realized, true)}</td>
      <td class="right">${confirmButton(`exit|${p.instrument}`, `exitPosition:${p.instrument}`, 'Exit', 'Confirm exit')}</td>
    </tr>`).join('');
    el.innerHTML = `<table class="pt-table"><thead><tr><th>Contract</th><th class="right">Lots (qty)</th><th class="right">Avg</th><th class="right">LTP</th><th class="right">P&amp;L</th><th class="right">Booked</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    return;
  }
  if (tab === 'open') {
    const open = s.openOrders;
    if (!open.length) { el.innerHTML = empty('No open orders.'); return; }
    el.innerHTML = `<table class="pt-table"><thead><tr><th>Placed</th><th>Order</th><th>Contract</th><th>Side</th><th class="right">Lots</th><th>Type</th><th class="right">Limit</th><th class="right">Trigger</th><th>Status</th><th></th></tr></thead><tbody>${open.map(o => `<tr>
      <td>${timeOf(o.placedAt)}</td><td>${escapeHtml(o.id)}${o.parentId ? ` <span class="pt-muted">exit of ${escapeHtml(o.parentId)}</span>` : ''}</td>
      <td>${escapeHtml(instLabel(o.instrument))}</td><td class="${o.side === 'BUY' ? 'pt-pos' : 'pt-neg'}">${o.side}</td>
      <td class="right">${o.lots}</td><td>${escapeHtml(o.orderType)}</td><td class="right">${px(o.limitPrice)}</td><td class="right">${px(o.triggerPrice)}</td>
      <td>${escapeHtml(statusText(o))}</td>
      <td class="right"><button class="pt-small" data-click="cancelOrder:${escapeHtml(o.id)}">Cancel</button></td>
    </tr>`).join('')}</tbody></table>`;
    return;
  }
  if (tab === 'history') {
    const list = account.orders;
    if (!list.length) { el.innerHTML = empty('No orders yet.'); return; }
    el.innerHTML = `<table class="pt-table"><thead><tr><th>Placed</th><th>Order</th><th>Contract</th><th>Side</th><th class="right">Lots</th><th>Type</th><th class="right">Price</th><th class="right">Filled at</th><th>Status</th><th>Note</th></tr></thead><tbody>${list.map(o => `<tr>
      <td>${dayTime(o.placedAt)}</td><td>${escapeHtml(o.id)}</td><td>${escapeHtml(instLabel(o.instrument))}</td>
      <td class="${o.side === 'BUY' ? 'pt-pos' : 'pt-neg'}">${o.side}</td><td class="right">${o.lots}</td><td>${escapeHtml(o.orderType)}</td>
      <td class="right">${px(o.limitPrice || o.triggerPrice)}</td><td class="right">${px(o.fillPrice)}</td>
      <td>${escapeHtml(statusText(o))}</td><td class="pt-note">${escapeHtml(o.reason || '')}</td>
    </tr>`).join('')}</tbody></table>`;
    return;
  }
  const trades = account.trades;
  if (!trades.length) { el.innerHTML = empty('No trades yet.'); return; }
  el.innerHTML = `<table class="pt-table"><thead><tr><th>Time</th><th>Contract</th><th>Side</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Charges</th><th class="right">Booked P&amp;L</th><th>Kind</th></tr></thead><tbody>${trades.map(t => `<tr>
    <td>${dayTime(t.at)}</td><td>${escapeHtml(instLabel(t.instrument))}</td><td class="${t.side === 'BUY' ? 'pt-pos' : 'pt-neg'}">${t.side}</td>
    <td class="right">${t.qty}</td><td class="right">${t.price.toFixed(2)}</td><td class="right">${inr(t.charges)}</td>
    <td class="right ${pnlClass(t.realized)}">${t.realized ? inr(t.realized, true) : ''}</td><td>${t.kind === 'settlement' ? 'expiry settlement' : 'fill'}</td>
  </tr>`).join('')}</tbody></table>`;
}

async function exitPosition(instrument) {
  const p = positionsByKey()[instrument];
  if (!p) return;
  const key = `exit|${instrument}`;
  if (!armed(key)) { arm(key); return; }
  const r = await api(`/accounts/${encodeURIComponent(accountId)}/orders`, {
    method: 'POST',
    body: { instrument, side: p.qty > 0 ? 'SELL' : 'BUY', lots: Math.abs(p.qty) / lotSize(), orderType: 'MARKET', reason: 'Exit from positions' }
  });
  if (!r.ok) alertBlotter(r.error || 'Exit refused.');
  refresh();
}

async function cancelOrder(id) {
  const r = await api(`/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) alertBlotter(r.error || 'Cancel failed.');
  refresh();
}

function alertBlotter(text) {
  const el = $('ptBlotter');
  el.insertAdjacentHTML('afterbegin', `<div class="pt-error">${escapeHtml(text)}</div>`);
}

// two-step confirm: first click turns the button into "Confirm ...", a second click within 4 seconds does it
function armed(key) {
  return confirmArm && confirmArm.key === key && Date.now() < confirmArm.until;
}
function arm(key) {
  confirmArm = { key, until: Date.now() + 4000 };
  renderBlotter();
  renderAccountList();
  setTimeout(() => { if (confirmArm && confirmArm.key === key) { confirmArm = null; renderBlotter(); renderAccountList(); } }, 4000);
}
// drawn from the armed state, so a refresh in the middle of confirming keeps the "Confirm" label
function confirmButton(key, action, label, confirmLabel) {
  const on = armed(key);
  return `<button class="pt-small${on ? ' pt-armed' : ''}" data-click="${escapeHtml(action)}">${on ? confirmLabel : label}</button>`;
}

// ── payoff and equity charts ──

function renderPayoffOptions() {
  const sel = $('ptPayoffExpiry');
  const exps = [...new Set(((account && account.summary.positions) || []).map(p => p.expiry))];
  const current = sel.value;
  sel.innerHTML = exps.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
  sel.hidden = exps.length < 2;
  if (exps.includes(current)) sel.value = current;
}

const expiryCloseMs = e => {
  const d = new Date(`${e.replace(/-/g, ' ')} 15:30:00 GMT+0530`);
  return d.getTime();
};

function chartColors() {
  return { text: cssVar('--muted'), grid: cssVar('--border'), bull: cssVar('--bull'), bear: cssVar('--bear'), accent: cssVar('--accent'), warn: cssVar('--warn') };
}

function drawChart(slot, canvasId, config) {
  if (charts[slot]) charts[slot].destroy();
  charts[slot] = typeof Chart === 'undefined' ? null : new Chart($(canvasId), config);
}

function renderPayoff() {
  const exp = $('ptPayoffExpiry').value;
  const note = $('ptPayoffNote');
  const legs = ((account && account.summary.positions) || []).filter(p => p.expiry === exp).map(p => {
    const q = market && market.expiry === p.expiry ? quoteFor(p.instrument) : null;
    return { strike: p.strike, optionType: p.optionType, qty: p.qty, avgPrice: p.avgPrice, iv: q && q.iv ? q.iv : null };
  });
  const spot = (market && market.spot) || (account && account.summary.spot);
  const series = exp && legs.length ? payoffSeries(legs, { spot, expiryMs: expiryCloseMs(exp), nowMs: Date.now() }) : null;
  if (!series) {
    if (charts.payoff) { charts.payoff.destroy(); charts.payoff = null; }
    note.textContent = 'Open a position to see its payoff.';
    return;
  }
  const c = chartColors();
  drawChart('payoff', 'ptPayoffChart', {
    type: 'line',
    data: {
      labels: series.xs,
      datasets: [
        { label: 'At expiry', data: series.atExpiry, borderColor: c.accent, borderWidth: 2, pointRadius: 0, tension: 0, segment: { borderColor: ctx => (ctx.p1.parsed.y >= 0 ? c.bull : c.bear) } },
        { label: 'Today', data: series.today, borderColor: c.warn, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, tension: 0.2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: c.text, boxWidth: 12 } },
        tooltip: { callbacks: { title: items => `NIFTY ${items[0].label}`, label: item => `${item.dataset.label}: ${inr(item.parsed.y, true)}` } }
      },
      scales: {
        x: { ticks: { color: c.text, maxTicksLimit: 8 }, grid: { color: c.grid } },
        y: { ticks: { color: c.text, callback: v => inrWhole(v) }, grid: { color: ctx => (ctx.tick.value === 0 ? c.text : c.grid) } }
      }
    }
  });
  const bits = [];
  bits.push(series.breakevens.length ? `Breakeven ${series.breakevens.join(', ')}` : 'No breakeven in this range');
  bits.push(`max profit ${series.maxProfit === null ? 'unlimited' : inr(series.maxProfit)}`);
  bits.push(`max loss ${series.maxLoss === null ? 'unlimited' : inr(series.maxLoss)}`);
  note.textContent = `${bits.join(', ')}. Today line uses each leg's IV from the chain; at expiry ignores charges.`;
}

function renderEquity() {
  if (!account) return;
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const pts = account.curve.filter(p => p.ymd !== today).map(p => ({ x: p.ymd, y: p.equity }));
  pts.push({ x: 'Now', y: account.summary.equity });
  if (pts.length === 1) pts.unshift({ x: 'Start', y: account.summary.startingCapital });
  const c = chartColors();
  const up = pts[pts.length - 1].y >= account.summary.startingCapital;
  drawChart('equity', 'ptEquityChart', {
    type: 'line',
    data: { labels: pts.map(p => p.x), datasets: [{ label: 'Equity', data: pts.map(p => p.y), borderColor: up ? c.bull : c.bear, borderWidth: 2, pointRadius: 2, tension: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => inr(item.parsed.y) } } },
      scales: { x: { ticks: { color: c.text, maxTicksLimit: 8 }, grid: { color: c.grid } }, y: { ticks: { color: c.text, callback: v => inrWhole(v) }, grid: { color: c.grid } } }
    }
  });
}

// ── accounts ──

function toggleManage() {
  $('ptManage').hidden = !$('ptManage').hidden;
}

function switchAccount() {
  accountId = $('ptAccountSelect').value;
  try { localStorage.setItem('paper_account', accountId); } catch (e) { /* ignore */ }
  account = null;
  ticket = { instrument: null, side: 'BUY' };
  refresh();
}

function renderAccountList() {
  $('ptAccountList').innerHTML = accounts.map(a => `<div class="pt-account-row">
    <span><b>${escapeHtml(a.name)}</b> <span class="pt-muted">${escapeHtml(a.id)}${a.active ? ', has open positions or orders' : ''}</span></span>
    <span>
      ${confirmButton(`reset|${a.id}`, `resetAccount:${a.id}`, 'Reset', 'Confirm reset')}
      ${accounts.length > 1 ? confirmButton(`delete|${a.id}`, `deleteAccount:${a.id}`, 'Delete', 'Confirm delete') : ''}
    </span>
  </div>`).join('');
}

async function createAccount() {
  const err = $('ptManageError');
  err.textContent = '';
  const r = await api('/accounts', { method: 'POST', body: { id: $('ptNewId').value.trim(), name: $('ptNewName').value.trim() || undefined, startingCapital: Number($('ptNewCap').value) } });
  if (!r.ok) { err.textContent = r.error || 'Could not create the account.'; return; }
  $('ptNewId').value = '';
  $('ptNewName').value = '';
  accountId = r.account.id;
  try { localStorage.setItem('paper_account', accountId); } catch (e) { /* ignore */ }
  await loadAccounts();
  refresh();
}

async function resetAccount(id) {
  if (!armed(`reset|${id}`)) { arm(`reset|${id}`); return; }
  const r = await api(`/accounts/${encodeURIComponent(id)}/reset`, { method: 'POST' });
  if (!r.ok) $('ptManageError').textContent = r.error || 'Reset failed.';
  await loadAccounts();
  refresh();
}

async function deleteAccount(id) {
  if (!armed(`delete|${id}`)) { arm(`delete|${id}`); return; }
  const r = await api(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) $('ptManageError').textContent = r.error || 'Delete failed.';
  await loadAccounts();
  refresh();
}

// ── wiring (no inline handlers: the CSP forbids them) ──

const ACTIONS = {
  signIn,
  signOut,
  onThemeChange,
  switchAccount,
  toggleManage,
  createAccount,
  resetAccount,
  deleteAccount,
  setExpiry,
  pick,
  setSide,
  ticketChanged,
  placeOrder,
  setTab,
  exitPosition,
  cancelOrder,
  renderPayoff
};

function runActions(spec, event) {
  spec.split(/\s+/).filter(Boolean).forEach(item => {
    const i = item.indexOf(':');
    const name = i < 0 ? item : item.slice(0, i);
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
    if (fn) fn(i < 0 ? event : item.slice(i + 1));
  });
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-click]');
  if (el) runActions(el.dataset.click, e);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el) runActions(el.dataset.change, e);
});

document.addEventListener('DOMContentLoaded', async () => {
  let theme = 'system';
  try { theme = localStorage.getItem('oi_tracker_theme') || 'system'; } catch (e) { /* ignore */ }
  applyTheme(theme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ($('themeSelect').value === 'system') applyTheme('system'); });
  for (const id of ['tkLots', 'tkLimit', 'tkTrigger', 'tkTarget', 'tkStop']) $(id).addEventListener('input', () => renderTicket(true));
  $('ptSecret').addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && account) refresh(); });

  const s = await api('/session');
  if (s.ok === false && s.status === 0) { setStatus('Cannot reach the server', false); return; }
  if (!s.configured) { setStatus('Paper trading is not configured on this server', false); return; }
  if (!s.signedIn) { showLogin(); return; }
  start();
});
