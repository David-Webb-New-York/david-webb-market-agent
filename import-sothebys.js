#!/usr/bin/env node
/**
 * David Webb — Sotheby's importer (source adapter)
 * --------------------------------------------------------
 * Sotheby's search page queries an Algolia index (o28sy4q7wu-dsn.algolia.net,
 * indexName "bsp_dotcom_prod_en") directly from the browser. Confirmed via
 * Browserbase probe (2026-08-07): a query for "david webb" with
 * filters=type:"Lot" returns REAL historical/sold auction-lot data (not just
 * current retail listings) — hammerPrice/salePrice, soldStatus, estimates,
 * sale number, dates.
 *
 * Confirmed this replays successfully with a bare Node fetch() -- no
 * Browserbase/cookies/session required, just the app-id + a public
 * search-only API key extracted from Sotheby's own embedded page config
 * (window config at shared.sothebys.com/syndicate, field names
 * "algoliaApiKey"/"algoliaAppId" — a public, client-embeddable search key by
 * Algolia's own design, not a secret). So this is a free structured adapter
 * like Rago/Invaluable, not a costly Browserbase one.
 *
 * Confirmed real "Lot" hit field shape (quoted from an actual probe
 * response, not guessed): saleNumber, auctionType, promoType:"lot",
 * endDate (unix MILLISECONDS, not seconds), highEstimate, lowEstimate,
 * estimateCurrency, hammerPrice, soldStatus ("SOLD" observed), salePrice,
 * normalizedValue, auctionLocations, geoDivisions, guaranteeLine (a
 * concise all-caps item description used here as piece_name), fullText
 * (long description incl. provenance).
 *
 * KNOWN LIMITATIONS (honest gaps, not guesses): no `lotNumber` field was
 * observed on the one real "Lot" hit inspected (differs from other sources
 * — Sotheby's identifies lots by `saleNumber`, not a separate lot number
 * field, in this index). No confirmed `listing_url` pattern for Lot-type
 * items either (the site's Buy Now items DO have a real `url` field, but
 * that wasn't observed on a Lot-type hit) -- left blank rather than guessed.
 * Algolia's standard search API refuses to page past position 1000
 * (page * hitsPerPage >= 1000 returns nothing further) regardless of the
 * real nbHits -- confirmed in practice: a live run returned exactly 1000
 * lots. If Sotheby's has more than 1000 "david webb" Lot-type records, the
 * remainder isn't reachable through this adapter as written; getting past
 * that would need a different Algolia feature (e.g. a distinct/faceted
 * query strategy to split the result set), not attempted here.
 *
 * Exposes `collect(map, opts)` for the orchestrator (import-all.js); also
 * runnable standalone: node import-sothebys.js ["david webb"]
 */

const store = require("./history-store");

const SOURCE = "sothebys-site";
const ALGOLIA_URL = "https://o28sy4q7wu-dsn.algolia.net/1/indexes/*/queries";
const ALGOLIA_HEADERS = {
  "x-algolia-api-key": "e732e65c70ebf8b51d4e2f922b536496",
  "x-algolia-application-id": "O28SY4Q7WU",
};
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HITS_PER_PAGE = 48;

function inferCategory(name) {
  const n = (name || "").toLowerCase();
  if (/bracelet|bangle|cuff(?!link)/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip|earclip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  if (/cufflink/.test(n)) return "cufflinks";
  return "other";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : "";
}

function dateFromUnixMillis(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString().slice(0, 10);
}

function mapItem(hit) {
  const sold = hit.soldStatus === "SOLD" && (num(hit.hammerPrice) || num(hit.salePrice));
  const title = hit.guaranteeLine || hit.title || "";
  const notes = [];
  if (hit.fullText && hit.fullText !== title) notes.push(String(hit.fullText).trim());
  if (hit.auctionType) notes.push(`Auction type: ${hit.auctionType}`);
  if (Array.isArray(hit.auctionLocations) && hit.auctionLocations.length) notes.push(`Location: ${hit.auctionLocations.join(", ")}`);
  return {
    piece_name: title,
    category: inferCategory(title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: sold ? "hammer" : num(hit.lowEstimate) || num(hit.highEstimate) ? "estimate" : "",
    sold_price: sold ? num(hit.hammerPrice) || num(hit.salePrice) : "",
    estimate_low: num(hit.lowEstimate),
    estimate_high: num(hit.highEstimate),
    currency_note: hit.estimateCurrency || "",
    sale_date: dateFromUnixMillis(hit.endDate),
    auction_house: "Sotheby's",
    sale_name: hit.saleNumber || "",
    lot_number: "",
    listing_url: "",
    notes: notes.join(" — "),
  };
}

function searchBody(term, page) {
  const params = [
    `filters=${encodeURIComponent('type:"Lot"')}`,
    `hitsPerPage=${HITS_PER_PAGE}`,
    `page=${page}`,
    "clickAnalytics=false",
    "userToken=",
  ].join("&");
  return { requests: [{ indexName: "bsp_dotcom_prod_en", query: term, params }] };
}

async function fetchPage(term, page) {
  const res = await fetch(ALGOLIA_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json", ...ALGOLIA_HEADERS },
    body: JSON.stringify(searchBody(term, page)),
  });
  if (!res.ok) throw new Error(`Sotheby's Algolia ${res.status} for page ${page}`);
  const json = await res.json();
  const result = json && json.results && json.results[0];
  if (!result) throw new Error("Unexpected Algolia response shape (no results[0])");
  return result; // { hits, nbHits, page, nbPages, hitsPerPage }
}

// Collect Sotheby's "Lot" (auction, not retail Buy Now) records into the
// shared store `map`. Returns count processed.
async function collect(map, { term = "david webb", today } = {}) {
  let page = 0;
  let processed = 0;
  let nbPages = 1;
  while (page < nbPages) {
    const result = await fetchPage(term, page);
    nbPages = Number(result.nbPages) || 1;
    for (const hit of result.hits || []) {
      store.upsert(map, mapItem(hit), { source: SOURCE, today });
      processed++;
    }
    page++;
    if (page > 50) break; // safety
    await new Promise((r) => setTimeout(r, 300));
  }
  return processed;
}

async function main() {
  const term = (process.argv[2] || "david webb").trim();
  console.log(`Sotheby's importer — term "${term}"`);
  const map = store.loadStore();
  const before = map.size;
  const processed = await collect(map, { term });
  const total = store.writeStore(map);
  console.log(`Done. ${processed} Sotheby's lot(s) processed; ${map.size - before} new; ${total} total records.`);
  console.log(`JSON: ${store.HISTORY_JSON}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, mapItem, SOURCE };
