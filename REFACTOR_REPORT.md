# Refactor report: `refactor/restructure`

Goal: a clearer layout and stronger CI security, with **no change in behaviour**. The routes, response shapes, env
var names, `vercel.json`, the public URLs (`/`, `/js/*`, `/css/*`, `/paper`) and the built paper bundle are all
unchanged. Every move uses `git mv`, so `git log --follow` still shows each file's history.

## What to review first

1. **`.github/workflows/security.yml`**: new jobs. Check that gitleaks and CodeQL pass on the PR.
2. **`test/run.js`** and `package.json` → `npm test`: the 36-command chain becomes a runner. It covers the same 36
   files (checked against the old list), and it exits non-zero on the first failure (checked with a failing file).
3. **One of the service-split commits**, for example `refactor: group market data services ...`. Every changed line
   is a `require` path or a comment.

## Baseline vs after

| Check | Before (main) | After (this branch) |
|---|---|---|
| `npm test` (paper type check + 36 test files) | pass, ~14 s | pass, ~14 s |
| `npm run build:paper` and committed bundle up to date | pass | pass, bundle byte-identical |
| `npm audit` (all deps and runtime only) | 0 vulnerabilities | 0 vulnerabilities |
| Every file under `api/` reachable from `api/index.js` | 40 of 41 (test helper lived in `api/lib`) | 41 of 41 |
| Every relative `require` in `api/`, `test/`, `scripts/` resolves | yes | yes |
| Every route answers on a live server (Upstox token) | n/a | 21 routes, all 200 (308 for the `/paper.html` redirect) |
| Linter | none configured | none configured (see follow-ups) |

The only lines in the whole diff that are neither `require` paths nor comments are the new test runner and the test
helpers that now point at the new locations. `api/middleware/security.js` is byte-identical to the old
`api/security.js`.

## Folder structure

Before:

```
api/
  index.js  security.js  check-upstox-live.js
  verify-*.js            (36 test files inside the deployed folder)
  lib/paperUi.js         (test helper inside the deployed folder)
  routes/                (3)
  services/              (36 files, flat)
public/  paper-app/  .github/workflows/ci.yml
```

After:

```
api/
  index.js                Vercel builds this file (unchanged location)
  middleware/security.js
  routes/                 (unchanged)
  services/
    providers/   upstox, upstoxAdapter, upstoxChain, upstoxCandles, nse, instruments, constituents
    market/      optionChain, market, candles, premarket, participants, calendar, holidays
    analytics/   analytics, integrity, volatility, levels, patterns, signals, conditions, backtest,
                 chartAnalysis, scorecard, forwardlog
    paper/       paperAccounts, paperAnalytics, paperCosts, paperEngine, paperStrategies, strategy,
                 strategyBacktest, strategyLive
    storage/     storage, history
    util/        retry
test/
  run.js                  runs every verify-*.js
  verify-*.js             (36, names unchanged)
  helpers/paperUi.js
scripts/check-upstox-live.js
public/  paper-app/       (unchanged)
.github/workflows/ci.yml  .github/workflows/security.yml  .github/dependabot.yml
```

## Move and rename map

No file was renamed; every file kept its name and only changed folder.

| From | To |
|---|---|
| `api/verify-*.js` (36 files) | `test/verify-*.js` |
| `api/lib/paperUi.js` | `test/helpers/paperUi.js` |
| `api/check-upstox-live.js` | `scripts/check-upstox-live.js` |
| `api/security.js` | `api/middleware/security.js` |
| `api/services/{upstox,upstoxAdapter,upstoxChain,upstoxCandles,nse,instruments,constituents}.js` | `api/services/providers/` |
| `api/services/{optionChain,market,candles,premarket,participants,calendar,holidays}.js` | `api/services/market/` |
| `api/services/{analytics,integrity,volatility,levels,patterns,signals,conditions,backtest,chartAnalysis,scorecard,forwardlog}.js` | `api/services/analytics/` |
| `api/services/{paperAccounts,paperAnalytics,paperCosts,paperEngine,paperStrategies,strategy,strategyBacktest,strategyLive}.js` | `api/services/paper/` |
| `api/services/{storage,history}.js` | `api/services/storage/` |
| `api/services/retry.js` | `api/services/util/` |

Added: `test/run.js`, `.github/workflows/security.yml`, `.github/dependabot.yml`, this report.
Edited for paths only: `api/index.js`, the three routers, every moved service, the tests, `package.json` (`test`
script), `paper-app/src/test-entry.ts` and two `public/js` files (comments only), and the README (new layout section).

## CI/CD changes and why

| Change | Why |
|---|---|
| `actions/checkout` and `actions/setup-node` pinned to commit SHAs (`v7.0.1`, `v7.1.0`: the same versions `@v7` already resolved to) | A moved or compromised tag can't change what runs |
| `persist-credentials: false` on checkout | Later steps never push, so the token shouldn't sit in `.git/config` |
| `timeout-minutes` and `concurrency` with cancel-in-progress | Stops runaway jobs; an old run doesn't race a newer push |
| New `security.yml`: gitleaks over the full history, and CodeQL (`security-extended`); push, PR and weekly | Secret scanning and static analysis in CI. The workflow starts with `permissions: {}` and each job asks only for what it needs |
| New `dependabot.yml` (npm grouped minor/patch weekly, majors separately; GitHub Actions weekly) | Keeps pinned SHAs and dependencies current through reviewable PRs. Nothing updates automatically |
| `vercel.json` | **Unchanged.** It builds `api/index.js`, which didn't move, and Vercel traces the moved modules from there |
| CI steps (`npm ci`, `npm test`, `build:paper`, bundle check, `npm audit`) | Unchanged |

## Security findings

| Severity | Finding | Location | Fix / action |
|---|---|---|---|
| None | Secret scan of all 175 commits (every added line; JWT, AWS, GitHub, Slack, private key, Vercel OIDC, Upstash and assigned-secret patterns). The only hits are made-up test values such as `owner-secret-for-tests`. No `.env`, key or token file was ever tracked; `.env.local` and `.vercel/` are git-ignored | `test/verify-{live,strategy,paper-agent,paper-api,security}.js` (test values) | **Nothing to rotate** |
| Medium | `main` has no branch protection | GitHub settings | **Manual:** protect `main`, require the `CI` and `Security` checks, and block force-pushes |
| Medium | Dependabot security updates are switched off | GitHub settings | `dependabot.yml` added; **manual:** turn on "Dependabot security updates" in Settings → Code security |
| Low | Actions pinned to movable tags | `ci.yml` | Fixed: pinned to SHAs |
| Low | Checkout kept the token; no job timeout or concurrency limit | `ci.yml` | Fixed |
| Low | No secret scanning or static analysis in CI (GitHub's own secret scanning and push protection are already on) | `.github/` | Fixed: `security.yml` |
| Info | Server code already does: constant-time secret comparison, HMAC-signed HttpOnly SameSite=Strict session cookie (Secure in production), 10-per-15-minute sign-in rate limit, 8 KB JSON body cap, sanitised error replies, strict CSP and security headers (kept in sync with `vercel.json` by a test), validated `expiry`/`symbol`/`strike` inputs, cron endpoints that fail closed in production without `CRON_SECRET`, no CORS | `api/middleware/security.js`, routes | No change needed |
| Info | `innerHTML` is used in the dashboard with values the server has already validated as numbers or `DD-Mon-YYYY` strings; the CSP forbids inline script | `public/js/app.js` and others | No change; see follow-ups |
| Info | No containers (Vercel serverless), so the container checks don't apply | n/a | n/a |

### Secret rotation

**Nothing needs rotating.** Real secrets (the Upstox Analytics Token, `VERCEL_OIDC_TOKEN`, `CRON_SECRET`,
`PAPER_SECRET`, Upstash credentials) live only in `.env.local` (git-ignored, never committed) and in Vercel's
encrypted environment variables.

## How to validate CI yourself

`act` isn't installed here, so the pipeline was checked by running the same commands CI runs (`npm ci`-equivalent
install, `npm test`, `npm run build:paper`, the `git diff --exit-code -- public/paper` check, `npm audit --omit=dev`),
and then by the real GitHub Actions run on the PR. To run it locally:

```bash
npm ci && npm test && npm run build:paper && git diff --exit-code -- public/paper && npm audit --omit=dev --audit-level=high
```

## Known risks

- **Lazy `require`s:** three services load `market/optionChain` inside functions. They were rewritten by the same
  resolver and exercised by the live-server check, but a path only reached at runtime is the most likely place for a
  slip. The reachability walk confirms every `require` target exists.
- **Vercel bundling:** Vercel traces dependencies from `api/index.js`. The PR's Preview deployment is the real check;
  smoke-test `/api/health` and `/api/option-chain` on it before relying on production.
- **gitleaks false positives:** if it flags the test values above, add them to a `.gitleaksignore`. Don't weaken the
  rule.

## Recommended follow-ups (not done: they would change behaviour or add dependencies)

1. Turn on branch protection for `main` and Dependabot security updates (settings, above).
2. Add ESLint (flat config) as a dev dependency, starting with `no-unused-vars` and `no-undef`; it needs your sign-off
   as a new tool.
3. Replace `node-fetch` v2 with Node's built-in `fetch` (Node 22+). Abort and header behaviour differ slightly, so it
   needs its own PR and tests.
4. Express 5 and dotenv 18 are new major versions. Leave them to Dependabot's separate PRs, reviewed one at a time.
5. Move the remaining `innerHTML` uses that build markup from data to `textContent` / DOM builders, as most panels
   already do.
6. Make `vercel.json` use the newer `functions` and `rewrites` keys instead of the legacy `builds` key; this changes
   deployment config, so it needs its own PR.
