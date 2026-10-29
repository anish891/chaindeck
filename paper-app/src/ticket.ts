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
}

export const emptyForm = (): TicketForm => ({ lots: '1', type: 'MARKET', limit: '', trigger: '', bracket: false, target: '', stop: '', note: '' });

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
  return order;
}
