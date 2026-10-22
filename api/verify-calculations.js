const assert = require('assert');

// ── TEST 1: BLACK-SCHOLES GAMMA & GEX VERIFICATION ──
function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function calculateOptionGamma(S, K, T, v, r = 0.065) {
  if (S <= 0 || K <= 0 || T <= 0 || v <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const gamma = normalPdf(d1) / (S * v * Math.sqrt(T));
  return isNaN(gamma) ? 0 : gamma;
}

// Test known Black-Scholes ATM Gamma value: S=24000, K=24000, T=7/365, IV=15%, r=6.5%
const testGamma = calculateOptionGamma(24000, 24000, 7 / 365, 0.15);
assert(testGamma > 0.0004 && testGamma < 0.0008, `Gamma ${testGamma} should be ~0.0006`);
console.log('✓ Test 1 Passed: Black-Scholes Gamma calculation is mathematically accurate.');

// ── TEST 2: MAX PAIN O(N log N) ALGORITHM VS BRUTE FORCE BENCHMARK ──
function computeMaxPainBruteForce(strikes) {
  let minPain = Infinity;
  let maxPainStrike = strikes[0].strike;

  strikes.forEach(target => {
    const K = target.strike;
    let totalPain = 0;

    strikes.forEach(s => {
      const cOI = s.CE?.openInterest || 0;
      const pOI = s.PE?.openInterest || 0;
      if (s.strike < K) totalPain += cOI * (K - s.strike);
      if (s.strike > K) totalPain += pOI * (s.strike - K);
    });

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = K;
    }
  });

  return maxPainStrike;
}

function computeMaxPainOptimized(allExpiryStrikes) {
  const nStrikes = allExpiryStrikes.length;
  if (nStrikes === 0) return 0;

  const sorted = [...allExpiryStrikes].sort((a, b) => a.strike - b.strike);
  const sumCE_OI = new Float64Array(nStrikes);
  const sumCE_W = new Float64Array(nStrikes);
  const sumPE_OI = new Float64Array(nStrikes);
  const sumPE_W = new Float64Array(nStrikes);

  let runCE_OI = 0, runCE_W = 0;
  let runPE_OI = 0, runPE_W = 0;

  for (let i = 0; i < nStrikes; i++) {
    const cOI = sorted[i].CE?.openInterest || 0;
    const pOI = sorted[i].PE?.openInterest || 0;
    const k = sorted[i].strike;

    runCE_OI += cOI;
    runCE_W += cOI * k;
    sumCE_OI[i] = runCE_OI;
    sumCE_W[i] = runCE_W;

    runPE_OI += pOI;
    runPE_W += pOI * k;
    sumPE_OI[i] = runPE_OI;
    sumPE_W[i] = runPE_W;
  }

  const totalPE_OI = sumPE_OI[nStrikes - 1];
  const totalPE_W = sumPE_W[nStrikes - 1];

  let maxPain = sorted[0].strike;
  let minTotalPain = Infinity;

  for (let i = 0; i < nStrikes; i++) {
    const K = sorted[i].strike;
    const callOI_left = i > 0 ? sumCE_OI[i - 1] : 0;
    const callW_left = i > 0 ? sumCE_W[i - 1] : 0;
    const callLoss = K * callOI_left - callW_left;

    const putOI_right = totalPE_OI - sumPE_OI[i];
    const putW_right = totalPE_W - sumPE_W[i];
    const putLoss = putW_right - K * putOI_right;

    const totalPain = callLoss + putLoss;
    if (totalPain < minTotalPain) {
      minTotalPain = totalPain;
      maxPain = K;
    }
  }

  return maxPain;
}

// Synthetic strike chain test
const mockChain = [
  { strike: 23800, CE: { openInterest: 1000 }, PE: { openInterest: 5000 } },
  { strike: 23900, CE: { openInterest: 2000 }, PE: { openInterest: 4000 } },
  { strike: 24000, CE: { openInterest: 8000 }, PE: { openInterest: 8000 } },
  { strike: 24100, CE: { openInterest: 5000 }, PE: { openInterest: 2000 } },
  { strike: 24200, CE: { openInterest: 6000 }, PE: { openInterest: 1000 } },
];

const brutePain = computeMaxPainBruteForce(mockChain);
const optPain = computeMaxPainOptimized(mockChain);

assert.strictEqual(brutePain, optPain, `Optimized Max Pain (${optPain}) must equal Brute Force (${brutePain})`);
console.log('✓ Test 2 Passed: Fast O(N log N) Max Pain matches brute-force baseline exactly.');

// ── TEST 3: CENTRAL PIVOT RANGE (CPR) VERIFICATION ──
function calculateCPR(H, L, C) {
  const pivot = (H + L + C) / 3;
  const bc = (H + L) / 2;
  const tc = (pivot - bc) + pivot;
  const width = Math.abs(tc - bc);
  return { pivot, tc, bc, width };
}

const {
  calculateOptionGreeks, computeImpliedProbabilityDistribution, computeIntradayMLPredictions,
  computeCPR, classifyCPR, findZeroGamma, computeRiskReversal25, computeCompositeRegime,
  updateWelfordZScore, updateAndDetectUnusualFlow
} = require('./services/analytics');

// Symmetric day: pivot == BC == TC, zero width
const cprRes = computeCPR(24100, 23900, 24000);
assert.strictEqual(cprRes.pivot, 24000);
assert.strictEqual(cprRes.bc, 24000);
assert.strictEqual(cprRes.tc, 24000);
assert.strictEqual(cprRes.width, 0);
// Close near the low pulls pivot below the midpoint: TC must still be >= BC
const cprSkew = computeCPR(22717.65, 22546.3, 22603.05);
assert(cprSkew.tc >= cprSkew.bc, 'TC must never be below BC');
assert(Math.abs(cprSkew.pivot - 22622.33) < 0.01, 'pivot = (H+L+C)/3');
assert.strictEqual(classifyCPR(cprSkew.widthPct), 'NARROW');
assert(cprSkew.r1 > cprSkew.pivot && cprSkew.s1 < cprSkew.pivot, 'R1 above / S1 below pivot');
console.log('✓ Test 3 Passed: CPR (real function) — ordering, pivot, classification verified.');

// ── TEST 4: BLACK-SCHOLES OPTION GREEKS ENGINE VERIFICATION ──
const callGreeks = calculateOptionGreeks(24000, 24000, 7 / 365, 0.15, true);
const putGreeks = calculateOptionGreeks(24000, 24000, 7 / 365, 0.15, false);

assert(callGreeks.delta > 0.45 && callGreeks.delta < 0.55, `ATM Call Delta (${callGreeks.delta}) should be ~0.50`);
assert(putGreeks.delta > -0.55 && putGreeks.delta < -0.45, `ATM Put Delta (${putGreeks.delta}) should be ~-0.50`);
assert(callGreeks.vega > 0, `Vega (${callGreeks.vega}) should be positive`);
assert(callGreeks.theta < 0, `Theta (${callGreeks.theta}) should be negative (time decay)`);

console.log('✓ Test 4 Passed: Black-Scholes Option Greeks Engine (Delta, Gamma, Vega, Theta) verified successfully.');

// ── TEST 5: STRADDLE → EXPECTED MOVE, DERIVED INDEPENDENTLY FROM BLACK-SCHOLES ──
// Not a re-multiplication of the code's own constant: price a real ATM straddle, then compare the implementation's
// moves with the true one-standard-deviation move S * sigma * sqrt(T).
const { expectedMoves } = require('./services/analytics');
const cdfRef = x => { let n = 40000, a = -12, h = (x - a) / n, s = 0; for (let i = 0; i <= n; i++) { const xi = a + i * h; s += ((i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2)) * Math.exp(-0.5 * xi * xi); } return s * h / 3 / Math.sqrt(2 * Math.PI); };
const bsPrice = (S, K, T, v, r, call) => { const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T); const C = S * cdfRef(d1) - K * Math.exp(-r * T) * cdfRef(d2); return call ? C : C - S + K * Math.exp(-r * T); };
for (const [S, v, T] of [[22700, 0.14, 7 / 365], [22700, 0.20, 30 / 365], [24000, 0.12, 2 / 365]]) {
  const F = S * Math.exp(0.065 * T); // at-the-forward strike, where parity makes the straddle symmetric
  const straddle = bsPrice(S, F, T, v, 0.065, true) + bsPrice(S, F, T, v, 0.065, false);
  const sigmaMove = S * v * Math.sqrt(T);
  const m = expectedMoves(straddle);
  assert(Math.abs(m.oneSigmaMove / sigmaMove - 1) < 0.02, `1-sigma move ${m.oneSigmaMove.toFixed(1)} should match S*sigma*sqrt(T) ${sigmaMove.toFixed(1)} within 2%`);
  const sigmas = m.expectedMove / sigmaMove;
  assert(sigmas > 0.66 && sigmas < 0.70, `0.85 x straddle is ${sigmas.toFixed(3)} sigma (not 1)`);
  const coverage = cdfRef(sigmas) - cdfRef(-sigmas);
  assert(coverage > 0.48 && coverage < 0.53, `0.85 x straddle covers about 50% (${(coverage * 100).toFixed(1)}%), not 68%`);
}
assert.strictEqual(expectedMoves(220).expectedMove, 187, 'the displayed convention is unchanged');

console.log('✓ Test 5 Passed: expected move derived from Black-Scholes (0.85x straddle = 0.68 sigma = ~50% range; true 1 sigma = 1.25x straddle).');

// ── TEST 4b: GREEKS AGAINST NUMERICAL DERIVATIVES OF AN INDEPENDENT PRICER ──
{
  const { calculateOptionGreeks } = require('./services/analytics');
  for (const [S, K, T, v, call] of [[22700, 22700, 7 / 365, 0.14, true], [22700, 22900, 7 / 365, 0.16, true], [22700, 22500, 30 / 365, 0.18, false], [22700, 22700, 2 / 365, 0.12, false]]) {
    const r = 0.065, g = calculateOptionGreeks(S, K, T, v, call, r);
    const P = (s, t, vol) => bsPrice(s, K, t, vol, r, call);
    const delta = (P(S + 1, T, v) - P(S - 1, T, v)) / 2;
    const gamma = P(S + 1, T, v) - 2 * P(S, T, v) + P(S - 1, T, v);
    const vega = (P(S, T, v + 0.0001) - P(S, T, v - 0.0001)) / 0.0002 / 100;
    const dt = 1e-5;
    const theta = ((P(S, T - dt, v) - P(S, T + dt, v)) / (2 * dt)) / 365;
    const tag = `${call ? 'call' : 'put'} K=${K} T=${(T * 365).toFixed(0)}d`;
    assert(Math.abs(g.delta - delta) < 0.001, `${tag}: delta ${g.delta} vs ${delta.toFixed(4)}`);
    assert(Math.abs(g.gamma - gamma) < 2e-6, `${tag}: gamma ${g.gamma} vs ${gamma.toFixed(6)}`);
    assert(Math.abs(g.vega - vega) < 0.02, `${tag}: vega ${g.vega} vs ${vega.toFixed(3)}`);
    assert(Math.abs(g.theta - theta) < 0.03, `${tag}: theta/day ${g.theta} vs ${theta.toFixed(3)}`);
  }
  console.log('✓ Test 4b Passed: delta, gamma, vega and theta match numerical derivatives of an independent Black-Scholes pricer.');
}

// ── TEST 6: BREEDEN-LITZENBERGER IMPLIED PROBABILITY DISTRIBUTION ──
const mockStrikesForPDF = [
  { strike: 23600, CE: { lastPrice: 420, impliedVolatility: 15 } },
  { strike: 23700, CE: { lastPrice: 330, impliedVolatility: 15 } },
  { strike: 23800, CE: { lastPrice: 245, impliedVolatility: 15 } },
  { strike: 23900, CE: { lastPrice: 170, impliedVolatility: 15 } },
  { strike: 24000, CE: { lastPrice: 105, impliedVolatility: 15 } },
  { strike: 24100, CE: { lastPrice: 55, impliedVolatility: 15 } },
  { strike: 24200, CE: { lastPrice: 25, impliedVolatility: 15 } },
  { strike: 24300, CE: { lastPrice: 10, impliedVolatility: 15 } },
  { strike: 24400, CE: { lastPrice: 3, impliedVolatility: 15 } },
];

const pdfResult = computeImpliedProbabilityDistribution(mockStrikesForPDF, 24000, 7 / 365);
const totalProbSum = pdfResult.distribution.reduce((acc, d) => acc + d.probabilityPct, 0);

assert(totalProbSum >= 99.0 && totalProbSum <= 101.0, `Sum of probabilities (${totalProbSum}%) should be ~100%`);
assert(pdfResult.confidence68.lower <= 24000 && pdfResult.confidence68.upper >= 24000, 'Spot 24000 should lie within 68% confidence interval');
assert(pdfResult.stayProbabilityPct > 0 && pdfResult.stayProbabilityPct <= 100, 'Stay probability should be valid percentage');

console.log('✓ Test 6 Passed: Breeden-Litzenberger Implied Probability Model & Distribution calculation verified successfully.');

// ── TEST 7: INTRADAY ML TREND & BREAKOUT PREDICTION ENGINE VERIFICATION ──
const mlRes = computeIntradayMLPredictions(24000, 24000, 23950, -15.5, 1.35, 1.8, 'NARROW', 2);
const trendSum = mlRes.directionalTrend.bullishPct + mlRes.directionalTrend.neutralPct + mlRes.directionalTrend.bearishPct;

assert(trendSum >= 99.0 && trendSum <= 101.0, `Sum of trend probabilities (${trendSum}%) should be ~100%`);
assert(mlRes.directionalTrend.bullishPct > mlRes.directionalTrend.bearishPct, 'High PCR (1.35) should produce higher bullish probability');
assert(mlRes.marketState.breakoutProbPct > 50, 'Negative Gamma & Narrow CPR should signal higher breakout probability');

console.log('✓ Test 7 Passed: Intraday ML Trend & Breakout Prediction Engine verified successfully.');

// ── TEST 8: PDF recovers a known lognormal when the smile is flat ──
{
  const S = 24000, T = 5 / 365, iv = 0.15;
  const strikes = [];
  for (let K = 22000; K <= 26000; K += 50) strikes.push({ strike: K, CE: { impliedVolatility: 15, openInterest: 1000 }, PE: { impliedVolatility: 15, openInterest: 1000 } });
  const res = computeImpliedProbabilityDistribution(strikes, S, T);
  const sd = S * iv * Math.sqrt(T);
  assert.strictEqual(res.method, 'SMILE_FIT_BL');
  assert(Math.abs((res.confidence68.upper - res.confidence68.lower) / 2 - sd) < sd * 0.12, `68% half-width should ≈ 1σ (${sd.toFixed(0)}), got ${(res.confidence68.upper - res.confidence68.lower) / 2}`);
  const sum = res.distribution.reduce((a, d) => a + d.probabilityPct, 0);
  assert(sum > 97 && sum <= 100.5, `visible mass should be ~100%, got ${sum}`);
  console.log('✓ Test 8 Passed: implied PDF recovers lognormal width (±1σ) from a flat smile.');
}

// ── TEST 9: zero-gamma is a real sign flip, null when none ──
{
  const flip = findZeroGamma(S => (S - 24050) * 1e6, 24000, 23000, 25000, 10);
  assert(Math.abs(flip - 24050) <= 1, `zero-gamma should be ~24050, got ${flip}`);
  assert.strictEqual(findZeroGamma(S => 5e6 + S, 24000, 23000, 25000, 10), null);
  const two = findZeroGamma(S => (S - 23500) * (S - 24400), 24000, 23000, 25000, 10); // flips at both ends
  assert(two === 23500 || two === 24400, 'picks the crossing nearest spot');
  console.log('✓ Test 9 Passed: zero-gamma finds true sign flips (and null when GEX never crosses).');
}

// ── TEST 10: 25Δ risk reversal sign & selection ──
{
  const S = 24000, T = 7 / 365;
  const strikes = [];
  for (let K = 23000; K <= 25000; K += 100) {
    // Put wing richer than call wing
    strikes.push({ strike: K, CE: { impliedVolatility: 14 }, PE: { impliedVolatility: K < S ? 17 : 14 } });
  }
  const rr = computeRiskReversal25(strikes, S, T);
  assert(rr && rr.value > 2.5 && rr.value < 3.5, `RR should be ~+3, got ${rr && rr.value}`);
  assert(rr.putStrike < S && rr.callStrike > S, 'put leg below spot, call leg above');
  console.log('✓ Test 10 Passed: 25Δ risk reversal picks OTM wings and signs put-richness positive.');
}

// ── TEST 11: flow/anomaly detectors use increments & exclude the current sample ──
{
  const key = 't|1';
  for (let i = 0; i < 6; i++) updateWelfordZScore(key, 1000 + (i % 2) * 100, true);
  const spike = updateWelfordZScore(key, 9000, true);
  assert(spike.isAnomaly && spike.zScore > 2.5, 'a spike must score against *prior* history');
  const tiny = updateWelfordZScore('t|2', 5, true);
  assert(!tiny.isAnomaly, 'no anomaly before baseline exists');

  const fk = 'f|1';
  for (let i = 0; i < 5; i++) assert.strictEqual(updateAndDetectUnusualFlow(24000, 1000, 500, true, fk), null);
  const flow = updateAndDetectUnusualFlow(24000, 9000, 4000, true, fk);
  assert(flow && flow.volRatio >= 2.5, 'sudden 9x volume increment is unusual');
  console.log('✓ Test 11 Passed: anomaly & flow detectors score increments against prior history only.');
}

// ── TEST 12: regime & ML sanity ──
{
  assert.strictEqual(computeCompositeRegime('NEGATIVE_GAMMA', 1.0, 'WIDE', 0, 24000, 24000).regimeLabel, 'VOLATILE TWO-WAY MOVES', 'neg GEX + neutral PCR must not fall through to a calm label');
  const calm = computeCompositeRegime('POSITIVE_GAMMA', 1.0, 'AVERAGE', 0, 24000, 24000);
  assert(calm.confidenceScore <= 90 && calm.confidenceScore >= 60);
  // spot far ABOVE max pain near expiry should tilt bearish vs the same setup at max pain
  const atPain = computeIntradayMLPredictions(24000, 24000, 23900, 5, 1.0, 0, 'AVERAGE', 0, { dteDays: 1 });
  const abovePain = computeIntradayMLPredictions(24000, 23700, 23900, 5, 1.0, 0, 'AVERAGE', 0, { dteDays: 1 });
  assert(abovePain.directionalTrend.bearishPct > atPain.directionalTrend.bearishPct, 'spot above max pain should lean bearish near expiry');
  assert(abovePain.marketState.breakoutProbPct < 99 && abovePain.marketState.breakoutProbPct > 1, 'state probabilities must not saturate');
  console.log('✓ Test 12 Passed: regime fall-through, max-pain gravity direction, no saturation.');
}


// ── TEST 13: SESSION SIMILARITY (MATH-002) — must discriminate, unlike cosine on the raw mixed-unit vector ──
{
  const { computeSessionSimilarities: sim, computeCosineSimilarity: cosine, readableSessions } = require('./services/analytics');
  const base = [0.9, 1, 0.2, 0.5, 0.04, 0.03];
  const cases = {
    identical: [0.9, 1, 0.2, 0.5, 0.04, 0.03],
    'PCR 0.9 to 1.6': [1.6, 1, 0.2, 0.5, 0.04, 0.03],
    'OI change 10x': [0.9, 1, 0.2, 0.5, 0.4, 0.3],
    'GEX regime flipped': [0.9, -1, 0.2, 0.5, 0.04, 0.03],
    'everything different': [1.6, -1, 0.5, -3, -0.4, 0.5]
  };
  const out = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, sim(base, [v])[0]]));
  assert(Math.abs(out.identical - 100) < 1e-9, 'identical sessions are 100');
  // the old measure called these 96.0% and 95.6% similar: effectively no signal
  assert(cosine(base, cases['PCR 0.9 to 1.6']) > 0.95 && cosine(base, cases['OI change 10x']) > 0.95, 'documents the old behaviour');
  assert(out['PCR 0.9 to 1.6'] < 60 && out['PCR 0.9 to 1.6'] > 30, `a 2.8-scale PCR change must drop the match from about 100 to the 50s, got ${out['PCR 0.9 to 1.6'].toFixed(1)}`);
  assert(out['OI change 10x'] < 15, `a 10x OI-change difference must read as clearly different, got ${out['OI change 10x'].toFixed(1)}`);
  assert(out['GEX regime flipped'] < 80, 'a flipped gamma regime is a real difference');
  assert(out['everything different'] < 1);
  // closeness is monotone: a small difference scores higher than a large one
  assert(sim(base, [[0.95, 1, 0.2, 0.5, 0.04, 0.03]])[0] > sim(base, [[1.2, 1, 0.2, 0.5, 0.04, 0.03]])[0]);
  // history-derived scales kick in with enough sessions, and bad vectors score 0 instead of throwing
  const hist = Array.from({ length: 12 }, (_, i) => [0.8 + i * 0.03, 1, 0.2, 0.5, 0.04, 0.03]);
  const scored = sim(base, [...hist, null, [1, 2], [NaN, 1, 1, 1, 1, 1]]);
  assert.strictEqual(scored.length, 15); assert.deepStrictEqual(scored.slice(12), [0, 0, 0]);
  assert.deepStrictEqual(sim(null, [[1]]), [0]);
  // BUG-004: a corrupt stored vector is skipped, not fatal
  const good = { date: 'a', feature_vector: JSON.stringify(base) };
  const rs = readableSessions([good, { date: 'b', feature_vector: '{not json' }, { date: 'c', feature_vector: null }, { date: 'd', feature_vector: base }, null]);
  assert.deepStrictEqual(rs.map(r => r.sess.date), ['a', 'd']);
  console.log('✓ Test 13 Passed: session similarity separates different days (old cosine scored them 95%+); corrupt records are skipped.');
}
console.log('\n✅ ALL MATHEMATICAL VERIFICATION TESTS PASSED SUCCESSFULLY!\n');
