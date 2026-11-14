// Order-ticket logic kept apart from the component so it can be tested without a browser.

import { instParts } from './format';
import type { Market, OrderRequest, OrderType, Quote, Side } from './types';

export interface Selection {
  instrument: string | null;
  side: Side;
  /** bumps on every pick so the ticket can reset its price fields even when the same strike is picked again */
  nonce: number;
}

export interface TicketForm {
  lots: string;
  type: OrderType;
  limit: string;
  trigger: string;
  bracket: boolean;
  target: string;
  stop: string;
  note: string;
  /** the setup this trade is an example of, e.g. "Breakout" */
  setup: string;
}

export const MAX_SETUP = 40;

export const emptyForm = (): TicketForm => ({ lots: '1', type: 'MARKET', limit: '', trigger: '', bracket: false, target: '', stop: '', note: '', setup: '' });

/** The live quote for an instrument key, or null when it is not in the loaded chain. */
export function quoteFor(market: Market | null, key: string | null): Quote | null {
  if (!market || !key) return null;
  const p = instParts(key);
  if (p.expiry !== market.expiry) return null;
  const row = market.strikes.find(r => r.strike === p.strike);
  return row ? row[p.optionType] : null;
}

const num = (v: string): number | undefined => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
};

/** The order request the server expects, from the form. */
export function buildOrder(form: TicketForm, sel: { instrument: string; side: Side }): OrderRequest {
  const order: OrderRequest = { instrument: sel.instrument, side: sel.side, lots: parseInt(form.lots, 10), orderType: form.type };
  if (form.type === 'LIMIT' || form.type === 'SL') order.limitPrice = num(form.limit);
  if (form.type === 'SL' || form.type === 'SL-M') order.triggerPrice = num(form.trigger);
  if (form.bracket) {
    const target = num(form.target);
    const stop = num(form.stop);
    if (target !== undefined || stop !== undefined) order.bracket = { ...(target !== undefined && { target }), ...(stop !== undefined && { stop }) };
  }
  const note = form.note.trim();
  if (note) order.reason = note;
  const setup = form.setup.trim().replace(/\s+/g, ' ').slice(0, MAX_SETUP);
  if (setup) order.tag = setup;
  return order;
}

// ── risk before the order is placed ──────────────────────────────────────────
// Read from the form alone (no request): what the trade can lose, what it aims to make, and how many lots fit a risk
// budget. Charges are not included; the server's preview line shows those.

export const MAX_LOTS = 20;

export interface RiskRead {
  /** the price the order is expected to trade at, or null when there is no price to go on */
  entry: number | null;
  /** 'stop': the loss if the stop loss is hit. 'premium': a bought option with no stop can lose what was paid.
   *  'uncapped': a sold option with no stop. 'unknown': no entry price yet. */
  basis: 'stop' | 'premium' | 'uncapped' | 'unknown';
  /** rupees lost per lot on that basis (positive), or null when it is not capped or not known */
  perLot: number | null;
  /** rupees lost for the lots on the form */
  maxLoss: number | null;
  /** rupees made at the target, when a target is set */
  reward: number | null;
  /** reward divided by maxLoss */
  ratio: number | null;
}

/** The price an order would trade at: its own limit (or trigger), else what a market order pays or receives. */
export function entryPrice(form: TicketForm, side: Side, quote: Quote | null): number | null {
  if (form.type !== 'MARKET') {
    const own = form.type === 'SL-M' ? num(form.trigger) : num(form.limit);
    return own !== undefined && own > 0 ? own : null; // a price not typed yet is not a price
  }
  if (!quote) return null;
  const px = side === 'BUY' ? quote.ask || quote.ltp : quote.bid || quote.ltp;
  return px && px > 0 ? px : null;
}

export function riskRead(form: TicketForm, side: Side, quote: Quote | null, lotSize: number): RiskRead {
  const none: RiskRead = { entry: null, basis: 'unknown', perLot: null, maxLoss: null, reward: null, ratio: null };
  const entry = entryPrice(form, side, quote);
  const lots = parseInt(form.lots, 10);
  if (entry === null || !(lotSize > 0)) return none;
  const qty = Number.isInteger(lots) && lots > 0 ? lots * lotSize : 0;
  const long = side === 'BUY';
  const stop = form.bracket ? num(form.stop) : undefined;
  const target = form.bracket ? num(form.target) : undefined;
  const r2 = (x: number) => Math.round(x * 100) / 100;

  // a stop on the wrong side of the entry is not a stop; the server refuses it, and here it is simply not counted
  const stopGap = stop !== undefined ? (long ? entry - stop : stop - entry) : 0;
  const targetGap = target !== undefined ? (long ? target - entry : entry - target) : 0;
  let basis: RiskRead['basis'];
  let perUnit: number | null;
  if (stopGap > 0) { basis = 'stop'; perUnit = stopGap; }
  else if (long) { basis = 'premium'; perUnit = entry; }
  else { basis = 'uncapped'; perUnit = null; }

  const perLot = perUnit === null ? null : r2(perUnit * lotSize);
  const maxLoss = perUnit === null || !qty ? null : r2(perUnit * qty);
  const reward = targetGap > 0 && qty ? r2(targetGap * qty) : null;
  return { entry, basis, perLot, maxLoss, reward, ratio: reward !== null && maxLoss ? r2(reward / maxLoss) : null };
}

/** The most lots whose loss stays inside `budget` rupees (0 when even one lot risks more). */
export function lotsForRisk(budget: number, perLot: number | null, maxLots = MAX_LOTS): number {
  if (!(budget > 0) || perLot === null || !(perLot > 0)) return 0;
  return Math.max(0, Math.min(maxLots, Math.floor(budget / perLot + 1e-9)));
}
