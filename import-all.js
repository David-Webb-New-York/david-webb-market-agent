#!/usr/bin/env node
/**
 * David Webb — historical auction "search everything"
 * ----------------------------------------------------
 * Runs every available data source into the single shared, deduplicated
 * auction-history dataset (output/david-webb-auction-history.{json,csv}).
 *
 * Sources fall into two buckets (see SOURCES below), based on the same
 * investigation performed for Rago:
 *   - "structured": the site serves its full result set as embeddable data, so
 *     we import it directly, completely, and for free (no API key). Rago today.
 *   - "web-search-only": the site loads results via client-side APIs and/or
 *     blocks automated requests (Cloudflare / SPA / auth). These cannot be
 *     imported like Rago; they are covered (broadly, not exhaustively) by the
 *     LLM web-search sweep (backfill.js), included with --with-llm.
 *
 * Usage:
 *   node import-all.js               # structured sources only (free)
 *   node import-all.js --with-llm    # also run the LLM web-search sweep (costs ~$3-6, needs ANTHROPIC_API_KEY)
 */

const store = require("./history-store");
const rago = require("./import-rago");
const backfill = require("./backfill");

// Per-source status from direct investigation of each site's search page.
const SOURCES = [
  { name: "Rago", method: "structured (Inertia data-page JSON)", status: "structured", collect: rago.collect },
  { name: "LiveAuctioneers", method: "JSON API behind auth/anti-bot (957-byte stub on GET)", status: "web-search-only" },
  { name: "Invaluable", method: "Algolia-loaded results (no data in shell)", status: "web-search-only" },
  { name: "Barnebys", method: "Next.js app, results via API", status: "web-search-only" },
  { name: "Sotheby's", method: "SPA + API, GET redirects to JS app", status: "web-search-only" },
  { name: "Christie's", method: "api.christies.com (key-gated)", status: "web-search-only" },
  { name: "Phillips", method: "SPA shell, results via JS", status: "web-search-only" },
  { name: "Bonhams", method: "Cloudflare 403 (bot-blocked)", status: "web-search-only" },
  { name: "Doyle", method: "SPA shell, results via JS", status: "web-search-only" },
  { name: "Heritage (ha.com)", method: "403 (bot-blocked)", status: "web-search-only" },
  { name: "Freeman's / Hindman", method: "Nuxt app, results via API", status: "web-search-only" },
];

async function main() {
  const withLlm = process.argv.includes("--with-llm") || /^(1|true|yes)$/i.test(process.env.WITH_LLM || "");
  const today = new Date().toISOString().slice(0, 10);
  const map = store.loadStore();
  const before = map.size;
  const summary = [];

  console.log("David Webb — importing all available auction-history sources\n");

  // 1) Structured, complete importers.
  for (const src of SOURCES.filter((s) => s.status === "structured")) {
    try {
      const n = await src.collect(map, { today });
      summary.push([src.name, "structured", `${n} lots`]);
    } catch (err) {
      summary.push([src.name, "structured", `ERROR: ${err.message}`]);
    }
  }

  // 2) Broad LLM web-search sweep for the sites we cannot import directly.
  if (withLlm) {
    try {
      const { added } = await backfill.collect(map, { today });
      summary.push(["LLM web-search sweep", "web-search", `${added} new lots`]);
    } catch (err) {
      summary.push(["LLM web-search sweep", "web-search", `skipped: ${err.message}`]);
    }
  } else {
    summary.push(["LLM web-search sweep", "web-search", "skipped (pass --with-llm to include)"]);
  }

  const total = store.writeStore(map);

  console.log("\nSource run summary:");
  for (const [name, kind, result] of summary) console.log(`  ${name.padEnd(22)} ${kind.padEnd(14)} ${result}`);
  console.log(`\nSources still web-search-only (need an API/headless adapter for full coverage):`);
  console.log(
    "  " + SOURCES.filter((s) => s.status === "web-search-only").map((s) => s.name).join(", ")
  );
  console.log(`\nTotal historical records: ${total} (${map.size - before} new this run).`);
  console.log(`JSON: ${store.HISTORY_JSON}`);
  console.log(`CSV:  ${store.HISTORY_CSV}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
