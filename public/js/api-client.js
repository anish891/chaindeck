// One-off reads of the server's own saved history. Live data (the option chain, prices, the price chart) never comes
// through here: it arrives over the WebSocket in stream.js.

// Which index the page shows: ?index=sensex in the address wins, then the last choice saved in this browser, then NIFTY.
export const SYMBOLS = ['NIFTY', 'SENSEX'];
export function readSymbol(search = typeof location !== 'undefined' ? location.search : '', stored = null) {
  const fromUrl = new URLSearchParams(search).get('index');
  let saved = stored;
  if (saved === null) { try { saved = localStorage.getItem('index'); } catch (e) { saved = null; } }
  const pick = String(fromUrl || saved || 'NIFTY').toUpperCase();
  return SYMBOLS.includes(pick) ? pick : 'NIFTY';
}
export const SYMBOL = readSymbol();

/** Add symbol= to an API path for anything but NIFTY (the default on the server), so NIFTY URLs stay as they were. */
export function withSymbol(path, symbol = SYMBOL) {
  if (symbol === 'NIFTY') return path;
  return `${path}${path.includes('?') ? '&' : '?'}symbol=${encodeURIComponent(symbol)}`;
}

export async function fetchSimilarSessionsData() {
  const r = await fetch(withSymbol('/api/similar-sessions'));
  const json = await r.json();
  if (!json.ok || !json.topMatches) return { topMatches: [], reason: json.error };
  return { topMatches: json.topMatches, reason: json.reason };
}

export async function fetchIntradayData(expiry) {
  const r = await fetch(withSymbol(`/api/intraday?expiry=${encodeURIComponent(expiry)}`));
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export async function fetchExpiryReplay(expiry) {
  const r = await fetch(withSymbol(expiry ? `/api/expiry-replay?expiry=${encodeURIComponent(expiry)}` : '/api/expiry-replay'));
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export async function fetchStrikeHistory(expiry, strike) {
  const r = await fetch(withSymbol(`/api/strike-history?expiry=${encodeURIComponent(expiry)}&strike=${strike}`));
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export async function fetchForwardLog() {
  const r = await fetch('/api/forward-log');
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export async function fetchLevelScorecard() {
  const r = await fetch('/api/level-scorecard');
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export async function fetchCalendar() {
  const r = await fetch('/api/calendar');
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json.holidays || [];
}
