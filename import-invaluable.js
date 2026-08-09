#!/usr/bin/env node
/**
 * David Webb — Invaluable importer (source adapter)
 * ----------------------------------------------------
 * Invaluable's search page fires a POST to https://www.invaluable.com/catResults
 * with an Algolia-style multi-index search body (indexName "upcoming_lots_prod")
 * and gets back a standard Algolia response envelope: results[0].{hits[], nbHits,
 * page, nbPages, hitsPerPage}. Confirmed via Browserbase probe (real request
 * captured, method+postData) AND confirmed the exact same POST replays
 * successfully with a bare Node fetch() — no cookies/session/Browserbase
 * required (200 status, real David-Webb-matching hits). So unlike
 * LiveAuctioneers, this is a free structured adapter like Rago.
 *
 * KNOWN LIMITATION: the index name "upcoming_lots_prod" strongly implies (and
 * every observed hit's priceResult was 0, consistent with) this index covering
 * only not-yet-sold/upcoming lots. A single guessed "past_lots_prod" sibling
 * index was tried and got back a 504 Gateway Timeout (CloudFront error page,
 * not a clean "index not found") -- inconclusive, not pursued further rather
 * than keep guessing index names. So today this adapter only covers upcoming
 * listings, not settled historical sale prices.
 *
 * No confirmed listing_url pattern exists yet (no anchor href was captured
 * pointing to an individual lot's detail page in any probe) -- left blank
 * rather than guessed.
 *
 * Exposes `collect(map, opts)` for the orchestrator (import-all.js); also
 * runnable standalone: node import-invaluable.js ["david webb"]
 */

const store = require("./history-store");

const SOURCE = "invaluable-site";
const CATRESULTS_URL = "https://www.invaluable.com/catResults";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HIGHLIGHT_TAG_RE = /<\/?ais-highlight-0000000000>/g;

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

function dateFromUnixSeconds(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function plainDescription(hit) {
  const raw = hit._highlightResult && hit._highlightResult.lotDescription && hit._highlightResult.lotDescription.value;
  if (!raw) return "";
  return decodeEntities(raw.replace(HIGHLIGHT_TAG_RE, "")).trim();
}

// Invaluable's catResults search is a fuzzy full-text match across its whole
// aggregated catalog (hundreds of small/regional houses) -- a query for
// "david webb" reliably surfaces unrelated lots (military gear, banknotes,
// book collections, ...) that just happen to share a word with the query
// somewhere in a long description. Unlike Rago/Phillips/Sotheby's/Christie's/
// Doyle (queried by a structured maker/attribution field, or spot-checked
// clean), there's no such guarantee here, so require the actual phrase
// "david webb" in the title or description before accepting a hit.
function isDavidWebb(hit) {
  const haystack = [decodeEntities(hit.lotTitle || ""), plainDescription(hit)].join(" ");
  return /david\s*webb/i.test(haystack);
}

function mapItem(hit) {
  const sold = num(hit.priceResult);
  const title = decodeEntities(hit.lotTitle);
  const notes = [];
  const desc = plainDescription(hit);
  if (desc && desc !== title) notes.push(desc);
  if (!sold && num(hit.currentBid)) notes.push(`Current bid at capture: $${Number(hit.currentBid).toLocaleString("en-US")}`);
  return {
    piece_name: title,
    category: inferCategory(title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: sold ? "hammer" : num(hit.estimateLow) || num(hit.estimateHigh) ? "estimate" : "",
    sold_price: sold,
    estimate_low: num(hit.estimateLow),
    estimate_high: num(hit.estimateHigh),
    currency_note: hit.currencyCode || "",
    sale_date: dateFromUnixSeconds(hit.dateTimeUTCUnix),
    auction_house: hit.houseName || "",
    sale_name: "",
    lot_number: hit.lotNumber || "",
    listing_url: "",
    notes: notes.join(" — "),
  };
}

function searchBody(term, page) {
  return {
    requests: [
      {
        indexName: "upcoming_lots_prod",
        params: {
          attributesToRetrieve: [
            "dateTimeUTCUnix",
            "currencyCode",
            "dateTimeLocal",
            "lotTitle",
            "lotNumber",
            "lotRef",
            "houseName",
            "currencySymbol",
            "priceResult",
            "saleType",
            "estimateLow",
            "estimateHigh",
            "currentBid",
            "bidCount",
            "subcategoryRef",
            "endTimeUTCUnix",
          ],
          clickAnalytics: true,
          filters:
            "banned:false AND channelIDs:1 AND unlotted:false AND onlineOnly:false AND closed:false AND NOT subcategoryRef:7IA742QGM5",
          hitsPerPage: 96,
          maxValuesPerFacet: 50,
          page,
          query: term,
          ruleContexts: "",
          tagFilters: "",
          getRankingInfo: false,
          highlightPreTag: "<ais-highlight-0000000000>",
          highlightPostTag: "</ais-highlight-0000000000>",
        },
      },
    ],
    isCatalogPageRequest: false,
  };
}

async function fetchPage(term, page) {
  const res = await fetch(CATRESULTS_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(searchBody(term, page)),
  });
  if (!res.ok) throw new Error(`Invaluable catResults ${res.status} for page ${page}`);
  const json = await res.json();
  const result = json && json.results && json.results[0];
  if (!result) throw new Error("Unexpected catResults response shape (no results[0])");
  return result; // { hits, nbHits, page, nbPages, hitsPerPage }
}

// Collect Invaluable lots into the shared store `map`. Returns count processed.
async function collect(map, { term = "david webb", today } = {}) {
  let page = 0;
  let processed = 0;
  let nbPages = 1;
  while (page < nbPages) {
    const result = await fetchPage(term, page);
    nbPages = Number(result.nbPages) || 1;
    for (const hit of result.hits || []) {
      if (!isDavidWebb(hit)) continue;
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
  console.log(`Invaluable importer — term "${term}"`);
  const map = store.loadStore();
  const before = map.size;
  const processed = await collect(map, { term });
  const total = store.writeStore(map);
  console.log(`Done. ${processed} Invaluable lot(s) processed; ${map.size - before} new; ${total} total records.`);
  console.log(`JSON: ${store.HISTORY_JSON}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, mapItem, SOURCE };
