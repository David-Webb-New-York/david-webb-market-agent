/**
 * Browserbase helper — a managed, stealth cloud browser for sites that render
 * results client-side or block plain HTTP requests (most auction houses).
 *
 * Needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (added as secrets).
 * Note: proxies require a paid Browserbase plan; the default (no-proxy) stealth
 * browser still renders JS-heavy sites.
 *
 * The actual navigate/type/click/capture logic lives in
 * browser-interactions.js, shared with steel.js (Steel.dev, added as a
 * second backend to test against sites Browserbase's plan tier can't get
 * past, e.g. Heritage's DataDome block) -- only session creation/teardown
 * (`withPage`) differs between providers.
 */

const { Browserbase } = require("@browserbasehq/sdk");
const { chromium } = require("playwright-core");
const { makeRenderAndExtract, makeInteractAndExtract } = require("./browser-interactions");

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

const renderAndExtract = makeRenderAndExtract(withPage);
const interactAndExtract = makeInteractAndExtract(withPage);

module.exports = { withPage, renderAndExtract, interactAndExtract, hasCreds };
