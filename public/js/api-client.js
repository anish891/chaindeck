const API = '/api/option-chain';

export async function fetchOptionChainData(selectedExpiry = null) {
  const url = selectedExpiry
    ? `${API}?expiry=${encodeURIComponent(selectedExpiry)}`
    : API;

  const r = await fetch(url);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

export async function fetchSimilarSessionsData() {
  const r = await fetch('/api/similar-sessions');
  const json = await r.json();
  if (!json.ok || !json.topMatches) return { topMatches: [], reason: json.error };
  return { topMatches: json.topMatches, reason: json.reason };
}

export async function fetchIntradayData(expiry) {
  const r = await fetch(`/api/intraday?expiry=${encodeURIComponent(expiry)}`);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export async function fetchStrikeHistory(expiry, strike) {
  const r = await fetch(`/api/strike-history?expiry=${encodeURIComponent(expiry)}&strike=${strike}`);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

export async function fetchParticipantData() {
  const r = await fetch('/api/participants');
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json.days || [];
}

export async function fetchChartAnalysis(interval, expiry) {
  const q = `interval=${encodeURIComponent(interval)}${expiry ? `&expiry=${encodeURIComponent(expiry)}` : ''}`;
  const r = await fetch(`/api/chart-analysis?${q}`);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}
