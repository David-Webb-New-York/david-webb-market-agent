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

// Standard browser/HTTP-plumbing headers every request carries -- not
// useful for finding a site's own custom auth header (e.g. an API
// Management subscription key), just noise to filter out.
const BORING_HEADER_RE =
  /^(accept|accept-encoding|accept-language|cache-control|connection|content-length|content-type|cookie|host|origin|pragma|referer|sec-ch-ua|sec-ch-ua-mobile|sec-ch-ua-platform|sec-fetch-dest|sec-fetch-mode|sec-fetch-site|user-agent|priority|te)$/i;

// Reduce a request's full header set down to the ones actually worth
// looking at when reverse-engineering an API's auth requirement (custom
// headers like a subscription/API key, not standard browser plumbing).
function notableHeaders(allHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(allHeaders || {})) {
    if (!BORING_HEADER_RE.test(k)) out[k] = v;
  }
  return out;
}

// A response worth capturing as a candidate API result: either a real
// `application/json` content-type, or a URL matching a known non-JSON-
// labeled data-route convention -- confirmed necessary on Phillips, whose
// Remix resource routes (`/remix/api/action/search/makers.data`) return
// real search-result data over HTTP 200 but don't set a "json" content-type,
// so the content-type-only check silently missed the exact response an
// adapter would need.
function isCandidateApiResponse(url, contentType) {
  if (/json/i.test(contentType || "")) return true;
  return /\.data(\?|$)/i.test(url);
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
          if (!isCandidateApiResponse(r.url(), ct)) return;
          const body = await r.text();
          const req = r.request();
          const headers = notableHeaders(await req.allHeaders().catch(() => ({})));
          jsonResponses.push({
            url: r.url(),
            bytes: body.length,
            body,
            method: req.method(),
            postData: req.postData() || null, // present for POST-body search APIs (e.g. Algolia-style endpoints with no query string)
            headers, // non-boilerplate request headers (e.g. an API Management subscription key) -- see notableHeaders()
          });
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

// Navigate to `baseUrl`, then simulate a real user typing a search query and
// pressing Enter (rather than relying on a URL query param), and capture
// what fires as a result. Some sites' search only executes via client-side
// JS bound to keyboard/form events -- a URL param like `?q=...` renders the
// page shell but never triggers the actual search (observed on Christie's
// and Doyle: real, unblocked pages rendered for multiple query-param
// guesses, but zero results populated and zero search-API XHRs fired).
//
// `searchSelectors` is a list of CSS selectors tried in order (first visible
// match wins) for the search input itself. `openTriggerSelectors` (optional)
// is a list tried BEFORE that, for a "click here to open search" icon/button
// some sites hide the input behind.
// `postSearchClickSelectors` (optional): after the search fires and results
// settle, click the first visible match (e.g. a "Past lots" tab) -- for
// sites whose default results view isn't the one we need (observed on
// Christie's: search lands on "available_lots", a separate tab click is
// needed to trigger the real is_past_lots=True request with its real
// headers, which a guessed URL param never produced).
async function interactAndExtract(
  baseUrl,
  term,
  {
    searchSelectors = [],
    openTriggerSelectors = [],
    postSearchClickSelectors = [],
    waitMs = 8000,
    captureJson = true,
    sessionOpts = {},
  } = {}
) {
  return withPage(async (page) => {
    const jsonResponses = [];
    if (captureJson) {
      page.on("response", async (r) => {
        try {
          const ct = r.headers()["content-type"] || "";
          if (!isCandidateApiResponse(r.url(), ct)) return;
          const body = await r.text();
          const req = r.request();
          const headers = notableHeaders(await req.allHeaders().catch(() => ({})));
          jsonResponses.push({
            url: r.url(),
            bytes: body.length,
            body,
            method: req.method(),
            postData: req.postData() || null,
            headers,
          });
        } catch (_) {}
      });
    }
    const log = [];
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (e) {
      log.push(`goto failed: ${e.message}`);
    }
    await page.waitForTimeout(2000);

    // Cookie-consent overlays (OneTrust and similar) render a full-page
    // click-intercepting backdrop (a *separate* element from the accept
    // button itself) that silently times out any later click without a
    // clear error -- observed on Christie's, where a click-the-accept-button
    // attempt never even matched (the button apparently wasn't present/
    // visible in this flow) while the backdrop div was still there
    // intercepting pointer events regardless ("locator.click: Timeout
    // exceeded ... onetrust-pc-dark-filter ... intercepts pointer events" on
    // an unrelated, correctly-resolved tab button). Removing the overlay
    // nodes from the DOM outright sidesteps needing to find/click a specific
    // accept button at all.
    async function removeConsentOverlays() {
      try {
        const removed = await page.evaluate(() => {
          const selectors = [
            "#onetrust-consent-sdk",
            "#onetrust-pc-sdk",
            "#onetrust-banner-sdk",
            ".onetrust-pc-dark-filter",
            "#onetrust-pc-dark-filter",
          ];
          let n = 0;
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((el) => {
              el.remove();
              n++;
            });
          }
          return n;
        });
        if (removed > 0) log.push(`removed ${removed} cookie-consent overlay node(s)`);
      } catch (_) {}
    }
    await removeConsentOverlays();

    // Belt-and-suspenders: OneTrust injects its overlay asynchronously
    // (after its own geolocation lookup), so a fixed-point-in-time removal
    // can race it -- confirmed live: the overlay was absent at the first
    // removal check but present by the time the search-box click ran a few
    // seconds later, blocking it identically to before. Every click below
    // also passes `force: true`, which makes Playwright dispatch the click
    // without checking whether another element visually covers the target --
    // the correct, timing-independent fix for a "such-and-such intercepts
    // pointer events" failure.

    for (const sel of openTriggerSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 })) {
          await el.click({ timeout: 3000, force: true });
          log.push(`clicked open-trigger: ${sel}`);
          await page.waitForTimeout(1000);
          break;
        }
      } catch (_) {}
    }

    let typed = false;
    for (const sel of searchSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 })) {
          await el.click({ timeout: 3000, force: true });
          await el.fill(term, { timeout: 3000 });
          log.push(`typed into: ${sel}`);
          await page.waitForTimeout(300);
          await el.press("Enter");
          log.push(`pressed Enter on: ${sel}`);
          typed = true;
          break;
        }
      } catch (e) {
        log.push(`selector ${sel} failed: ${e.message}`);
      }
    }
    if (!typed) log.push("no search input matched any selector -- nothing typed");

    await page.waitForTimeout(waitMs);
    await removeConsentOverlays(); // a fresh results page can re-render/re-trigger the overlay

    for (const sel of postSearchClickSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 })) {
          await el.click({ timeout: 3000, force: true });
          log.push(`clicked post-search: ${sel}`);
          await page.waitForTimeout(waitMs);
          break;
        }
      } catch (e) {
        log.push(`post-search selector ${sel} failed: ${e.message}`);
      }
    }

    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");
    const url = page.url();
    return { title, html, url, jsonResponses, interactionLog: log };
  }, { sessionOpts });
}

module.exports = { withPage, renderAndExtract, interactAndExtract, hasCreds };
