#!/usr/bin/env node
/**
 * David Webb — Christie's importer (source adapter)
 * -------------------------------------------------
 * Christie's search is a client-rendered SPA behind apim.christies.com (an
 * Azure API Management gateway). Confirmed via live investigation (see
 * HANDOFF.md), not guessed:
 *   - A cold plain fetch() of the search API always 404s, even with the
 *     exact real headers/params a live browser sends -- some browser-only
 *     signal (WAF/TLS fingerprint, not a missing header) gates it, so this
 *     needs a real Browserbase session, like Bonhams.
 *   - The site's search box only fires via real client-side JS (a URL query
 *     param like ?q= never triggers it) -- BUT once the correct URL scheme
 *     is known, a FRESH page load with the right params DOES trigger the
 *     real request. The earlier "direct URL nav doesn't work" finding was
 *     an artifact of guessing the wrong tab key (`tab=past_lots`, which
 *     isn't real); the real tab keys are `available_lots`/`sold_lots`/
 *     `articles`, and navigating straight to `tab=sold_lots` on a fresh
 *     load works with no clicking needed.
 *   - Confirmed real request/response shape via
 *     apim.christies.com/search-client?keyword=<term>&page=<N>&is_past_lots=True&sortby=relevance&language=en&geocountrycode=US&show_on_loan=true&datasourceId=182f8bb2-d729-4a38-b539-7cf1a901cf2e
 *     -> `{"lots":[...], "filters":{...}, "total_pages": N}`, 20 lots/page.
 *     Real full field shape of a lot record (27 keys, confirmed via
 *     christies-lot-shape.js, not guessed): object_id, lot_id_txt,
 *     analytics_id, event_type, start_date, end_date, url, is_auction_over,
 *     is_in_progress, title_primary_txt, title_secondary_txt,
 *     title_tertiary_txt, consigner_information, description_txt, image{},
 *     estimate_visible, estimate_on_request, lot_estimate_txt,
 *     price_on_request, estimate_txt ("USD 3,000,000 - 5,000,000"),
 *     lot_withdrawn, price_realised_txt ("USD 7,698,500"), current_bid,
 *     current_bid_txt, is_saved, show_save, sale{id, number, location, type}.
 *
 * A "david webb" keyword search returns ~2015 total matches at 20/page
 * (~101 pages) -- too many to page through every weekly run (each page is
 * its own Browserbase session, like LiveAuctioneers). `sortby=relevance`
 * isn't date-ordered, so a small weekly maxPages can miss newly-added sold
 * lots that don't rank near the top -- a real, accepted limitation (same
 * shape as Sotheby's Algolia 1000-result cap). Run once with a large
 * maxPages for the exhaustive baseline, then a small maxPages weekly.
 *
 * Exposes `collect(map, opts)` for the orchestrator (import-all.js); also
 * runnable standalone: node import-christies.js ["david webb"] [maxPages]
 */

const store = require("./history-store");
const bb = require("./browserbase");

const SOURCE = "christies-site";
const BASE = "https://www.christies.com";

const searchUrl = (term, page) =>
  `${BASE}/en/search?entry=${encodeURIComponent(term)}&page=${page}&sortby=relevance&tab=sold_lots`;

function inferCategory(text) {
  const n = (text || "").toLowerCase();
  if (/bracelet|bangle|cuff/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  if (/cufflink/.test(n)) return "cufflinks";
  return "other";
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'");
}

function stripHtml(html) {
  return decodeEntities(String(html || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "USD 7,698,500" -> { currency: "USD", amount: 7698500 }
function parseCurrencyAmount(s) {
  const m = String(s || "").trim().match(/^([A-Z]{3})\s+([\d,]+(?:\.\d+)?)$/);
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ""));
  return Number.isFinite(amount) ? { currency: m[1], amount } : null;
}

// "USD 3,000,000 - 5,000,000" -> { currency: "USD", low: 3000000, high: 5000000 }
function parseEstimateRange(s) {
  const m = String(s || "").trim().match(/^([A-Z]{3})\s+([\d,]+)\s*-\s*([\d,]+)$/);
  if (!m) return null;
  const low = Number(m[2].replace(/,/g, ""));
  const high = Number(m[3].replace(/,/g, ""));
  return Number.isFinite(low) && Number.isFinite(high) ? { currency: m[1], low, high } : null;
}

function mapLot(lot) {
  const title = lot.title_primary_txt || "";
  const realised = parseCurrencyAmount(lot.price_realised_txt);
  const estimate = parseEstimateRange(lot.estimate_txt);
  const sale = lot.sale || {};
  const notesParts = [];
  const desc = stripHtml(lot.description_txt);
  if (desc) notesParts.push(desc);
  if (lot.consigner_information && lot.consigner_information.trim() && lot.consigner_information.trim() !== desc) {
    notesParts.push(stripHtml(lot.consigner_information));
  }
  if (lot.lot_withdrawn) notesParts.push("Lot withdrawn from sale");

  return {
    piece_name: title,
    category: inferCategory(title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: realised ? "hammer" : estimate ? "estimate" : "",
    sold_price: realised ? realised.amount : "",
    estimate_low: estimate ? estimate.low : "",
    estimate_high: estimate ? estimate.high : "",
    currency_note: (realised && realised.currency) || (estimate && estimate.currency) || "",
    sale_date: lot.start_date ? String(lot.start_date).slice(0, 10) : "",
    auction_house: "Christie's",
    sale_name: sale.number ? `Sale ${sale.number}${sale.location ? ` (${sale.location})` : ""}` : "",
    lot_number: lot.lot_id_txt || "",
    listing_url: lot.url || "",
    notes: notesParts.join(" — ").slice(0, 1500),
  };
}

// Fetch one search-results page via a fresh Browserbase session (each page
// is its own session, like LiveAuctioneers -- confirmed real via probe:
// page 2 returns genuinely different lots than page 1, not a repeat).
// Returns { lots, totalPages }.
async function fetchPage(term, page) {
  if (!bb.hasCreds()) {
    throw new Error("Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (add them as secrets).");
  }
  const { jsonResponses } = await bb.renderAndExtract(searchUrl(term, page), { waitMs: 10000, captureJson: true });
  const r = jsonResponses.find(
    (r) => r.url.includes("apim.christies.com/search-client") && r.url.includes("is_past_lots=True")
  );
  if (!r) throw new Error("search-client (is_past_lots=True) response not captured");
  const data = JSON.parse(r.body);
  return { lots: Array.isArray(data.lots) ? data.lots : [], totalPages: Number(data.total_pages) || 0 };
}

// Collect Christie's sold lots into the shared store `map`, paging through
// the real total_pages field the API itself reports (unlike LiveAuctioneers,
// no heuristic needed) -- capped at maxPages since a "david webb" keyword
// search runs ~101 pages total, too many for a routine weekly run.
async function collect(map, { term = "david webb", today, maxPages = 10 } = {}) {
  let processed = 0;
  let pagesFetched = 0;
  let totalPages = 1;

  for (let page = 1; page <= Math.min(maxPages, totalPages); page++) {
    let result;
    try {
      result = await fetchPage(term, page);
    } catch (err) {
      console.error(`  page ${page}: ${err.message}`);
      break;
    }
    pagesFetched++;
    if (page === 1) totalPages = result.totalPages || 1;
    if (!result.lots.length) break;
    for (const lot of result.lots) {
      store.upsert(map, mapLot(lot), { source: SOURCE, today });
      processed++;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const truncated = totalPages > maxPages;
  return { processed, pages: pagesFetched, totalPages, truncated };
}

async function main() {
  const term = (process.argv[2] || "david webb").trim();
  const maxPages = process.argv[3] ? parseInt(process.argv[3], 10) : 10;
  console.log(`Christie's importer — term "${term}", maxPages=${maxPages}`);
  const map = store.loadStore();
  const before = map.size;
  const { processed, pages, totalPages, truncated } = await collect(map, { term, maxPages });
  const total = store.writeStore(map);
  console.log(
    `Done. ${processed} Christie's lot(s) across ${pages} page(s) of ${totalPages} total${
      truncated ? " [TRUNCATED at maxPages -- raise it for an exhaustive backfill]" : ""
    }; ${map.size - before} new; ${total} total records.`
  );
  console.log(`JSON: ${store.HISTORY_JSON}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, mapLot, SOURCE };
