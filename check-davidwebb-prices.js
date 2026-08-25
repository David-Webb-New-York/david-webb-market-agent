#!/usr/bin/env node
/**
 * One-off: looks up current davidwebb.com retail prices for two pieces
 * (Skip Pendant Necklace, Nail Stud Earrings) to compare against secondary-
 * market asking prices already in the tracker. Not part of the scheduled
 * pipeline; dispatched by hand.
 */
const QUERIES = ["skip pendant", "nail stud earrings", "nail stud"];

async function searchAndDump(q) {
  const url = `https://www.davidwebb.com/search?q=${encodeURIComponent(q)}&type=product`;
  console.log(`\n=== search: "${q}" -> ${url} ===`);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; price-check/1.0)" } });
  console.log("Status:", res.status);
  const body = await res.text();
  console.log("Body length:", body.length);

  // Pull product links
  const linkMatches = [...body.matchAll(/href="(\/products\/[a-z0-9\-]+)"/gi)].map((m) => m[1]);
  const uniqueLinks = [...new Set(linkMatches)];
  console.log("Product links found:", uniqueLinks.slice(0, 10));

  // Pull anything that looks like a price near product titles
  const priceMatches = [...body.matchAll(/\$[0-9][0-9,]*(?:\.[0-9]{2})?/g)].map((m) => m[0]);
  console.log("Prices seen on page:", [...new Set(priceMatches)].slice(0, 20));

  return uniqueLinks;
}

async function fetchProduct(link) {
  const url = `https://www.davidwebb.com${link}`;
  console.log(`\n--- product: ${url} ---`);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; price-check/1.0)" } });
  console.log("Status:", res.status);
  const body = await res.text();
  const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/i);
  console.log("Title:", titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "(none)");
  const jsonLdMatches = [...body.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of jsonLdMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed.offers || parsed["@type"] === "Product") {
        console.log("JSON-LD product data:", JSON.stringify(parsed.offers || parsed, null, 2).slice(0, 800));
      }
    } catch {}
  }
  const priceMeta = body.match(/property="product:price:amount" content="([^"]+)"/i);
  if (priceMeta) console.log("meta product:price:amount:", priceMeta[1]);
  const priceMatches = [...body.matchAll(/\$[0-9][0-9,]*(?:\.[0-9]{2})?/g)].map((m) => m[0]);
  console.log("Prices seen on product page:", [...new Set(priceMatches)].slice(0, 15));
}

async function main() {
  for (const q of QUERIES) {
    let links = [];
    try {
      links = await searchAndDump(q);
    } catch (err) {
      console.error(`Search failed for "${q}":`, err.message || err);
      continue;
    }
    for (const link of links.slice(0, 3)) {
      try {
        await fetchProduct(link);
      } catch (err) {
        console.error(`Product fetch failed for ${link}:`, err.message || err);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
