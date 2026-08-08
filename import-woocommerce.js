#!/usr/bin/env node
/**
 * David Webb — WooCommerce dealer importer (source adapter)
 * -------------------------------------------------------
 * Sibling to import-shopify.js: some estate/secondary-market jewelers run
 * WordPress + WooCommerce, which exposes its public Store API (used by the
 * block-based cart/checkout) as free, unauthenticated JSON at
 * `/wp-json/wc/store/products` — same idea as Shopify's /products.json.
 *
 * Confirmed via scan-dealer-domains.js: fredleighton.com, estatediamondjewelry.com.
 *
 * These are FOR-SALE listings, so — like the Shopify adapter — they upsert
 * into the dealer layer (dealer-store.js: output/david-webb-dealer-listings.*).
 *
 * Exposes `collect(map, opts)` for one shop and `collectAll(map, opts)` for
 * every registered dealer, for the orchestrator (import-dealers.js). Also
 * runnable standalone:
 *   node import-woocommerce.js                          # all registered dealers
 *   node import-woocommerce.js fredleighton.com "Fred Leighton"
 */

const store = require("./dealer-store");

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DEALERS = [
  { shop: "fredleighton.com", dealer: "Fred Leighton" },
  { shop: "estatediamondjewelry.com", dealer: "Estate Diamond Jewelry" },
];

const PER_PAGE = 100; // WooCommerce Store API caps per_page at 100
const MAX_PAGES = 40; // safety cap (40 * 100 = 4,000 products)

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
  const categories = (product.categories || []).map((c) => c.name).join(" ");
  const tags = (product.tags || []).map((t) => t.name).join(" ");
  const haystack = [product.name, categories, tags, product.short_description, product.description]
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

function priceFromMinorUnit(prices) {
  if (!prices) return "";
  const raw = Number(prices.price);
  if (!Number.isFinite(raw) || raw <= 0) return "";
  const minorUnit = Number.isFinite(Number(prices.currency_minor_unit)) ? Number(prices.currency_minor_unit) : 2;
  return raw / 10 ** minorUnit;
}

function primaryImage(p) {
  if (Array.isArray(p.images) && p.images[0]) {
    return p.images[0].src || p.images[0].thumbnail || "";
  }
  return "";
}

function mapProduct(p, { shop, dealer }) {
  const categories = (p.categories || []).map((c) => c.name).join(" ");
  const combinedText = [p.name, categories, p.short_description, p.description].filter(Boolean).join(" ");
  const bodyText = stripHtml(p.short_description || p.description);
  return {
    piece_name: decodeEntities(p.name || ""),
    category: inferCategory(combinedText),
    era_or_year: inferEra(combinedText),
    materials_gemstones: "",
    price_type: "asking",
    asking_price: priceFromMinorUnit(p.prices),
    currency_note: (p.prices && p.prices.currency_code) || "",
    dealer,
    listing_url: p.permalink || "",
    image_url: primaryImage(p),
    sku: p.sku || (p.id != null ? String(p.id) : ""),
    notes: bodyText ? bodyText.slice(0, 300) : "",
  };
}

async function fetchPage(shop, page) {
  const url = `https://${shop}/wp-json/wc/store/products?per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`WooCommerce ${res.status} for ${url}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Collect one WooCommerce dealer's David Webb products into the shared store `map`.
// Returns { seen, matched, added } counts.
async function collect(map, { shop, dealer, today } = {}) {
  if (!shop || !dealer) throw new Error("import-woocommerce collect() requires { shop, dealer }");
  let seen = 0;
  let matched = 0;
  let added = 0;
  let truncated = false;
  let lastFirstId = null;
  const seenIds = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const products = await fetchPage(shop, page);
    if (products.length === 0) break;
    const firstId = products[0] && products[0].id;
    if (firstId != null && firstId === lastFirstId) {
      truncated = true;
      break;
    }
    lastFirstId = firstId;
    seen += products.length;
    for (const p of products) {
      if (!isDavidWebb(p)) continue;
      matched++;
      const record = mapProduct(p, { shop, dealer });
      const key = store.recordKey(record);
      seenIds.add(key);
      const isNew = store.upsert(map, record, { source: `woocommerce:${shop}`, today });
      if (isNew) added++;
    }
    if (products.length < PER_PAGE) break;
    if (page === MAX_PAGES) truncated = true;
    await new Promise((r) => setTimeout(r, 300));
  }

  store.markMissingInactive(map, seenIds, today || new Date().toISOString().slice(0, 10));
  return { seen, matched, added, truncated };
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
    console.log(`WooCommerce importer — ${dealer} (${shopArg})`);
    const r = await collect(map, { shop: shopArg, dealer });
    results = [{ shop: shopArg, dealer, ...r }];
  } else {
    console.log(`WooCommerce importer — ${DEALERS.length} registered dealer(s)`);
    results = await collectAll(map);
  }

  const total = store.writeStore(map);
  console.log("\nResults:");
  for (const r of results) {
    if (r.error) console.log(`  ${r.dealer.padEnd(24)} ERROR: ${r.error}`);
    else
      console.log(
        `  ${r.dealer.padEnd(24)} ${r.seen} products scanned, ${r.matched} David Webb, ${r.added} new${
          r.truncated ? "  [TRUNCATED]" : ""
        }`
      );
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
