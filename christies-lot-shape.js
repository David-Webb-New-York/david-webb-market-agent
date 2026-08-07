#!/usr/bin/env node
/**
 * One-off debug script: dump the FULL, untruncated field shape of one real
 * Christie's sold-lot record, so import-christies.js's mapItem() maps real
 * fields instead of guessing. Prior probes only ever printed truncated
 * previews (1000b console limit) or hit blocked artifact downloads, so the
 * complete key set was never actually seen.
 *
 * Confirmed working pattern (no UI interaction needed -- a fresh page load
 * with the real tab key fires the real request): navigate directly to
 * https://www.christies.com/en/search?entry=<term>&page=1&sortby=relevance&tab=sold_lots
 */
const bb = require("./browserbase");

async function main() {
  const term = process.argv[2] || "david webb";
  const page = process.argv[3] || "1";
  const url = `https://www.christies.com/en/search?entry=${encodeURIComponent(term)}&page=${page}&sortby=relevance&tab=sold_lots`;

  const { jsonResponses } = await bb.renderAndExtract(url, { waitMs: 10000, captureJson: true });

  const searchClient = jsonResponses.find((r) => r.url.includes("apim.christies.com/search-client") && r.url.includes("is_past_lots=True"));
  if (!searchClient) {
    console.log("No is_past_lots=True search-client response captured. All apim.christies.com responses:");
    for (const r of jsonResponses.filter((r) => r.url.includes("apim.christies.com"))) {
      console.log(`  ${r.method} ${r.bytes}b ${r.url}`);
    }
    process.exit(1);
  }

  const data = JSON.parse(searchClient.body);
  console.log(`total_pages: ${data.total_pages}, lots on this page: ${(data.lots || []).length}`);
  console.log("\nFull first lot object (all fields):");
  console.log(JSON.stringify(data.lots[0], null, 2));
  if (data.lots[1]) {
    console.log("\nFull second lot object (to compare field presence across records):");
    console.log(JSON.stringify(data.lots[1], null, 2));
  }
  console.log("\nfilters object:");
  console.log(JSON.stringify(data.filters, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
