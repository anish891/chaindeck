// Candlestick chart with support / resistance zones, ETF volume, VWAP, a volume profile and pattern markers,
// plus the level ladder, signals and buying / selling zone panels that sit beside it.
//
// Data comes from /api/chart-analysis. Lightweight Charts (vendored, public/vendor) draws the chart. Zone bands and the
// volume profile are series primitives so they stay locked to the price scale when the user pans or zooms.
import { fetchChartAnalysis } from './api-client.js';
import { escapeHtml } from './ui-utils.js';

const REFRESH_MS = 15000;
const IST_OFFSET_S = 19800;
const LAYER_DEFAULTS = { zones: true, volume: true, vwap: true, profile: true, patterns: true };
const TIMEFRAMES = ['5m', '15m', '1d'];

let tf = '5m';
let layers = { ...LAYER_DEFAULTS };
let data = null;
let fetchedAt = 0;
let fetchedKey = '';
let inflight = false;
let getExpiry = () => null;

let chart = null;
let candleSeries = null;
let volumeSeries = null;
let vwapSeries = null;
let markersApi = null;
let zoneBands = null;
let profileBars = null;
let planLines = [];
let needsFit = true;

try {
  const saved = localStorage.getItem('chartTf');
  if (TIMEFRAMES.includes(saved)) tf = saved;
  const l = JSON.parse(localStorage.getItem('chartLayers') || 'null');
  if (l && typeof l === 'object') Object.keys(LAYER_DEFAULTS).forEach(k => { if (typeof l[k] === 'boolean') layers[k] = l[k]; });
} catch (e) { /* storage unavailable */ }

// ── colours (read from CSS variables so light, dark and system themes all work) ──
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(color);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return color;
}
function palette() {
  const bull = cssVar('--bull', '#10b981');
  const bear = cssVar('--bear', '#ef4444');
  const accent = cssVar('--accent', '#3b82f6');
  const warn = cssVar('--warn', '#f59e0b');
  const text = cssVar('--text', '#e8eaf0');
  const muted = cssVar('--muted', '#6b7280');
  const surface = cssVar('--surface', '#141720');
  return { bull, bear, accent, warn, text, muted, surface, grid: withAlpha(muted, 0.14) };
}

// ── time helpers: Lightweight Charts times are UTC, so shift into IST for display ──
const istDate = ms => new Date(ms + IST_OFFSET_S * 1000).toISOString().slice(0, 10);
const toTime = ms => (tf === '1d' ? istDate(ms) : Math.floor(ms / 1000) + IST_OFFSET_S);
const fmtPrice = n => (Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : 'n/a');
const fmtVol = n => (n >= 1e7 ? (n / 1e7).toFixed(2) + ' Cr' : n >= 1e5 ? (n / 1e5).toFixed(1) + ' L' : Math.round(n).toLocaleString('en-IN'));

// ── primitives ───────────────────────────────────────────────────────────

class ZoneBands {
  constructor() {
    this.zones = [];
    this.colors = null;
    this.series = null;
    this.requestUpdate = null;
    const self = this;
    this.view = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw: target => target.useBitmapCoordinateSpace(scope => self.draw(scope))
      })
    };
  }
  attached({ series, requestUpdate }) { this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.series = null; this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this.view]; }
  setData(zones, colors) {
    this.zones = zones;
    this.colors = colors;
    if (this.requestUpdate) this.requestUpdate();
  }
  draw({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) {
    if (!this.series || !this.colors) return;
    const c = this.colors;
    ctx.save();
    ctx.font = `${Math.round(10 * vr)}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const z of this.zones) {
      const yHigh = this.series.priceToCoordinate(z.high);
      const yLow = this.series.priceToCoordinate(z.low);
      if (yHigh === null || yLow === null) continue;
      const top = Math.min(yHigh, yLow) * vr;
      const h = Math.max(Math.abs(yLow - yHigh) * vr, 3 * vr);
      const colour = z.kind === 'support' ? c.bull : z.kind === 'resistance' ? c.bear : c.warn;
      const alpha = 0.07 + (z.strength / 100) * 0.2;
      ctx.fillStyle = withAlpha(colour, alpha);
      ctx.fillRect(0, top, bitmapSize.width, h);
      ctx.strokeStyle = withAlpha(colour, 0.35 + (z.strength / 100) * 0.4);
      ctx.lineWidth = Math.max(1, hr);
      ctx.setLineDash(z.status === 'broken' ? [4 * hr, 4 * hr] : []);
      ctx.beginPath();
      ctx.moveTo(0, top + h / 2);
      ctx.lineTo(bitmapSize.width, top + h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = withAlpha(colour, 0.95);
      ctx.fillText(`${z.kind === 'support' ? 'S' : z.kind === 'resistance' ? 'R' : 'Zone'} ${z.strength}`, 6 * hr, top + h / 2 - 8 * vr);
    }
    ctx.restore();
  }
}

class ProfileBars {
  constructor() {
    this.profile = null;
    this.colors = null;
    this.series = null;
    this.requestUpdate = null;
    const self = this;
    this.view = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw: target => target.useBitmapCoordinateSpace(scope => self.draw(scope))
      })
    };
  }
  attached({ series, requestUpdate }) { this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.series = null; this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this.view]; }
  setData(profile, colors) {
    this.profile = profile;
    this.colors = colors;
    if (this.requestUpdate) this.requestUpdate();
  }
  draw({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) {
    const p = this.profile;
    if (!p || !this.series || !this.colors) return;
    const maxVol = Math.max(...p.bins.map(b => b.volume));
    if (!maxVol) return;
    const maxW = bitmapSize.width * 0.2;
    ctx.save();
    for (const b of p.bins) {
      const y1 = this.series.priceToCoordinate(b.price + p.binSize / 2);
      const y2 = this.series.priceToCoordinate(b.price - p.binSize / 2);
      if (y1 === null || y2 === null) continue;
      const w = (b.volume / maxVol) * maxW;
      const isPoc = Math.abs(b.price - p.poc) < p.binSize / 2 + 0.001;
      const inValue = b.price <= p.vah && b.price >= p.val;
      ctx.fillStyle = withAlpha(this.colors.accent, isPoc ? 0.55 : inValue ? 0.26 : 0.14);
      ctx.fillRect(bitmapSize.width - w, Math.min(y1, y2) * vr, w, Math.max(1, Math.abs(y2 - y1) * vr - 1));
    }
    ctx.restore();
  }
}

// ── chart lifecycle ──────────────────────────────────────────────────────

function chartOptions(p) {
  return {
    autoSize: true,
    layout: { background: { type: 'solid', color: p.surface }, textColor: p.muted, attributionLogo: true, fontFamily: cssVar('--font', 'system-ui, sans-serif') },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    rightPriceScale: { borderColor: p.grid, scaleMargins: { top: 0.06, bottom: 0.22 } },
    timeScale: { borderColor: p.grid, timeVisible: tf !== '1d', secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: 0 },
    localization: { priceFormatter: n => n.toLocaleString('en-IN', { maximumFractionDigits: 1 }) }
  };
}

function ensureChart() {
  const el = document.getElementById('priceChart');
  const LW = window.LightweightCharts;
  if (!el || !LW) return false;
  if (chart) return true;
  const p = palette();
  chart = LW.createChart(el, chartOptions(p));
  candleSeries = chart.addSeries(LW.CandlestickSeries, {
    upColor: p.bull, downColor: p.bear, wickUpColor: p.bull, wickDownColor: p.bear, borderVisible: false, priceLineVisible: true
  });
  volumeSeries = chart.addSeries(LW.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vwapSeries = chart.addSeries(LW.LineSeries, { color: p.warn, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  markersApi = LW.createSeriesMarkers(candleSeries, []);
  zoneBands = new ZoneBands();
  profileBars = new ProfileBars();
  candleSeries.attachPrimitive(zoneBands);
  candleSeries.attachPrimitive(profileBars);
  chart.subscribeCrosshairMove(onCrosshair);
  return true;
}

function applyTheme() {
  if (!chart) return;
  const p = palette();
  chart.applyOptions(chartOptions(p));
  candleSeries.applyOptions({ upColor: p.bull, downColor: p.bear, wickUpColor: p.bull, wickDownColor: p.bear });
  vwapSeries.applyOptions({ color: p.warn });
  draw();
}

function onCrosshair(param) {
  const legend = document.getElementById('chartLegend');
  if (!legend || !data) return;
  const bar = param && param.seriesData ? param.seriesData.get(candleSeries) : null;
  if (!bar) { legend.textContent = legendDefault(); return; }
  const up = bar.close >= bar.open;
  const vol = param.seriesData.get(volumeSeries);
  const parts = [`O ${fmtPrice(bar.open)}`, `H ${fmtPrice(bar.high)}`, `L ${fmtPrice(bar.low)}`, `C ${fmtPrice(bar.close)}`, `${up ? '+' : ''}${fmtPrice(bar.close - bar.open)}`];
  if (vol && vol.value) parts.push(`ETF vol ${fmtVol(vol.value)}`);
  legend.textContent = parts.join('   ');
}

function legendDefault() {
  if (!data || !data.candles.length) return '';
  const c = data.candles[data.candles.length - 1];
  return `O ${fmtPrice(c.o)}   H ${fmtPrice(c.h)}   L ${fmtPrice(c.l)}   C ${fmtPrice(c.c)}`;
}

const chartNarrow = () => (document.getElementById('priceChart') || {}).clientWidth < 600;

function markersFor(p) {
  if (!data || !layers.patterns) return [];
  const byTime = new Map();
  data.patterns.forEach(pt => {
    if (pt.quality < 0.5) return;
    const cur = byTime.get(pt.t);
    if (!cur || pt.quality > cur.quality) byTime.set(pt.t, pt);
  });
  const list = [...byTime.values()].sort((a, b) => a.t - b.t);
  const labelled = new Set(list.filter(x => x.quality >= 0.6).slice(chartNarrow() ? -3 : -5).map(x => x.t)); // names only on a few, or they pile up
  return list.map(pt => ({
    time: toTime(pt.t),
    position: pt.dir === 'bull' ? 'belowBar' : 'aboveBar',
    color: pt.dir === 'bull' ? p.bull : p.bear,
    shape: pt.dir === 'bull' ? 'arrowUp' : 'arrowDown',
    text: labelled.has(pt.t) ? pt.label : ''
  }));
}

function draw() {
  if (!chart || !data) return;
  const p = palette();
  const rows = data.candles;
  candleSeries.setData(rows.map(c => ({ time: toTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
  volumeSeries.setData(layers.volume ? rows.filter(c => c.v).map(c => ({ time: toTime(c.t), value: c.v, color: withAlpha(c.c >= c.o ? p.bull : p.bear, 0.45) })) : []);
  vwapSeries.setData(layers.vwap ? data.vwap.map(v => ({ time: toTime(v.t), value: v.value })) : []);
  zoneBands.setData(layers.zones ? data.zones : [], p);
  profileBars.setData(layers.profile ? data.profile : null, p);
  markersApi.setMarkers(markersFor(p));
  drawPlan(p);
  if (needsFit && rows.length) {
    const n = rows.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (tf === '1d' ? 90 : 110)), to: n + 6 });
    needsFit = false;
  }
  const legend = document.getElementById('chartLegend');
  if (legend) legend.textContent = legendDefault();
}

/** Trigger, invalidation and target of the best live signal, drawn as labelled lines. */
function drawPlan(p) {
  planLines.forEach(l => candleSeries.removePriceLine(l));
  planLines = [];
  const sig = data.signals.find(s => s.confirmed && s.state !== 'invalidated');
  if (!sig || !layers.patterns) return;
  const add = (price, title, color) => {
    if (!Number.isFinite(price)) return;
    planLines.push(candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
  };
  add(sig.trigger, 'Trigger', p.accent);
  add(sig.invalidation, 'Invalid', p.bear);
  add(sig.target, 'Target', p.bull);
}

// ── panels ───────────────────────────────────────────────────────────────

const VERDICT_TEXT = {
  edge: 'edge on this instrument',
  none: 'no clear edge',
  negative: 'worse than chance',
  insufficient: 'too few samples'
};

function renderStatus() {
  const el = document.getElementById('chartNote');
  if (!el) return;
  if (!data) { el.textContent = 'Loading chart data...'; return; }
  const bits = [];
  if (data.source === 'yahoo') bits.push('Candles: Yahoo Finance (delayed, unofficial)');
  else if (data.source === 'stored') bits.push('Candles built from this app\'s saved spot values (Yahoo unavailable); highs and lows are approximate');
  else bits.push('No candle data available right now');
  bits.push(data.volumeSource === 'etf' ? 'Volume: NIFTYBEES ETF as a proxy (the index has no volume)' : 'No volume data');
  el.textContent = bits.join('. ') + '.';
}

function renderLadder() {
  const el = document.getElementById('levelLadder');
  if (!el) return;
  if (!data || !data.zones.length) {
    el.innerHTML = '<div class="timeline-empty">Levels appear once option chain and price data have loaded.</div>';
    return;
  }
  const rows = [];
  let spotPlaced = false;
  const spotRow = `<div class="ladder-spot"><span>Spot ${escapeHtml(fmtPrice(data.spot))}</span><span>ATR ${escapeHtml(fmtPrice(data.atr))}</span></div>`;
  data.zones.forEach(z => {
    if (!spotPlaced && z.mid < data.spot) { rows.push(spotRow); spotPlaced = true; }
    const kind = z.kind === 'support' ? 'support' : z.kind === 'resistance' ? 'resistance' : 'inside';
    const kindLabel = kind === 'support' ? 'Support' : kind === 'resistance' ? 'Resistance' : 'At price';
    const status = z.status === 'broken' ? 'Broken'
      : z.status === 'held' ? (z.held > 0 ? `Held ${z.held}/${z.touches}` : `Tested ${z.touches}x, not held`)
      : 'Untested';
    const range = z.high - z.low >= 1 ? `${Math.round(z.low)} to ${Math.round(z.high)}` : `${Math.round(z.mid)}`;
    const why = z.sources.slice(0, 4).map(s => escapeHtml(s.label)).join(', ');
    rows.push(`<div class="ladder-row ${kind}">
      <div class="ladder-main"><span class="ladder-kind">${kindLabel}</span><strong>${escapeHtml(range)}</strong><span class="ladder-dist">${z.distancePct > 0 ? '+' : ''}${escapeHtml(String(z.distancePct))}%</span></div>
      <div class="ladder-bar"><span style="width:${Math.max(4, Math.min(100, z.strength))}%"></span></div>
      <div class="ladder-meta"><span>Strength ${z.strength}</span><span class="ladder-status ${escapeHtml(z.status)}">${escapeHtml(status)}</span></div>
      <div class="ladder-why">${why}</div>
    </div>`);
  });
  if (!spotPlaced) rows.push(spotRow);
  el.innerHTML = rows.join('');
}

/** Plain text: the caller escapes it once when building the card. */
function historyLine(h) {
  if (!h) return 'No backtest available for this pattern yet.';
  const pc = x => Math.round(x * 100);
  return `Past sessions: ${pc(h.hitRate)}% moved the expected way over ${h.horizon} candles vs ${pc(h.baseline)}% for any candle (n=${h.n}, range ${pc(h.ci.low)}-${pc(h.ci.high)}%): ${VERDICT_TEXT[h.verdict] || h.verdict}.`;
}

function renderSignals() {
  const el = document.getElementById('signalsList');
  if (!el) return;
  if (!data) { el.innerHTML = '<div class="timeline-empty">Waiting for chart data.</div>'; return; }
  if (!data.signals.length) {
    el.innerHTML = '<div class="timeline-empty">No reversal pattern on the latest candles. Signals appear only when a pattern forms; most of the time there is none.</div>';
    return;
  }
  el.innerHTML = data.signals.slice(0, 4).map(s => {
    const dir = s.dir === 'bull' ? 'bull' : 'bear';
    const state = s.state === 'triggered' ? 'Trigger hit' : 'Waiting for trigger';
    const grade = s.confirmed ? s.grade : 'unconfirmed';
    const evidence = s.evidence.map(e => `<li class="${e.against ? 'against' : e.neutral ? 'neutral' : ''}"><em>${escapeHtml(e.family)}</em> ${escapeHtml(e.text)}</li>`).join('');
    const tgt = s.target ? `${escapeHtml(fmtPrice(s.target))}${s.rr ? ` (about ${escapeHtml(String(s.rr))}R)` : ''}` : 'no zone ahead';
    return `<div class="signal-card ${dir}">
      <div class="signal-head"><strong>${escapeHtml(s.label)}</strong><span class="signal-grade ${escapeHtml(grade)}">${escapeHtml(grade)} ${s.score}</span></div>
      <div class="signal-sub">${s.dir === 'bull' ? 'Bullish reversal' : 'Bearish reversal'} · ${escapeHtml(state)} · ${s.age === 0 ? 'latest candle' : s.age + ' candle' + (s.age > 1 ? 's' : '') + ' ago'}</div>
      <div class="signal-plan">
        <span>Trigger <b>${escapeHtml(fmtPrice(s.trigger))}</b></span>
        <span>Invalid <b>${escapeHtml(fmtPrice(s.invalidation))}</b></span>
        <span>Target <b>${tgt}</b></span>
      </div>
      <ul class="signal-evidence">${evidence}</ul>
      <div class="signal-history">${escapeHtml(historyLine(s.history))}</div>
    </div>`;
  }).join('');
}

function renderActionZones() {
  const el = document.getElementById('actionZones');
  if (!el) return;
  if (!data || !data.actionZones.length) {
    el.innerHTML = '<div class="timeline-empty">No zone has two kinds of evidence agreeing right now.</div>';
    return;
  }
  el.innerHTML = data.actionZones.map(z => {
    const side = z.side === 'buy' ? 'bull' : 'bear';
    const range = z.high - z.low >= 1 ? `${Math.round(z.low)} to ${Math.round(z.high)}` : `${Math.round(z.mid)}`;
    return `<div class="action-zone ${side}">
      <div class="signal-head"><strong>${z.side === 'buy' ? 'Buying interest' : 'Selling interest'} zone ${escapeHtml(range)}</strong><span class="signal-grade ${z.families.length >= 3 ? 'strong' : 'moderate'}">${z.families.length} of 4 agree</span></div>
      <ul class="signal-evidence">${z.evidence.map(e => `<li><em>${escapeHtml(e.family)}</em> ${escapeHtml(e.text)}</li>`).join('')}</ul>
    </div>`;
  }).join('');
}

function renderPatternStats() {
  const el = document.getElementById('patternStats');
  if (!el) return;
  const bt = data && data.backtest;
  if (!bt) { el.innerHTML = '<div class="timeline-empty">Backtest not available yet.</div>'; return; }
  const pc = x => Math.round(x * 100) + '%';
  const labels = {};
  data.patterns.forEach(p => { labels[p.name] = p.label; });
  const rows = Object.values(bt.patterns).sort((a, b) => b.n - a.n).map(p => `<tr>
    <td>${escapeHtml(labels[p.name] || p.name)}</td>
    <td class="${p.dir === 'bull' ? 'bull' : 'bear'}">${p.dir === 'bull' ? 'Bullish' : 'Bearish'}</td>
    <td>${p.n}</td><td>${pc(p.hitRate)}</td><td>${pc(p.baseline)}</td>
    <td class="verdict-${escapeHtml(p.verdict)}">${escapeHtml(VERDICT_TEXT[p.verdict] || p.verdict)}</td></tr>`).join('');
  el.innerHTML = `<div class="panel-note">${bt.sessions} sessions, ${bt.candles.toLocaleString('en-IN')} candles. Hit means the market closed beyond the next candle's open in the pattern's direction ${bt.horizon} candles later. Baseline is how often any candle did the same.</div>
    <div class="table-scroll"><table class="pattern-table"><thead><tr><th>Pattern</th><th>Direction</th><th>Count</th><th>Hit rate</th><th>Baseline</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderTfButtons() {
  document.querySelectorAll('[data-tf]').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
  document.querySelectorAll('[data-layer]').forEach(inp => { inp.checked = !!layers[inp.dataset.layer]; });
}

function renderAll() {
  renderStatus();
  renderLadder();
  renderSignals();
  renderActionZones();
  renderPatternStats();
  renderTfButtons();
}

// ── public API ───────────────────────────────────────────────────────────

export async function refreshPriceChart(force = false) {
  if (inflight || document.hidden) return;
  const expiry = getExpiry();
  const key = `${tf}|${expiry || ''}`;
  if (!force && key === fetchedKey && Date.now() - fetchedAt < REFRESH_MS) return;
  inflight = true;
  const requested = tf;
  try {
    const result = await fetchChartAnalysis(tf, expiry);
    if (requested !== tf) return; // user switched timeframe while loading
    data = result;
    fetchedAt = Date.now();
    fetchedKey = key;
    if (ensureChart()) draw();
    renderAll();
  } catch (e) {
    console.error('Chart analysis fetch failed:', e);
    const el = document.getElementById('chartNote');
    if (el && !data) el.textContent = 'Could not load chart data. Retrying.';
  } finally {
    inflight = false;
    // The timeframe changed while this was loading: that request was skipped (one at a time), so make it now.
    if (requested !== tf) refreshPriceChart(true);
  }
}

export function setChartTimeframe(next) {
  if (!TIMEFRAMES.includes(next) || next === tf) return;
  tf = next;
  try { localStorage.setItem('chartTf', tf); } catch (e) { /* storage unavailable */ }
  data = null;
  needsFit = true;
  if (chart) {
    chart.applyOptions({ timeScale: { timeVisible: tf !== '1d' } });
    candleSeries.setData([]); volumeSeries.setData([]); vwapSeries.setData([]);
  }
  renderAll();
  refreshPriceChart(true);
}

export function toggleChartLayer(event) {
  const inp = event && event.target;
  const key = inp && inp.dataset ? inp.dataset.layer : null;
  if (!key || !(key in LAYER_DEFAULTS)) return;
  layers[key] = !!inp.checked;
  try { localStorage.setItem('chartLayers', JSON.stringify(layers)); } catch (e) { /* storage unavailable */ }
  draw();
}

export function restyleChart() {
  applyTheme();
}

/** A picture of the chart for the PDF / snapshot: a cloned DOM chart would be blank (it is several stacked canvases). */
export function chartScreenshot() {
  if (!chart || !data || !data.candles.length) return null;
  try {
    const canvas = chart.takeScreenshot();
    return { src: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  } catch (e) {
    console.error('Chart screenshot failed:', e);
    return null;
  }
}

/** Best live signal, used by the alert rules. */
export function currentChartSignals() {
  return data ? { interval: data.interval, spot: data.spot, signals: data.signals, zones: data.zones, atr: data.atr } : null;
}

export function initPriceChart(opts = {}) {
  if (typeof opts.getExpiry === 'function') getExpiry = opts.getExpiry;
  renderTfButtons();
  renderAll();
}
