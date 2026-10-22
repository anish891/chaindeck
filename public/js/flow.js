// Smart money flow: turns the raw strike-level OI moves and volume surges into one readable picture.
// Pure functions (no DOM, no imports) so they can be unit-tested in Node.
//
//   classifyFlow({ spikes, unusual, spot, zones }) -> { verdict, score, bullish, bearish, heavy, headline, ... }
//
// spikes  : [{ type: PUT_WRITING | PUT_UNWINDING | CALL_WRITING | CALL_COVERING, strike, delta }]  OI change over ~5 minutes
// unusual : [{ strike, optionType: 'CE' | 'PE', intensity, summary }]  volume surges (direction is ambiguous, so never scored)
// zones   : [{ low, high, mid, kind: 'support' | 'resistance' | 'inside', strength }]  from the chart's ladder (optional)
//
// Put writing and call short covering are read as buying pressure (put sellers expect price to hold; short covering lifts
// price). Call writing and put unwinding are read as selling pressure. This is evidence of positioning, not a list of who
// bought or sold.

export const FLOW_KINDS = {
  PUT_WRITING: { side: 'bull', label: 'Put writing', meaning: 'sellers of puts defend this level' },
  CALL_COVERING: { side: 'bull', label: 'Call short covering', meaning: 'call writers are buying back, which lifts price' },
  CALL_WRITING: { side: 'bear', label: 'Call writing', meaning: 'sellers of calls cap this level' },
  PUT_UNWINDING: { side: 'bear', label: 'Put unwinding', meaning: 'put protection is being removed, a weaker floor' }
};

const FULL_SIZE = 25000;   // OI change that counts as one full unit (the detector's own trigger size)
const MAX_UNITS = 3;       // a huge move cannot count for more than this
const VERDICT_BAND = 15;   // |score| below this is "mixed", not a direction

function proximity(distancePct) {
  const d = Math.abs(distancePct);
  return d <= 0.5 ? 1 : d <= 1.5 ? 0.7 : d <= 3 ? 0.4 : 0.15;
}

function levelAt(strike, zones) {
  if (!Array.isArray(zones)) return null;
  const hit = zones
    .filter(z => z.kind !== 'inside' && strike >= z.low - 15 && strike <= z.high + 15)
    .sort((a, b) => b.strength - a.strength)[0];
  return hit ? { kind: hit.kind, low: hit.low, high: hit.high, strength: hit.strength } : null;
}

export function classifyFlow({ spikes = [], unusual = [], spot, zones = [] } = {}) {
  const items = [];
  for (const s of spikes) {
    const kind = FLOW_KINDS[s.type];
    if (!kind || !Number.isFinite(s.strike) || !Number.isFinite(spot) || !(spot > 0)) continue;
    const delta = Number.isFinite(s.delta) ? s.delta : 0;
    const distancePct = ((s.strike - spot) / spot) * 100;
    const units = Math.min(MAX_UNITS, Math.abs(delta) / FULL_SIZE);
    const weight = units * proximity(distancePct);
    const level = levelAt(s.strike, zones);
    // a flow that lines up with a strong level matters more
    const boosted = level && level.strength >= 50 ? weight * 1.25 : weight;
    items.push({ type: s.type, side: kind.side, label: kind.label, meaning: kind.meaning, strike: s.strike, delta, distancePct, weight: boosted, level });
  }
  const bullish = items.filter(i => i.side === 'bull').sort((a, b) => b.weight - a.weight);
  const bearish = items.filter(i => i.side === 'bear').sort((a, b) => b.weight - a.weight);
  const up = bullish.reduce((s, i) => s + i.weight, 0);
  const down = bearish.reduce((s, i) => s + i.weight, 0);
  const net = up - down;
  const score = Math.round(Math.tanh(net / 4) * 100);

  let verdict = 'quiet';
  if (items.length) verdict = score >= VERDICT_BAND ? 'bullish' : score <= -VERDICT_BAND ? 'bearish' : 'mixed';

  const heavy = (unusual || [])
    .filter(a => Number.isFinite(a.strike))
    .sort((a, b) => (b.intensity === 'CRITICAL') - (a.intensity === 'CRITICAL') || Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .map(a => ({ strike: a.strike, optionType: a.optionType, intensity: a.intensity, summary: a.summary }));

  const lead = verdict === 'bullish' ? bullish[0] : verdict === 'bearish' ? bearish[0] : null;
  const headline = verdict === 'quiet'
    ? 'Quiet: no strike has moved enough in the last few minutes'
    : verdict === 'mixed'
      ? 'Mixed: buying and selling pressure are about equal'
      : `${verdict === 'bullish' ? 'Buying' : 'Selling'} pressure: ${lead.label.toLowerCase()} at ${Math.round(lead.strike)} leads`;

  return { verdict, score, up: Math.round(up * 10) / 10, down: Math.round(down * 10) / 10, bullish, bearish, heavy, headline, count: items.length };
}
