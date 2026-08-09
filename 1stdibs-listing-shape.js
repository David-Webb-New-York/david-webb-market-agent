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

  // Round 1's flat-object assumption was wrong -- ecommerceTrackingParams
  // has at least one nested object (convertedAmounts:{...}), which a naive
  // `{[^{}]*}` match can't span (found 0 items on retest). Balance braces
  // properly instead of assuming a fixed nesting depth.
  function extractBalancedObjects(text, keyPrefix) {
    const results = [];
    const marker = `"${keyPrefix}":`;
    let searchFrom = 0;
    while (true) {
      const markerIdx = text.indexOf(marker, searchFrom);
      if (markerIdx === -1) break;
      const braceStart = text.indexOf("{", markerIdx);
      if (braceStart === -1) break;
      let depth = 0;
      let i = braceStart;
      for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0) results.push(text.slice(braceStart, i + 1));
      searchFrom = markerIdx + marker.length;
    }
    return results;
  }

  const items = extractBalancedObjects(blob, "ecommerceTrackingParams")
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  console.log(`\nFound ${items.length} ecommerceTrackingParams item(s):`);
  for (const it of items) {
    console.log(` - id=${it.id} price=${it.price} brand=${it.brand} name=${JSON.stringify(it.name)}`);
  }

  // Seller/dealer name and listing URL: search EVERY occurrence of a real
  // item's serviceId (not just its ecommerceTrackingParams leaf) for
  // nearby fields -- Relay's normalized store likely holds the seller/url
  // info in a different, separately-keyed record for the same item, not
  // bundled into the ecommerce tracking object.
  if (items.length) {
    const sampleServiceId = items[0].id; // e.g. "j_19549292"
    const positions = [];
    let searchFrom = 0;
    while (positions.length < 6) {
      const idx = blob.indexOf(sampleServiceId, searchFrom);
      if (idx === -1) break;
      positions.push(idx);
      searchFrom = idx + sampleServiceId.length;
    }
    console.log(`\n--- ${positions.length} occurrence(s) of serviceId "${sampleServiceId}" in the blob ---`);
    for (const idx of positions) {
      console.log(`  ...${blob.slice(Math.max(0, idx - 300), idx + 500)}...\n`);
    }
  }

  const urlFieldCandidates = [
    "sellerName", "dealerName", "vendorName", "storefrontName", "shopName", "seller", "gallery", "Gallery",
    '"url":', '"slug":', "canonicalUrl", "itemUrl", "detailUrl", "id-j_", "pdpUrl", "productUrl", "webUrl",
  ];
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
