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
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (isProduction()) {
      return res.status(503).json({ ok: false, error: 'This endpoint is disabled until CRON_SECRET is configured.' });
    }
    return next();
  }
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const given = match ? match[1] : '';
  // Hash both sides so the comparison is constant-time and length-independent.
  if (!crypto.timingSafeEqual(sha256(given), sha256(secret))) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

// ── Validation & errors ──────────────────────────────────────────────────

const EXPIRY_RE = /^\d{2}-[A-Za-z]{3}-\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isValidExpiry = s => typeof s === 'string' && s.length === 11 && EXPIRY_RE.test(s);
const isValidDate = s => typeof s === 'string' && s.length === 10 && DATE_RE.test(s);

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
  sendError
};
