#!/usr/bin/env node
/**
 * Round 5. Round 4 dumped the first 3 of 31 captured GraphQL responses raw
 * -- but those happened to be `retailItemBySlug` calls scoped to JUST the
 * media.images field (a component that lazy-loads images independently),
 * with zero price/title/slug data in them. The page fires many differently
 * -scoped queries against the same field name; this round searches ALL 31
 * captured bodies for "price" (and related keywords) and dumps only the
 * ones that actually contain pricing/title/slug data, instead of guessing
 * which of the 31 to print.
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

  const KEYWORDS = /price|amount|slug|sku|currency|permalink|"url":|condition|listPrice|askingPrice/i;
  const matches = result.graphqlBodies
    .map((b, i) => ({ i, body: b, hit: KEYWORDS.test(b) }))
    .filter((x) => x.hit);

  console.log(`${matches.length} of ${result.graphqlBodies.length} bodies contain a pricing/slug-related keyword\n`);

  for (const m of matches.slice(0, 5)) {
    console.log(`=== Body ${m.i} (${m.body.length} bytes) ===`);
    console.log(m.body);
    console.log("\n\n");
  }

  // Also print byte-length distribution so we know which ones are "big"
  // (likely the full item record) vs "small" (likely just one field).
  console.log(
    "All body sizes:",
    result.graphqlBodies.map((b) => b.length)
  );
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
