import { initAlerts, processAlerts, toggleAlertsDrawer, alertsEnabled } from './alerts.js';
import { fetchOptionChainData, fetchSimilarSessionsData, fetchIntradayData, fetchParticipantData } from './api-client.js';
import { initExplain } from './explain.js';
import { openStrikePanel, initStrikePanel } from './strike-panel.js';
import { icon, setIconText, hydrateIcons, regimeIcon, themeIcon } from './icons.js';
import { escapeHtml } from './ui-utils.js';
import { freshness, candleLagSec } from './freshness.js';
import { refreshForwardLog } from './forward-log.js';
import { initPriceChart, refreshPriceChart, setChartTimeframe, toggleChartLayer, restyleChart, chartScreenshot, currentChartSignals, chartFeedStatus } from './price-chart.js';
import { fmt, fmtK, fmtChg, pct, timeStr, getSmoothedBuildup, renderProbabilityChart, renderTimelineChart, renderOiChart, renderStraddleChart, renderIvRvChart, renderParticipantChart } from './charts.js';

let currentData = null;
let prevData = null;
let intervalMs = 3000;
let timer = null;
let cdInterval = null;
let sortCol = null;
let sortDir = -1;
let selectedExpiry = null;
let cdRemaining = 5;
let fetchInProgress = false;

// Server-side intraday history (survives page refresh / cold starts when storage is configured)
let intraday = null;
let intradayFetchedAt = 0;
let intradayExpiry = null;
let timelineMetric = 'pcr';
let oiChartMode = 'oi';
try { oiChartMode = localStorage.getItem('oiChartMode') || 'oi'; } catch (e) { /* storage unavailable */ }
const INTRADAY_REFRESH_MS = 30000;

// NSE participant-wise OI (end of day): fetched on load and every 15 minutes
let participantDays = null;
let participantsFetchedAt = 0;
let participantMode = 'fut';
try { participantMode = localStorage.getItem('participantMode') === 'opt' ? 'opt' : 'fut'; } catch (e) { /* storage unavailable */ }
const PARTICIPANT_REFRESH_MS = 15 * 60 * 1000;
const METRIC_LABELS = {
  pcr: 'PCR', volPcr: 'Volume PCR', straddle: 'ATM Straddle', atmIv: 'ATM IV', ivSkew: 'IV Skew (25Δ RR)',
  vix: 'India VIX', gexCr: 'Net GEX (Cr)', callOI: 'Total Call OI', putOI: 'Total Put OI'
};

async function refreshIntraday(force = false) {
  const expiry = currentData && currentData.expiry;
  if (!expiry) return;
  const stale = Date.now() - intradayFetchedAt > INTRADAY_REFRESH_MS;
  if (!force && !stale && intradayExpiry === expiry) return;
  intradayFetchedAt = Date.now();
  intradayExpiry = expiry;
  try {
    intraday = await fetchIntradayData(expiry);
  } catch (e) {
    console.error('Intraday history fetch failed:', e);
    intraday = null;
  }
  if (currentData) {
    renderTimeline();
    renderVolPanels();
    renderOiChart_();
    renderFlowFeed(currentData);
  }
}

async function refreshParticipants() {
  if (Date.now() - participantsFetchedAt < PARTICIPANT_REFRESH_MS) return;
  participantsFetchedAt = Date.now();
  try {
    participantDays = await fetchParticipantData();
  } catch (e) {
    console.error('Participant OI fetch failed:', e);
    if (!participantDays) participantDays = [];
  }
  renderParticipants();
}

export function onParticipantModeChange() {
  const sel = document.getElementById('participantMode');
  participantMode = sel && sel.value === 'opt' ? 'opt' : 'fut';
  try { localStorage.setItem('participantMode', participantMode); } catch (e) { /* ignore */ }
  renderParticipants();
}

const signedK = v => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${fmtK(v)}`);
const signClass = v => (v > 0 ? 'bull' : v < 0 ? 'bear' : '');

function cell(tag, text, cls) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function renderParticipants() {
  const head = document.getElementById('participantHead');
  const body = document.getElementById('participantBody');
  const note = document.getElementById('participantNote');
  const sel = document.getElementById('participantMode');
  if (!head || !body) return;
  if (sel) sel.value = participantMode;

  const days = participantDays || [];
  const latest = days[0];
  const prev = days[1];
  const cols = participantMode === 'opt'
    ? ['Participant', 'Calls net', 'Puts net', 'Calls chg', 'Puts chg']
    : ['Participant', 'Long', 'Short', 'Net', 'Long %', 'Net chg'];
  head.replaceChildren(...cols.map((c, i) => cell('th', c, i ? 'right' : '')));

  if (!latest) {
    const td = cell('td', participantDays ? 'NSE participant data is unavailable right now.' : 'Loading NSE participant data…', 'ctx-empty');
    td.colSpan = cols.length;
    body.replaceChildren(document.createElement('tr'));
    body.firstChild.append(td);
    return;
  }

  const LABELS = { FII: 'FII', DII: 'DII', Pro: 'Pro', Client: 'Client' };
  body.replaceChildren(...Object.keys(LABELS).map(who => {
    const r = latest[who];
    const p = prev ? prev[who] : null;
    const tr = document.createElement('tr');
    tr.append(cell('td', LABELS[who], 'ctx-who'));
    if (participantMode === 'opt') {
      const callChg = p ? r.optIdxCallNet - p.optIdxCallNet : null;
      const putChg = p ? r.optIdxPutNet - p.optIdxPutNet : null;
      tr.append(
        cell('td', signedK(r.optIdxCallNet), `right ${signClass(r.optIdxCallNet)}`),
        cell('td', signedK(r.optIdxPutNet), `right ${signClass(r.optIdxPutNet)}`),
        cell('td', signedK(callChg), 'right'),
        cell('td', signedK(putChg), 'right')
      );
    } else {
      const netChg = p ? r.futIdxNet - p.futIdxNet : null;
      tr.append(
        cell('td', fmtK(r.futIdxLong), 'right'),
        cell('td', fmtK(r.futIdxShort), 'right'),
        cell('td', signedK(r.futIdxNet), `right ${signClass(r.futIdxNet)}`),
        cell('td', r.futIdxLongPct === null ? 'n/a' : `${r.futIdxLongPct}%`, 'right'),
        cell('td', signedK(netChg), 'right')
      );
    }
    return tr;
  }));

  renderParticipantChart('participantChart', days, participantMode);
  if (note) {
    const asOf = new Date(latest.date + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    note.textContent = `As of ${asOf} (NSE end-of-day file, published each evening). Contracts; changes are vs the previous trading day.`;
  }
}

// NSE's index list sometimes times out for one refresh; keep the last good sectors on screen meanwhile.
let lastSectorData = null;

function renderSectors(d) {
  if (d.sectors && d.sectors.length) lastSectorData = { sectors: d.sectors, breadth: d.breadth };
  else if (lastSectorData) d = lastSectorData;
  const grid = document.getElementById('sectorGrid');
  const breadthEl = document.getElementById('breadthNote');
  if (breadthEl) {
    const b = d.breadth;
    breadthEl.textContent = b ? `NIFTY 50 breadth: ${b.advances} up, ${b.declines} down` : 'NIFTY 50 breadth: n/a';
  }
  if (!grid) return;
  const sectors = (d.sectors || []).slice().sort((a, b) => b.percentChange - a.percentChange);
  if (!sectors.length) {
    grid.replaceChildren(cell('div', 'Sector data is unavailable right now.', 'ctx-empty'));
    return;
  }
  grid.replaceChildren(...sectors.map(sct => {
    const pctChg = Number(sct.percentChange) || 0;
    const strength = Math.round(12 + Math.min(Math.abs(pctChg) / 2, 1) * 58); // 2% or more = full colour
    const tile = document.createElement('div');
    tile.className = 'sector-tile';
    tile.classList.add(pctChg === 0 ? 'flat' : pctChg > 0 ? 'up' : 'down');
    if (pctChg !== 0) tile.style.setProperty('--tile-a', (strength / 100).toFixed(2));
    tile.title = `${sct.index}: ${fmt(sct.last)}`;
    tile.append(
      cell('span', sct.name, 'sector-name'),
      cell('strong', `${pctChg > 0 ? '+' : ''}${pctChg.toFixed(2)}%`, 'sector-pct'),
      cell('span', `${sct.advances} up · ${sct.declines} down`, 'sector-breadth')
    );
    return tile;
  }));
}

export function onTimelineMetricChange() {
  const sel = document.getElementById('timelineMetric');
  timelineMetric = sel ? sel.value : 'pcr';
  renderTimeline();
}

export function onOiChartModeChange() {
  const sel = document.getElementById('oiChartMode');
  oiChartMode = sel ? sel.value : 'oi';
  try { localStorage.setItem('oiChartMode', oiChartMode); } catch (e) { /* ignore */ }
  renderOiChart_();
}

const hmIst = t => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

// Builds per-strike bar series for the selected view from live data (+ stored baselines for windows).
function buildOiSeries(d, mode) {
  const strikes = d.strikes.map(s => s.strike);
  if (mode === 'oi') {
    return {
      strikes,
      calls: d.strikes.map(s => s.CE?.openInterest || 0),
      puts: d.strikes.map(s => s.PE?.openInterest || 0),
      diverging: false
    };
  }
  if (mode === 'chg') {
    return {
      strikes,
      calls: d.strikes.map(s => s.CE?.changeinOpenInterest || 0),
      puts: d.strikes.map(s => s.PE?.changeinOpenInterest || 0),
      diverging: true
    };
  }
  const snap = serverSnapshot(mode);
  if (!snap) return null;
  // A strike missing from the baseline (ATM drifted) is skipped rather than shown as a fake full-size build.
  const delta = (liveOI, base) => (base === undefined ? null : liveOI - base);
  return {
    strikes,
    calls: d.strikes.map(s => delta(s.CE?.openInterest || 0, snap.strikes[s.strike]?.ceOI)),
    puts: d.strikes.map(s => delta(s.PE?.openInterest || 0, snap.strikes[s.strike]?.peOI)),
    diverging: true,
    baselineT: snap.timestamp
  };
}

function summarizeOi(d, series, mode) {
  const el = document.getElementById('oiChartSummary');
  if (!el) return;
  const pick = (arr, cmp) => arr.reduce((best, v, i) => (v !== null && (best === null || cmp(v, arr[best])) ? i : best), null);
  const at = i => (i === null ? 'n/a' : fmt(series.strikes[i]));
  const fmtV = v => (v > 0 ? '+' : '') + fmtK(v);
  const parts = [];

  if (mode === 'oi') {
    const c = pick(series.calls, (a, b) => a > b);
    const p = pick(series.puts, (a, b) => a > b);
    const sumC = series.calls.reduce((a, v) => a + (v || 0), 0);
    const sumP = series.puts.reduce((a, v) => a + (v || 0), 0);
    parts.push(`Largest call OI: <strong class="bear">${at(c)}</strong> (${fmtK(series.calls[c])})`);
    parts.push(`Largest put OI: <strong class="bull">${at(p)}</strong> (${fmtK(series.puts[p])})`);
    parts.push(`PCR in view: <strong>${sumC > 0 ? (sumP / sumC).toFixed(2) : 'n/a'}</strong>`);
  } else {
    const cUp = pick(series.calls, (a, b) => a > b);
    const pUp = pick(series.puts, (a, b) => a > b);
    const cDn = pick(series.calls, (a, b) => a < b);
    const pDn = pick(series.puts, (a, b) => a < b);
    if (cUp !== null && series.calls[cUp] > 0) parts.push(`Biggest call build: <strong class="bear">${at(cUp)}</strong> ${fmtV(series.calls[cUp])}`);
    if (pUp !== null && series.puts[pUp] > 0) parts.push(`Biggest put build: <strong class="bull">${at(pUp)}</strong> ${fmtV(series.puts[pUp])}`);
    if (cDn !== null && series.calls[cDn] < 0) parts.push(`Biggest call unwind: <strong>${at(cDn)}</strong> ${fmtV(series.calls[cDn])}`);
    if (pDn !== null && series.puts[pDn] < 0) parts.push(`Biggest put unwind: <strong>${at(pDn)}</strong> ${fmtV(series.puts[pDn])}`);
    const net = (arr) => arr.reduce((a, v) => a + (v || 0), 0);
    parts.push(`Net in view: calls <strong>${fmtV(net(series.calls))}</strong> · puts <strong>${fmtV(net(series.puts))}</strong>`);
  }
  el.innerHTML = parts.map(x => `<span>${x}</span>`).join('');
}

function renderOiChart_() {
  const d = currentData;
  if (!d || !d.strikes || !d.strikes.length) return;

  // Label window options with the baseline they would compare against; disable the ones without history.
  const sel = document.getElementById('oiChartMode');
  if (sel) {
    const names = { m5: 'last 5 min', m15: 'last 15 min', m30: 'last 30 min', open: 'since first snapshot' };
    [...sel.options].forEach(o => {
      if (!names[o.value]) return;
      const snap = serverSnapshot(o.value);
      o.disabled = !snap;
      o.textContent = snap ? `OI change · ${names[o.value]} (vs ${hmIst(snap.timestamp)})` : `OI change · ${names[o.value]} (needs history)`;
    });
    if (sel.value !== oiChartMode) sel.value = oiChartMode;
  }

  let mode = oiChartMode;
  let series = buildOiSeries(d, mode);
  const empty = document.getElementById('oiChartEmpty');
  if (!series) {
    // Chosen window has no baseline yet: fall back to plain OI instead of showing an empty chart
    mode = 'oi';
    series = buildOiSeries(d, 'oi');
    if (sel) sel.value = 'oi'; // show what is drawn; the saved preference is kept for when history arrives
    if (empty) empty.textContent = '';
  } else if (empty) {
    empty.textContent = '';
  }

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const markers = [
    { value: d.spot, label: 'Spot', color: css('--accent') || '#3b82f6' },
    { value: d.maxPain, label: 'Max Pain', color: css('--warn') || '#f59e0b', dash: [5, 4] }
  ];
  if (d.walls?.calls?.[0]) markers.push({ value: d.walls.calls[0].strike, label: 'Call wall', color: css('--bear') || '#ef4444', dash: [2, 3] });
  if (d.walls?.puts?.[0]) markers.push({ value: d.walls.puts[0].strike, label: 'Put wall', color: css('--bull') || '#10b981', dash: [2, 3] });

  renderOiChart('oiChart', series, markers);
  summarizeOi(d, series, mode);
}

function renderTimeline() {
  const chip = document.getElementById('historyChip');
  const empty = document.getElementById('timelineEmpty');
  const points = intraday && intraday.expiry === (currentData && currentData.expiry) ? intraday.points || [] : [];

  if (chip) {
    if (!intraday) {
      chip.textContent = 'History: unavailable';
      chip.className = 'pill pill-warn';
    } else if (intraday.persistent) {
      chip.textContent = `History: saved · ${points.length} pts${intraday.date ? ' · ' + intraday.date : ''}`;
      chip.className = 'pill pill-bull';
    } else {
      chip.textContent = `History: in-memory · ${points.length} pts`;
      chip.className = 'pill pill-warn';
      chip.title = 'No storage configured, so history is lost on restart or cold start. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.';
    }
  }

  if (points.length < 2) {
    if (empty) empty.textContent = intraday
      ? 'Collecting snapshots. One is stored each time NSE updates (about once a minute).'
      : 'Intraday history is unavailable right now.';
    if (points.length === 0) return;
  } else if (empty) {
    empty.textContent = '';
  }
  renderTimelineChart('timelineChart', points, timelineMetric, METRIC_LABELS[timelineMetric] || timelineMetric);
}

// Summary row under a chart: [label, value, className?] items, written as text nodes.
function fillSummary(id, items) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  items.forEach(([label, value, cls]) => {
    const span = document.createElement('span');
    const strong = document.createElement('strong');
    if (cls) strong.className = cls;
    strong.textContent = value;
    span.append(document.createTextNode(`${label}: `), strong);
    el.append(span);
  });
}

const signedPct = v => (v === null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const volPct = v => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${v.toFixed(1)}%`);

function renderVolPanels() {
  const d = currentData;
  const points = intraday && d && intraday.expiry === d.expiry ? intraday.points || [] : [];
  const emptyText = intraday
    ? 'Collecting snapshots. One is stored each time NSE updates (about once a minute).'
    : 'Intraday history is unavailable right now.';
  const last = points[points.length - 1] || null;

  // Rolling ATM straddle
  const sEmpty = document.getElementById('straddleChartEmpty');
  const straddles = points.map(p => p.straddle).filter(v => v > 0);
  if (sEmpty) sEmpty.textContent = straddles.length >= 2 ? '' : emptyText;
  renderStraddleChart('straddleChart', points);
  const now = d && d.straddlePrice > 0 ? d.straddlePrice : (straddles.length ? straddles[straddles.length - 1] : null);
  const open = straddles.length ? straddles[0] : null;
  const avg = straddles.length ? straddles.reduce((a, v) => a + v, 0) / straddles.length : null;
  const chgVs = base => (now && base ? ((now - base) / base) * 100 : null);
  fillSummary('straddleSummary', [
    ['Now', now ? fmt(Math.round(now)) : 'n/a'],
    ['ATM', d && d.atm ? fmt(d.atm) : 'n/a'],
    ['vs open', signedPct(chgVs(open))],
    ['vs day avg', signedPct(chgVs(avg))],
    ['Day range', straddles.length ? `${fmt(Math.round(Math.min(...straddles)))} to ${fmt(Math.round(Math.max(...straddles)))}` : 'n/a']
  ]);

  // IV vs realised vol
  const vEmpty = document.getElementById('ivRvChartEmpty');
  const hasRv = points.some(p => p.rv15 !== null && p.rv15 !== undefined);
  if (vEmpty) {
    vEmpty.textContent = points.length < 2 ? emptyText
      : hasRv ? '' : 'Realised vol needs about 15 minutes of snapshots.';
  }
  renderIvRvChart('ivRvChart', points);
  const ivT = d && d.atmIvTrading ? d.atmIvTrading : (last ? last.ivT : null);
  const rv30 = last ? last.rv30 : null;
  const spread = ivT && rv30 ? ivT - rv30 : null;
  const pctl = d && d.atmIvPercentile;
  fillSummary('ivRvSummary', [
    ['ATM IV', volPct(ivT)],
    ['NSE IV (calendar)', volPct(d ? d.atmIv : null)],
    ['RV 15m', volPct(last ? last.rv15 : null)],
    ['RV 30m', volPct(rv30)],
    ['RV 60m', volPct(last ? last.rv60 : null)],
    ['IV minus RV 30m', spread === null ? 'n/a' : `${spread >= 0 ? '+' : ''}${spread.toFixed(1)} pts`],
    ['IV percentile', pctl && pctl.pct !== null ? `${pctl.pct} (${pctl.samples} sessions)` : `n/a (${pctl ? pctl.samples : 0} of 5 sessions)`]
  ]);
}

// Baseline snapshot (5m / 15m earlier) from server history, shaped like a local snapshot.
function serverSnapshot(name) {
  const b = intraday && intraday.baselines && intraday.baselines[name];
  if (!b || !currentData || intraday.expiry !== currentData.expiry) return null;
  const nowT = new Date(currentData.dataAsOf || currentData.fetchedAt).getTime();
  if (b.t >= nowT) return null;
  const strikes = {};
  Object.entries(b.strikes || {}).forEach(([k, [ce, pe]]) => { strikes[k] = { ceOI: ce, peOI: pe }; });
  return { pcr: b.pcr, spot: b.spot, totalCallOI: b.callOI, totalPutOI: b.putOI, strikes, timestamp: b.t };
}

export async function fetchNow() {
  if (fetchInProgress) return;

  fetchInProgress = true;
  try {
    const data = await fetchOptionChainData(selectedExpiry);
    const unchanged = currentData && data.fetchedAt === currentData.fetchedAt;
    if (!unchanged) {
      prevData = currentData;
      currentData = data;
      renderAll();
    }
    hideOverlay();
    setLive(true);
    refreshIntraday();
    refreshParticipants();
    refreshPriceChart();
    refreshForwardLog();
  } catch (e) {
    setLive(false);
    console.error('Fetch failed:', e);
  } finally {
    fetchInProgress = false;
  }
}

export function setLive(ok) {
  const dot = document.getElementById('liveDot');
  const st = document.getElementById('statusText');
  if (dot) dot.classList.toggle('error', !ok);
  if (st) st.textContent = ok ? (isMarketOpen() ? 'Live · auto-refresh every ' + (intervalMs / 1000) + 's' : 'Market closed · refreshing every 60s') : 'Disconnected / Retrying…';
}

export function hideOverlay() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.add('hidden');
}

function updateKeyStrip(d) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ksSpot', fmt(d.spot));
  set('ksAtm', fmt(d.atm));
  set('ksPcr', d.pcr.toFixed(2));
  set('ksVix', d.vix ? `${d.vix.last.toFixed(2)} ${d.vix.percentChange >= 0 ? '▲' : '▼'}${Math.abs(d.vix.percentChange).toFixed(1)}%` : 'n/a');
  set('ksDay', d.day ? `${d.day.percentChange >= 0 ? '+' : ''}${d.day.percentChange.toFixed(2)}%` : 'n/a');
  set('ksPain', fmt(d.maxPain));
  set('ksFut', d.impliedFuture ? `${fmt(d.impliedFuture)} (${d.basis >= 0 ? '+' : ''}${d.basis})` : 'n/a');
  const dayEl = document.getElementById('ksDay');
  if (dayEl && d.day) dayEl.style.color = d.day.percentChange >= 0 ? 'var(--bull)' : 'var(--bear)';
  set('ksRegime', d.compositeRegime ? d.compositeRegime.regimeLabel : 'n/a');
  document.body.classList.remove('is-loading');
  updateAge();
}

function updateAge() {
  const el = document.getElementById('ksAge');
  if (!el || !currentData) return;
  const sec = Math.max(0, Math.round((Date.now() - new Date(currentData.dataAsOf || currentData.fetchedAt).getTime()) / 1000));
  el.textContent = sec < 90 ? sec + 's ago' : sec < 5400 ? Math.round(sec / 60) + 'm ago' : (sec / 3600).toFixed(1) + 'h ago';
  el.classList.toggle('stale', sec > 120 && isMarketOpen());
  renderFreshness();
}
setInterval(updateAge, 1000);

const FEED_HELP = {
  chain: 'Option chain from NSE. NSE refreshes about every 30 to 60 seconds. Amber after 90 seconds, red after 3 minutes or when the server is showing a leftover copy because NSE failed.',
  candles: 'Price candles from Yahoo Finance (delayed by design). Shows how far the latest candle is behind the clock. Red when the server is showing a leftover copy or this page could not load them.',
  saved: 'Saved per-minute snapshots (the cron job). Amber after 3 minutes without a new point, red after 6.'
};

function setChip(id, name, kind, result) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `fresh-chip ${result.level}`;
  el.title = FEED_HELP[kind];
  el.textContent = '';
  const dot = document.createElement('i');
  dot.className = 'fresh-dot';
  const label = document.createElement('span');
  label.className = 'fresh-name';
  label.textContent = name;
  el.append(dot, label, document.createTextNode(' ' + result.text));
}

function renderFreshness() {
  const now = Date.now();
  const open = isMarketOpen();

  const chainAge = currentData ? (now - new Date(currentData.dataAsOf || currentData.fetchedAt).getTime()) / 1000 : NaN;
  setChip('freshChain', 'NSE', 'chain', freshness('chain', chainAge, { open, hasData: !!currentData, stale: !!(currentData && currentData.feed && currentData.feed.stale) }));

  const cs = chartFeedStatus();
  if (!cs) {
    setChip('freshCandles', 'Candles', 'candles', freshness('candles', NaN, { open, hasData: false }));
  } else {
    const lag = candleLagSec(cs.feed, cs.interval, now);
    const pollAge = cs.clientFetchedAt ? (now - cs.clientFetchedAt) / 1000 : 0;
    // daily candles have no lag measure; otherwise also count this page failing to refresh them
    const age = lag === null ? NaN : Math.max(lag, pollAge > 90 ? pollAge : 0);
    const res = freshness('candles', age, { open: open && lag !== null, hasData: cs.hasCandles, stale: !!(cs.feed && cs.feed.stale) });
    setChip('freshCandles', cs.feed && cs.feed.source === 'stored' ? 'Candles (saved)' : 'Candles', 'candles', res);
  }

  const pts = intraday && intraday.points;
  const lastT = pts && pts.length ? pts[pts.length - 1].t : null;
  setChip('freshSaved', 'Saved', 'saved', freshness('saved', lastT ? (now - lastT) / 1000 : NaN, { open, hasData: !!lastT }));
}

export function renderAll() {
  if (!currentData) return;
  const d = currentData;

  // Expiry dropdown
  const sel = document.getElementById('expirySelect');
  if (sel && (sel.options.length <= 1 || sel.options[0].value === '')) {
    sel.innerHTML = d.allExpiries.map(e =>
      `<option value="${escapeHtml(e)}" ${e === d.expiry ? 'selected' : ''}>${escapeHtml(e)}</option>`
    ).join('');
  }
  const expLabel = document.getElementById('expiryLabel');
  if (expLabel) expLabel.textContent = d.expiry;

  updateKeyStrip(d);

  // Metrics
  document.getElementById('mSpot').textContent = fmt(d.spot);
  document.getElementById('mATM').textContent = fmt(d.atm);

  const pcrEl = document.getElementById('mPCR');
  if (pcrEl) {
    pcrEl.textContent = d.pcr.toFixed(2);
    pcrEl.className = 'val ' + (d.pcr > 1.2 ? 'bull' : d.pcr < 0.8 ? 'bear' : 'warn');
  }
  document.getElementById('mPCRsub').textContent = d.pcr > 1.2 ? 'Bullish' : d.pcr < 0.8 ? 'Bearish' : 'Neutral';

  document.getElementById('mNtmPcr').textContent = d.ntmPcr !== undefined ? d.ntmPcr.toFixed(2) : 'n/a';
  document.getElementById('mVolPcr').textContent = d.volPcr !== undefined ? d.volPcr.toFixed(2) : 'n/a';

  if (d.lowerRange && d.upperRange) {
    document.getElementById('mExpectedRange').textContent = `${fmt(Math.round(d.lowerRange))} - ${fmt(Math.round(d.upperRange))}`;
  } else {
    document.getElementById('mExpectedRange').textContent = 'n/a';
  }
  document.getElementById('mStraddlePrice').textContent = d.straddlePrice ? fmt(Math.round(d.straddlePrice)) : 'n/a';

  // Populate ATM Straddle & Expected Move Calculator
  if (d.straddleDetails) {
    const sd = d.straddleDetails;
    const atmBadge = document.getElementById('straddleAtmBadge');
    if (atmBadge) atmBadge.textContent = `ATM: ${fmt(sd.atm)}`;
    const ceLtp = document.getElementById('straddleCeLtp');
    if (ceLtp) ceLtp.textContent = `CE: ₹${sd.ceLtp.toFixed(2)}`;
    const peLtp = document.getElementById('straddlePeLtp');
    if (peLtp) peLtp.textContent = `PE: ₹${sd.peLtp.toFixed(2)}`;
    const totalLtp = document.getElementById('straddleTotalLtp');
    if (totalLtp) totalLtp.textContent = `₹${sd.straddlePrice.toFixed(2)}`;
    const openPrice = document.getElementById('straddleOpenPrice');
    if (openPrice) openPrice.textContent = sd.prevCloseStraddle ? `₹${sd.prevCloseStraddle.toFixed(2)}` : 'n/a';
    const dayChg = document.getElementById('straddleDayChg');
    if (dayChg) {
      dayChg.textContent = sd.prevCloseStraddle ? `${sd.decayPct >= 0 ? '+' : ''}${sd.decayPct.toFixed(1)}%` : 'n/a';
      dayChg.style.color = sd.decayPct < 0 ? 'var(--bull)' : sd.decayPct > 0 ? 'var(--bear)' : 'var(--muted)';
    }
    const dailyMove = document.getElementById('straddleDailyMove');
    if (dailyMove) dailyMove.textContent = sd.dailyMove ? `±${sd.dailyMove.toFixed(0)}` : 'n/a';

    const expMove = document.getElementById('straddleExpectedMove');
    if (expMove) expMove.textContent = `± ${sd.expectedMove.toFixed(1)} pts (${sd.expectedMovePct.toFixed(2)}%)`;
    const rangeBounds = document.getElementById('straddleRangeBounds');
    if (rangeBounds) rangeBounds.textContent = `${fmt(Math.round(sd.lowerRange))} - ${fmt(Math.round(sd.upperRange))}`;
    const lowerB = document.getElementById('straddleLowerBound');
    if (lowerB) lowerB.textContent = fmt(Math.round(sd.lowerRange));
    const upperB = document.getElementById('straddleUpperBound');
    if (upperB) upperB.textContent = fmt(Math.round(sd.upperRange));

    const decayBadge = document.getElementById('straddleDecayBadge');
    if (decayBadge) {
      if (sd.decayStatus === 'DECAYING') {
        setIconText(decayBadge, 'trending-down', `${Math.abs(sd.decayPct).toFixed(1)}% below prev session`);
        decayBadge.style.background = 'rgba(16,185,129,0.15)';
        decayBadge.style.color = 'var(--bull)';
      } else if (sd.decayStatus === 'EXPANDING') {
        setIconText(decayBadge, 'trending-up', `${Math.abs(sd.decayPct).toFixed(1)}% above prev session`);
        decayBadge.style.background = 'rgba(239,68,68,0.15)';
        decayBadge.style.color = 'var(--bear)';
      } else {
        setIconText(decayBadge, 'minus', `Flat vs prev session (${sd.decayPct.toFixed(1)}%)`);
        decayBadge.style.background = 'var(--surface2)';
        decayBadge.style.color = 'var(--text)';
      }
    }

    const gaugeSpotLabel = document.getElementById('gaugeSpotLabel');
    const gaugeLowerLabel = document.getElementById('gaugeLowerLabel');
    const gaugeUpperLabel = document.getElementById('gaugeUpperLabel');
    const gaugeSpotMarker = document.getElementById('gaugeSpotMarker');

    if (gaugeSpotLabel) gaugeSpotLabel.textContent = fmt(d.spot);
    if (gaugeLowerLabel) gaugeLowerLabel.textContent = fmt(Math.round(sd.lowerRange));
    if (gaugeUpperLabel) gaugeUpperLabel.textContent = fmt(Math.round(sd.upperRange));

    if (gaugeSpotMarker && sd.upperRange > sd.lowerRange) {
      const rangeSpan = sd.upperRange - sd.lowerRange;
      let pct = ((d.spot - sd.lowerRange) / rangeSpan) * 100;
      pct = Math.max(0, Math.min(100, pct));
      gaugeSpotMarker.style.left = `${pct.toFixed(1)}%`;
    }
  }

  document.getElementById('mCallOI').textContent = fmtK(d.totalCallOI);
  document.getElementById('mPutOI').textContent = fmtK(d.totalPutOI);
  document.getElementById('mCallChg').textContent = 'Chg: ' + fmtChg(d.totalCallChgOI);
  document.getElementById('mPutChg').textContent = 'Chg: ' + fmtChg(d.totalPutChgOI);

  document.getElementById('mMaxCall').textContent = fmt(d.maxCallOIStrike);
  document.getElementById('mResStrength').textContent = d.resistanceStrength !== undefined ? d.resistanceStrength : 'n/a';

  document.getElementById('mMaxPut').textContent = fmt(d.maxPutOIStrike);
  document.getElementById('mSupStrength').textContent = d.supportStrength !== undefined ? d.supportStrength : 'n/a';

  const skewEl = document.getElementById('mIvSkew');
  if (skewEl) {
    if (d.ivSkew !== undefined) {
      const skewRounded = Number(d.ivSkew.toFixed(1)); // avoids a stray "-0.0%"
      skewEl.textContent = (skewRounded > 0 ? '+' : '') + (skewRounded === 0 ? '0.0' : skewRounded.toFixed(1)) + '%';
      skewEl.className = 'val ' + (d.ivSkew > 1 ? 'bear' : d.ivSkew < -1 ? 'bull' : 'warn');
      const skewSub = document.getElementById('mIvSkewSub');
      if (skewSub) {
        if (d.ivSkew > 1) {
          skewSub.textContent = 'Puts richer (hedging demand)';
          skewSub.className = 'sub bear';
        } else if (d.ivSkew < -1) {
          skewSub.textContent = 'Calls richer (upside chasing)';
          skewSub.className = 'sub bull';
        } else {
          skewSub.textContent = 'Balanced IV';
          skewSub.className = 'sub warn';
        }
        if (d.ivSkewDetail) {
          skewSub.title = `${d.ivSkewMethod}: ${d.ivSkewDetail.putStrike}PE ${d.ivSkewDetail.putIv}% vs ${d.ivSkewDetail.callStrike}CE ${d.ivSkewDetail.callIv}%`;
        }
      }
    } else {
      skewEl.textContent = 'n/a';
      document.getElementById('mIvSkewSub').textContent = 'n/a';
    }
  }
  const volBadge = document.getElementById('volRegimeBadge');
  if (d.volatilityRegime && volBadge) {
    const vr = d.volatilityRegime;
    volBadge.textContent = vr.badgeText;
    volBadge.className = 'vol-badge ' + (
      vr.regime === 'HIGH_IV' ? 'vol-high' :
        vr.regime === 'LOW_IV' ? 'vol-low' :
          vr.regime === 'NORMAL_IV' ? 'vol-normal' : 'vol-history'
    );

    if (vr.source === 'VIX') {
      volBadge.title = `India VIX ${vr.vix} (${vr.vixChangePct >= 0 ? '+' : ''}${vr.vixChangePct}% today) | ATM IV ${vr.todayIv}% (${vr.atmIvVsVix >= 0 ? '+' : ''}${vr.atmIvVsVix} vs VIX). No stored IV history, so regime uses VIX level (≥20 high, ≤12 low).`;
    } else if (vr.regime === 'INSUFFICIENT_HISTORY') {
      volBadge.title = 'No IV history and VIX unavailable';
    } else {
      volBadge.title = `z = ${vr.zScore > 0 ? '+' : ''}${vr.zScore} | 20-day avg IV: ${vr.mean20}% | StdDev: ${vr.stddev20}% | Today: ${vr.todayIv}%`;
    }
  }

  document.getElementById('mMaxPain').textContent = fmt(d.maxPain);
  if (d.walls) {
    const fmtWalls = ws => ws.map(w => `${fmt(w.strike)} <span style="color:var(--muted)">(${fmtK(w.oi)})</span>`).join('<br>') || 'n/a';
    document.getElementById('mWallsCall').innerHTML = fmtWalls(d.walls.calls);
    document.getElementById('mWallsPut').innerHTML = fmtWalls(d.walls.puts);
  }
  document.getElementById('mTime').textContent = timeStr(d.fetchedAt);

  if (d.cpr) {
    document.getElementById('mCprPivot').textContent = fmt(d.cpr.pivot);
    document.getElementById('mCprTc').textContent = fmt(d.cpr.tc);
    document.getElementById('mCprBc').textContent = fmt(d.cpr.bc);
    document.getElementById('mCprWidth').textContent = d.cpr.cprWidth;
    const cprTypeEl = document.getElementById('mCprType');
    if (cprTypeEl) {
      cprTypeEl.textContent = d.cpr.cprType;
      cprTypeEl.className = 'val ' + (d.cpr.cprType === 'NARROW' ? 'bull' : d.cpr.cprType === 'WIDE' ? 'bear' : 'warn');
    }

    const srcEl = document.getElementById('cprSource');
    if (srcEl) {
      const real = d.cpr.source === 'PREV_SESSION';
      setIconText(srcEl, real ? null : 'alert-triangle', real ? `· from ${d.cpr.basisDate} H/L/C` : 'OI-estimate (prev-session data unavailable)');
      srcEl.style.color = d.cpr.source === 'PREV_SESSION' ? 'var(--muted)' : 'var(--warn)';
    }
    document.getElementById('mCprR1').textContent = fmt(d.cpr.r1);
    document.getElementById('mCprS1').textContent = fmt(d.cpr.s1);
    document.getElementById('mCprR2').textContent = fmt(d.cpr.r2);
    document.getElementById('mCprS2').textContent = fmt(d.cpr.s2);
  }

  if (d.gex) {
    const netGexEl = document.getElementById('mNetGex');
    if (netGexEl) {
      netGexEl.textContent = (d.gex.totalGexCr >= 0 ? '+' : '') + d.gex.totalGexCr + ' Cr';
      netGexEl.className = 'val ' + (d.gex.totalGexCr >= 0 ? 'bull' : 'bear');
    }

    const gexRegimeEl = document.getElementById('mGexRegime');
    if (gexRegimeEl) {
      gexRegimeEl.textContent = d.gex.gexRegime === 'POSITIVE_GAMMA' ? 'Low Vol (Mean Revert)' : 'High Vol (Trend)';
      gexRegimeEl.className = 'sub ' + (d.gex.gexRegime === 'POSITIVE_GAMMA' ? 'bull' : 'bear');
    }

    document.getElementById('mZeroGamma').textContent = d.gex.zeroGammaLevel !== null ? fmt(d.gex.zeroGammaLevel) : 'None';
    document.getElementById('mGexDist').textContent = d.gex.distToZeroGamma !== null
      ? (d.gex.distToZeroGamma >= 0 ? '+' : '') + d.gex.distToZeroGamma + ' pts to flip'
      : 'No sign flip within ±1500 pts';

    document.getElementById('mCallGex').textContent = d.gex.callGexCr;
    document.getElementById('mPutGex').textContent = d.gex.putGexCr;
  }

  const pcr = d.pcr;
  const pFill = document.getElementById('pcrFill');
  if (pFill) {
    pFill.style.width = Math.min(100, Math.round(pcr / 2 * 100)) + '%';
    pFill.style.background = pcr > 1.2 ? '#10b981' : pcr < 0.8 ? '#ef4444' : '#f59e0b';
  }
  document.getElementById('pcrVal').textContent = pcr.toFixed(2);
  const sentEl = document.getElementById('pcrSent');
  if (sentEl) {
    if (pcr > 1.2) { sentEl.textContent = 'Bullish'; sentEl.className = 'pcr-sent bull'; }
    else if (pcr < 0.8) { sentEl.textContent = 'Bearish'; sentEl.className = 'pcr-sent bear'; }
    else { sentEl.textContent = 'Neutral'; sentEl.className = 'pcr-sent warn'; }
  }

  if (d.compositeRegime) {
    const cr = d.compositeRegime;
    setIconText(document.getElementById('regimeTitle'), regimeIcon(cr.regimeLabel), cr.regimeLabel);
    document.getElementById('regimeStrategy').textContent = 'Strategy: ' + cr.actionableStrategy;
    document.getElementById('regimeConfidence').textContent = `Signal agreement: ${cr.confidenceScore}%`;

    const biasBadge = document.getElementById('tacticalBiasBadge');
    if (biasBadge) {
      setIconText(biasBadge, cr.tacticalBias.includes('BULLISH') ? 'trending-up' : cr.tacticalBias.includes('BEARISH') ? 'trending-down' : 'scale', 'Bias: ' + cr.tacticalBias.replace('_', ' '));
      biasBadge.className = 'bias-badge ' + (
        cr.tacticalBias.includes('BULLISH') ? 'bull' :
          cr.tacticalBias.includes('BEARISH') ? 'bear' : 'warn'
      );
    }
  }

  if (d.impliedProbability) {
    const ip = d.impliedProbability;
    const modeEl = document.getElementById('pdfModeStrike');
    if (modeEl) modeEl.textContent = fmt(ip.modeStrike);

    const range68El = document.getElementById('pdf68Range');
    if (range68El) range68El.textContent = `${fmt(ip.confidence68.lower)} - ${fmt(ip.confidence68.upper)}`;

    const range95El = document.getElementById('pdf95Range');
    if (range95El) range95El.textContent = `${fmt(ip.confidence95.lower)} - ${fmt(ip.confidence95.upper)}`;

    const stayEl = document.getElementById('pdfStayProbability');
    if (stayEl) stayEl.textContent = `${ip.stayProbabilityPct}%`;
  }

  if (d.mlPredictions) {
    const ml = d.mlPredictions;

    const signalBadge = document.getElementById('mlSignalBadge');
    if (signalBadge) {
      signalBadge.textContent = ml.directionalTrend.signal;
      signalBadge.style.background = ml.directionalTrend.signalClass === 'bull' ? 'rgba(16,185,129,0.15)' :
        ml.directionalTrend.signalClass === 'bear' ? 'rgba(239,68,68,0.15)' : 'var(--surface2)';
      signalBadge.style.color = ml.directionalTrend.signalClass === 'bull' ? 'var(--bull)' :
        ml.directionalTrend.signalClass === 'bear' ? 'var(--bear)' : 'var(--warn)';
    }

    const confEl = document.getElementById('mlDirectionConfidence');
    if (confEl) confEl.textContent = `Lean strength: ${ml.directionalTrend.confidence.toFixed(1)}%`;

    const barBull = document.getElementById('mlBarBull');
    const barNeut = document.getElementById('mlBarNeut');
    const barBear = document.getElementById('mlBarBear');

    if (barBull) barBull.style.width = `${ml.directionalTrend.bullishPct}%`;
    if (barNeut) barNeut.style.width = `${ml.directionalTrend.neutralPct}%`;
    if (barBear) barBear.style.width = `${ml.directionalTrend.bearishPct}%`;

    const pctBull = document.getElementById('mlPctBull');
    const pctNeut = document.getElementById('mlPctNeut');
    const pctBear = document.getElementById('mlPctBear');

    if (pctBull) pctBull.textContent = `${ml.directionalTrend.bullishPct}%`;
    if (pctNeut) pctNeut.textContent = `${ml.directionalTrend.neutralPct}%`;
    if (pctBear) pctBear.textContent = `${ml.directionalTrend.bearishPct}%`;

    const stateLabel = document.getElementById('mlStateLabel');
    if (stateLabel) {
      stateLabel.textContent = ml.marketState.stateLabel;
      stateLabel.style.color = ml.marketState.isHighVol ? '#a78bfa' : '#3b82f6';
    }

    const barBreakout = document.getElementById('mlBarBreakout');
    const barRangebound = document.getElementById('mlBarRangebound');

    if (barBreakout) barBreakout.style.width = `${ml.marketState.breakoutProbPct}%`;
    if (barRangebound) barRangebound.style.width = `${ml.marketState.rangeboundProbPct}%`;

    const pctBreakout = document.getElementById('mlPctBreakout');
    const pctRangebound = document.getElementById('mlPctRangebound');

    if (pctBreakout) pctBreakout.textContent = `${ml.marketState.breakoutProbPct}%`;
    if (pctRangebound) pctRangebound.textContent = `${ml.marketState.rangeboundProbPct}%`;
  }

  renderTradeSetup(d);


  recordSnapshot(d);
  renderSectors(d);
  renderFlowFeed(d);
  renderTimeline();
  renderVolPanels();
  renderOiChart_();
  processAlerts(d, { spikeAlerts: lastSpikeAlerts, spot5m: serverSnapshot('m5')?.spot, chart: currentChartSignals() });
  fetchSimilarSessions();
  renderTable();
}

// --- Rate of Change (RoC) & Institutional Velocity Engine ---
const snapshotHistory = [];

function recordSnapshot(d) {
  if (!d) return;
  const now = Date.now();
  const strikesMap = {};
  if (d.strikes && Array.isArray(d.strikes)) {
    d.strikes.forEach(s => {
      strikesMap[s.strike] = {
        ceOI: s.CE?.openInterest || 0,
        peOI: s.PE?.openInterest || 0
      };
    });
  }

  snapshotHistory.push({
    timestamp: now,
    pcr: d.pcr || 0,
    totalCallOI: d.totalCallOI || 0,
    totalPutOI: d.totalPutOI || 0,
    strikes: strikesMap
  });

  // Maintain up to 16 minutes of rolling history (local fallback when server history is unavailable)
  const cutoff = now - 960000;
  while (snapshotHistory.length > 0 && snapshotHistory[0].timestamp < cutoff) {
    snapshotHistory.shift();
  }
}

function getSnapshotAgo(msAgo) {
  if (snapshotHistory.length < 2) return null;
  const now = Date.now();
  const targetTime = now - msAgo;
  let closest = snapshotHistory[0];
  let minDiff = Math.abs(closest.timestamp - targetTime);

  for (let i = 1; i < snapshotHistory.length; i++) {
    const diff = Math.abs(snapshotHistory[i].timestamp - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = snapshotHistory[i];
    }
  }

  const historySpan = now - snapshotHistory[0].timestamp;
  if (minDiff > 45000 && historySpan < msAgo - 30000) {
    if (historySpan >= 15000) return snapshotHistory[0];
    return null;
  }
  return closest;
}

function calculateAndRenderRoC(d) {
  const snap3m = getSnapshotAgo(180000);
  const snap5m = serverSnapshot('m5') || getSnapshotAgo(300000);
  const snap15m = serverSnapshot('m15') || getSnapshotAgo(900000);
  const snapOpen = serverSnapshot('open');

  const fmtDelta = (val, isPcr = false) => {
    if (val === null || val === undefined) return 'n/a';
    if (isPcr) {
      const sign = val > 0 ? '+' : '';
      const color = val > 0.02 ? 'var(--bull)' : val < -0.02 ? 'var(--bear)' : 'var(--muted)';
      return `<span style="color:${color}">${sign}${val.toFixed(2)}</span>`;
    } else {
      const sign = val > 0 ? '+' : '';
      const color = val > 0 ? 'var(--bull)' : val < 0 ? 'var(--bear)' : 'var(--muted)';
      return `<span style="color:${color}">${sign}${fmtK(val)}</span>`;
    }
  };

  // PCR RoC (5m / 15m; tooltip adds change since the open when history has it)
  const diff = (snap, key, now) => (snap ? now - snap[key] : null);
  const pcrRocEl = document.getElementById('mPcrRoc');
  if (pcrRocEl) {
    pcrRocEl.innerHTML = `5m: ${fmtDelta(diff(snap5m, 'pcr', d.pcr), true)} | 15m: ${fmtDelta(diff(snap15m, 'pcr', d.pcr), true)}`;
    pcrRocEl.title = snapOpen ? `Since open: ${(d.pcr - snapOpen.pcr >= 0 ? '+' : '')}${(d.pcr - snapOpen.pcr).toFixed(2)}` : '';
  }

  // Call & Put OI RoC
  const callRocEl = document.getElementById('mCallRoc');
  if (callRocEl) {
    callRocEl.innerHTML = `5m: ${fmtDelta(diff(snap5m, 'totalCallOI', d.totalCallOI))} | 15m: ${fmtDelta(diff(snap15m, 'totalCallOI', d.totalCallOI))}`;
    callRocEl.title = snapOpen ? `Since open: ${fmtK(d.totalCallOI - snapOpen.totalCallOI)}` : '';
  }

  const putRocEl = document.getElementById('mPutRoc');
  if (putRocEl) {
    putRocEl.innerHTML = `5m: ${fmtDelta(diff(snap5m, 'totalPutOI', d.totalPutOI))} | 15m: ${fmtDelta(diff(snap15m, 'totalPutOI', d.totalPutOI))}`;
    putRocEl.title = snapOpen ? `Since open: ${fmtK(d.totalPutOI - snapOpen.totalPutOI)}` : '';
  }

  // Institutional Spike Detection (3-min & 5-min strike velocity)
  const spikeAlerts = [];
  const compSnap = snap5m || snap3m;
  if (compSnap && d.strikes && Array.isArray(d.strikes)) {
    const timeLabel = snap5m ? '5m' : 'recent';
    d.strikes.forEach(s => {
      const prevStrike = compSnap.strikes[s.strike];
      if (!prevStrike) return;

      const ceDelta = (s.CE?.openInterest || 0) - prevStrike.ceOI;
      const peDelta = (s.PE?.openInterest || 0) - prevStrike.peOI;

      if (peDelta >= 25000) {
        spikeAlerts.push({
          type: 'PUT_WRITING',
          strike: s.strike,
          summary: `Rapid Put Writing at ${s.strike}: +${fmtK(peDelta)} in ${timeLabel} (Bullish Support)`
        });
      } else if (peDelta <= -20000) {
        spikeAlerts.push({
          type: 'PUT_UNWINDING',
          strike: s.strike,
          summary: `Rapid Put Unwinding at ${s.strike}: ${fmtK(peDelta)} in ${timeLabel} (Support Break)`
        });
      }

      if (ceDelta >= 25000) {
        spikeAlerts.push({
          type: 'CALL_WRITING',
          strike: s.strike,
          summary: `Rapid Call Writing at ${s.strike}: +${fmtK(ceDelta)} in ${timeLabel} (Bearish Wall)`
        });
      } else if (ceDelta <= -20000) {
        spikeAlerts.push({
          type: 'CALL_COVERING',
          strike: s.strike,
          summary: `Rapid Call Short Covering at ${s.strike}: ${fmtK(ceDelta)} in ${timeLabel} (Short Squeeze)`
        });
      }
    });
  }

  return spikeAlerts;
}

let lastSpikeAlerts = [];

function renderFlowFeed(d) {
  const spikeAlerts = calculateAndRenderRoC(d);
  lastSpikeAlerts = spikeAlerts;

  const flowFeed = document.getElementById('flowAlertsFeed');
  if (flowFeed) {
    const combinedAlerts = [];

    // Add 5m institutional spike alerts first
    spikeAlerts.forEach(s => {
      const isBull = s.type === 'PUT_WRITING' || s.type === 'CALL_COVERING';
      const color = isBull ? 'var(--bull)' : 'var(--bear)';
      const bg = isBull ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
      const border = isBull ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
      const glyph = s.type === 'PUT_UNWINDING' ? 'alert-triangle' : s.type === 'CALL_COVERING' ? 'rocket' : 'zap';
      combinedAlerts.push(`
        <span class="flow-chip" style="background: ${bg}; color: ${color}; border: 1px solid ${border}; border-radius: 4px; padding: 2px 8px; white-space: nowrap; font-weight: 600;">
          ${icon(glyph)}${escapeHtml(s.summary)}
        </span>
      `);
    });

    if (d.unusualActivity && d.unusualActivity.length > 0) {
      d.unusualActivity.forEach(a => {
        combinedAlerts.push(`
          <span class="flow-chip" style="background: rgba(245,158,11,0.15); color: var(--warn); border: 1px solid rgba(245,158,11,0.3); border-radius: 4px; padding: 2px 8px; white-space: nowrap; font-weight: 600;">
            ${icon(a.intensity === 'CRITICAL' ? 'zap' : 'flame')}${escapeHtml(a.summary)}
          </span>
        `);
      });
    }

    if (combinedAlerts.length > 0) {
      flowFeed.innerHTML = combinedAlerts.join('');
    } else {
      flowFeed.innerHTML = '<span style="color: var(--muted);">Scanning for 5m OI velocity & volume anomalies...</span>';
    }
  }

}

export async function fetchSimilarSessions() {
  try {
    const { topMatches, reason } = await fetchSimilarSessionsData();
    const container = document.getElementById('similarSessionsList');
    if (!container) return;
    if (!topMatches || topMatches.length === 0) {
      container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:10px;">${escapeHtml(reason || 'No matching sessions')}</div>`;
      return;
    }

    container.innerHTML = topMatches.map(m => `
      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:4px 8px; border-radius:4px;">
        <div>
          <span style="font-weight:600;">${escapeHtml(m.date)}</span>
          <span style="color:var(--muted); font-size:9px; margin-left:4px;">(PCR ${Number(m.closingPcr).toFixed(2)})</span>
        </div>
        <div style="font-weight:600;" class="${m.similarityPct > 90 ? 'bull' : m.similarityPct > 75 ? 'acc' : 'warn'}">
          ${Number(m.similarityPct)}% match
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch similar sessions:', err);
  }
}

export function renderTable() {
  if (!currentData) return;
  const d = currentData;
  let rows = [...d.strikes];

  const maxCallOI = Math.max(...rows.map(r => r.CE?.openInterest || 0));
  const maxPutOI = Math.max(...rows.map(r => r.PE?.openInterest || 0));
  const maxCallChg = Math.max(...rows.map(r => Math.abs(r.CE?.changeinOpenInterest || 0)));
  const maxPutChg = Math.max(...rows.map(r => Math.abs(r.PE?.changeinOpenInterest || 0)));

  if (sortCol) {
    rows.sort((a, b) => {
      const av = getSortVal(a, sortCol);
      const bv = getSortVal(b, sortCol);
      return (av - bv) * sortDir;
    });
  }

  const atm = d.atm;
  const prevRows = prevData ? prevData.strikes : [];
  const prevMap = {};
  prevRows.forEach(r => { prevMap[r.strike] = r; });

  const tbody = document.getElementById('chainBody');
  if (!tbody) return;

  const htmls = rows.map(r => {
    const ce = r.CE || {};
    const pe = r.PE || {};
    const prev = prevMap[r.strike] || {};
    const prevCE = prev.CE || {};
    const isATM = r.strike === atm;

    const cOI = ce.openInterest || 0;
    const pOI = pe.openInterest || 0;
    const cChg = ce.changeinOpenInterest || 0;
    const pChg = pe.changeinOpenInterest || 0;
    const cIV = ce.impliedVolatility || 0;
    const pIV = pe.impliedVolatility || 0;
    const cLTP = ce.lastPrice || 0;
    const pLTP = pe.lastPrice || 0;
    const cBid = ce.bidprice || 0;
    const cAsk = ce.askPrice || 0;
    const pBid = pe.bidprice || 0;
    const pAsk = pe.askPrice || 0;

    const cBD = getSmoothedBuildup(r.strike, cOI, cLTP, true, cChg, ce.change || 0, d.expiry);
    const pBD = getSmoothedBuildup(r.strike, pOI, pLTP, false, pChg, pe.change || 0, d.expiry);

    const cBarW = pct(cOI, maxCallOI);
    const pBarW = pct(pOI, maxPutOI);
    const cChgW = pct(cChg, maxCallChg);
    const pChgW = pct(pChg, maxPutChg);

    const cChgCls = cChg > 0 ? 'pos' : cChg < 0 ? 'neg' : 'zero';
    const pChgCls = pChg > 0 ? 'pos' : pChg < 0 ? 'neg' : 'zero';

    const flashCls = prevData ? (cChg > (prevCE.changeinOpenInterest || 0) ? 'flash-bull' : '') : '';

    const cAnomalyHtml = ce.anomaly && ce.anomaly.isAnomaly ? `<span class="anomaly-badge" title="Z-Score: ${escapeHtml(ce.anomaly.zScore)}">${icon('flame')}z=${escapeHtml(ce.anomaly.zScore)}</span>` : '';
    const pAnomalyHtml = pe.anomaly && pe.anomaly.isAnomaly ? `<span class="anomaly-badge" title="Z-Score: ${escapeHtml(pe.anomaly.zScore)}">${icon('flame')}z=${escapeHtml(pe.anomaly.zScore)}</span>` : '';

    const cFlowHtml = ce.unusualFlow ? `<span class="anomaly-badge" style="background:rgba(239,68,68,0.2); color:#f87171; border-color:rgba(239,68,68,0.4);" title="${escapeHtml(ce.unusualFlow.summary)}">${icon('zap')}${escapeHtml(ce.unusualFlow.volRatio)}x Vol</span>` : '';
    const pFlowHtml = pe.unusualFlow ? `<span class="anomaly-badge" style="background:rgba(16,185,129,0.2); color:#34d399; border-color:rgba(16,185,129,0.4);" title="${escapeHtml(pe.unusualFlow.summary)}">${icon('zap')}${escapeHtml(pe.unusualFlow.volRatio)}x Vol</span>` : '';

    const cGreeks = ce.greeks || {};
    const pGreeks = pe.greeks || {};

    const cGreeksTitle = cGreeks.delta !== undefined
      ? escapeHtml(`Call Greeks:\nDelta (Δ): ${cGreeks.delta}\nGamma (Γ): ${cGreeks.gamma}\nVega (V): ₹${cGreeks.vega} / 1% IV\nTheta (Θ): ₹${cGreeks.theta} / day`)
      : '';

    const pGreeksTitle = pGreeks.delta !== undefined
      ? escapeHtml(`Put Greeks:\nDelta (Δ): ${pGreeks.delta}\nGamma (Γ): ${pGreeks.gamma}\nVega (V): ₹${pGreeks.vega} / 1% IV\nTheta (Θ): ₹${pGreeks.theta} / day`)
      : '';

    const cGreeksClass = window.showGreeks ? '' : 'hidden-greeks';
    const cDeltaVal = cGreeks.delta !== undefined ? cGreeks.delta : '—';
    const cThetaVal = cGreeks.theta !== undefined ? `₹${cGreeks.theta}` : '—';
    const pDeltaVal = pGreeks.delta !== undefined ? pGreeks.delta : '—';
    const pThetaVal = pGreeks.theta !== undefined ? `₹${pGreeks.theta}` : '—';

    return `
<tr class="${isATM ? 'atm-row' : ''} ${flashCls}" data-strike="${r.strike}">
  <td class="right greeks-col ${cGreeksClass} ${cDeltaVal > 0.5 ? 'pos' : ''}" style="font-family:var(--mono); font-size:11px;">${cDeltaVal}</td>
  <td class="right greeks-col ${cGreeksClass} neg" style="font-family:var(--mono); font-size:11px;">${cThetaVal}</td>
  <td class="right">
    <div class="oi-bar-row">
      <span class="chg-val ${cChgCls}">${fmtChg(cChg)}</span>
      ${cAnomalyHtml}
      ${cFlowHtml}
      <div class="bar-track"><div class="bar-fill call-fill" style="width:${cChgW}%"></div></div>
      <span class="bd ${cBD.cls}">${cBD.label}</span>
    </div>
  </td>
  <td class="right">
    <div class="oi-bar-row">
      <span>${fmtK(cOI)}</span>
      <div class="bar-track"><div class="bar-fill call-fill" style="width:${cBarW}%"></div></div>
    </div>
  </td>
  <td class="right muted" title="${cGreeksTitle}">${cIV ? cIV.toFixed(1) + '%' : '—'}</td>
  <td class="right" title="${cGreeksTitle}">${cLTP ? cLTP.toFixed(2) : '—'}</td>
  <td class="right muted" style="font-size:11px;">${cBid ? cBid.toFixed(1) + ' / ' + cAsk.toFixed(1) : '—'}</td>

  <td class="strike-cell ${isATM ? 'atm-row' : ''}" title="Click for this strike's history">
    ${fmt(r.strike)}${isATM ? '<span class="atm-tag">ATM</span>' : ''}
  </td>

  <td class="right muted" style="font-size:11px;">${pBid ? pBid.toFixed(1) + ' / ' + pAsk.toFixed(1) : '—'}</td>
  <td class="right" title="${pGreeksTitle}">${pLTP ? pLTP.toFixed(2) : '—'}</td>
  <td class="right muted" title="${pGreeksTitle}">${pIV ? pIV.toFixed(1) + '%' : '—'}</td>
  <td class="right">
    <div class="oi-bar-row left">
      <div class="bar-track"><div class="bar-fill put-fill" style="width:${pBarW}%"></div></div>
      <span>${fmtK(pOI)}</span>
    </div>
  </td>
  <td class="right">
    <div class="oi-bar-row left">
      <span class="bd ${pBD.cls}">${pBD.label}</span>
      <div class="bar-track"><div class="bar-fill put-fill" style="width:${pChgW}%"></div></div>
      ${pAnomalyHtml}
      ${pFlowHtml}
      <span class="chg-val ${pChgCls}">${fmtChg(pChg)}</span>
    </div>
  </td>
  <td class="right greeks-col ${cGreeksClass} ${Math.abs(pDeltaVal) > 0.5 ? 'pos' : ''}" style="font-family:var(--mono); font-size:11px;">${pDeltaVal}</td>
  <td class="right greeks-col ${cGreeksClass} neg" style="font-family:var(--mono); font-size:11px;">${pThetaVal}</td>
</tr>`;
  });

  reconcileRows(tbody, rows.map(r => r.strike), htmls);
}

// Only touch rows whose markup changed; keep unchanged <tr> nodes in place.
const rowHtmlCache = new Map();
function reconcileRows(tbody, keys, htmls) {
  const existing = new Map();
  for (const tr of tbody.children) existing.set(tr.dataset.strike, tr);

  const tpl = document.createElement('template');
  const seen = new Set();
  let cursor = tbody.firstElementChild;

  keys.forEach((strike, i) => {
    const key = String(strike);
    seen.add(key);
    let tr = existing.get(key);

    if (!tr || rowHtmlCache.get(key) !== htmls[i]) {
      tpl.innerHTML = htmls[i].trim();
      const fresh = tpl.content.firstElementChild;
      if (tr) {
        if (tr === cursor) cursor = cursor.nextElementSibling;
        tr.replaceWith(fresh);
      }
      tr = fresh;
      rowHtmlCache.set(key, htmls[i]);
    }

    if (tr !== cursor) tbody.insertBefore(tr, cursor);
    else cursor = cursor.nextElementSibling;
  });

  for (const [key, tr] of existing) {
    if (!seen.has(key)) { tr.remove(); rowHtmlCache.delete(key); }
  }
}

export function getSortVal(row, col) {
  const ce = row.CE || {};
  const pe = row.PE || {};
  const cG = ce.greeks || {};
  const pG = pe.greeks || {};
  const map = {
    callDelta: cG.delta !== undefined ? cG.delta : 0,
    callTheta: cG.theta !== undefined ? cG.theta : 0,
    callChgOI: ce.changeinOpenInterest || 0,
    callOI: ce.openInterest || 0,
    callIV: ce.impliedVolatility || 0,
    callLTP: ce.lastPrice || 0,
    callBid: ce.bidprice || 0,
    putBid: pe.bidprice || 0,
    putLTP: pe.lastPrice || 0,
    putIV: pe.impliedVolatility || 0,
    putOI: pe.openInterest || 0,
    putChgOI: pe.changeinOpenInterest || 0,
    putDelta: pG.delta !== undefined ? pG.delta : 0,
    putTheta: pG.theta !== undefined ? pG.theta : 0,
  };
  return map[col] !== undefined ? map[col] : row.strike;
}

export function toggleGreeksView() {
  const chk = document.getElementById('toggleGreeksBtn');
  window.showGreeks = chk ? chk.checked : false;

  const callColspan = document.getElementById('callHeaderColspan');
  const putColspan = document.getElementById('putHeaderColspan');
  if (callColspan) callColspan.colSpan = window.showGreeks ? 7 : 5;
  if (putColspan) putColspan.colSpan = window.showGreeks ? 7 : 5;

  const greeksCols = document.querySelectorAll('.greeks-col');
  greeksCols.forEach(col => {
    col.classList.toggle('hidden-greeks', !window.showGreeks);
  });
}

export function sortTable(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = -1; }
  renderSortIndicator();
  renderTable();
}

// Arrow on the sorted column header (styles .sort-asc / .sort-desc) and aria-sort for screen readers.
function renderSortIndicator() {
  document.querySelectorAll('#chainTable th[data-click^="sortTable:"]').forEach(th => {
    const col = th.dataset.click.split(':')[1];
    const active = col === sortCol;
    th.classList.toggle('sort-asc', active && sortDir === 1);
    th.classList.toggle('sort-desc', active && sortDir === -1);
    th.setAttribute('aria-sort', active ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
  });
}

function isMarketOpen() {
  // NSE cash hours: Mon-Fri 09:15-15:30 IST (with a small buffer)
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 10 && mins <= 15 * 60 + 40;
}

function scheduleNext() {
  clearTimeout(timer);
  // Closed market: data is static, poll slowly. Hidden tab: stop polling unless alerts need it.
  if (document.hidden && !alertsEnabled()) return;
  let delay = isMarketOpen() ? intervalMs : Math.max(intervalMs, 60000);
  if (document.hidden) delay = Math.max(delay, 30000);
  cdRemaining = Math.round(delay / 1000);
  timer = setTimeout(async () => {
    await fetchNow();
    scheduleNext();
  }, delay);
}

export function startAutoRefresh() {
  clearTimeout(timer);
  clearInterval(cdInterval);

  cdInterval = setInterval(() => {
    cdRemaining = Math.max(0, cdRemaining - 1);
    const cdEl = document.getElementById('cdTimer');
    if (cdEl) cdEl.textContent = cdRemaining;
  }, 1000);

  scheduleNext();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (!alertsEnabled()) clearTimeout(timer);
  } else {
    fetchNow().then(scheduleNext); // catch up immediately on return
  }
});

export function onIntervalChange() {
  const sel = document.getElementById('intervalSelect');
  intervalMs = sel ? parseInt(sel.value, 10) : 3000;
  setLive(true);
  startAutoRefresh();
}

export function onExpiryChange() {
  const sel = document.getElementById('expirySelect');
  selectedExpiry = sel ? sel.value : null;
  intraday = null;
  fetchNow();
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = theme;
  setIconText(document.getElementById('themeIcon'), themeIcon(theme), '');
  // Charts read colours from CSS variables when they draw, so redraw them now rather than on the next tick.
  if (currentData) {
    renderTimeline();
    renderVolPanels();
    renderOiChart_();
  }
  if (participantDays) renderParticipants();
  restyleChart();
}

export function initTheme() {
  const saved = localStorage.getItem('oi_tracker_theme') || 'system';
  applyTheme(saved);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = localStorage.getItem('oi_tracker_theme') || 'system';
    if (current === 'system') {
      applyTheme('system');
    }
  });
}

export function onThemeSelectChange() {
  const sel = document.getElementById('themeSelect');
  const val = sel ? sel.value : 'system';
  localStorage.setItem('oi_tracker_theme', val);
  applyTheme(val);
}

export function exportCSV() {
  if (!currentData || !currentData.strikes) {
    alert('No data available to export yet!');
    return;
  }

  const headers = [
    'Call_Chg_OI', 'Call_OI', 'Call_IV', 'Call_LTP', 'Call_Bid', 'Call_Ask',
    'Strike',
    'Put_Bid', 'Put_Ask', 'Put_LTP', 'Put_IV', 'Put_OI', 'Put_Chg_OI'
  ];

  const csvRows = [headers.join(',')];

  currentData.strikes.forEach(r => {
    const ce = r.CE || {};
    const pe = r.PE || {};
    const row = [
      ce.changeinOpenInterest || 0,
      ce.openInterest || 0,
      ce.impliedVolatility || 0,
      ce.lastPrice || 0,
      ce.bidprice || 0,
      ce.askPrice || 0,
      r.strike,
      pe.bidprice || 0,
      pe.askPrice || 0,
      pe.lastPrice || 0,
      pe.impliedVolatility || 0,
      pe.openInterest || 0,
      pe.changeinOpenInterest || 0
    ];
    // Numbers only: a spreadsheet would execute a text cell starting with = + - or @ as a formula.
    csvRows.push(row.map(v => (Number.isFinite(Number(v)) ? Number(v) : 0)).join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = `ChainDeck_${currentData.expiry || 'chain'}_${new Date().toISOString().slice(0, 10)}.csv`;
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Load a same-origin script once; rejects (instead of throwing inside a callback) so callers can catch it. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.loaded) { resolve(); return; }
    const script = existing || document.createElement('script');
    script.onload = () => { script.dataset.loaded = '1'; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    if (!existing) { script.src = src; document.head.appendChild(script); }
  });
}

export async function takeSnapshot() {
  const btn = document.getElementById('btnSnapshot');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) setIconText(btn, 'loader', 'Capturing...', 'spin');

  const captureWindow = async () => {
    const canvas = await window.html2canvas(document.body, {
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#0d0f14',
      scrollX: 0,
      scrollY: 0,
      scale: 1.5,
      useCORS: true
    });
    const image = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    const filename = `ChainDeck_Snapshot_${new Date().toISOString().slice(0, 10)}.png`;
    link.download = filename;
    link.href = image;
    link.click();
  };

  try {
    if (typeof window.html2canvas === 'undefined') await loadScript('/vendor/html2canvas.min.js');
    await captureWindow();
  } catch (err) {
    console.error('Snapshot failed:', err);
    alert('Failed to capture snapshot.');
  } finally {
    if (btn) btn.innerHTML = originalHtml; // always reset the button, whatever happened
  }
}

export async function exportPDF() {
  if (!currentData || !currentData.strikes) {
    alert('No data available to export yet!');
    return;
  }

  const btn = document.getElementById('btnPDF');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) setIconText(btn, 'loader', 'Generating PDF...', 'spin');

  const generatePDF = async () => {
    const reportContainer = buildDashboardReport(currentData);
    // Keep it laid out (so it has a real size) but out of sight, via a wrapper instead of positioning the report itself.
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    // 1074px = A4 landscape printable width, so heights measured here match the layout html2pdf will use
    holder.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 1074px; overflow: hidden; pointer-events: none;';
    holder.appendChild(reportContainer);
    document.body.appendChild(holder);
    markAvoidBreaks(reportContainer);

    try {
      const opt = {
        margin: [0.25, 0.25, 0.25, 0.25],
        filename: `ChainDeck_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 1.6, useCORS: true, logging: false, backgroundColor: '#ffffff' },
        // Landscape: the dashboard is laid out for a wide screen, so this keeps panels side by side as they appear on screen.
        jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape', compress: true },
        // Keep cards, panels and table rows whole instead of slicing through them ('avoid-all' would leave huge gaps).
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.pdf-avoid', 'img', '.keystrip', '.oi-summary', 'tr'] }
      };

      if (window.html2pdf) {
        await window.html2pdf().set(opt).from(reportContainer).save();
      } else {
        throw new Error('PDF library failed to load');
      }
    } finally {
      holder.remove();
    }
  };

  try {
    if (typeof window.html2pdf === 'undefined') await loadScript('/vendor/html2pdf.bundle.min.js');
    await generatePDF();
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('Failed to export PDF.');
  } finally {
    if (btn) btn.innerHTML = originalHtml;
  }
}

/**
 * Builds the PDF from the live dashboard (every panel, chart and table as shown on screen), so the PDF carries the same
 * information as the Snapshot and new panels are included automatically. Each section is cloned into a print-friendly
 * light-theme container. Things a clone cannot carry over are handled explicitly:
 *   - <canvas> charts clone as blank, so they become <img> snapshots of the original canvas;
 *   - dropdowns become plain text, and buttons / help popovers / the greeks toggle are dropped;
 *   - collapsed "Advanced analytics" is opened; fixed overlays, drawers and the toolbar are skipped.
 * The container is normal-flow and width:100%: html2pdf lays the clone out inside a container as wide as the page,
 * and an absolutely positioned or fixed-width element there gets clipped or collapses to 0px (blank PDF).
 */
const PDF_PAGE_PX = 746; // printable page height in CSS px at the report width (A4 landscape, 0.25in margins)

/**
 * html2pdf can keep chosen elements from being sliced by a page break, but only via selectors. The dashboard's cards
 * are a mix of classes and inline-styled boxes, so tag them by how they look instead: any rounded box that is bordered
 * or filled and no more than 60% of a page tall (larger containers may break between their inner cards). Must run while the report is attached and laid out at the page width.
 */
function markAvoidBreaks(root) {
  root.querySelectorAll('div, details, table').forEach(el => {
    const h = el.getBoundingClientRect().height;
    if (h < 24) return;
    const cs = getComputedStyle(el);
    // A grid's items cannot be held back one at a time (the page-break spacer becomes a grid cell and shifts the layout
    // instead of moving the card), so keep a whole grid together whenever it fits on one page.
    if (cs.display === 'grid' && h <= PDF_PAGE_PX * 0.95) { el.classList.add('pdf-avoid'); return; }
    if (h > PDF_PAGE_PX * 0.6) return; // bigger containers may split between their inner cards
    const rounded = parseFloat(cs.borderTopLeftRadius) > 0;
    const bordered = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    const filled = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    if (rounded && (bordered || filled)) el.classList.add('pdf-avoid');
  });
}

function buildDashboardReport(d) {
  const root = document.createElement('div');
  root.className = 'pdf-export-report';
  root.setAttribute('data-theme', 'light'); // scopes the light palette to the report, whatever theme the page is in

  const dateStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const head = document.createElement('div');
  head.className = 'pdf-report-head';
  head.innerHTML = `
    <div>
      <h1>Chain<span>Deck</span> Analytics Report</h1>
      <div class="pdf-report-sub">Generated: <strong>${escapeHtml(dateStr)} IST</strong> | Expiry: <strong>${escapeHtml(d.expiry || 'n/a')}</strong> | Data sourced from NSE India. For analytical purposes only.</div>
    </div>
    <div class="pdf-report-spot">
      <div>Spot: ${escapeHtml(fmt(d.spot))}</div>
      <div class="pdf-report-sub">ATM Strike: ${escapeHtml(fmt(d.atm))}</div>
    </div>`;
  root.appendChild(head);

  let previous = null;
  [...document.body.children].forEach(node => {
    if (node.tagName === 'SCRIPT' || node.classList.contains('topbar')) return;
    if (getComputedStyle(node).position === 'fixed') return; // overlay, drawers, toasts, footer, popovers
    const clone = node.cloneNode(true);
    // the option chain (heading + table) reads best starting on a fresh page, and keeps its heading with the table
    if (node.classList.contains('table-wrap') && previous) {
      previous.style.pageBreakBefore = 'always';
      previous.style.breakBefore = 'page';
    }

    // charts: a cloned <canvas> is blank, so swap in an image of the real one
    const sources = node.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((cv, i) => {
      const src = sources[i];
      if (!src || !src.width || !src.height || src.closest('#priceChart')) { cv.remove(); return; } // the price chart is handled below
      const img = document.createElement('img');
      img.src = src.toDataURL('image/png');
      img.alt = '';
      img.style.cssText = `display: block; width: 100%; height: ${src.clientHeight || src.height}px;`;
      cv.replaceWith(img);
    });

    // the price chart is several stacked canvases (and a logo link), so it is captured with the library's own screenshot
    const chartHost = clone.querySelector('#priceChart');
    if (chartHost) {
      const shot = chartScreenshot();
      if (shot) {
        const img = document.createElement('img');
        img.src = shot.src;
        img.alt = '';
        img.style.cssText = `display: block; width: 100%; aspect-ratio: ${shot.width} / ${shot.height};`;
        chartHost.replaceWith(img);
      } else {
        chartHost.remove();
      }
    }

    // dropdowns keep their current value as text; controls are not useful on paper
    clone.querySelectorAll('select').forEach(sel => {
      const span = document.createElement('span');
      span.className = 'pdf-select-value';
      span.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
      sel.replaceWith(span);
    });
    clone.querySelectorAll('input').forEach(inp => (inp.closest('label') || inp).remove());
    clone.querySelectorAll('button, textarea').forEach(el => el.remove());
    clone.querySelectorAll('details').forEach(el => { el.open = true; });
    if (clone.tagName === 'DETAILS') clone.open = true;
    root.appendChild(clone);
    previous = clone;
  });

  return root;
}

// Dropdown Menu Handlers
/**
 * The menu is right-aligned under its button, but on narrow screens the toolbar wraps and the button can sit at the
 * left edge, which pushed the menu partly off-screen (its icons and the start of every label were clipped).
 * Measure it once open and slide it back inside the viewport.
 */
function placeExportMenu() {
  const dd = document.getElementById('exportDropdown');
  const menu = document.getElementById('exportMenu');
  if (!dd || !menu || !dd.classList.contains('active')) return;
  menu.style.left = '';
  menu.style.right = ''; // back to the default right-aligned position before measuring
  const margin = 8;
  const m = menu.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - margin - m.width);
  const wanted = Math.min(Math.max(m.left, margin), maxLeft);
  if (Math.abs(wanted - m.left) > 0.5) {
    menu.style.right = 'auto';
    menu.style.left = `${wanted - dd.getBoundingClientRect().left}px`;
  }
}

export function toggleExportMenu(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('exportDropdown');
  if (!dd) return;
  dd.classList.toggle('active');
  placeExportMenu();
}

// A resize (rotation, window drag) can change where the button sits: re-clamp instead of leaving it misplaced.
window.addEventListener('resize', placeExportMenu);

export function closeExportMenu() {
  const dd = document.getElementById('exportDropdown');
  if (dd) dd.classList.remove('active');
}

document.addEventListener('click', (e) => {
  const dd = document.getElementById('exportDropdown');
  if (dd && !dd.contains(e.target)) {
    dd.classList.remove('active');
  }
});

export function renderTradeSetup(d) {
  if (!d) return;

  const todayBiasEl = document.getElementById('setupTodayBias');
  const keyTargetEl = document.getElementById('setupKeyTarget');
  const invalidationEl = document.getElementById('setupInvalidation');
  const optimalStrategyEl = document.getElementById('setupOptimalStrategy');
  const biasBadgeEl = document.getElementById('setupBiasBadge');

  if (!todayBiasEl || !keyTargetEl || !invalidationEl || !optimalStrategyEl) return;

  const spot = d.spot || 0;
  const pivot = d.cpr ? d.cpr.pivot : d.atm;
  const tc = d.cpr ? d.cpr.tc : pivot + 10;
  const bc = d.cpr ? d.cpr.bc : pivot - 10;
  const r1 = d.cpr ? d.cpr.r1 : pivot + 50;
  const s1 = d.cpr ? d.cpr.s1 : pivot - 50;
  const zeroGamma = d.gex ? d.gex.zeroGammaLevel : (bc || pivot - 30);
  const maxCall = d.maxCallOIStrike || (d.atm + 100);
  const maxPut = d.maxPutOIStrike || (d.atm - 100);
  const pcr = d.pcr || 1.0;
  const isPosGamma = d.gex ? (d.gex.totalGexCr >= 0) : true;
  const sd = d.straddleDetails || {};

  // Directional bias = agreement of three independent reads (each -1/0/+1):
  // price vs CPR, PCR, and the composite regime. Needs 2+ net votes, so Neutral is reachable.
  const cprPos = spot > tc ? 1 : spot < bc ? -1 : 0;
  const pcrPos = pcr > 1.2 ? 1 : pcr < 0.8 ? -1 : 0;
  const tb = d.compositeRegime ? d.compositeRegime.tacticalBias : '';
  const regimePos = tb.includes('BULL') ? 1 : tb.includes('BEAR') ? -1 : 0;
  const biasScore = cprPos + pcrPos + regimePos;
  const isBullish = biasScore >= 2;
  const isBearish = biasScore <= -2;

  let biasText = '';
  let biasBadgeText = '';
  let biasIcon = 'scale';
  let biasColor = 'var(--warn)';
  let biasBg = 'rgba(245,158,11,0.15)';

  if (isBullish) {
    biasText = `Bullish while above ${fmt(Math.round(tc))} (CPR top) · ${biasScore}/3 signals`;
    biasBadgeText = 'Bias: Bullish';
    biasIcon = 'trending-up';
    biasColor = 'var(--bull)';
    biasBg = 'rgba(16,185,129,0.15)';
  } else if (isBearish) {
    biasText = `Bearish while below ${fmt(Math.round(bc))} (CPR bottom) · ${Math.abs(biasScore)}/3 signals`;
    biasBadgeText = 'Bias: Bearish';
    biasIcon = 'trending-down';
    biasColor = 'var(--bear)';
    biasBg = 'rgba(239,68,68,0.15)';
  } else {
    biasText = `Neutral / Rangebound around ${fmt(Math.round(pivot))} (mixed signals, ${biasScore >= 0 ? '+' : ''}${biasScore}/3)`;
    biasBadgeText = 'Bias: Neutral';
    biasColor = 'var(--warn)';
    biasBg = 'rgba(245,158,11,0.15)';
  }

  // Key Target
  let targetText = '';
  if (isBullish) {
    targetText = `${fmt(maxCall)} (Max Call Wall / Resistance)`;
  } else if (isBearish) {
    targetText = `${fmt(maxPut)} (Max Put Wall / Support)`;
  } else {
    targetText = `${fmt(maxCall)} Res / ${fmt(maxPut)} Sup`;
  }

  // Invalidation Level
  let invalidationText = '';
  if (zeroGamma && Math.abs(spot - zeroGamma) > 5) {
    invalidationText = `${fmt(zeroGamma)} (Zero-Gamma Flip Level)`;
  } else {
    invalidationText = isBullish
      ? `${fmt(Math.round(s1))} (S1 Support Level)`
      : `${fmt(Math.round(r1))} (R1 Resistance Level)`;
  }

  // Optimal Strategy
  let strategyText = '';
  if (isBullish) {
    if (isPosGamma) {
      strategyText = `Bull Put Spread / Buying dips near S1 Pivot (${fmt(Math.round(s1))})`;
    } else {
      strategyText = `Long Call / Bull Call Spread above ${fmt(Math.round(pivot))}`;
    }
  } else if (isBearish) {
    if (isPosGamma) {
      strategyText = `Bear Call Spread / Shorting rallies near R1 (${fmt(Math.round(r1))})`;
    } else {
      strategyText = `Long Put / Bear Put Spread below ${fmt(Math.round(pivot))}`;
    }
  } else {
    if (sd.lowerRange && sd.upperRange) {
      strategyText = `Iron Condor / Selling ATM Straddle (Range: ${fmt(Math.round(sd.lowerRange))} - ${fmt(Math.round(sd.upperRange))})`;
    } else {
      strategyText = `Iron Condor / Range Trade between ${fmt(maxPut)} & ${fmt(maxCall)}`;
    }
  }

  // Update DOM
  todayBiasEl.textContent = biasText;
  keyTargetEl.textContent = targetText;
  invalidationEl.textContent = invalidationText;
  optimalStrategyEl.textContent = strategyText;

  if (biasBadgeEl) {
    setIconText(biasBadgeEl, biasIcon, biasBadgeText);
    biasBadgeEl.style.background = biasBg;
    biasBadgeEl.style.color = biasColor;
  }
}

function openStrike(strike) {
  const d = currentData;
  if (!d || !strike) return;
  openStrikePanel({ expiry: d.expiry, strike, live: d.strikes.find(s => s.strike === strike), spot: d.spot });
}

// Page actions wired through data-click / data-change attributes (no inline handlers, so the CSP can
// forbid inline script). A value is a space-separated list of actions; "name:arg" passes an argument.
const ACTIONS = {
  fetchNow: () => fetchNow(),
  toggleAlertsDrawer: () => toggleAlertsDrawer(),
  toggleExportMenu,
  closeExportMenu,
  exportCSV,
  exportPDF,
  takeSnapshot,
  sortTable,
  onThemeSelectChange,
  onExpiryChange,
  onIntervalChange,
  onOiChartModeChange,
  onTimelineMetricChange,
  toggleGreeksView,
  onParticipantModeChange,
  setChartTimeframe,
  toggleChartLayer
};

function runActions(spec, event) {
  spec.split(/\s+/).filter(Boolean).forEach(item => {
    const [name, arg] = item.split(':');
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
    if (fn) fn(arg !== undefined ? arg : event);
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

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  hydrateIcons();
  initTheme();
  initAlerts();
  initStrikePanel();
  initExplain();
  initPriceChart({ getExpiry: () => (currentData && currentData.expiry) || selectedExpiry || null });
  window.addEventListener('strike-click', e => openStrike(e.detail));
  document.getElementById('chainBody')?.addEventListener('click', e => {
    const cell = e.target.closest('.strike-cell');
    const row = cell && cell.closest('tr');
    if (row) openStrike(Number(row.dataset.strike));
  });
  document.body.classList.add('is-loading');
  const tb = document.querySelector('.topbar');
  const syncTopbar = () => tb && document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
  syncTopbar();
  window.addEventListener('resize', syncTopbar);
  const adv = document.getElementById('advancedAnalytics');
  if (adv) {
    try { adv.open = localStorage.getItem('advOpen') === '1'; } catch (e) { /* storage unavailable */ }
    adv.addEventListener('toggle', () => {
      try { localStorage.setItem('advOpen', adv.open ? '1' : '0'); } catch (e) { /* ignore */ }
    });
  }
  fetchNow();
  startAutoRefresh();
});
