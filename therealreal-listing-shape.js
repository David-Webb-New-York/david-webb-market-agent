#!/usr/bin/env node
/**
 * One-off debug script, same approach as 1stdibs-listing-shape.js: render
 * The RealReal's search page for "david webb" and dump every <script>
 * tag's content, searching for plausible price-field name candidates,
 * rather than guessing a field name blind. URL is a best guess (not yet
 * confirmed real) -- the script prints the final URL/title/status so a
 * wrong guess is visible immediately rather than silently producing
 * nothing.
 */
const bb = require("./browserbase");

const PRICE_CANDIDATES = [
  "price", "Price", "amount", "Amount", "cents", "Cents", "askingPrice",
  "convertedPrice", "displayPrice", "retailPrice", "listingPrice", "itemPrice",
  "sellingPrice", "originalPrice", "priceRange", "formattedPrice", "designer",
  "Designer", "brand", "Brand",
];

async function main() {
  const url = process.argv[2] || "https://www.therealreal.com/search?keywords=david%20webb";
  const result = await bb.withPage(
    async (page) => {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => ({ error: e.message }));
      await page.waitForTimeout(8000);

      const data = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        const blobs = scripts
          .map((s) => s.textContent || "")
          .filter((t) => t.length > 2000);
        return {
          title: document.title,
          finalUrl: location.href,
          htmlLength: document.documentElement.outerHTML.length,
          totalScripts: scripts.length,
          largeBlobCount: blobs.length,
          largeBlobSizes: blobs.map((b) => b.length),
          blobs,
        };
      });
      data.navStatus = resp && resp.status ? resp.status() : (resp && resp.error) || "unknown";
      return data;
    },
    { sessionOpts: { proxies: true } }
  );

  console.log("title:", JSON.stringify(result.title), "| final URL:", result.finalUrl, "| html bytes:", result.htmlLength);
  console.log("total <script> tags:", result.totalScripts, "| large (>2000b) blobs:", result.largeBlobCount);
  console.log("large blob sizes:", result.largeBlobSizes);

  if (result.htmlLength < 50000) {
    console.log("\n--- rendered HTML under 50kb, likely a block page or empty shell -- can't tell from summary alone, see artifact-free debug below ---");
  }

  for (let i = 0; i < result.blobs.length; i++) {
    const blob = result.blobs[i];
    const hits = PRICE_CANDIDATES.filter((c) => blob.includes(c));
    if (hits.length === 0) continue;
    console.log(`\n=== blob ${i} (${blob.length}b) matches: ${hits.join(", ")} ===`);
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
