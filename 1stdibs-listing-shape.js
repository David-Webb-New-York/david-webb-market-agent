#!/usr/bin/env node
/**
 * One-off debug script: bb-probe.js's hardcoded HTML signal list
 * (itemId/lotNumber/salePrice/priceResult/soldPrice/isSold) was built
 * around auction-house field naming and found real "itemId" occurrences on
 * 1stDibs but zero of the price-related ones -- meaning 1stDibs' own
 * Relay/GraphQL schema uses different field names we haven't found yet.
 * Renders the search page, dumps every <script> tag's content (not just
 * ones with an id, which is all bb-probe.js's HTML deep-dive shows), and
 * searches for a broader set of plausible price-field name candidates so
 * we can see the real schema instead of guessing further.
 */
const bb = require("./browserbase");

const PRICE_CANDIDATES = [
  "price", "Price", "amount", "Amount", "cents", "Cents", "askingPrice",
  "convertedPrice", "displayPrice", "retailPrice", "listingPrice", "itemPrice",
  "sellingPrice", "originalPrice", "priceRange", "formattedPrice",
];

async function main() {
  const url = process.argv[2] || "https://www.1stdibs.com/search/jewelry/?oq=david%20webb&q=david%20webb&st=classified";
  const result = await bb.withPage(
    async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(8000);

      const data = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        const blobs = scripts
          .map((s) => s.textContent || "")
          .filter((t) => t.length > 2000); // skip tiny boilerplate/tracking snippets
        return {
          totalScripts: scripts.length,
          largeBlobCount: blobs.length,
          largeBlobSizes: blobs.map((b) => b.length),
          blobs, // full content -- filtered small already, still could be large
        };
      });

      return data;
    },
    { sessionOpts: { proxies: true } }
  );

  console.log("total <script> tags:", result.totalScripts, "| large (>2000b) blobs:", result.largeBlobCount);
  console.log("large blob sizes:", result.largeBlobSizes);

  for (let i = 0; i < result.blobs.length; i++) {
    const blob = result.blobs[i];
    const hits = PRICE_CANDIDATES.filter((c) => blob.includes(c));
    if (hits.length === 0) continue;
    console.log(`\n=== blob ${i} (${blob.length}b) matches: ${hits.join(", ")} ===`);
    // Print context around the first occurrence of each matching candidate.
    for (const c of hits.slice(0, 3)) {
      const idx = blob.indexOf(c);
      console.log(`  ...${blob.slice(Math.max(0, idx - 150), idx + 250)}...`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
