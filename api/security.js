const crypto = require('crypto');

// Security building blocks (no dependencies):
//   SECURITY_HEADERS  - sent on every response by Express (local/dev, API) and mirrored in vercel.json
//                       (Vercel serves public/ files directly, bypassing Express). A test keeps both in sync.
//   rateLimit         - small in-memory fixed-window limiter (per instance: a speed bump, not a guarantee)
//   requireSecret     - Bearer-token check for operational endpoints; constant-time and fail-closed in production
//   isValidExpiry / isValidDate / sendError - input validation and non-leaky error responses

const isProduction = () => process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

// Everything the page needs comes from our own origin (fonts, Chart.js and the export libraries are vendored),
// so the policy can be strict: no third-party scripts, no framing, no plugins, no <base> tricks.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // many inline style="" attributes; styles cannot run code
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function securityHeaders(req, res, next) {
  Object.entries(SECURITY_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  next();
}

// ── Rate limiting ────────────────────────────────────────────────────────

function clientIp(req) {
  // Vercel overwrites x-forwarded-for with the real client address, so it can be trusted there only.
  if (process.env.VERCEL === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimit({ windowMs, max, name = 'default' }) {
  const hits = new Map(); // ip -> { count, resetAt }
  const MAX_TRACKED = 5000;

  return function limiter(req, res, next) {
    const now = Date.now();
    if (hits.size > MAX_TRACKED) {
      for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
      if (hits.size > MAX_TRACKED) hits.clear(); // under a flood from many addresses, favour staying up
    }
    const ip = clientIp(req);
    let h = hits.get(ip);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((h.resetAt - now) / 1000))));
      return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });
    }
    return next();
  };
}

// ── Authentication for operational endpoints ─────────────────────────────

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();

/**
 * Requires `Authorization: Bearer <CRON_SECRET>`.
 *  - Production without CRON_SECRET: refuses (503) rather than silently allowing everyone.
 *  - Local development without CRON_SECRET: allowed, for convenience.
 *  - The secret is never accepted in the URL (query strings end up in logs and browser history).
 */
function requireSecret(req, res, next) {
  // Env vars pasted into dashboards often pick up a trailing newline or space (e.g. from `openssl ... | pbcopy`),
  // which would make every request fail. Surrounding whitespace is never part of a real secret, so ignore it.
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) {
    if (isProduction()) {
      return res.status(503).json({ ok: false, error: 'This endpoint is disabled until CRON_SECRET is configured.' });
    }
    return next();
  }
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const given = match ? match[1].trim() : '';
  // Hash both sides so the comparison is constant-time and length-independent.
  if (!crypto.timingSafeEqual(sha256(given), sha256(secret))) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

// ── Validation & errors ──────────────────────────────────────────────────

const EXPIRY_RE = /^\d{2}-[A-Za-z]{3}-\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 3600 * 1000;

const isValidExpiry = s => typeof s === 'string' && s.length === 11 && EXPIRY_RE.test(s);

/** A real calendar date in YYYY-MM-DD form ('2026-02-31' is rejected, not just badly formatted ones). */
function isValidDate(s) {
  if (typeof s !== 'string' || s.length !== 10 || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Expiry strings reach storage keys, so beyond the format they must be plausible: a real date inside the window where
 * option expiries exist (a little in the past for history, about a year ahead). This bounds the key space an anonymous
 * caller can make the server read.
 */
function isPlausibleExpiry(s, now = Date.now()) {
  if (!isValidExpiry(s)) return false;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi === -1) return false;
  const t = Date.UTC(Number(m[3]), mi, Number(m[1]));
  if (new Date(t).getUTCMonth() !== mi) return false; // 31-Feb and friends
  return t >= now - 45 * DAY_MS && t <= now + 420 * DAY_MS;
}

/** A real date within the retention window of stored history (about two months back, never in the future). */
function isRecentDate(s, now = Date.now()) {
  if (!isValidDate(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return t >= now - 62 * DAY_MS && t <= now + DAY_MS;
}

const PUBLIC_ERRORS = {
  400: 'Bad request.',
  429: 'Too many requests. Please slow down.',
  500: 'Internal error.',
  502: 'Market data is temporarily unavailable.'
};

/** Log the real error server-side; tell the client only a generic message (no hostnames, paths or stack details). */
function sendError(res, status, context, err) {
  console.error(`${context}:`, err && err.code ? `[${err.code}] ` : '', err && err.message ? err.message : err);
  return res.status(status).json({ ok: false, error: PUBLIC_ERRORS[status] || 'Error.' });
}

module.exports = {
  CSP,
  SECURITY_HEADERS,
  securityHeaders,
  rateLimit,
  requireSecret,
  clientIp,
  isProduction,
  isValidExpiry,
  isValidDate,
  isPlausibleExpiry,
  isRecentDate,
  sendError
};
