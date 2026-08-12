#!/usr/bin/env node
/**
 * Attempt 3 at TheRealReal: attempts 1-2 (see therealreal-listing-shape.js,
 * HANDOFF.md 2026-08-09) both went straight at a full headless browser
 * against /search and hit a DataDome device-check wall. Neither tried a
 * PLAIN fetch() (no browser at all -- no CDP automation markers for a
 * fingerprinting script to detect) against a DIFFERENT part of the site.
 *
 * New lead (found via web search just now, not guessed): Google has
 * indexed real product pages and a designer-category page for David Webb
 * on therealreal.com with real titles/prices in the snippets --
 *   https://www.therealreal.com/designers/david-webb/jewelry
 *   https://www.therealreal.com/products/jewelry/rings/.../david-webb-...
 * Individual product + category pages are the SEO backbone of an e-comm
 * site (Google Shopping needs them server-rendered/crawlable), so they're
 * plausibly a different code path than /search -- worth testing on their
 * own merits rather than assuming the same wall applies everywhere.
 *
 * This is a zero-cost probe: no Browserbase, no Steel, no proxy -- a
 * single polite plain fetch() per URL from the GitHub Actions runner's
 * own IP, with realistic browser headers. If this works, a real importer
 * needs no paid browser-automation service at all.
 */
const { fetchWithTimeout } = require("./fetch-with-timeout");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TARGETS = [
  { label: "robots.txt", url: "https://www.therealreal.com/robots.txt" },
  { label: "designer category page", url: "https://www.therealreal.com/designers/david-webb/jewelry" },
  { label: "designer landing page", url: "https://www.therealreal.com/designers/david-webb" },
  {
    label: "products search (taxons param)",
    url: "https://www.therealreal.com/products?keywords=David+Webb&taxons%5B%5D=759",
  },
  {
    label: "individual product page",
    url: "https://www.therealreal.com/products/jewelry/rings/cocktail-ring/david-webb-18k-enamel-domed-ring-9uobu",
  },
  {
    label: "algolia-test-evergreen sales page",
    url: "https://www.therealreal.com/sales/algolia-test-evergreen?taxons%5B%5D=1320",
  },
];

// Known DataDome/challenge fingerprints from the earlier Heritage/RealReal
// browser-based attempts, so a plain-fetch response can be classified the
// same way without needing to eyeball it.
const BLOCK_SIGNATURES = [
  "captcha-delivery.com",
  "DataDome Device Check",
  "Access to this page has been denied",
  "Press & Hold",
  "geo.captcha-delivery.com",
];

function classify(status, html) {
  if (BLOCK_SIGNATURES.some((sig) => html.includes(sig))) return "BLOCKED (DataDome signature found)";
  if (status >= 400) return `HTTP ${status} (not necessarily a bot block -- could be a real 404/etc)`;
  if (html.length < 5000) return `SUSPICIOUSLY SMALL (${html.length}b) -- likely a block/redirect page`;
  return "LOOKS REAL";
}

function extractSignals(html) {
  const signals = {};
  signals.hasNextData = html.includes("__NEXT_DATA__");
  signals.hasNuxtData = html.includes("__NUXT__");
  signals.hasJsonLd = html.includes('type="application/ld+json"') || html.includes("type='application/ld+json'");
  signals.mentionsAlgolia = /algolia/i.test(html);
  signals.mentionsAppId = /appId["\s:]/i.test(html);
  const algoliaAppIdMatch = html.match(/["']?appId["']?\s*[:=]\s*["']([A-Z0-9]{6,12})["']/i);
  if (algoliaAppIdMatch) signals.algoliaAppId = algoliaAppIdMatch[1];
  const algoliaKeyMatch = html.match(/["']?apiKey["']?\s*[:=]\s*["']([a-f0-9]{32})["']/i);
  if (algoliaKeyMatch) signals.algoliaApiKey = algoliaKeyMatch[1];
  const indexNameMatch = html.match(/["']?indexName["']?\s*[:=]\s*["']([\w.-]+)["']/i);
  if (indexNameMatch) signals.indexName = indexNameMatch[1];
  // David Webb price mentions -- crude but cheap signal that real product
  // data is present in the HTML, not just a shell.
  const priceMatches = [...html.matchAll(/\$[\d,]{2,7}(?:\.\d{2})?/g)].map((m) => m[0]);
  signals.priceMentionCount = priceMatches.length;
  signals.samplePrices = [...new Set(priceMatches)].slice(0, 10);
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  signals.title = titleMatch ? titleMatch[1].trim() : "";
  return signals;
}

async function probeOne({ label, url }) {
  console.log(`\n=== ${label} ===`);
  console.log(url);
  try {
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      25000
    );
    const html = await res.text();
    const verdict = classify(res.status, html);
    console.log(`status: ${res.status} | bytes: ${html.length} | verdict: ${verdict}`);
    if (verdict === "LOOKS REAL") {
      const signals = extractSignals(html);
      console.log("signals:", JSON.stringify(signals, null, 2));
      // Print a slice around the first price mention for a real sanity check.
      const idx = html.search(/\$[\d,]{2,7}/);
      if (idx >= 0) console.log("context around first price:", JSON.stringify(html.slice(Math.max(0, idx - 200), idx + 200)));
    } else {
      console.log("first 500 bytes:", JSON.stringify(html.slice(0, 500)));
    }
  } catch (err) {
    console.log(`FETCH ERROR: ${err.message}`);
  }
  // Be polite -- this is a read-only market-monitoring probe against a
  // real commercial site, not a load test.
  await new Promise((r) => setTimeout(r, 1500));
}

async function main() {
  for (const t of TARGETS) await probeOne(t);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
