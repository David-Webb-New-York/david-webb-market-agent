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
const sothebys = require("./import-sothebys");
const christies = require("./import-christies");
const phillips = require("./import-phillips");
const doyle = require("./import-doyle");
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
  {
    name: "Sotheby's",
    method: "structured (Algolia search API, plain fetch with a public search-only key extracted from the site's own embedded config)",
    status: "structured",
    collect: sothebys.collect,
  },
  {
    name: "Barnebys",
    method:
      "real search UI found (button[aria-label='Search'][aria-controls='mobile-search-panel'] reveals a bare unlabeled <input>, confirmed via interactive probing) but the input reliably fails Playwright's own actionability check (\"Element is outside of the viewport\") even after a mobile-width viewport + longer settle wait -- 3 attempts, a near-miss, not pursued further per project policy against indefinite guessing.",
    status: "web-search-only",
  },
  {
    name: "Christie's",
    method:
      "search-client always 404s cold (even with real headers -- a browser-only WAF/fingerprint signal, not a missing header); a fresh Browserbase page load direct to the real tab=sold_lots URL DOES trigger it though. ~2015 total matches at 20/page (~101 pages) -- weekly run caps to CHRISTIES_MAX_PAGES (default 10, sortby=relevance so not date-ordered -- can miss low-relevance new lots, a real accepted limitation); run with a large maxPages once for an exhaustive baseline.",
    status: "browserbase",
    collect: christies.collect,
  },
  {
    name: "Phillips",
    method:
      "structured (server-rendered search-results HTML, confirmed reachable via a plain cold fetch -- no Browserbase needed; site was previously down for maintenance across 3 probes, since recovered). Real listing-card markup parsed directly (maker/title/sale name/sale date/listing URL); no price/estimate is shown on the results page itself, so those fields are left blank rather than guessed -- would need a per-lot detail-page fetch to add.",
    status: "structured",
    collect: phillips.collect,
  },
  {
    name: "Doyle",
    method:
      "structured (server-rendered search-results HTML, confirmed reachable via a plain cold fetch -- no Browserbase needed). The real search URL (/auction/search/?st=...) was only found via interactive UI probing (type + Enter; a guessed URL param never triggered it), but once known, cold-fetching it directly works. Real listing-card markup parsed directly, INCLUDING real sold/estimate prices shown right on the results page (unlike Phillips) -- no per-lot detail-page fetch needed for price data. No sale name/date appears in the card markup though, so those are left blank.",
    status: "structured",
    collect: doyle.collect,
  },
  {
    name: "Heritage (ha.com)",
    method:
      "DataDome device-check challenge (geo.captcha-delivery.com iframe), survives Browserbase proxies; browserSettings.advancedStealth also 403s (\"Verified mode is only available on the Enterprise plan\" -- confirmed advancedStealth itself is Enterprise-gated on this account, not just the separate `verified` flag, since a retry with `verified` fully removed from the request payload got the identical 403). No remaining Browserbase lever without a plan upgrade.",
    status: "web-search-only",
  },
  {
    name: "Freeman's / Hindman",
    method:
      "real page renders for guessed query params but search never fires (2 attempts). A follow-up interactive-UI attempt hit a persistent net::ERR_TUNNEL_CONNECTION_FAILED at the Browserbase proxy layer, unchanged with proxies disabled too (3 attempts total) -- while sibling probes to other hosts succeeded through the same infrastructure in the same window, pointing at something host-specific (edge/WAF blocking Browserbase's egress, or a routing issue) rather than a general outage. Not resolved.",
    status: "web-search-only",
  },
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
      const r = await src.collect(map, { today });
      const detail = typeof r === "number" ? `${r} lots` : `${r.processed} lots (${r.pages} pages${r.truncated ? ", TRUNCATED" : ""})`;
      summary.push([src.name, "structured", detail]);
    } catch (err) {
      summary.push([src.name, "structured", `ERROR: ${err.message}`]);
    }
  }

  // 1b) Browserbase-backed importers (real, but cost a session per run).
  // Christie's alone takes a maxPages override -- its ~101-page result set
  // is too large to page through every routine run (see SOURCES above), so
  // a normal weekly run caps it while a one-time baseline backfill can pass
  // a much larger value.
  const christiesMaxPagesArg = process.argv.find((a) => a.startsWith("--christies-max-pages="));
  const christiesMaxPages = christiesMaxPagesArg
    ? parseInt(christiesMaxPagesArg.split("=")[1], 10)
    : process.env.CHRISTIES_MAX_PAGES
    ? parseInt(process.env.CHRISTIES_MAX_PAGES, 10)
    : 10;
  if (withBrowserbase) {
    for (const src of SOURCES.filter((s) => s.status === "browserbase")) {
      try {
        const opts = src.name === "Christie's" ? { today, maxPages: christiesMaxPages } : { today };
        const r = await src.collect(map, opts);
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
