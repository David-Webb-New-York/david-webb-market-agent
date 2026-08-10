#!/usr/bin/env node
/**
 * Standalone re-verification driver for import-sothebys-buynow.js --
 * calls collect() against a throwaway in-memory Map (never touches
 * output/ files) so it can be re-run cheaply and repeatedly via
 * upcoming-auctions-debug.yml to check for run-to-run flakiness, without
 * needing a full dealer-refresh.yml dry-run each time.
 */
const { collect } = require("./import-sothebys-buynow");

async function main() {
  const map = new Map();
  const result = await collect(map, { today: new Date().toISOString().slice(0, 10) });
  console.log("collect() result:", JSON.stringify(result));
  console.log(`\n${map.size} record(s) in the throwaway map:`);
  for (const [key, rec] of map) {
    console.log(` - ${key} | ${rec.piece_name} | $${rec.asking_price}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
