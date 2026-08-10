#!/usr/bin/env node
/**
 * Round 2 of the Sotheby's "upcoming inventory" investigation: round 1
 * found a real, live "Available lots"/"Buy Now" section (34 results for
 * "david webb", real fixed prices captured directly in page text) running
 * on a GraphQL backend (clientapi.prod.sothelabs.com/graphql) distinct
 * from the historical Algolia archive import-sothebys.js already uses --
 * but only response BYTE SIZES were captured, not the actual shape, and
 * it's not yet confirmed whether these are genuine upcoming AUCTION lots
 * (bid-based, with an estimate + sale date) or Sotheby's "Buy Now"
 * fixed-price marketplace (functionally a dealer listing, not an
 * auction). This round captures full response bodies to settle that, and
 * checks whether the site's own filters can separate the two.
 */
const bb = require("./browserbase");

async function probe(url) {
  return bb.withPage(
    async (page) => {
      const graphqlBodies = [];
      page.on("response", async (res) => {
        if (res.url().includes("clientapi.prod.sothelabs.com/graphql")) {
          try {
            const body = await res.text();
            graphqlBodies.push({ url: res.url(), body });
          } catch (_) {}
        }
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(7000);

      const fullBodyText = await page.evaluate(() => document.body.innerText);
      const filterLinks = await page.evaluate(() => {
        return [...document.querySelectorAll("a[href]")]
          .map((a) => a.getAttribute("href"))
          .filter((h) => h && /filter|type|category|auction|buy-now|buynow/i.test(h))
          .slice(0, 30);
      });

      return { graphqlBodies, fullBodyText, filterLinks, finalUrl: page.url() };
    },
    { sessionOpts: { proxies: true } }
  );
}

function summarizeGraphqlBody(body) {
  try {
    const data = JSON.parse(body);
    // Walk the response looking for anything that looks like a list of items.
    const found = [];
    (function walk(obj, path) {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj) && obj.length && typeof obj[0] === "object") {
        found.push({ path, length: obj.length, sampleKeys: Object.keys(obj[0] || {}) });
      }
      for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k);
    })(data, "");
    return found;
  } catch (e) {
    return { parseError: e.message, snippet: body.slice(0, 300) };
  }
}

async function main() {
  console.log("=== Full search: query=david webb ===");
  const r1 = await probe("https://www.sothebys.com/en/search?query=david+webb");
  console.log("final URL:", r1.finalUrl);
  console.log("GraphQL responses captured:", r1.graphqlBodies.length);
  for (const g of r1.graphqlBodies) {
    console.log("\n--- response for", g.url, "---");
    const summary = summarizeGraphqlBody(g.body);
    console.log(JSON.stringify(summary, null, 2).slice(0, 2000));
  }

  console.log("\n=== Full page text (first 4000 chars) ===");
  console.log(r1.fullBodyText.slice(0, 4000));

  console.log("\n=== Filter-related links found on the page ===");
  console.log(r1.filterLinks);

  console.log("\n\n=== Try navigating straight to Sotheby's Auctions section for david webb ===");
  try {
    const r2 = await probe("https://www.sothebys.com/en/auctions?query=david+webb");
    console.log("final URL:", r2.finalUrl);
    console.log("body text sample:", r2.fullBodyText.slice(0, 1500));
  } catch (err) {
    console.log("Auctions-section probe failed:", err.message);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
