// Number, money and time formatting shared by the whole page. Pure functions (no DOM), so they can be unit-tested.

export function inr(x: number | null | undefined, signed = false): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  const s = Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${x < 0 ? '-' : signed && x > 0 ? '+' : ''}₹${s}`;
}

export const inrWhole = (x: number): string => `${x < 0 ? '-' : ''}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;

export const px = (x: number | null | undefined): string => (x ? Number(x).toFixed(2) : 'n/a');

export const pnlClass = (x: number | null | undefined): string => (x && x > 0 ? 'pt-pos' : x && x < 0 ? 'pt-neg' : '');

export const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export const pctText = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

export interface InstrumentParts {
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
}

/** 'NIFTY|03-Nov-2026|22700|CE' -> its parts. */
export function instParts(key: string): InstrumentParts {
  const [, expiry = '', strike = '0', type = 'CE'] = String(key).split('|');
  return { expiry, strike: Number(strike), optionType: type === 'PE' ? 'PE' : 'CE' };
}

export const instrumentKey = (expiry: string, strike: number, type: 'CE' | 'PE'): string => `NIFTY|${expiry}|${strike}|${type}`;

/** '03-Nov-2026' -> '03 Nov' */
export const shortExpiry = (e: string): string => e.slice(0, 6).replace('-', ' ');

export function instLabel(key: string): string {
  const p = instParts(key);
  return `${shortExpiry(p.expiry)} ${p.strike} ${p.optionType}`;
}

/** Wall-clock HH:MM in India for an epoch-ms or ISO timestamp. */
export const timeIst = (t: number | string | null | undefined): string =>
  t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : 'n/a';

export const dayTime = (t: number | string | null | undefined): string =>
  t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : 'n/a';

/** Today's date in India as YYYY-MM-DD. */
export const todayIst = (now = Date.now()): string => new Date(now + 330 * 60000).toISOString().slice(0, 10);

/** Epoch ms of 15:30 IST on the expiry day ('03-Nov-2026'). */
export const expiryCloseMs = (e: string): number => new Date(`${e.replace(/-/g, ' ')} 15:30:00 GMT+0530`).getTime();

// ── labels ──

const ORDER_WHY: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'not enough free cash',
  NOTHING_TO_CLOSE: 'position already closed',
  OCO_FILLED: 'other leg filled',
  END_OF_DAY: 'end of day',
  EXPIRED_CONTRACT: 'contract expired',
  USER: 'by you'
};

export function statusText(o: { status: string; statusReason?: string | null }): string {
  const why = o.statusReason ? ORDER_WHY[o.statusReason] : undefined;
  return `${o.status.toLowerCase()}${why ? ` (${why})` : ''}`;
}

export function byText(o: { agent?: { label: string } | null; source?: string }): string {
  return o.agent ? `${o.agent.label} (agent)` : o.source === 'strategy' ? 'strategy' : 'you';
}

export const MARKET_REASONS: Record<string, string> = {
  MARKET_CLOSED: 'Market closed. Orders are accepted 09:15 to 15:30 IST on trading days.',
  NO_DATA: 'No option chain data right now.',
  DATA_STALE: 'NSE did not answer, so prices are a leftover copy. Orders and fills are paused until fresh data arrives.',
  DATA_OLD: 'The latest NSE snapshot is more than 3 minutes old. Orders and fills are paused.'
};
