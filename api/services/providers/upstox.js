const fetch = require('node-fetch');

// Minimal client for the Upstox REST API (https://api.upstox.com).
//
// Auth: a bearer token read from UPSTOX_ACCESS_TOKEN. The intended token is Upstox's read-only Analytics Token (valid one
// year, generated from the Developer Apps page), so the server never needs a daily login. A normal OAuth access token also
// works but expires every morning.
//
// Every successful Upstox reply is { status: 'success', data }. This module returns `data` and throws an Error with a
// `code` on anything else:
//   UPSTOX_NO_TOKEN  no token configured           (not retried)
//   UPSTOX_AUTH      401/403: token missing/expired (not retried)
//   UPSTOX_RATE      429: rate limited              (retried once after a short pause)
//   UPSTOX_HTTP      any other non-2xx status       (retried once)
//   UPSTOX_BAD_REPLY a 2xx reply that is not JSON or not status 'success'
//   UPSTOX_TIMEOUT   no answer within the timeout   (retried once)

const BASE_URL = 'https://api.upstox.com';
const DEFAULT_TIMEOUT_MS = 6000;
const RETRY_PAUSE_MS = 400;

const token = () => (process.env.UPSTOX_ACCESS_TOKEN || '').trim();
const isConfigured = () => Boolean(token());

function upstoxError(code, message, status = null) {
  const err = new Error(message);
  err.code = code;
  if (status !== null) err.status = status;
  return err;
}

const RETRYABLE = new Set(['UPSTOX_RATE', 'UPSTOX_HTTP', 'UPSTOX_TIMEOUT']);

/** First human-readable message from an Upstox error body, kept short (it only goes to the server log). */
function errorText(body) {
  const e = body && Array.isArray(body.errors) && body.errors[0];
  return e ? String(e.message || e.errorCode || '').slice(0, 200) : '';
}

/** Build a URL with query parameters (values are URL-encoded; instrument keys contain '|' and spaces). */
function buildUrl(path, query = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v)}`)
    .join('&');
  return `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
}

async function requestOnce(url, { fetchImpl, timeoutMs, accessToken }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.type === 'aborted')) throw upstoxError('UPSTOX_TIMEOUT', `Upstox did not answer within ${timeoutMs} ms`);
    throw upstoxError('UPSTOX_HTTP', `Upstox request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }

  if (res.status === 401 || res.status === 403) {
    throw upstoxError('UPSTOX_AUTH', `Upstox rejected the token (${res.status})${errorText(body) ? `: ${errorText(body)}` : ''}`, res.status);
  }
  if (res.status === 429) throw upstoxError('UPSTOX_RATE', 'Upstox rate limit hit (429)', 429);
  if (!res.ok) throw upstoxError('UPSTOX_HTTP', `Upstox HTTP ${res.status}${errorText(body) ? `: ${errorText(body)}` : ''}`, res.status);
  if (!body || body.status !== 'success' || body.data === undefined) {
    throw upstoxError('UPSTOX_BAD_REPLY', `Unexpected Upstox reply${errorText(body) ? `: ${errorText(body)}` : ''}`, res.status);
  }
  return body.data;
}

/**
 * GET an Upstox endpoint and return its `data`. One retry for transient failures (timeouts, 429, 5xx), none for auth errors.
 * Options are injectable for tests: fetchImpl, accessToken, timeoutMs, sleep.
 */
async function get(path, query = {}, {
  fetchImpl = fetch,
  accessToken = token(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = ms => new Promise(r => setTimeout(r, ms))
} = {}) {
  if (!accessToken) throw upstoxError('UPSTOX_NO_TOKEN', 'UPSTOX_ACCESS_TOKEN is not set');
  const url = buildUrl(path, query);
  try {
    return await requestOnce(url, { fetchImpl, timeoutMs, accessToken });
  } catch (err) {
    if (!RETRYABLE.has(err.code)) throw err;
    await sleep(err.code === 'UPSTOX_RATE' ? RETRY_PAUSE_MS * 2 : RETRY_PAUSE_MS);
    return requestOnce(url, { fetchImpl, timeoutMs, accessToken });
  }
}

module.exports = { get, buildUrl, isConfigured, BASE_URL };
