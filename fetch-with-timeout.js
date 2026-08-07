/**
 * Plain `fetch()` has no default timeout -- a request that hangs (no
 * response, no error) blocks forever. Confirmed as a real production
 * problem, not theoretical: import-doyle.js's first live orchestrator run
 * hung past 70 minutes on a page fetch and had to be manually cancelled.
 * Wraps fetch() with an AbortController-based timeout so a stuck page
 * request fails fast instead of hanging the whole CI job.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`timed out after ${timeoutMs}ms fetching ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
