#!/usr/bin/env node
/**
 * David Webb — historical auction "search everything"
 * ----------------------------------------------------
 * Runs every available data source into the single shared, deduplicated
 * auction-history dataset (output/david-webb-auction-history.{json,csv}).
 *
 * Sources fall into three buckets (see SOURCES below), based on the same
 * investigation performed for Rago:
 *   - "structured": the site serves its full result set as embeddable data, so
 *     we import it directly, completely, and for free (no API key). Rago today.
 *   - "browserbase": the site blocks plain HTTP (bot protection) or only
 *     renders results client-side, but a rendered-HTML extraction gets the
 *     real data reliably. Costs a Browserbase session per run, so this bucket
 *     only runs with --with-browserbase. LiveAuctioneers today.
 *   - "web-search-only": no deterministic adapter yet (Cloudflare / SPA / auth
 *     not yet cracked). Covered (broadly, not exhaustively) by the LLM
 *     web-search sweep (backfill.js), included with --with-llm.
 *
 * Usage:
 *   node import-all.js                    # structured sources only (free)
 *   node import-all.js --with-browserbase # also run Browserbase-backed sources (costs a Browserbase session)
 *   node import-all.js --with-llm         # also run the LLM web-search sweep (costs ~$3-6, needs ANTHROPIC_API_KEY)
 */

const store = require("./history-store");
const rago = require("./import-rago");
const liveauctioneers = require("./import-liveauctioneers");
const invaluable = require("./import-invaluable");
const bonhams = require("./import-bonhams");
const backfill = require("./backfill");

// Per-source status from direct investigation of each site's search page.
const SOURCES = [
  { name: "Rago", method: "structured (Inertia data-page JSON)", status: "structured", collect: rago.collect },
  {
    name: "Invaluable",
    method: "structured (Algolia catResults POST replayed with plain fetch, no Browserbase needed)",
    status: "structured",
    collect: invaluable.collect,
  },
  {
    name: "LiveAuctioneers",
    method: "Incapsula-protected; window.__data extracted from Browserbase-rendered HTML",
    status: "browserbase",
    collect: liveauctioneers.collect,
  },
  {
    name: "Bonhams",
    method: "Typesense search-proxy behind an auth-gated nginx (401 on plain replay); captured from a Browserbase-rendered session instead",
    status: "browserbase",
    collect: bonhams.collect,
  },
  { name: "Barnebys", method: "Next.js app, results via API", status: "web-search-only" },
  { name: "Sotheby's", method: "SPA + API, GET redirects to JS app", status: "web-search-only" },
  { name: "Christie's", method: "api.christies.com (key-gated)", status: "web-search-only" },
  { name: "Phillips", method: "SPA shell, results via JS", status: "web-search-only" },
  { name: "Doyle", method: "SPA shell, results via JS", status: "web-search-only" },
  { name: "Heritage (ha.com)", method: "403 (bot-blocked)", status: "web-search-only" },
  { name: "Freeman's / Hindman", method: "Nuxt app, results via API", status: "web-search-only" },
];

async function main() {
  const withBrowserbase =
    process.argv.includes("--with-browserbase") || /^(1|true|yes)$/i.test(process.env.WITH_BROWSERBASE || "");
  const withLlm = process.argv.includes("--with-llm") || /^(1|true|yes)$/i.test(process.env.WITH_LLM || "");
  const today = new Date().toISOString().slice(0, 10);
  const map = store.loadStore();
  const before = map.size;
  const summary = [];

  console.log("David Webb — importing all available auction-history sources\n");

  // 1) Structured, complete importers (free, no API key/session cost).
  for (const src of SOURCES.filter((s) => s.status === "structured")) {
    try {
      const n = await src.collect(map, { today });
      summary.push([src.name, "structured", `${n} lots`]);
    } catch (err) {
      summary.push([src.name, "structured", `ERROR: ${err.message}`]);
    }
  }

  // 1b) Browserbase-backed importers (real, but cost a session per run).
  if (withBrowserbase) {
    for (const src of SOURCES.filter((s) => s.status === "browserbase")) {
      try {
        const r = await src.collect(map, { today });
        const detail = typeof r === "number" ? `${r} lots` : `${r.processed} lots (${r.pages} pages${r.truncated ? ", TRUNCATED" : ""})`;
        summary.push([src.name, "browserbase", detail]);
      } catch (err) {
        summary.push([src.name, "browserbase", `ERROR: ${err.message}`]);
      }
    }
  } else {
    for (const src of SOURCES.filter((s) => s.status === "browserbase")) {
      summary.push([src.name, "browserbase", "skipped (pass --with-browserbase to include)"]);
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
