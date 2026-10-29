// Strategy form helpers: defaults, labels and small edits on the strategy object (the same JSON the agent API takes).

import type { Condition, ConditionType, ExitRule, Leg, Strategy } from './types';

export const CONDITION_LABELS: Record<ConditionType, string> = {
  gap: 'Gap at the open',
  dayMove: 'Move since the open',
  orb: 'Opening range breakout',
  vwap: 'Price vs VWAP',
  prevDay: 'Price vs previous day',
  vix: 'India VIX',
  signal: 'Reversal signal'
};

export const CONDITION_ORDER: ConditionType[] = ['gap', 'dayMove', 'orb', 'vwap', 'prevDay', 'vix', 'signal'];

export function defaultCondition(type: ConditionType): Condition {
  switch (type) {
    case 'gap': return { type, op: 'above', pct: 0.3 };
    case 'dayMove': return { type, op: 'above', pct: 0.3 };
    case 'orb': return { type, minutes: 30, direction: 'up' };
    case 'vwap': return { type, position: 'above' };
    case 'prevDay': return { type, level: 'high', position: 'above' };
    case 'vix': return { type, op: 'below', value: 15 };
    case 'signal': return { type, direction: 'bull' };
  }
}

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export const MAX_LEGS = 4;
export const MAX_CONDITIONS = 6;

export function blankStrategy(): Strategy {
  return {
    name: 'My strategy',
    interval: '5m',
    entry: { window: { from: '09:30', to: '14:00' }, weekdays: [1, 2, 3, 4, 5], maxTradesPerDay: 1, conditions: [] },
    legs: [{ side: 'BUY', optionType: 'CE', strikeOffset: 0, lots: 1, expiry: 'weekly' }],
    exits: { stopLoss: { unit: 'pct', value: 30 }, target: { unit: 'pct', value: 60 }, exitAt: '15:15', indexMovePts: null }
  };
}

export const cloneStrategy = (s: Strategy): Strategy => JSON.parse(JSON.stringify(s)) as Strategy;

export const newLeg = (): Leg => ({ side: 'BUY', optionType: 'PE', strikeOffset: 0, lots: 1, expiry: 'weekly' });

export const offsetLabel = (n: number): string => (n === 0 ? 'ATM' : n > 0 ? `ATM+${n}` : `ATM${n}`);

/** An exit rule from the form's two inputs; no unit or an empty value means "no rule". */
export function exitRule(unit: string, value: number | null): ExitRule | null {
  if ((unit !== 'pct' && unit !== 'rupees') || value === null || !Number.isFinite(value)) return null;
  return { unit, value };
}

/** '' -> null, otherwise a number (the form's number inputs hold strings). */
export function numOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const VERDICT_TEXT: Record<string, [title: string, cls: string, explain: string]> = {
  edge: ['Looks like an edge', 'pt-pos', 'At least 30 trades, the average trade is positive with 95% confidence, and it beat 95% of random-entry runs. Still a backtest on modelled prices: forward test it before trusting it.'],
  none: ['No clear edge', '', 'Enough trades, but the result is within what chance or random entries produce.'],
  negative: ['Loses money', 'pt-neg', 'The average trade is negative with 95% confidence.'],
  insufficient: ['Not enough trades to tell', 'pt-warnc', 'Fewer than 30 trades. Any number below can be luck either way.']
};
