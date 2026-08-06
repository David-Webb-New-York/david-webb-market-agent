#!/usr/bin/env node
/**
 * David Webb — dealer layer "import everything"
 * ------------------------------------------------
 * Runs every registered structured dealer adapter (Shopify, WooCommerce, ...)
 * into the single shared, deduplicated dealer-listings dataset
 * (output/david-webb-dealer-listings.{json,csv}). Sibling to import-all.js
 * (which does the same thing for auction-history sources).
 *
 * Usage: node import-dealers.js
 */

const store = require("./dealer-store");
const shopify = require("./import-shopify");
const woocommerce = require("./import-woocommerce");

const ADAPTERS = [
  { name: "Shopify", platform: shopify },
  { name: "WooCommerce", platform: woocommerce },
];

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const map = store.loadStore();
  const before = map.size;

  console.log("David Webb — importing all registered dealer sources\n");

  for (const { name, platform } of ADAPTERS) {
    console.log(`-- ${name} (${platform.DEALERS.length} dealer(s)) --`);
    const results = await platform.collectAll(map, { today });
    for (const r of results) {
      if (r.error) console.log(`  ${r.dealer.padEnd(28)} ERROR: ${r.error}`);
      else console.log(`  ${r.dealer.padEnd(28)} ${r.seen} scanned, ${r.matched} David Webb, ${r.added} new`);
    }
    console.log();
  }

  const total = store.writeStore(map);
  console.log(`Total dealer listings: ${total} (${map.size - before} new this run).`);
  console.log(`JSON: ${store.LISTINGS_JSON}`);
  console.log(`CSV:  ${store.LISTINGS_CSV}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
