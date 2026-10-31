// Expiry Day panel: the pure readings in public/js/expiry-day.js and a render pass of public/js/expiry-panel.js on a
// minimal fake DOM (every state must render without throwing and without innerHTML).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const load = f => import('data:text/javascript;base64,' + Buffer.from(read(f)).toString('base64'));
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const ist = s => Date.parse(`${s}+05:30`);

// Minimal DOM: enough for createElement / append / textContent / className / style.
function fakeDocument() {
  const make = tag => {
    const node = {
      tag, className: '', style: {}, hidden: false, children: [], _text: '',
      append(...kids) { kids.forEach(k => node.children.push(typeof k === 'string' ? { tag: '#text', _text: k, children: [] } : k)); },
      get textContent() { return node._text + node.children.map(c => c.textContent ?? c._text).join(''); },
      set textContent(v) { node.children = []; node._text = String(v); }
    };
    return node;
  };
  return { createElement: make, make };
}

(async () => {
  const X = await load('public/js/expiry-day.js');

  // ── dates and session time ──
  assert.strictEqual(X.expiryYmd('03-Nov-2026'), '2026-11-03');
  assert.strictEqual(X.expiryYmd('3-Nov-2026'), null);
  assert.strictEqual(X.expiryYmd('03-Foo-2026'), null);
  assert.strictEqual(X.expiryYmd(undefined), null);
  assert.strictEqual(X.sessionMinutesLeft(ist('2026-11-03T08:00:00')), 375, 'before the open the whole session is left');
  assert.strictEqual(X.sessionMinutesLeft(ist('2026-11-03T09:15:00')), 375);
  assert.strictEqual(X.sessionMinutesLeft(ist('2026-11-03T12:00:00')), 210);
  assert.strictEqual(X.sessionMinutesLeft(ist('2026-11-03T15:30:00')), 0);
  assert.strictEqual(X.sessionMinutesLeft(ist('2026-11-03T16:10:00')), 0);

  // ── close-near probability ──
  near(X.closeNearProb(24000, 24000, 50, 25), 0.3829, 0.001, 'within half a sigma either side');
  near(X.closeNearProb(24000, 24100, 50), X.closeNearProb(24000, 23900, 50), 1e-9, 'symmetric');
  assert(X.closeNearProb(24000, 24200, 50) < 0.01, 'four sigma away is unlikely');
  near(X.closeNearProb(24000, 24000, 50, 10000), 1, 1e-6, 'a huge band is certain');
  assert.strictEqual(X.closeNearProb(24000, 24000, 0), null, 'no sigma, no probability');
  assert.strictEqual(X.closeNearProb(24000, 24000, null), null);

  // ── gamma ──
  const gEarly = X.bsGamma(24000, 24000, 6 / 24 / 365, 12);
  const gLate = X.bsGamma(24000, 24000, 1 / 24 / 365, 12);
  assert(gEarly > 0 && gLate > gEarly * 2, `ATM gamma rises as expiry nears (${gEarly} -> ${gLate})`);
  near(gLate / gEarly, Math.sqrt(6), 0.05, 'ATM gamma scales with 1/sqrt(T)');
  assert.strictEqual(X.bsGamma(24000, 24000, 0, 12), null);
  assert.strictEqual(X.bsGamma(24000, 24000, 0.01, 0), null);

  // ── straddle decay ──
  const day = '2026-11-03';
  const series = (endHm, factor = 1, s0 = 120) => {
    const out = [];
    const start = ist(`${day}T09:15:00`), end = ist(`${day}T${endHm}:00`);
    for (let t = start; t <= end; t += 60000) {
      const left = X.sessionMinutesLeft(t);
      // factor applies after 09:30 so the first point (the anchor) is unchanged
      const f = t - start >= 15 * 60000 ? factor : 1;
      out.push({ t, straddle: s0 * Math.sqrt(left / 375) * f, spot: 24000, atmIv: 12, maxPain: 24000, gexCr: 10 });
    }
    return out;
  };
  let dc = X.straddleDecay(series('12:00'), day);
  assert.strictEqual(dc.status, 'ok');
  assert.strictEqual(dc.verdict, 'inline');
  near(dc.ratio, 1, 1e-9, 'on the time-only path');
  near(dc.timeOnlyNow, 120 * Math.sqrt(210 / 375), 1e-6, 'time-only value at 12:00');
  near(dc.decayedPct, (1 - Math.sqrt(210 / 375)) * 100, 1e-6, 'decayed since the open');
  assert(dc.rate && dc.rate.actualPerHour > 0, 'losing premium over the last 30 minutes');
  near(dc.rate.actualPerHour, dc.rate.timeOnlyPerHour, 1e-6, 'on path, actual and time-only rates match');
  assert.deepStrictEqual(dc.ahead.map(a => a.mins), [780, 840, 900], 'checkpoints 13:00, 14:00, 15:00 are ahead at 12:00');
  near(dc.ahead[2].value, dc.now.straddle * Math.sqrt(30 / 210), 1e-6, '15:00 checkpoint from the current value');
  assert.strictEqual(dc.series.length, dc.series.filter(p => p.timeOnly > 0).length);

  assert.strictEqual(X.straddleDecay(series('12:00', 0.8), day).verdict, 'faster', '20% under the path is faster than time');
  assert.strictEqual(X.straddleDecay(series('12:00', 1.25), day).verdict, 'slower', '25% over the path is slower than time');
  assert.strictEqual(X.straddleDecay(series('12:00', 0.95), day).verdict, 'inline', 'within 10% is in line');
  assert.strictEqual(X.straddleDecay(series('09:25'), day).verdict, 'early', 'ten minutes in is too early');
  assert.strictEqual(X.straddleDecay(series('15:27'), day).verdict, 'closing', 'last minutes are not judged');
  assert.deepStrictEqual(X.straddleDecay(series('15:27'), day).ahead, [], 'no checkpoints left after 15:00');

  // other days, pre-open quotes and empty straddles are ignored; the anchor is the first point after 09:15
  const noisy = [
    { t: ist('2026-11-02T14:00:00'), straddle: 300 },
    { t: ist(`${day}T09:08:00`), straddle: 999 },
    { t: ist(`${day}T09:20:00`), straddle: 0 },
    ...series('11:00')
  ];
  dc = X.straddleDecay(noisy, day);
  assert.strictEqual(dc.open.straddle, 120, 'anchor ignores yesterday, pre-open and zero straddles');
  assert.strictEqual(dc.verdict, 'inline');
  assert.strictEqual(X.straddleDecay([], day).status, 'waiting');
  assert.strictEqual(X.straddleDecay(null, day).status, 'waiting');

  // a live quote newer than the last saved snapshot becomes "now"; an older one is ignored
  const pts = series('11:00');
  const liveT = ist(`${day}T11:01:30`);
  dc = X.straddleDecay(pts, day, { t: liveT, straddle: 50 });
  assert.strictEqual(dc.now.t, liveT); assert.strictEqual(dc.now.straddle, 50); assert.strictEqual(dc.verdict, 'faster');
  dc = X.straddleDecay(pts, day, { t: ist(`${day}T10:00:00`), straddle: 50 });
  assert.notStrictEqual(dc.now.straddle, 50, 'an older live quote does not replace the latest snapshot');
  dc = X.straddleDecay([], day, { t: ist(`${day}T10:00:00`), straddle: 80 });
  assert.strictEqual(dc.status, 'ok'); assert.strictEqual(dc.verdict, 'early', 'a single live quote is enough to start');

  // ── chain fixture ──
  const leg = (oi, gamma, iv = 12) => ({ openInterest: oi, impliedVolatility: iv, lastPrice: 10, greeks: { gamma } });
  const strikes = [];
  for (let k = 23500; k <= 24500; k += 50) {
    const dist = Math.abs(k - 24000);
    const g = Math.max(0, 0.004 - dist * 0.00001);
    const ce = k === 24100 ? 900000 : 100000, pe = k === 23950 ? 700000 : 100000;
    strikes.push({ strike: k, CE: leg(ce, g), PE: leg(pe, g) });
  }
  const chain = (asOf, extra = {}) => ({
    expiry: '03-Nov-2026', spot: 24010, atm: 24000, dataAsOf: asOf, straddlePrice: 60, atmIv: 12, maxPain: 24050,
    straddleDetails: { oneSigmaMove: 75, tradingDaysLeft: 1 },
    gex: { totalGexCr: 42.5, zeroGammaLevel: 23880, gexRegime: 'POSITIVE_GAMMA', lotSize: 65 },
    strikes, ...extra
  });

  // ── pin risk ──
  const mpPts = series('11:00').map((p, i) => ({ ...p, maxPain: i < 60 ? 24000 : 24050 }));
  let pin = X.pinRisk(chain(new Date(ist(`${day}T11:01:00`)).toISOString()), mpPts, day);
  assert.strictEqual(pin.atOpen, 24000);
  assert.strictEqual(pin.shiftCount, 1); assert.strictEqual(pin.shifts[0].from, 24000); assert.strictEqual(pin.shifts[0].to, 24050);
  assert.strictEqual(pin.distance, -40, 'spot 40 points below max pain');
  near(pin.distanceSigma, -40 / 75, 1e-9, 'distance in sigma');
  near(pin.maxPainProb, X.closeNearProb(24010, 24050, 75), 1e-12, 'max pain close-near probability');
  assert.strictEqual(pin.heavy.length, 3);
  assert.deepStrictEqual(pin.heavy.slice(0, 2).map(h => h.strike), [24100, 23950], 'heaviest combined OI first');
  assert.strictEqual(pin.heavy[0].oi, 1000000); assert.strictEqual(pin.heavy[0].distance, 90);
  assert(pin.heavy.every(h => Math.abs(h.strike - 24010) <= 150), 'only strikes within reach (2 sigma = 150)');
  near(pin.heavy[1].prob, X.closeNearProb(24010, 23950, 75), 1e-12, 'per-strike probability');
  // a tiny late-day sigma still looks 150 points out
  const tight = X.pinRisk(chain('2026-11-03T09:50:00.000Z', { straddleDetails: { oneSigmaMove: 10 } }), [], day);
  assert.deepStrictEqual(tight.heavy.slice(0, 2).map(h => h.strike), [24100, 23950]);
  // live max pain differs from the last saved point: that counts as a shift too
  const pin2 = X.pinRisk(chain(new Date(ist(`${day}T11:01:00`)).toISOString(), { maxPain: 24100 }), mpPts, day);
  assert.strictEqual(pin2.shiftCount, 2); assert.strictEqual(pin2.shifts[1].to, 24100);
  // no sigma: probabilities are n/a, not zero
  const pin3 = X.pinRisk(chain('2026-11-03T05:00:00.000Z', { straddleDetails: {} }), [], day);
  assert.strictEqual(pin3.maxPainProb, null); assert(pin3.heavy.every(h => h.prob === null));

  // ── gamma near the money ──
  const closeMs = Date.parse(`${day}T10:00:00Z`);
  let gm = X.gammaNearMoney(chain(new Date(ist(`${day}T14:30:00`)).toISOString()), series('14:30'), closeMs);
  assert.strictEqual(gm.rows.length, 11, 'ATM +-5 strikes');
  assert.strictEqual(gm.rows[0].strike, 23750); assert.strictEqual(gm.rows[10].strike, 24250);
  const rCall = gm.rows.find(r => r.strike === 24100), rPut = gm.rows.find(r => r.strike === 23950);
  assert(rCall.netCr > 0 && rPut.netCr < 0, 'calls count positive, puts negative (dealer convention)');
  const scale = 65 * 24010 * 24010 * 0.01 / 1e7;
  near(rCall.callCr, 900000 * 0.003 * scale, 1e-6, 'per-strike GEX matches the server formula');
  assert(gm.nearSharePct > 50 && gm.nearSharePct <= 100, `gamma concentrates near the money (${gm.nearSharePct})`);
  assert.strictEqual(gm.peak.strike, 24100, 'heaviest gross gamma');
  assert(gm.gammaVsOpen > 2, `ATM gamma at 14:30 is well above the open (${gm.gammaVsOpen})`);
  near(gm.deltaPer50, gm.atmGamma * 50, 1e-12, 'delta per 50 points');
  assert.strictEqual(gm.netGexOpenCr, 10); assert.strictEqual(gm.netGexCr, 42.5); assert.strictEqual(gm.zeroGamma, 23880);
  gm = X.gammaNearMoney(chain('2026-11-03T05:00:00.000Z', { strikes: [] }), [], closeMs);
  assert.strictEqual(gm.rows.length, 0); assert.strictEqual(gm.nearSharePct, null); assert.strictEqual(gm.peak, null);

  // ── whole panel model ──
  let x = X.computeExpiryDay(chain(new Date(ist(`${day}T12:00:00`)).toISOString()), series('12:00'));
  assert.strictEqual(x.status, 'ok'); assert.strictEqual(x.isExpiryDay, true); assert.strictEqual(x.weekday, 2, 'Tuesday');
  assert.strictEqual(x.minsLeft, 210); assert.strictEqual(x.decay.status, 'ok');
  // the day before: no decay tracking, pin and gamma still computed, no intraday history mixed in
  x = X.computeExpiryDay(chain(new Date(ist('2026-11-02T12:00:00')).toISOString(), { straddleDetails: { oneSigmaMove: 160, tradingDaysLeft: 2 } }), series('12:00'));
  assert.strictEqual(x.isExpiryDay, false); assert.strictEqual(x.decay.status, 'not-expiry'); assert.strictEqual(x.minsLeft, null);
  assert.strictEqual(x.pin.shiftCount, 0); assert.strictEqual(x.gamma.netGexOpenCr, null);
  assert(x.pin.maxPainProb > 0); assert.strictEqual(x.tradingDaysLeft, 2);
  // a quote just after midnight UTC is still the same IST day; 18:31 UTC the evening before is already expiry day in IST
  assert.strictEqual(X.computeExpiryDay(chain('2026-11-02T18:31:00.000Z')).isExpiryDay, true, 'IST date, not UTC date');
  assert.strictEqual(X.computeExpiryDay(chain('2026-11-02T18:29:00.000Z')).isExpiryDay, false);
  assert.strictEqual(X.computeExpiryDay(null).status, 'nodata');
  assert.strictEqual(X.computeExpiryDay({ expiry: 'bad', spot: 1 }).status, 'nodata');
  assert.strictEqual(X.computeExpiryDay({ expiry: '03-Nov-2026', spot: 0 }).status, 'nodata');

  // ── render every state on a fake DOM ──
  const doc = fakeDocument();
  global.document = doc;
  const P = await load('public/js/expiry-panel.js');
  const hosts = () => ({ head: doc.make('div'), decay: doc.make('div'), pin: doc.make('div'), gamma: doc.make('div') });
  const states = {
    expiryMidday: X.computeExpiryDay(chain(new Date(ist(`${day}T11:00:00`)).toISOString(), { straddlePrice: 120 * Math.sqrt(270 / 375) }), mpPts),
    expiryEarly: X.computeExpiryDay(chain(new Date(ist(`${day}T09:20:00`)).toISOString()), series('09:20')),
    expiryAfterClose: X.computeExpiryDay(chain(new Date(ist(`${day}T15:45:00`)).toISOString()), series('15:29')),
    expiryNoHistory: X.computeExpiryDay(chain(new Date(ist(`${day}T08:30:00`)).toISOString()), []),
    dayBefore: x,
    noStrikes: X.computeExpiryDay(chain(new Date(ist('2026-11-02T12:00:00')).toISOString(), { strikes: [], gex: null, straddleDetails: null })),
    nodata: X.computeExpiryDay(null)
  };
  for (const [name, model] of Object.entries(states)) {
    const h = hosts();
    P.renderExpiryPanel(h, model);
    const text = Object.values(h).map(n => n.textContent).join(' | ');
    assert(!/undefined|NaN|\[object/.test(text), `${name} renders clean text: ${text.slice(0, 300)}`);
    assert(h.head.textContent.length > 0, `${name} has a header line`);
  }
  const mid = hosts(); P.renderExpiryPanel(mid, states.expiryMidday);
  assert(/Expiry day/.test(mid.head.textContent) && /4 h 30 min/.test(mid.head.textContent), mid.head.textContent);
  assert(/In line with time decay/.test(mid.decay.textContent), mid.decay.textContent);
  assert(/moved 1 time: 24,000 to 24,050/.test(mid.pin.textContent), mid.pin.textContent);
  assert(/24,100/.test(mid.gamma.textContent) && /Cr/.test(mid.gamma.textContent));
  const before = hosts(); P.renderExpiryPanel(before, states.dayBefore);
  assert(/Not expiry day/.test(before.head.textContent) && /Tuesday, 2 trading days away/.test(before.head.textContent), before.head.textContent);
  assert(/Fills on expiry day/.test(before.decay.textContent));
  const after = hosts(); P.renderExpiryPanel(after, states.expiryAfterClose);
  assert(/expired at 15:30 today/.test(after.head.textContent), after.head.textContent);
  delete global.document;

  // ── wiring ──
  const html = read('public/index.html'), app = read('public/js/app.js'), panel = read('public/js/expiry-panel.js');
  for (const id of ['expiryDaySection', 'expiryDayHead', 'expiryDecayChart', 'expiryDecayChartWrap', 'expiryDecayBody', 'expiryPinBody', 'expiryGammaBody']) {
    assert(html.includes(`id="${id}"`), `#${id} missing from the page`);
  }
  for (const k of ['expiryDay', 'expiryDecay', 'expiryPin', 'expiryGamma']) assert(html.includes(`data-explain="${k}"`), `explain ${k} not wired`);
  assert(!/innerHTML/.test(panel.replace(/\/\/[^\n]*/g, '')), 'expiry-panel.js builds DOM with textContent only');
  assert(!/innerHTML|document\./.test(read('public/js/expiry-day.js').replace(/\/\/[^\n]*/g, '')), 'expiry-day.js is pure logic');
  assert(/renderExpiryDay\(points\);\n\}/.test(app), 'renderVolPanels must also render the expiry panel');
  assert(/renderExpiryDecayChart\('expiryDecayChart'/.test(app));
  assert(html.indexOf('id="expiryDaySection"') < html.indexOf('id="volPanelsSection"'), 'expiry panel sits above the vol panels');

  console.log('expiry day OK');
})().catch(e => { console.error(e); process.exit(1); });
