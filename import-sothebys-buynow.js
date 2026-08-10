#!/usr/bin/env node
/**
 * David Webb — Sotheby's Buy Now importer (source adapter)
 * -------------------------------------------------------
 * Sotheby's live site has a real, separate fixed-price "Buy Now" retail
 * marketplace, distinct from import-sothebys.js's historical Algolia
 * archive of sold/estimate lots -- confirmed via five live probe rounds
 * (see HANDOFF.md, 2026-08-10): searching "david webb" returns 34
 * results, EVERY one showing a "Buy now" CTA with a fixed USD price --
 * no bid, no estimate, no lot number, no sale date anywhere. The GraphQL
 * query backing individual item pages is literally named
 * `retailItemBySlug`. This is retail inventory, not auction lots, so it
 * upserts into the dealer layer (dealer-store.js), not auction-history.
 *
 * KNOWN GAP, left blank rather than guessed (matching import-sothebys.js's
 * own precedent for its historical adapter, which also ships without a
 * confirmed listing_url): no per-item detail-page URL or image URL.
 * The rendered search-results page text reliably gives title + price for
 * every item (confirmed identically across two separate probe rounds),
 * but three further rounds trying to recover a per-item URL all failed --
 * the 31 GraphQL calls the page makes carry zero pricing/URL data (only
 * image renditions, in responses with no shared join key back to a
 * title/price), and a DOM-selector attempt grabbed the site's nav menu
 * instead of a result card. listing_url is left empty; dealer-store.js's
 * recordKey() falls back to dealer+piece_name for identity, which is
 * stable as long as two items never share an exact title.
 *
 * Needs Browserbase since the page renders client-side.
 *
 * Exposes `collect(map, opts)` and `collectAll(map, opts)` for the
 * orchestrator (import-dealers.js). Also runnable standalone:
 *   node import-sothebys-buynow.js
 */
const store = require("./dealer-store");
const bb = require("./browserbase");

const SOURCE = "sothebys-buynow";
const SEARCH_URL = "https://www.sothebys.com/en/search?query=david+webb";
const DEALER = "Sotheby's (Buy Now)";

function inferCategory(text) {
  const n = (text || "").toLowerCase();
  if (/bracelet|bangle|cuff(?!link)/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip|earclip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  if (/cufflink/.test(n)) return "cufflinks";
  return "other";
}

function inferEra(text) {
  const m = String(text || "").match(/\b(circa\s*)?(19\d0s|19\d{2}|20\d{2})\b/i);
  return m ? m[0].trim() : "";
}

// Parses the "David Webb\n\n<Title>\n\nBuy now\n\n<price> USD" repeating
// block confirmed identically across two separate live probe rounds
// against the real, rendered search-results page text.
function parseResults(pageText) {
  const items = [];
  const re = /David Webb\s*\n\s*([^\n]+?)\s*\n\s*Buy now\s*\n\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})\b/g;
  let m;
  while ((m = re.exec(pageText))) {
    const price = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    items.push({ name: m[1].trim(), price, currency: m[3] });
  }
  return items;
}

async function fetchListings(searchUrl) {
  return bb.withPage(
    async (page) => {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(7000);
      const pageText = await page.evaluate(() => document.body.innerText);
      return parseResults(pageText);
    },
    { sessionOpts: { proxies: true } }
  );
}

function mapItem(it) {
  return {
    piece_name: it.name,
    category: inferCategory(it.name),
    era_or_year: inferEra(it.name),
    materials_gemstones: "",
    price_type: "asking",
    asking_price: it.price,
    currency_note: it.currency || "USD",
    dealer: DEALER,
    listing_url: "",
    image_url: "",
    sku: "",
    notes: "",
  };
}

// Collect the current David Webb Sotheby's Buy Now results into the
// shared store `map`. Returns { seen, matched, added } counts.
async function collect(map, { today, searchUrl = SEARCH_URL } = {}) {
  if (!bb.hasCreds()) {
    throw new Error("Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (add them as secrets).");
  }
  let matched = 0;
  let added = 0;
  const seenIds = new Set();

  const items = await fetchListings(searchUrl);
  const seen = items.length;
  // No separate isDavidWebb() filter here (unlike the other dealer
  // adapters): parseResults()'s regex anchors on the literal "David Webb"
  // brand line, which precedes and is NOT part of the captured title --
  // so every item that survives the regex is already brand-matched by
  // construction. Filtering it.name against isDavidWebb() would always
  // fail (confirmed the hard way: a live run parsed 31 real items and
  // matched 0, since titles like "Gold and Enamel Cufflinks" never repeat
  // the brand name themselves) and silently drop every real item.
  for (const it of items) {
    matched++;
    const record = mapItem(it);
    const key = store.recordKey(record);
    seenIds.add(key);
    const isNew = store.upsert(map, record, { source: SOURCE, today });
    if (isNew) added++;
  }

  store.markMissingInactive(map, seenIds, today || new Date().toISOString().slice(0, 10));
  return { seen, matched, added, truncated: false };
}

// Single multi-seller-style search, like 1stDibs -- no fixed per-dealer
// list to iterate. Wraps collect() in the shape import-dealers.js expects.
const DEALERS = [{ label: "Sotheby's Buy Now (single search)" }];

async function collectAll(map, { today } = {}) {
  try {
    const r = await collect(map, { today });
    return [{ dealer: DEALER, ...r }];
  } catch (err) {
    return [{ dealer: DEALER, error: err.message }];
  }
}

async function main() {
  console.log("Sotheby's Buy Now importer — David Webb search");
  const map = store.loadStore();
  const before = map.size;
  const { seen, matched, added, truncated } = await collect(map);
  const total = store.writeStore(map);
  console.log(
    `Done. ${seen} listing(s) scanned, ${matched} David Webb, ${added} new${
      truncated ? " [TRUNCATED]" : ""
    }; ${map.size - before} new record(s); ${total} total dealer listing(s).`
  );
  console.log(`JSON: ${store.LISTINGS_JSON}`);
  console.log(`CSV:  ${store.LISTINGS_CSV}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, collectAll, DEALERS, SOURCE };
