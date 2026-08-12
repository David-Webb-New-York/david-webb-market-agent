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
const firstdibs = require("./import-1stdibs");
const sothebysBuyNow = require("./import-sothebys-buynow");
const therealreal = require("./import-therealreal");

const ADAPTERS = [
  { name: "Shopify", platform: shopify },
  { name: "WooCommerce", platform: woocommerce },
  { name: "1stDibs", platform: firstdibs },
  { name: "Sotheby's Buy Now", platform: sothebysBuyNow },
  { name: "The RealReal", platform: therealreal },
];

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const map = store.loadStore();
  const before = map.size;

  console.log("David Webb — importing all registered dealer sources\n");

  // Match rate above this is suspicious for a single brand at a multi-brand
  // dealer — print sample matched titles so an implausible count (a false
  // positive in the title/vendor/tag filter) is visible right in the log
  // instead of silently trusted.
  const SUSPICIOUS_MATCH_RATE = 0.15;

  for (const { name, platform } of ADAPTERS) {
    console.log(`-- ${name} (${platform.DEALERS.length} dealer(s)) --`);
    const results = await platform.collectAll(map, { today });
    for (const r of results) {
      if (r.error) {
        console.log(`  ${r.dealer.padEnd(28)} ERROR: ${r.error}`);
        continue;
      }
      console.log(
        `  ${r.dealer.padEnd(28)} ${r.seen} scanned, ${r.matched} David Webb, ${r.added} new${
          r.truncated ? "  [TRUNCATED]" : ""
        }`
      );
      if (r.seen > 0 && r.matched / r.seen > SUSPICIOUS_MATCH_RATE) {
        const sample = [...map.values()]
          .filter((rec) => rec.dealer === r.dealer)
          .slice(0, 8)
          .map((rec) => rec.piece_name);
        console.log(
          `    ^ SUSPICIOUS match rate (${((r.matched / r.seen) * 100).toFixed(1)}%) — sample titles:`
        );
        for (const t of sample) console.log(`      - ${t}`);
      }
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
