// Strategy format for paper trading backtests (and, later, live forward tests): plain JSON rules, never code.
//
// {
//   name: 'ORB breakout',
//   interval: '5m' | '15m',
//   entry: {
//     window: { from: '09:45', to: '13:30' },       entry candle must START inside this window (IST)
//     weekdays: [1, 2, 3, 4, 5],                    Monday = 1
//     maxTradesPerDay: 1,                           1 to 5, one position at a time
//     conditions: [ { type: 'orb', minutes: 30, direction: 'up' }, ... ]   all must hold on the candle before entry
//   },
//   legs: [ { side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' } ],   1 to 4 legs
//   exits: {
//     stopLoss: { unit: 'pct' | 'rupees', value: 30 } | null,   pct = percent of the net premium paid or received
//     target:   { unit: 'pct' | 'rupees', value: 60 } | null,
//     exitAt: '15:15',                                          every trade is closed by then (intraday only)
//     indexMovePts: 80 | null                                   exit if NIFTY moves this far from the entry level
//   }
// }
//
// Conditions (judged on the close of the candle before entry, using only data known by then):
//   gap       { op: 'above' | 'below', pct }               today's open against the previous close, in percent
//   dayMove   { op: 'above' | 'below', pct }               close against today's open, in percent
//   orb       { minutes: 15 | 30 | 60, direction: 'up' | 'down' }   close beyond the opening range, after it has formed
//   vwap      { position: 'above' | 'below' }              close against the session VWAP (Nifty ETF volume as a proxy)
//   prevDay   { level: 'high' | 'low' | 'close', position: 'above' | 'below' }
//   vix       { op: 'above' | 'below', value }             India VIX
//   signal    { direction: 'bull' | 'bear' }               a notable reversal pattern completed on that candle
//
// Option-chain readings (PCR, OI walls) are not conditions here: there is no history of them to backtest against.

const STRIKE_STEP = 50;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OPEN_MIN = 9 * 60 + 15;
const LAST_EXIT_MIN = 15 * 60 + 25;
const MAX_CONDITIONS = 6;
const MAX_LEGS = 4;

const toMins = s => { const m = TIME_RE.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const num = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const oneOf = (x, list) => list.includes(x);
const bad = message => ({ ok: false, error: { code: 'BAD_STRATEGY', message } });

const CONDITION_RULES = {
  gap: c => oneOf(c.op, ['above', 'below']) && num(c.pct, -10, 10) && { type: 'gap', op: c.op, pct: c.pct },
  dayMove: c => oneOf(c.op, ['above', 'below']) && num(c.pct, -10, 10) && { type: 'dayMove', op: c.op, pct: c.pct },
  orb: c => oneOf(c.minutes, [15, 30, 60]) && oneOf(c.direction, ['up', 'down']) && { type: 'orb', minutes: c.minutes, direction: c.direction },
  vwap: c => oneOf(c.position, ['above', 'below']) && { type: 'vwap', position: c.position },
  prevDay: c => oneOf(c.level, ['high', 'low', 'close']) && oneOf(c.position, ['above', 'below']) && { type: 'prevDay', level: c.level, position: c.position },
  vix: c => oneOf(c.op, ['above', 'below']) && num(c.value, 5, 90) && { type: 'vix', op: c.op, value: c.value },
  signal: c => oneOf(c.direction, ['bull', 'bear']) && { type: 'signal', direction: c.direction }
};

const CONDITION_HELP = {
  gap: 'op above/below, pct between -10 and 10',
  dayMove: 'op above/below, pct between -10 and 10',
  orb: 'minutes 15/30/60, direction up/down',
  vwap: 'position above/below',
  prevDay: 'level high/low/close, position above/below',
  vix: 'op above/below, value between 5 and 90',
  signal: 'direction bull/bear'
};

function validateExitRule(r, name) {
  if (r === null || r === undefined) return { ok: true, value: null };
  if (!r || !oneOf(r.unit, ['pct', 'rupees'])) return bad(`exits.${name}.unit must be pct or rupees.`);
  if (r.unit === 'pct' ? !num(r.value, 1, 1000) : !num(r.value, 1, 1e7)) return bad(`exits.${name}.value is out of range.`);
  return { ok: true, value: { unit: r.unit, value: r.value } };
}

/** Check and normalise a strategy. Returns { ok: true, value } or { ok: false, error: { code, message } }. */
function validateStrategy(input) {
  const s = input || {};
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 40) return bad('name: 1 to 40 characters.');
  if (!oneOf(s.interval, ['5m', '15m'])) return bad('interval must be 5m or 15m.');

  const e = s.entry || {};
  const w = e.window || {};
  const from = toMins(w.from), to = toMins(w.to);
  if (from === null || to === null || from < OPEN_MIN || to > LAST_EXIT_MIN || from > to) return bad('entry.window: from and to as HH:MM between 09:15 and 15:25, from not after to.');
  const weekdays = e.weekdays === undefined ? [1, 2, 3, 4, 5] : e.weekdays;
  if (!Array.isArray(weekdays) || !weekdays.length || !weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 5)) return bad('entry.weekdays: Monday = 1 to Friday = 5.');
  const maxTradesPerDay = e.maxTradesPerDay === undefined ? 1 : e.maxTradesPerDay;
  if (!Number.isInteger(maxTradesPerDay) || maxTradesPerDay < 1 || maxTradesPerDay > 5) return bad('entry.maxTradesPerDay: 1 to 5.');
  const rawConds = e.conditions === undefined ? [] : e.conditions;
  if (!Array.isArray(rawConds) || rawConds.length > MAX_CONDITIONS) return bad(`entry.conditions: a list of at most ${MAX_CONDITIONS}.`);
  const conditions = [];
  for (const c of rawConds) {
    const rule = c && CONDITION_RULES[c.type];
    if (!rule) return bad(`Unknown condition type ${JSON.stringify(c && c.type)}. Known: ${Object.keys(CONDITION_RULES).join(', ')}.`);
    const v = rule(c);
    if (!v) return bad(`Condition ${c.type}: ${CONDITION_HELP[c.type]}.`);
    conditions.push(v);
  }

  if (!Array.isArray(s.legs) || !s.legs.length || s.legs.length > MAX_LEGS) return bad(`legs: 1 to ${MAX_LEGS}.`);
  const legs = [];
  for (const l of s.legs) {
    if (!l || !oneOf(l.side, ['BUY', 'SELL']) || !oneOf(l.optionType, ['CE', 'PE'])) return bad('Each leg needs side BUY/SELL and optionType CE/PE.');
    if (!Number.isInteger(l.strikeOffset) || l.strikeOffset < -20 || l.strikeOffset > 20) return bad('strikeOffset: whole number of strikes from ATM, -20 to 20 (50 points each).');
    if (!Number.isInteger(l.lots) || l.lots < 1 || l.lots > 10) return bad('lots: 1 to 10 per leg.');
    const expiry = l.expiry === undefined ? 'weekly' : l.expiry;
    if (!oneOf(expiry, ['weekly', 'next'])) return bad('expiry: weekly (nearest) or next.');
    legs.push({ side: l.side, optionType: l.optionType, strikeOffset: l.strikeOffset, lots: l.lots, expiry });
  }

  const x = s.exits || {};
  const stop = validateExitRule(x.stopLoss, 'stopLoss');
  if (!stop.ok) return stop;
  const target = validateExitRule(x.target, 'target');
  if (!target.ok) return target;
  const exitAt = toMins(x.exitAt);
  if (exitAt === null || exitAt <= from || exitAt > LAST_EXIT_MIN) return bad('exits.exitAt: HH:MM after the entry window opens, at the latest 15:25 (trades never stay overnight).');
  const indexMovePts = x.indexMovePts === undefined || x.indexMovePts === null ? null : x.indexMovePts;
  if (indexMovePts !== null && !num(indexMovePts, 5, 2000)) return bad('exits.indexMovePts: 5 to 2000 points, or null.');

  return {
    ok: true,
    value: {
      name: s.name.trim(),
      interval: s.interval,
      entry: { window: { from: w.from, to: w.to }, weekdays: [...new Set(weekdays)].sort(), maxTradesPerDay, conditions },
      legs,
      exits: { stopLoss: stop.value, target: target.value, exitAt: x.exitAt, indexMovePts }
    }
  };
}

const PRESETS = [
  {
    name: '09:20 iron fly',
    interval: '5m',
    entry: { window: { from: '09:20', to: '09:25' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [] },
    legs: [
      { side: 'SELL', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' },
      { side: 'SELL', optionType: 'PE', strikeOffset: 0, lots: 1, expiry: 'weekly' },
      { side: 'BUY', optionType: 'CE', strikeOffset: 4, lots: 1, expiry: 'weekly' },
      { side: 'BUY', optionType: 'PE', strikeOffset: -4, lots: 1, expiry: 'weekly' }
    ],
    exits: { stopLoss: { unit: 'pct', value: 30 }, target: { unit: 'pct', value: 50 }, exitAt: '15:15', indexMovePts: null }
  },
  {
    name: 'Opening range breakout',
    interval: '5m',
    entry: { window: { from: '09:45', to: '13:30' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [{ type: 'orb', minutes: 30, direction: 'up' }, { type: 'vwap', position: 'above' }] },
    legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' }],
    exits: { stopLoss: { unit: 'pct', value: 30 }, target: { unit: 'pct', value: 60 }, exitAt: '15:00', indexMovePts: null }
  },
  {
    name: 'Gap up fade',
    interval: '5m',
    entry: { window: { from: '09:25', to: '10:30' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [{ type: 'gap', op: 'above', pct: 0.4 }, { type: 'vwap', position: 'below' }] },
    legs: [{ side: 'BUY', optionType: 'PE', strikeOffset: 0, lots: 1, expiry: 'weekly' }],
    exits: { stopLoss: { unit: 'pct', value: 25 }, target: { unit: 'pct', value: 50 }, exitAt: '14:00', indexMovePts: null }
  }
];

module.exports = { STRIKE_STEP, LAST_EXIT_MIN, toMins, validateStrategy, PRESETS, CONDITION_HELP };
