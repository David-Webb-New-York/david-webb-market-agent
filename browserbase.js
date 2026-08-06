/**
 * Browserbase helper — a managed, stealth cloud browser for sites that render
 * results client-side or block plain HTTP requests (most auction houses).
 *
 * Needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (added as secrets).
 * Note: proxies require a paid Browserbase plan; the default (no-proxy) stealth
 * browser still renders JS-heavy sites.
 */

const { Browserbase } = require("@browserbasehq/sdk");
const { chromium } = require("playwright-core");

const API_KEY = process.env.BROWSERBASE_API_KEY;
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

function hasCreds() {
  return !!(API_KEY && PROJECT_ID);
}

function assertCreds() {
  if (!hasCreds()) {
    throw new Error("Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (add them as secrets).");
  }
}

// Open a session, hand a Playwright `page` to `fn`, always clean up.
async function withPage(fn, { sessionOpts = {} } = {}) {
  assertCreds();
  const bb = new Browserbase({ apiKey: API_KEY });
  const session = await bb.sessions.create({ projectId: PROJECT_ID, ...sessionOpts });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    return await fn(page, { session });
  } finally {
    await browser.close().catch(() => {});
  }
}

// Navigate to `url`, wait for JS to settle, and return the rendered HTML, page
// title, common embedded state blobs, and (optionally) captured JSON responses.
async function renderAndExtract(url, { waitMs = 8000, captureJson = false, sessionOpts = {} } = {}) {
  return withPage(async (page) => {
    const jsonResponses = [];
    if (captureJson) {
      page.on("response", async (r) => {
        try {
          const ct = r.headers()["content-type"] || "";
          if (!/json/i.test(ct)) return;
          const body = await r.text();
          jsonResponses.push({ url: r.url(), bytes: body.length, body });
        } catch (_) {}
      });
    }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (_) {}
    await page.waitForTimeout(waitMs);
    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");
    const state = await page
      .evaluate(() => {
        const out = {};
        const g = (k) => {
          try { return window[k] ? JSON.stringify(window[k]) : null; } catch (e) { return null; }
        };
        out.__data = g("__data"); // LiveAuctioneers & others
        out.__APOLLO_STATE__ = g("__APOLLO_STATE__");
        out.__PRELOADED_STATE__ = g("__PRELOADED_STATE__");
        try {
          const n = document.getElementById("__NEXT_DATA__");
          out.__NEXT_DATA__ = n ? n.textContent : null;
        } catch (e) {}
        return out;
      })
      .catch(() => ({}));
    return { title, html, state, jsonResponses };
  }, { sessionOpts });
}

module.exports = { withPage, renderAndExtract, hasCreds };
