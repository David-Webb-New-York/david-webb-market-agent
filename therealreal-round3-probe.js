#!/usr/bin/env node
/**
 * Round 3 of the TheRealReal investigation (see therealreal-plain-fetch-probe.js
 * for round 2, HANDOFF.md for the full history).
 *
 * Round 2, confirmed via real job logs: EVERY content path (plain fetch AND
 * Steel.dev's real browser with stealth config) hits an IDENTICAL 403
 * PerimeterX "Press & Hold" captcha page (window._pxAppId = 'PXev56mY37'),
 * while robots.txt alone returns real content (200). Identical blocking
 * regardless of whether JS executes points to IP-reputation blocking of
 * datacenter/cloud IP ranges (GitHub Actions runners, Browserbase, Steel),
 * not (only) browser-fingerprint detection.
 *
 * This round tests free ways to route around an IP-based block, all zero
 * additional cost (no Browserbase/Steel/proxy signup):
 *   1. r.jina.ai -- a free public "reader" proxy (fetches server-side from
 *      its own infra, returns cleaned text/markdown). Different IP range
 *      than GitHub Actions; worth testing empirically.
 *   2. Wayback Machine -- archive.org's own crawler is usually NOT blocked
 *      by commercial bot-management vendors (sites often explicitly allow
 *      it), so even a slightly-stale snapshot could reveal real page
 *      structure/data.
 *   3. Googlebot user-agent -- free 30-second test. Naive UA-string-only
 *      checks fall for this; well-configured ones verify reverse-DNS
 *      against Google's published ranges and won't, but cheap to rule out.
 *   4. Fuller browser-like headers (Referer, Sec-Fetch-*) on a plain
 *      fetch, in case any of the 403s are a lighter-weight check than the
 *      full PerimeterX captcha suggests.
 */
const { fetchWithTimeout } = require("./fetch-with-timeout");

const TARGET = "https://www.therealreal.com/designers/david-webb/jewelry";
const BLOCK_SIGNATURES = ["_pxAppId", "Access to this page has been denied", "Press & Hold", "px-captcha"];

function classify(status, text) {
  if (BLOCK_SIGNATURES.some((sig) => text.includes(sig))) return "BLOCKED (PerimeterX signature found)";
  if (status >= 400) return `HTTP ${status}`;
  if (text.length < 2000) return `SUSPICIOUSLY SMALL (${text.length}b)`;
  return "LOOKS REAL";
}

async function report(label, fn) {
  console.log(`\n=== ${label} ===`);
  try {
    const { status, text } = await fn();
    const verdict = classify(status, text);
    console.log(`status: ${status} | bytes: ${text.length} | verdict: ${verdict}`);
    if (verdict === "LOOKS REAL") {
      console.log("first 1500 bytes:", JSON.stringify(text.slice(0, 1500)));
      const priceMatches = [...text.matchAll(/\$[\d,]{2,7}(?:\.\d{2})?/g)].map((m) => m[0]);
      console.log("price mentions:", [...new Set(priceMatches)].slice(0, 15));
      console.log("mentions 'David Webb':", (text.match(/David Webb/gi) || []).length, "times");
    } else {
      console.log("first 400 bytes:", JSON.stringify(text.slice(0, 400)));
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

async function main() {
  await report("1. r.jina.ai reader proxy", async () => {
    const res = await fetchWithTimeout(`https://r.jina.ai/${TARGET}`, {}, 30000);
    return { status: res.status, text: await res.text() };
  });

  await report("2. Wayback Machine (latest snapshot)", async () => {
    const res = await fetchWithTimeout(`https://web.archive.org/web/2/${TARGET}`, {}, 30000);
    return { status: res.status, text: await res.text() };
  });

  await report("3. Wayback Machine availability API (find any snapshot)", async () => {
    const res = await fetchWithTimeout(
      `https://archive.org/wayback/available?url=${encodeURIComponent(TARGET)}`,
      {},
      20000
    );
    return { status: res.status, text: await res.text() };
  });

  await report("4. Plain fetch, Googlebot UA", async () => {
    const res = await fetchWithTimeout(
      TARGET,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      20000
    );
    return { status: res.status, text: await res.text() };
  });

  await report("5. Plain fetch, full browser-like headers + Google referer", async () => {
    const res = await fetchWithTimeout(
      TARGET,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.google.com/",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
      },
      20000
    );
    return { status: res.status, text: await res.text() };
  });
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
