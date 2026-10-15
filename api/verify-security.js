// Security regression tests. Everything runs against the real Express app on an ephemeral port;
// no request here reaches NSE, Yahoo or Redis (validation / auth fail first, by design).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fetch = require('node-fetch');
const express = require('express');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const sec = require('./security');
const app = require('./index');

const listen = a => new Promise(res => { const s = http.createServer(a).listen(0, () => res(s)); });
const url = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;

(async () => {
  const server = await listen(app);
  const get = (p, opts) => fetch(url(server, p), opts);

  // ── 1. headers on static files and API responses; no framework banner; no open CORS ──
  for (const p of ['/', '/css/styles.css', '/js/app.js', '/api/health']) {
    const r = await get(p);
    for (const [k, v] of Object.entries(sec.SECURITY_HEADERS)) {
      assert.strictEqual(r.headers.get(k), v, `${p} must send ${k}`);
    }
    assert.strictEqual(r.headers.get('x-powered-by'), null, `${p} must not advertise Express`);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null, `${p} must not enable cross-origin reads`);
  }

  // ── 2. the CSP is actually strict ──
  const csp = sec.CSP;
  assert(!/https?:\/\//.test(csp), 'CSP allows no third-party origins');
  assert(/default-src 'self'/.test(csp) && /script-src 'self'(;|$)/.test(csp), "scripts only from 'self'");
  assert(!/script-src[^;]*unsafe/.test(csp), 'no unsafe-inline / unsafe-eval for scripts');
  assert(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp));

  // ── 3. vercel.json (what actually serves public/ in production) mirrors the Express headers ──
  const vercel = JSON.parse(read('vercel.json'));
  const hdrRoute = vercel.routes.find(r => r.headers);
  assert(hdrRoute && hdrRoute.continue === true, 'vercel.json needs a header route with continue:true');
  assert.deepStrictEqual(hdrRoute.headers, sec.SECURITY_HEADERS, 'vercel.json headers must equal api/security.js (regenerate vercel.json if you change one)');
  assert.strictEqual(vercel.routes[0], hdrRoute, 'header route must come first');

  // ── 4. the page is CSP-clean: no inline handlers, no inline scripts, no third-party resources ──
  const html = read('public/index.html');
  assert.strictEqual((html.match(/\son[a-z]+="/gi) || []).length, 0, 'no inline event handlers in index.html');
  assert.strictEqual((html.match(/<script(?![^>]*\ssrc=)[^>]*>/gi) || []).length, 0, 'no inline <script> blocks');
  assert.strictEqual((html.match(/\b(?:src|href)="https?:\/\//gi) || []).length, 0, 'no external src/href in index.html');
  for (const f of ['public/css/styles.css', ...fs.readdirSync(path.join(root, 'public/js')).map(n => 'public/js/' + n)]) {
    const external = (read(f).match(/https?:\/\/(?!www\.w3\.org)[^\s"'`)]+/g) || []);
    assert.deepStrictEqual(external, [], `${f} must not reference external URLs`);
  }

  // ── 5. vendored third-party code is byte-for-byte what we verified ──
  const pinned = {
    'public/vendor/chart.umd.js': 'sha512-ZwR1/gSZM3ai6vCdI+LVF1zSq/5HznD3ZSTk7kajkaj4D292NLuduDCO1c/NT8Id+jE58KYLKT7hXnbtryGmMg==', // chart.js 4.4.1 npm tarball
    'public/vendor/html2canvas.min.js': 'sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==', // cdnjs SRI, 1.4.1
    'public/vendor/html2pdf.bundle.min.js': 'sha512-GsLlZN/3F2ErC5ifS5QtgpiJtWd43JWSuIgh7mbzZ8zBps+dvLusV+eNQATqgA/HdeKFVgA5v3S/cIrLF7QnIg==', // cdnjs SRI, 0.10.1
    'public/vendor/lightweight-charts.standalone.production.js': 'sha512-C76k0yV9MsfI42H6hU7QXuhtuj9/1OLOEEUfIRpqlU5u6p8ZrOYxOFQkn3TlcC8JWuU6Maf4yUrDcAgcGjSOVA==' // lightweight-charts 5.2.1 npm tarball (Apache-2.0)
  };
  for (const [f, h] of Object.entries(pinned)) {
    const got = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(root, f))).digest('base64');
    assert.strictEqual(got, h, `${f} changed: re-verify it against the official source before updating this hash`);
  }

  // ── 5b. self-hosted fonts: every file exists and each subset carries ITS OWN unicode-range
  //        (a mismatch silently drops basic Latin to a system font) ──
  {
    const css = read('public/css/styles.css');
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1]);
    assert(faces.length >= 10, 'expected the self-hosted font faces');
    for (const f of faces) {
      const file = /url\('\/fonts\/([^']+)'\)/.exec(f)[1];
      const range = /unicode-range:\s*([^;]+);/.exec(f)[1];
      assert(fs.existsSync(path.join(root, 'public/fonts', file)), `${file} must exist`);
      if (/-latin-ext-/.test(file)) assert(/^U\+0100-02BA/.test(range), `${file} must use the latin-ext range, got ${range.slice(0, 30)}`);
      else if (/-latin-/.test(file)) assert(/^U\+0000-00FF/.test(range), `${file} must use the basic latin range, got ${range.slice(0, 30)}`);
    }
    // the rupee sign (U+20B9) is used all over the UI and lives in latin-ext
    const hasRupee = ranges => ranges.split(',').some(r => { const [a, b] = r.trim().replace('U+', '').split('-'); const lo = parseInt(a, 16); const hi = b ? parseInt(b, 16) : lo; return 0x20B9 >= lo && 0x20B9 <= hi; });
    assert(faces.some(f => /latin-ext/.test(f) && hasRupee(/unicode-range:\s*([^;]+);/.exec(f)[1])), 'the rupee sign must be covered by a self-hosted face');
  }

  // ── 6. input validation happens before anything touches NSE or Redis ──
  const bad = [
    '/api/option-chain?expiry=<script>alert(1)</script>',
    '/api/option-chain?expiry=../../etc/passwd',
    '/api/option-chain?expiry=' + 'A'.repeat(500),
    '/api/intraday?expiry=oi:latest:*',
    '/api/intraday',
    '/api/intraday?expiry=13-Oct-2026&date=2026-10-9',
    '/api/strike-history?expiry=13-Oct-2026&strike=-5',
    '/api/strike-history?expiry=13-Oct-2026&strike=22500.5',
    '/api/strike-history?expiry=13-Oct-2026&strike=abc',
    '/api/strike-history?expiry=13-Oct-2026&strike=22500&date=nope'
  ];
  for (const p of bad) assert.strictEqual((await get(p)).status, 400, `${p.slice(0, 70)} must be rejected with 400`);

  // ── 7. operational endpoints: fail closed, constant-time, never accept the secret in the URL ──
  const prevVercel = process.env.VERCEL;
  const prevSecret = process.env.CRON_SECRET;
  try {
    process.env.VERCEL = '1';
    delete process.env.CRON_SECRET;
    assert.strictEqual((await get('/api/cron/snapshot')).status, 503, 'production without CRON_SECRET refuses instead of allowing everyone');
    assert.strictEqual((await fetch(url(server, '/api/session-summary'), { method: 'POST' })).status, 503);

    process.env.CRON_SECRET = 's3cret-value-for-tests';
    assert.strictEqual((await get('/api/cron/snapshot')).status, 401, 'no credentials');
    assert.strictEqual((await get('/api/cron/snapshot', { headers: { Authorization: 'Bearer wrong' } })).status, 401, 'wrong secret');
    assert.strictEqual((await get('/api/cron/snapshot', { headers: { Authorization: 's3cret-value-for-tests' } })).status, 401, 'missing Bearer scheme');
    assert.strictEqual((await get('/api/cron/snapshot?key=s3cret-value-for-tests')).status, 401, 'the secret in the URL is not accepted');
    assert.strictEqual((await fetch(url(server, '/api/session-summary'), { method: 'POST' })).status, 401, 'session-summary is no longer open');
    // correct secret passes authentication (we then stop at validation so NSE is never contacted)
    const ok = await get('/api/cron/snapshot?expiry=bad', { headers: { Authorization: 'Bearer s3cret-value-for-tests' } });
    assert.strictEqual(ok.status, 400, 'correct secret reaches the handler');

    // a secret stored with stray whitespace (trailing newline from a paste) still works with the clean header
    process.env.CRON_SECRET = 's3cret-value-for-tests\n';
    assert.strictEqual((await get('/api/cron/snapshot?expiry=bad', { headers: { Authorization: 'Bearer s3cret-value-for-tests' } })).status, 400, 'trailing newline in the env var must not lock the owner out');
    assert.strictEqual((await get('/api/cron/snapshot', { headers: { Authorization: 'Bearer wrong' } })).status, 401, 'whitespace tolerance must not weaken matching');
    process.env.CRON_SECRET = '   \n';
    assert.strictEqual((await get('/api/cron/snapshot')).status, 503, 'a whitespace-only secret counts as unset (fail closed)');
    process.env.CRON_SECRET = 's3cret-value-for-tests';

    // local development without a secret stays convenient
    process.env.VERCEL = '0';
    delete process.env.CRON_SECRET;
    assert.strictEqual((await get('/api/cron/snapshot?expiry=bad')).status, 400, 'dev without CRON_SECRET reaches the handler');
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = prevVercel;
    if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret;
  }

  // ── 8. rate limiting ──
  {
    const mini = express();
    mini.use(sec.rateLimit({ windowMs: 60000, max: 3 }));
    mini.get('/', (q, r) => r.json({ ok: true }));
    const s2 = await listen(mini);
    const codes = [];
    let retry = null;
    for (let i = 0; i < 5; i++) { const r = await fetch(url(s2, '/')); codes.push(r.status); if (r.status === 429) retry = r.headers.get('retry-after'); }
    assert.deepStrictEqual(codes, [200, 200, 200, 429, 429], 'fourth request in the window is limited');
    assert(Number(retry) >= 1, 'Retry-After is set');
    s2.close();
  }

  // ── 9. errors never leak internals ──
  {
    const origErr = console.error; console.error = () => {};
    const fake = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    sec.sendError(fake, 500, 'ctx', new Error('request to https://my-db-123.upstash.io/ failed, reason: ECONNREFUSED'));
    console.error = origErr;
    assert.strictEqual(fake.code, 500);
    assert(!/upstash|my-db|ECONN/i.test(JSON.stringify(fake.body)), 'upstream error details must not reach the client');
  }
  const status = await (await get('/api/storage-status')).json();
  assert.deepStrictEqual(Object.keys(status).sort(), ['ok', 'persistent'], 'storage-status reveals no backend or env var names');

  // ── 10. validators ──
  assert(sec.isValidExpiry('13-Oct-2026') && !sec.isValidExpiry('13-Oct-2026 ') && !sec.isValidExpiry('2026-10-13') && !sec.isValidExpiry(undefined) && !sec.isValidExpiry(['13-Oct-2026']));
  assert(sec.isValidDate('2026-10-09') && !sec.isValidDate('2026-10-9') && !sec.isValidDate(null));

  server.close();
  console.log('✓ security OK (headers, strict CSP, CSP-clean page, pinned vendor code, validation, fail-closed auth, rate limit, no leaks)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
