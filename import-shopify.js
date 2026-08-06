#!/usr/bin/env node
/**
 * David Webb — Shopify dealer importer (source adapter)
 * -------------------------------------------------------
 * Many estate/secondary-market jewelers run on Shopify, which exposes the
 * full active catalog as free structured JSON at `/products.json` (no API
 * key, no auth) — same idea as the Rago importer, but for dealer inventory
 * rather than auction results.
 *
 * Proven pattern (see HANDOFF.md §7.3): Yafa Signed Jewels —
 *   https://yafasignedjewels.com/products.json?limit=250
 * returns structured products; filtering vendor/title/tags for "David Webb"
 * yields ~22 priced pieces.
 *
 * These are FOR-SALE listings, not past auction hammers, so they upsert into
 * the dealer layer (dealer-store.js: output/david-webb-dealer-listings.*),
 * kept separate from both the auction-history store and the weekly-scan
 * library.
 *
 * Exposes `collect(map, opts)` for a single shop and `collectAll(map, opts)`
 * for every registered dealer, for the orchestrator (import-dealers.js).
 * Also runnable standalone:
 *   node import-shopify.js                          # all registered dealers
 *   node import-shopify.js yafasignedjewels.com Yafa # one shop
 */

const store = require("./dealer-store");

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Estate jewelers / dealers known (or likely, per HANDOFF §7.3 OPTIONAL_QUERIES)
// to run on Shopify. Add more here as they're confirmed — probing a new
// domain is just `curl https://<domain>/products.json?limit=1`.
const DEALERS = [
  { shop: "yafasignedjewels.com", dealer: "Yafa Signed Jewels", currency: "USD" },
];

const PAGE_LIMIT = 250;
const MAX_PAGES = 40; // safety cap (40 * 250 = 10,000 products)

function decodeEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripHtml(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function isDavidWebb(product) {
  const haystack = [product.vendor, product.title, product.product_type, product.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /david\s*webb/.test(haystack);
}

function inferCategory(text) {
  const n = (text || "").toLowerCase();
  if (/bracelet|bangle|cuff/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  return "other";
}

function inferEra(text) {
  const m = String(text || "").match(/\b(circa\s*)?(19\d0s|19\d{2}|20\d{2})\b/i);
  return m ? m[0].trim() : "";
}

function minVariantPrice(variants) {
  const prices = (variants || [])
    .map((v) => Number(v.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min(...prices) : "";
}

function mapProduct(p, { shop, dealer, currency }) {
  const combinedText = [p.title, p.product_type, p.tags, p.body_html].filter(Boolean).join(" ");
  const bodyText = stripHtml(p.body_html);
  const variant = (p.variants || [])[0] || {};
  return {
    piece_name: p.title || "",
    category: inferCategory(combinedText),
    era_or_year: inferEra(combinedText),
    materials_gemstones: "",
    price_type: "asking",
    asking_price: minVariantPrice(p.variants),
    currency_note: currency || "",
    dealer,
    listing_url: p.handle ? `https://${shop}/products/${p.handle}` : "",
    sku: variant.sku || (p.id != null ? String(p.id) : ""),
    notes: bodyText ? bodyText.slice(0, 300) : "",
  };
}

async function fetchPage(shop, page) {
  const url = `https://${shop}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Shopify ${res.status} for ${url}`);
  const data = await res.json();
  return Array.isArray(data.products) ? data.products : [];
}

// Collect one Shopify dealer's David Webb products into the shared store `map`.
// Returns { seen, matched, added } counts.
async function collect(map, { shop, dealer, currency, today } = {}) {
  if (!shop || !dealer) throw new Error("import-shopify collect() requires { shop, dealer }");
  let seen = 0;
  let matched = 0;
  let added = 0;
  const seenIds = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const products = await fetchPage(shop, page);
    if (products.length === 0) break;
    seen += products.length;
    for (const p of products) {
      if (!isDavidWebb(p)) continue;
      matched++;
      const record = mapProduct(p, { shop, dealer, currency });
      const key = store.recordKey(record);
      seenIds.add(key);
      const isNew = store.upsert(map, record, { source: `shopify:${shop}`, today });
      if (isNew) added++;
    }
    if (products.length < PAGE_LIMIT) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  store.markMissingInactive(map, seenIds, today || new Date().toISOString().slice(0, 10));
  return { seen, matched, added };
}

// Run every registered dealer. Returns per-dealer results.
async function collectAll(map, { today } = {}) {
  const results = [];
  for (const d of DEALERS) {
    try {
      const r = await collect(map, { ...d, today });
      results.push({ ...d, ...r });
    } catch (err) {
      results.push({ ...d, error: err.message });
    }
  }
  return results;
}

async function main() {
  const shopArg = process.argv[2];
  const dealerArg = process.argv[3];
  const map = store.loadStore();
  const before = map.size;

  let results;
  if (shopArg) {
    const known = DEALERS.find((d) => d.shop === shopArg);
    const dealer = dealerArg || (known && known.dealer) || shopArg;
    const currency = known && known.currency;
    console.log(`Shopify importer — ${dealer} (${shopArg})`);
    const r = await collect(map, { shop: shopArg, dealer, currency });
    results = [{ shop: shopArg, dealer, ...r }];
  } else {
    console.log(`Shopify importer — ${DEALERS.length} registered dealer(s)`);
    results = await collectAll(map);
  }

  const total = store.writeStore(map);
  console.log("\nResults:");
  for (const r of results) {
    if (r.error) console.log(`  ${r.dealer.padEnd(24)} ERROR: ${r.error}`);
    else console.log(`  ${r.dealer.padEnd(24)} ${r.seen} products scanned, ${r.matched} David Webb, ${r.added} new`);
  }
  console.log(`\n${map.size - before} new record(s); ${total} total dealer listing(s).`);
  console.log(`JSON: ${store.LISTINGS_JSON}`);
  console.log(`CSV:  ${store.LISTINGS_CSV}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, collectAll, DEALERS };
