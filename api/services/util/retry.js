// Retry an async call a few times inside a time budget (the cron endpoint has a hard serverless limit, so it cannot
// wait forever). Errors for which `shouldRetry` returns false, such as a bad request, are thrown immediately.
async function withRetry(fn, { attempts = 3, delayMs = 800, budgetMs = 6500, shouldRetry = () => true, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const start = now();
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const outOfTime = now() - start + delayMs >= budgetMs;
      if (i === attempts || outOfTime || !shouldRetry(err)) break;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
