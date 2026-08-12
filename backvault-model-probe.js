#!/usr/bin/env node
/**
 * One-off probe: is The Back Vault (thebackvault.com) a single retailer
 * selling its own inventory, or a consignment/vault marketplace surfacing
 * many independent sellers' own listings (like 1stDibs)? Matters for
 * cross-listing dedup -- if it's the latter, a piece consigned there could
 * ALSO be listed separately under the original dealer's own site, and our
 * matching heuristic can only catch that if we're independently tracking
 * that other site too.
 *
 * Checks the homepage/about copy for consignment/seller language, and a
 * sample of real product pages (pulled from our own committed dataset) for
 * any per-item seller/consignor attribution distinct from "The Back Vault"
 * itself.
 *
 * Dispatched via dealer-marketplaces-debug.yml -- this sandbox's own
 * network can't reach thebackvault.com directly (see HANDOFF.md §7.6).
 */
const { fetchWithTimeout } = require("./fetch-with-timeout");

const SAMPLE_PRODUCT_URLS = [
  "https://thebackvault.com/products/david-webb-jade-platinum-18k-yellow-gold-jade-diamond-blue-enamel-necklace-rr8093",
  "https://thebackvault.com/products/david-webb-platinum-18k-yellow-gold-carved-coral-bangle-bracelet-rr5117",
  "https://thebackvault.com/products/david-webb-turquoise-platinum-turquoise-and-diamond-necklace-rr7804",
];

const CONSIGNMENT_KEYWORDS = [
  "consign", "consignor", "consignment", "our sellers", "our vendors", "trusted sellers",
  "independent dealers", "marketplace", "list your", "sell with us", "sell on the back vault",
];

async function checkPage(label, url) {
  console.log(`\n=== ${label}: ${url} ===`);
  try {
    const res = await fetchWithTimeout(url, {}, 20000);
    console.log("status:", res.status);
    if (!res.ok) return;
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
    const lower = text.toLowerCase();
    const hits = CONSIGNMENT_KEYWORDS.filter((kw) => lower.includes(kw));
    console.log("consignment/marketplace keyword hits:", hits.length ? hits : "(none)");

    // look for an explicit "sold by" / "seller" / vendor byline distinct from The Back Vault
    const vendorMatch = html.match(/"vendor"\s*:\s*"([^"]+)"/i);
    if (vendorMatch) console.log("Shopify 'vendor' field:", vendorMatch[1]);
    const sellerMatch = text.match(/(sold by|seller:|consigned by)\s*[:\-]?\s*([A-Z][\w&.,' -]{2,40})/i);
    if (sellerMatch) console.log("per-item seller byline found:", sellerMatch[0]);
    else console.log("no per-item seller byline found");
  } catch (err) {
    console.log("fetch error:", err.message || err);
  }
}

async function main() {
  await checkPage("Homepage", "https://thebackvault.com/");
  await checkPage("About page (guess)", "https://thebackvault.com/pages/about-us");
  for (const url of SAMPLE_PRODUCT_URLS) {
    await checkPage("Product page", url);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
