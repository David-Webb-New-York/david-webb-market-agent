#!/usr/bin/env node
/**
 * David Webb — Doyle importer (source adapter)
 * -------------------------------------------------
 * Doyle's search-results page is genuinely server-rendered HTML, confirmed
 * via a cold plain fetch() with no Browserbase/JS (not guessed): a fetch of
 *   https://www.doyle.com/auction/search/?st=david+webb&c=1
 * returns status 200 with 385 "david webb" occurrences in the raw response
 * body -- exactly matching a live Browserbase-rendered session of the same
 * page (the URL itself was found by simulating real typing + Enter into
 * Doyle's search box, since a guessed URL param never triggered results;
 * see HANDOFF.md for the full investigation).
 *
 * Real confirmed listing-card markup (from doyle-listing-shape.js, not
 * guessed -- each card sits between successive `<div class="auction-lot">`
 * occurrences):
 *   <div class="auction-lot">
 *     <div class="auction-lot-image">
 *       <a href="/auction/lot/<slug>/?lot=<id>&so=4&st=...">
 *         <img src="<cdn image url>" alt="Lot N - <title>" />
 *       </a>
 *     </div>
 *     <div class="auction-lot-text">
 *       <p class="auction-lot-title">
 *         <a href="...">
 *           <span class='lot-title cat-3'>Lot N<br />TITLE</span>
 *         </a>
 *       </p>
 *       <p><p class="stockfields-list">PROVENANCE</p></p>
 *       <p>
 *         <strong>Sold for $5,120</strong><br />
 *         <strong>Estimated at $4,000 - $6,000</strong>
 *       </p>
 *     </div>
 *   </div>
 *
 * Unlike Phillips, Doyle DOES show real sold/estimate prices directly on
 * the search-results page -- no per-lot detail-page fetch needed for price
 * data. Known, honest gap: no sale/auction name or sale date appears
 * anywhere in the card markup (checked directly, not assumed) -- left
 * blank rather than guessed; would need a per-lot detail-page fetch to add.
 *
 * Exposes `collect(map, opts)` for the orchestrator (import-all.js); also
 * runnable standalone: node import-doyle.js ["david webb"] [maxPages]
 */

const store = require("./history-store");
const { fetchWithTimeout } = require("./fetch-with-timeout");

const SOURCE = "doyle-site";
const BASE = "https://www.doyle.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// `pn` (page number) is the real param the site's own detail-page hrefs
// carry alongside the confirmed search term/page-size params -- not a
// guessed name.
function searchUrl(term, page) {
  const st = encodeURIComponent(term).replace(/%20/g, "+");
  return `${BASE}/auction/search/?st=${st}&c=1&pn=${page}`;
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
  if (/earring|ear clip|ear-clip|earclip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  if (/cufflink/.test(n)) return "cufflinks";
  return "other";
}

function parseMoney(str) {
  const m = String(str || "").replace(/,/g, "").match(/\$(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : "";
}

// Parse one search-results page's HTML into raw listing records. Cards sit
// between successive "auction-lot" div opens -- splitting on that literal
// string (rather than balanced-tag HTML parsing) sidesteps the page's own
// malformed nested <p><p class="stockfields-list">...</p></p> markup.
function parseListings(html) {
  const chunks = html.split('<div class="auction-lot">').slice(1);
  const items = [];
  for (const chunk of chunks) {
    const hrefMatch = chunk.match(/<a href="([^"]+)"/);
    const titleMatch = chunk.match(/<span class='lot-title[^']*'>Lot\s+(\S+)<br\s*\/>\s*([^<]*)<\/span>/);
    const lotIdMatch = chunk.match(/[?&]lot=(\d+)/);
    const provenanceMatch = chunk.match(/<p class="stockfields-list">([^<]*)<\/p>/);
    const soldMatch = chunk.match(/Sold for\s*\$([\d,]+(?:\.\d+)?)/);
    const estMatch = chunk.match(/Estimated at\s*\$([\d,]+(?:\.\d+)?)\s*-\s*\$([\d,]+(?:\.\d+)?)/);
    if (!hrefMatch || !titleMatch) continue;
    const rawHref = decodeEntities(hrefMatch[1]).split("?")[0];
    const listingUrl = rawHref.startsWith("http") ? rawHref : `${BASE}${rawHref}`;
    items.push({
      lotNumber: titleMatch[1],
      title: decodeEntities(titleMatch[2]),
      lotId: lotIdMatch ? lotIdMatch[1] : "",
      listingUrl,
      provenance: provenanceMatch ? decodeEntities(provenanceMatch[1]) : "",
      soldPrice: soldMatch ? Number(soldMatch[1].replace(/,/g, "")) : "",
      estimateLow: estMatch ? Number(estMatch[1].replace(/,/g, "")) : "",
      estimateHigh: estMatch ? Number(estMatch[2].replace(/,/g, "")) : "",
    });
  }
  return items;
}

function mapItem(it) {
  return {
    piece_name: it.title || "",
    category: inferCategory(it.title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: it.soldPrice !== "" ? "hammer" : it.estimateLow !== "" ? "estimate" : "",
    sold_price: it.soldPrice,
    estimate_low: it.estimateLow,
    estimate_high: it.estimateHigh,
    currency_note: it.soldPrice !== "" || it.estimateLow !== "" ? "USD" : "",
    sale_date: "",
    auction_house: "Doyle",
    sale_name: "",
    lot_number: it.lotNumber || "",
    listing_url: it.listingUrl || "",
    notes: it.provenance || "",
  };
}

async function fetchPage(term, page) {
  const res = await fetchWithTimeout(searchUrl(term, page), { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Doyle ${res.status} for page ${page}`);
  const html = await res.text();
  return parseListings(html);
}

// Collect Doyle listings into the shared store `map`. Pages through
// &pn=N until a page returns nothing new or the safety cap is hit.
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
    if (!items.length) break;
    const freshItems = items.filter((it) => !seenIds.has(it.lotId || it.listingUrl));
    for (const it of freshItems) {
      seenIds.add(it.lotId || it.listingUrl);
      store.upsert(map, mapItem(it), { source: SOURCE, today });
      processed++;
    }
    if (freshItems.length === 0) break; // page repeats what we've already seen -- genuinely done
    await new Promise((r) => setTimeout(r, 300));
  }
  const truncated = pagesFetched >= maxPages;
  return { processed, pages: pagesFetched, truncated };
}

async function main() {
  const term = (process.argv[2] || "david webb").trim();
  const maxPages = process.argv[3] ? parseInt(process.argv[3], 10) : 15;
  console.log(`Doyle importer — term "${term}", maxPages=${maxPages}`);
  const map = store.loadStore();
  const before = map.size;
  const { processed, pages, truncated } = await collect(map, { term, maxPages });
  const total = store.writeStore(map);
  console.log(
    `Done. ${processed} Doyle lot(s) across ${pages} page(s)${truncated ? " [TRUNCATED at maxPages]" : ""}; ${map.size - before} new; ${total} total records.`
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
