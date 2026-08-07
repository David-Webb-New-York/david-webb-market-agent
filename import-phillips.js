#!/usr/bin/env node
/**
 * David Webb — Phillips importer (source adapter)
 * -------------------------------------------------
 * Phillips' search-results page is genuinely server-rendered HTML, confirmed
 * via a cold plain fetch() with no Browserbase/JS (not guessed): a fetch of
 *   https://www.phillips.com/Search?Search=david+webb
 * returns status 200 with the real "found N results" grid directly in the
 * raw response body (245 "david webb" occurrences on a cold fetch, matching
 * scale with a Browserbase-rendered capture of the same page) -- so this is
 * a free structured source, no paid Browserbase session needed.
 *
 * Real confirmed listing-card markup (from phillips-listing-shape.js, not
 * guessed):
 *   <li class="col-xs-6 col-sm-3 pending search-result-item" id="itemidNN">
 *     <div class="image">
 *       <a href='https://www.phillips.com/detail/<maker-slug>/<lotId>?fromSearch=...'
 *          data-image="<cdn image url>" class="image-link"></a>
 *     </div>
 *     <div class="search-result-text">
 *       <strong class="maker">David Webb</strong><br/>
 *       <em>Coral, Diamond and Enamel Cuff Bracelet</em><br/>
 *       <span>The New York Jewels Auction</span>
 *       <p>10 June 2026</p>
 *     </div>
 *   </li>
 *
 * Known, honest limitation: no price/estimate/hammer text appears anywhere
 * on the search-results page for any listing observed -- only maker, title,
 * sale name, and sale date. Getting sold prices would need a follow-up fetch
 * of each lot's own /detail/... page (not built here, given the added cost
 * of ~150+ extra requests per run); price_type/sold_price/estimate_* are
 * left blank rather than guessed.
 *
 * Exposes `collect(map, opts)` for the orchestrator (import-all.js); also
 * runnable standalone: node import-phillips.js ["david webb"] [maxPages]
 */

const store = require("./history-store");
const { fetchWithTimeout } = require("./fetch-with-timeout");

const SOURCE = "phillips-site";
const BASE = "https://www.phillips.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Page 1 uses the confirmed-working capitalized path/param
// (/Search?Search=...); subsequent pages use the lowercase path real
// pagination links on the site itself point to (/search/N/?search=...).
function searchUrl(term, page) {
  const q = encodeURIComponent(term);
  return page <= 1 ? `${BASE}/Search?Search=${q}` : `${BASE}/search/${page}/?search=${q}`;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

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

// Parse one search-results page's HTML into raw listing records
// ({ maker, title, saleName, saleDate, listingUrl, lotId }).
function parseListings(html) {
  const items = [];
  const liRe = /<li class="[^"]*search-result-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html))) {
    const block = m[1];
    const hrefMatch = block.match(/<a href='([^']+)'/);
    const makerMatch = block.match(/<strong class="maker">([^<]*)<\/strong>/);
    const titleMatch = block.match(/<em>([^<]*)<\/em>/);
    const saleMatch = block.match(/<span>([^<]*)<\/span>/);
    const dateMatch = block.match(/<p>\s*([^<\n]+?)\s*<\/p>/);
    if (!hrefMatch) continue;
    const listingUrl = decodeEntities(hrefMatch[1]).split("?")[0];
    const lotIdMatch = listingUrl.match(/\/detail\/[^/]+\/(\d+)/);
    items.push({
      maker: makerMatch ? decodeEntities(makerMatch[1]) : "",
      title: titleMatch ? decodeEntities(titleMatch[1]) : "",
      saleName: saleMatch ? decodeEntities(saleMatch[1]) : "",
      saleDate: dateMatch ? decodeEntities(dateMatch[1]) : "",
      listingUrl,
      lotId: lotIdMatch ? lotIdMatch[1] : "",
    });
  }
  return items;
}

function parseSaleDate(text) {
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function mapItem(it) {
  return {
    piece_name: it.title || "",
    category: inferCategory(it.title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: "",
    sold_price: "",
    estimate_low: "",
    estimate_high: "",
    currency_note: "",
    sale_date: parseSaleDate(it.saleDate),
    auction_house: "Phillips",
    sale_name: it.saleName || "",
    lot_number: it.lotId || "",
    listing_url: it.listingUrl || "",
    notes: "",
  };
}

async function fetchPage(term, page) {
  const res = await fetchWithTimeout(searchUrl(term, page), { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Phillips ${res.status} for page ${page}`);
  const html = await res.text();
  return parseListings(html);
}

// Collect Phillips listings into the shared store `map`. Pages through
// /search/N/ until a page returns nothing new or the safety cap is hit.
async function collect(map, { term = "david webb", today, maxPages = 15 } = {}) {
  let processed = 0;
  let pagesFetched = 0;
  const seenIds = new Set();

  for (let page = 1; page <= maxPages; page++) {
    let items;
    try {
      items = await fetchPage(term, page);
    } catch (err) {
      console.error(`  page ${page}: ${err.message}`);
      break;
    }
    pagesFetched++;
    const davidWebbItems = items.filter((it) => /david\s*webb/i.test(it.maker) || /david\s*webb/i.test(it.title));
    if (!items.length) break;
    const freshItems = davidWebbItems.filter((it) => !seenIds.has(it.lotId || it.listingUrl));
    for (const it of freshItems) {
      seenIds.add(it.lotId || it.listingUrl);
      store.upsert(map, mapItem(it), { source: SOURCE, today });
      processed++;
    }
    // A page with items but none matching "david webb" (or a fully-repeated
    // page) means we've paged past the relevant results.
    if (davidWebbItems.length === 0 || freshItems.length === 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const truncated = pagesFetched >= maxPages;
  return { processed, pages: pagesFetched, truncated };
}

async function main() {
  const term = (process.argv[2] || "david webb").trim();
  const maxPages = process.argv[3] ? parseInt(process.argv[3], 10) : 15;
  console.log(`Phillips importer — term "${term}", maxPages=${maxPages}`);
  const map = store.loadStore();
  const before = map.size;
  const { processed, pages, truncated } = await collect(map, { term, maxPages });
  const total = store.writeStore(map);
  console.log(
    `Done. ${processed} Phillips lot(s) across ${pages} page(s)${truncated ? " [TRUNCATED at maxPages]" : ""}; ${map.size - before} new; ${total} total records.`
  );
  console.log(`JSON: ${store.HISTORY_JSON}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, mapItem, parseListings, SOURCE };
