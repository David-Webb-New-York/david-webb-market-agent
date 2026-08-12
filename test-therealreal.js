#!/usr/bin/env node
/**
 * Standalone re-verification driver for import-therealreal.js -- calls
 * collect() against a throwaway in-memory Map (never touches output/
 * files) so this importer can be re-run cheaply and repeatedly to check
 * for run-to-run reliability, matching the test-sothebys-buynow.js
 * precedent. No Browserbase/Steel/proxy secrets needed -- this importer
 * is a plain fetch() to https://r.jina.ai, nothing else.
 */
const { collect } = require("./import-therealreal");

async function main() {
  const map = new Map();
  const result = await collect(map, { today: new Date().toISOString().slice(0, 10) });
  console.log("collect() result:", JSON.stringify(result));
  console.log(`\n${map.size} record(s) in the throwaway map. Sample:`);
  let i = 0;
  for (const [key, rec] of map) {
    if (i++ >= 10) break;
    console.log(` - ${key} | ${rec.piece_name} | $${rec.asking_price} | img=${rec.image_url ? "yes" : "no"} | ${rec.notes}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
