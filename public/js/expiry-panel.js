// Renders the Expiry Day panel from computeExpiryDay() (expiry-day.js). DOM built with textContent only: every number
// comes from the network, so nothing here goes through innerHTML. The decay chart itself is drawn by charts.js.

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const num = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : 'n/a');
const signed = n => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString('en-IN')}` : 'n/a');
const prob = p => (p === null || !Number.isFinite(p) ? 'n/a' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);
const cr = n => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)} Cr` : 'n/a');
const lakh = n => (Number.isFinite(n) ? `${(n / 1e5).toFixed(1)}L` : 'n/a');
const hm = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const clock = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function stat(label, value, cls) {
  const s = el('div', 'xd-stat');
  s.append(el('span', 'xd-stat-label', label), el('strong', cls ? `xd-stat-val ${cls}` : 'xd-stat-val', value));
  return s;
}

function stats(items) {
  const g = el('div', 'xd-stats');
  items.forEach(i => g.append(stat(...i)));
  return g;
}

const DECAY_VERDICT = {
  faster: { cls: 'fast', text: 'Faster than time decay', note: 'Premium is falling faster than the clock alone explains: IV is coming off, or price is pinned.' },
  slower: { cls: 'slow', text: 'Slower than time decay', note: 'Premium is holding up against the clock: price is moving, or IV is rising.' },
  inline: { cls: 'even', text: 'In line with time decay', note: 'The straddle is close to where time decay alone would have taken it.' },
  early: { cls: '', text: 'Too early to judge', note: 'Needs about 15 minutes of snapshots after 09:15.' },
  closing: { cls: '', text: 'Session closing', note: 'In the last minutes the straddle is mostly intrinsic value, so the comparison no longer means much.' }
};

/** Header status line: expiry day or how far away it is. */
export function renderExpiryHead(host, x) {
  host.textContent = '';
  if (!x || x.status !== 'ok') { host.append(el('div', 'empty-note', 'Waiting for option chain data.')); return; }
  const bar = el('div', 'xd-head');
  if (x.isExpiryDay) {
    bar.append(el('span', 'xd-badge live', 'Expiry day'));
    bar.append(el('span', 'xd-head-text', x.minsLeft > 0
      ? `${x.expiry} expires at 15:30 today, ${x.minsLeft >= 60 ? `${Math.floor(x.minsLeft / 60)} h ${Math.round(x.minsLeft % 60)} min` : `${Math.round(x.minsLeft)} min`} of trading left.`
      : `${x.expiry} expired at 15:30 today. Figures are from the last snapshot.`));
  } else {
    bar.append(el('span', 'xd-badge', 'Not expiry day'));
    const days = x.tradingDaysLeft;
    bar.append(el('span', 'xd-head-text', `${x.expiry} expires ${DAYS[x.weekday]}${days ? `, ${days} trading day${days === 1 ? '' : 's'} away` : ''}. Straddle decay tracking runs on expiry day; pin and gamma below are for this expiry as it stands now.`));
  }
  host.append(bar);
}

export function renderDecay(host, x) {
  host.textContent = '';
  const dc = x && x.decay;
  if (!dc || dc.status === 'not-expiry') {
    host.append(el('div', 'empty-note', 'Fills on expiry day from 09:15, comparing the ATM straddle with the path time decay alone would take.'));
    return;
  }
  if (dc.status !== 'ok') { host.append(el('div', 'empty-note', 'Waiting for the first snapshot after 09:15.')); return; }
  const v = DECAY_VERDICT[dc.verdict] || DECAY_VERDICT.early;
  const head = el('div', 'xd-verdict');
  head.append(el('span', `xd-pill ${v.cls}`, v.text));
  if (dc.ratio !== null) head.append(el('span', 'xd-verdict-sub', `${(dc.ratio * 100).toFixed(0)}% of the time-only value`));
  host.append(head);
  host.append(el('div', 'xd-note', v.note));
  host.append(stats([
    [`At ${hm(dc.open.t)}`, num(dc.open.straddle)],
    ['Now', num(dc.now.straddle)],
    ['Change since then', `${dc.decayedPct >= 0 ? '-' : '+'}${Math.abs(dc.decayedPct).toFixed(0)}%`],
    ['Time decay alone', num(dc.timeOnlyNow)],
    ['Last 30 min', dc.rate ? `${signed(-dc.rate.actualPerHour)} / h` : 'n/a'],
    ['Time alone, 30 min', dc.rate && dc.rate.timeOnlyPerHour !== null ? `${signed(-dc.rate.timeOnlyPerHour)} / h` : 'n/a']
  ]));
  if (dc.ahead.length && dc.minsLeft > 0) {
    host.append(el('div', 'xd-note', `If IV and spot held still, time decay alone would leave it near ${dc.ahead.map(a => `${num(a.value)} by ${clock(a.mins)}`).join(', ')}.`));
  }
}

export function renderPin(host, x) {
  host.textContent = '';
  const p = x && x.pin;
  if (!p) return;
  const away = p.distance === null ? 'n/a' : p.distance === 0 ? 'at max pain' : `${num(Math.abs(p.distance))} pts ${p.distance > 0 ? 'above' : 'below'}`;
  host.append(stats([
    ['Max pain', num(p.maxPain)],
    ['Spot vs max pain', away],
    ['In 1σ moves', p.distanceSigma === null ? 'n/a' : `${Math.abs(p.distanceSigma).toFixed(2)}σ`],
    [`Close within ±${p.band}`, prob(p.maxPainProb)]
  ]));
  if (x.isExpiryDay) {
    host.append(el('div', 'xd-note', p.shiftCount
      ? `Max pain opened at ${num(p.atOpen)} and has moved ${p.shiftCount} time${p.shiftCount === 1 ? '' : 's'}: ${p.shifts.map(s => `${num(s.from)} to ${num(s.to)} at ${hm(s.t)}`).join('; ')}.`
      : p.atOpen ? `Max pain has stayed at ${num(p.atOpen)} since the open.` : 'Max pain history fills as snapshots are saved.'));
  }
  const list = el('div', 'xd-list');
  list.append(el('div', 'xd-list-title', 'Heaviest open interest near spot'));
  if (!p.heavy.length) list.append(el('div', 'empty-note', 'No open interest within reach of spot.'));
  p.heavy.forEach(h => {
    const row = el('div', 'xd-row');
    const left = el('div', 'xd-row-main');
    left.append(el('strong', '', num(h.strike)), el('span', 'xd-row-sub', `CE ${lakh(h.ceOI)} · PE ${lakh(h.peOI)} · ${h.distance === 0 ? 'at spot' : `${num(Math.abs(h.distance))} ${h.distance > 0 ? 'above' : 'below'}`}`));
    row.append(left, el('span', 'xd-row-val', prob(h.prob)));
    list.append(row);
  });
  host.append(list);
  host.append(el('div', 'xd-fine', `Probability of a close within ±${p.band} points, priced by options (normal move of 1.25x the ATM straddle). It is what the market charges for, not a forecast of pinning.`));
}

export function renderGamma(host, x) {
  host.textContent = '';
  const g = x && x.gamma;
  if (!g) return;
  host.append(stats([
    ['ATM delta per 50 pts', g.deltaPer50 === null ? 'n/a' : g.deltaPer50.toFixed(2)],
    ['ATM gamma vs open', g.gammaVsOpen === null ? 'n/a' : `${g.gammaVsOpen.toFixed(1)}x`],
    ['Near-money share', g.nearSharePct === null ? 'n/a' : `${g.nearSharePct.toFixed(0)}%`],
    ['Net GEX', cr(g.netGexCr)],
    ['Net GEX at open', cr(g.netGexOpenCr)],
    ['Zero gamma', num(g.zeroGamma)]
  ]));
  if (g.peak && g.peak.grossCr > 0) {
    host.append(el('div', 'xd-note', `Gross gamma (calls plus puts) is heaviest at ${num(g.peak.strike)}: option deltas change fastest for moves around that strike, so that is where hedging needs are largest.`));
  }
  const bars = el('div', 'xd-bars');
  const max = g.maxAbsNet || 1;
  g.rows.forEach(r => {
    const row = el('div', r.strike === g.atm ? 'xd-bar-row atm' : 'xd-bar-row');
    row.append(el('span', 'xd-bar-strike', num(r.strike)));
    const track = el('div', 'xd-bar-track');
    track.append(el('span', 'xd-bar-mid'));
    const fill = el('span', `xd-bar-fill ${r.netCr >= 0 ? 'pos' : 'neg'}`);
    const w = Math.min(50, (Math.abs(r.netCr) / max) * 50);
    fill.style.width = `${w}%`;
    fill.style.left = r.netCr >= 0 ? '50%' : `${50 - w}%`;
    track.append(fill);
    row.append(track, el('span', 'xd-bar-val', cr(r.netCr)));
    bars.append(row);
  });
  host.append(bars);
  host.append(el('div', 'xd-fine', 'Net gamma exposure by strike in Cr per 1% move, assuming dealers are long calls and short puts (a convention, not observed positioning).'));
}

export function renderExpiryPanel(hosts, x) {
  renderExpiryHead(hosts.head, x);
  if (!x || x.status !== 'ok') { hosts.decay.textContent = ''; hosts.pin.textContent = ''; hosts.gamma.textContent = ''; return; }
  renderDecay(hosts.decay, x);
  renderPin(hosts.pin, x);
  renderGamma(hosts.gamma, x);
}
