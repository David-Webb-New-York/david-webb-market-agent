#!/usr/bin/env node
/**
 * Round 2: round 1 found the real data (a big embedded Relay/GraphQL store
 * blob in the page HTML, not a separate XHR) and one confirmed real item
 * via its `ecommerceTrackingParams` object: name + price + brand(id) +
 * serviceId. This round extracts EVERY ecommerceTrackingParams occurrence
 * (full item list, not just the first match) and searches for the fields
 * ecommerceTrackingParams doesn't have: listing URL/slug, image, and a
 * human-readable seller/dealer name (its "brand" field is an opaque
 * internal id, not a string).
 */
const bb = require("./browserbase");

async function main() {
  const url = process.argv[2] || "https://www.1stdibs.com/search/jewelry/?oq=david%20webb&q=david%20webb&st=classified";
  const result = await bb.withPage(
    async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(8000);

      const data = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        const blobs = scripts.map((s) => s.textContent || "").filter((t) => t.length > 2000);
        return { blobs };
      });
      return data;
    },
    { sessionOpts: { proxies: true } }
  );

  const blob = result.blobs.sort((a, b) => b.length - a.length)[0] || "";
  console.log("largest blob:", blob.length, "bytes");

  // Every ecommerceTrackingParams object is a flat, self-contained JSON
  // value (no nested braces observed in round 1's sample) -- a
  // non-greedy brace match is safe here and much simpler than a real
  // JSON-aware scan.
  const items = [...blob.matchAll(/"ecommerceTrackingParams":(\{[^{}]*\})/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  console.log(`\nFound ${items.length} ecommerceTrackingParams item(s):`);
  for (const it of items) {
    console.log(` - id=${it.id} price=${it.price} brand=${it.brand} name=${JSON.stringify(it.name)}`);
  }

  // Seller/dealer name and listing URL: search near one real item's id
  // for plausible field names rather than guessing one and hoping.
  if (items.length) {
    const sampleId = items[0].id;
    const idx = blob.indexOf(`"${sampleId}"`);
    console.log(`\n--- 2000b of context around first item (id=${sampleId}) for URL/seller fields ---`);
    console.log(blob.slice(Math.max(0, idx - 500), idx + 1500));
  }

  const urlFieldCandidates = ["sellerName", "dealerName", "vendorName", "storefrontName", "shopName", '"url":', '"slug":', "canonicalUrl", "itemUrl", "detailUrl"];
  console.log("\n--- field-name candidate occurrence counts (whole blob) ---");
  for (const c of urlFieldCandidates) {
    const re = new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const count = (blob.match(re) || []).length;
    if (count > 0) {
      const idx = blob.indexOf(c);
      console.log(`${c}: ${count} occurrence(s), first context: ...${blob.slice(Math.max(0, idx - 100), idx + 200)}...`);
    } else {
      console.log(`${c}: 0`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
