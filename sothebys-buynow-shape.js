#!/usr/bin/env node
/**
 * Round 4. Round 3's DOM-selector approach failed (a heuristic bug --
 * "walk up 5 parent levels from any element containing 'Buy now' text"
 * landed on the site's top nav menu, not a result card, since "Buy now"
 * text apparently also appears somewhere in nav/promo chrome). Rather
 * than keep fighting fragile CSS selectors, this pivots to parsing the
 * GraphQL response directly -- more robust anyway. Rounds 1-2 already
 * confirmed the query field is `retailItemBySlug` and the response
 * contains real data (image arrays were seen), but the summarizer only
 * captured ARRAY fields, not scalar leaves like price/title/slug. This
 * dumps full raw JSON for a couple of responses to get those directly.
 */
const bb = require("./browserbase");

async function main() {
  const url = "https://www.sothebys.com/en/search?query=david+webb";
  const result = await bb.withPage(
    async (page) => {
      const graphqlBodies = [];
      page.on("response", async (res) => {
        if (res.url().includes("clientapi.prod.sothelabs.com/graphql")) {
          try {
            const body = await res.text();
            graphqlBodies.push(body);
          } catch (_) {}
        }
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(7000);
      return { graphqlBodies };
    },
    { sessionOpts: { proxies: true } }
  );

  console.log(`Captured ${result.graphqlBodies.length} GraphQL response bodies\n`);
  // Print full raw bodies for the first 3 -- these are per-item queries
  // (each ~7-13KB per round 1-2), so full dumps should reveal the real
  // top-level scalar fields (price, title, slug, sku, condition, etc.)
  // right next to the media.images array we already confirmed exists.
  for (let i = 0; i < Math.min(3, result.graphqlBodies.length); i++) {
    console.log(`=== Body ${i} (${result.graphqlBodies[i].length} bytes) ===`);
    console.log(result.graphqlBodies[i]);
    console.log("\n\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
