#!/usr/bin/env node
/**
 * David Webb — LiveAuctioneers importer (source adapter)
 * --------------------------------------------------------
 * LiveAuctioneers sits behind Incapsula bot-protection (confirmed: a plain
 * fetch() gets a 960-byte JS-challenge stub, not the real page — see
 * plain-fetch-test.js), so this renders the search page in a Browserbase
 * cloud browser like a real visitor.
 *
 * The site embeds its full Redux state as `<script>window.__data = {...}` in
 * the raw server HTML, but the app's own client hydration reads and clears
 * that global before a headless browser's page.evaluate() can see it — so
 * this extracts it directly from the rendered HTML instead (see
 * inline-state.js). Individual lot records live at
 * `window.__data.itemSummary.byId.<itemId>`, found by their real field shape
 * (confirmed via bb-probe.js probes, not guessed):
 *   itemId, lotNumber, title, slug, slugWithLocation, catalogId, catalogTitle,
 *   sellerName, currency, salePrice, buyNowPrice, leadingBid, startPrice,
 *   lowBidEstimate, highBidEstimate, isSold, isPassed, isAvailable,
 *   saleStartTs (unix seconds).
 * Confirmed listing_url pattern (real <a href> found in the rendered HTML,
 * not inferred from general site knowledge):
 *   https://www.liveauctioneers.com/item/{itemId}_{slugWithLocation}
 *
 * Pagination: the search page's own Redux pagination slice
 * (catalogItems.pagination) is always empty — it belongs to a different
 * feature, not the search-results grid. But appending `&page=N` to the
 * search URL IS real (confirmed: page 2 renders a different <title> and
 * different lots than page 1), so collect() pages through &page=N until a
 * page returns nothing new, rather than reading a total-pages field that
 * doesn't exist for this view.
 *
 * The ~80KB window.__data blob can fail a whole-tree JSON.parse due to
 * unrelated debug telemetry elsewhere in the tree (observed: a serialized
 * `Array.prototype` reference under apiPerformanceStats on one render) —
 * when that happens, this falls back to parsing just the itemSummary.byId
 * slice directly, which is the only part actually needed.
 *
 * Exposes `collect(map, opts)` for the orchestrator (import-all.js); also
 * runnable standalone: node import-liveauctioneers.js ["david webb"]
 */

const store = require("./history-store");
const bb = require("./browserbase");
const { extractInlineWindowVars, extractKeyObject, findLotLikeObjects } = require("./inline-state");

const SOURCE = "liveauctioneers-site";
const BASE = "https://www.liveauctioneers.com";

const searchUrl = (term) => `${BASE}/search/?keyword=${encodeURIComponent(term).replace(/%20/g, "+")}`;

function inferCategory(name) {
  const n = (name || "").toLowerCase();
  if (/bracelet|bangle|cuff/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
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

function mapItem(it) {
  const sold = it.isSold === true && num(it.salePrice);
  const notes = [];
  if (it.isPassed === true && !sold) notes.push("Passed / did not sell");
  if (it.isAvailable === true && !sold) notes.push("Currently listed / bidding open");
  if (num(it.buyNowPrice)) notes.push(`Buy-now price $${Number(it.buyNowPrice).toLocaleString("en-US")}`);
  if (!sold && num(it.leadingBid)) notes.push(`Leading bid at capture: $${Number(it.leadingBid).toLocaleString("en-US")}`);
  return {
    piece_name: it.title || "",
    category: inferCategory(it.title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: sold ? "hammer" : num(it.lowBidEstimate) || num(it.highBidEstimate) ? "estimate" : "",
    sold_price: sold ? num(it.salePrice) : "",
    estimate_low: num(it.lowBidEstimate),
    estimate_high: num(it.highBidEstimate),
    currency_note: it.currency || "",
    sale_date: dateFromUnixSeconds(it.saleStartTs),
    auction_house: it.sellerName || "",
    sale_name: it.catalogTitle || "",
    lot_number: it.lotNumber || "",
    listing_url:
      it.itemId && (it.slugWithLocation || it.slug)
        ? `${BASE}/item/${it.itemId}_${it.slugWithLocation || it.slug}`
        : "",
    notes: notes.join(" — "),
  };
}

// Render one search page and pull every lot record out of the
// server-embedded window.__data state. Returns the mapped lot objects for
// this page only (see collect() for how pages are combined).
async function fetchLotsForUrl(url) {
  if (!bb.hasCreds()) {
    throw new Error("Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (add them as secrets).");
  }
  const { html } = await bb.renderAndExtract(url, { waitMs: 12000 });
  const inline = extractInlineWindowVars(html, ["__data"]);
  const data = inline.__data;
  if (!data) throw new Error("window.__data not found in rendered HTML");

  if (data.ok) {
    const results = [];
    findLotLikeObjects(data.value, "window.__data", results, {
      maxResults: 500,
      maxVisited: 500000,
      visited: { count: 0 },
    });
    return results.map((r) => r.value);
  }

  // The full ~80KB blob can fail to parse because of unrelated debug
  // telemetry elsewhere in the same tree (observed: a serialized
  // `Array.prototype` reference under apiPerformanceStats — not a lot-data
  // issue). Fall back to parsing just the itemSummary.byId slice we
  // actually need, which narrows the surface area to well-formed lot data.
  const itemSummary = extractKeyObject(data.rawText, "itemSummary");
  if (!itemSummary.ok || !itemSummary.value || typeof itemSummary.value.byId !== "object") {
    throw new Error(
      `window.__data failed to parse (${data.error}) and itemSummary fallback also failed (${itemSummary.error || "no byId"})`
    );
  }
  return Object.values(itemSummary.value.byId);
}

// Collect LiveAuctioneers lots into the shared store `map`, paging through
// &page=N (confirmed real via probe: page 2 returns a different page title
// and different lots, not a repeat of page 1) until a page yields nothing
// new. There's no reliable "total pages" field to read (the site's own
// catalogItems.pagination Redux slice is unrelated/always empty), so "done"
// is inferred from repeated/empty results rather than a count — with a
// safety cap so a change in that behavior can't spin forever.
async function collect(map, { term = "david webb", today, maxPages = 25 } = {}) {
  const seenItemIds = new Set();
  let processed = 0;
  let page = 1;
  let truncated = false;
  while (page <= maxPages) {
    const url = page === 1 ? searchUrl(term) : `${searchUrl(term)}&page=${page}`;
    let lots;
    try {
      lots = await fetchLotsForUrl(url);
    } catch (err) {
      console.error(`  page ${page}: ${err.message}`);
      break;
    }
    if (!lots.length) break;
    const freshLots = lots.filter((it) => it.itemId != null && !seenItemIds.has(it.itemId));
    if (freshLots.length === 0) break; // page repeats what we've already seen -- genuinely done
    for (const it of freshLots) {
      seenItemIds.add(it.itemId);
      store.upsert(map, mapItem(it), { source: SOURCE, today });
      processed++;
    }
    if (freshLots.length < lots.length) break; // partial overlap is an ambiguous signal -- stop rather than guess
    page++;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (page > maxPages) truncated = true;
  return { processed, pages: page - 1, truncated };
}

async function main() {
  const term = (process.argv[2] || "david webb").trim();
  console.log(`LiveAuctioneers importer — term "${term}"`);
  const map = store.loadStore();
  const before = map.size;
  const { processed, pages, truncated } = await collect(map, { term });
  const total = store.writeStore(map);
  console.log(
    `Done. ${processed} LiveAuctioneers lot(s) across ${pages} page(s)${truncated ? " [TRUNCATED at maxPages]" : ""}; ${map.size - before} new; ${total} total records.`
  );
  console.log(`JSON: ${store.HISTORY_JSON}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, mapItem, SOURCE };
