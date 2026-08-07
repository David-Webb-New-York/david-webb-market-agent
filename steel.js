/**
 * Steel.dev helper — a second managed cloud-browser backend, tried
 * specifically against sites Browserbase's current plan tier can't get
 * past (Heritage's DataDome device-check block: Browserbase's own
 * advancedStealth/verified modes both 403 as Enterprise-plan-only on this
 * account; Freeman's/Hindman: a persistent net::ERR_TUNNEL_CONNECTION_FAILED
 * specific to that one host through Browserbase's proxy pool).
 *
 * Needs STEEL_API_KEY (added as a secret). Confirmed via Steel's own docs
 * (not guessed): `new Steel({ steelAPIKey })`, `client.sessions.create({...})`,
 * connect via `chromium.connectOverCDP('wss://connect.steel.dev?apiKey=...&sessionId=...')`,
 * `client.sessions.release(session.id)` to tear down. Session options
 * confirmed real (steel-sdk docs/examples): `useProxy` (Steel's own
 * residential proxy network), `solveCaptcha`, `stealthConfig` (e.g.
 * `{ autoCaptchaSolving: false }` to detect without solving), `timeout`,
 * `inactivityTimeout`, `userAgent`, `dimensions` ({width, height}).
 *
 * Shares the actual navigate/type/click/capture logic with browserbase.js
 * via browser-interactions.js -- only session creation/teardown differs.
 */

const Steel = require("steel-sdk");
const { chromium } = require("playwright-core");
const { makeRenderAndExtract, makeInteractAndExtract } = require("./browser-interactions");

const API_KEY = process.env.STEEL_API_KEY;

function hasCreds() {
  return !!API_KEY;
}

function assertCreds() {
  if (!hasCreds()) {
    throw new Error("Steel.dev needs STEEL_API_KEY (add it as a secret).");
  }
}

// Open a session, hand a Playwright `page` to `fn`, always clean up.
async function withPage(fn, { sessionOpts = {} } = {}) {
  assertCreds();
  const client = new Steel({ steelAPIKey: API_KEY });
  const session = await client.sessions.create(sessionOpts);
  const browser = await chromium.connectOverCDP(`wss://connect.steel.dev?apiKey=${API_KEY}&sessionId=${session.id}`);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    return await fn(page, { session });
  } finally {
    await browser.close().catch(() => {});
    await client.sessions.release(session.id).catch(() => {});
  }
}

const renderAndExtract = makeRenderAndExtract(withPage);
const interactAndExtract = makeInteractAndExtract(withPage);

module.exports = { withPage, renderAndExtract, interactAndExtract, hasCreds };
