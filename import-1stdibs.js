#!/usr/bin/env node
/**
 * David Webb — 1stDibs importer (source adapter)
 * -------------------------------------------------
 * Unlike the Shopify/WooCommerce adapters (one shop per dealer), 1stDibs is
 * a multi-seller marketplace: a single search page returns listings from
 * many different galleries/dealers at once. Confirmed real via live
 * investigation across several probe rounds (1stdibs-listing-shape.js, not
 * guessed):
 *   - The search-results page renders client-side; the full item list lives
 *     in a large inline <script> blob as a Relay/GraphQL normalized store
 *     (flat dictionary of records keyed by opaque base64 ids), not a
 *     separate XHR a network-signal scan would catch.
 *   - Real per-item data ("ecommerceTrackingParams") gives id/price/name
 *     directly, but the listing URL, seller name, and image need one to
 *     three more ref hops into that same flat store:
 *       item = store[base64("Item:"+id)]
 *         .localizedPdpUrl                              -> listing URL
 *         .seller.__ref -> sellerRecord
 *           .sellerProfile.company                       -> seller/gallery name (a plain string)
 *         .photos(limit:1).__refs[0] -> photoRecord
 *           .masterOrZoomPath / .smallPath                -> image path (needs CDN prefix)
 *   - Requires a real browser (Browserbase) like the other JS-heavy sources
 *     (Bonhams, Christie's) — a cold fetch() won't render this blob.
 *
 * These are FOR-SALE listings, so — like Shopify/WooCommerce — they upsert
 * into the dealer layer (dealer-store.js: output/david-webb-dealer-listings.*).
 * Cross-listing caveat: a dealer may list the same physical piece both on
 * their own site (via the Shopify/WooCommerce adapters) AND on 1stDibs.
 * There's no reliable way to match those as the same piece (no shared SKU/
 * image-hash matching available), so 1stDibs listings are kept as their own
 * distinct records rather than merged/deduped against direct-site listings.
 * When the resolved seller name matches an existing dealer's name, records
 * naturally group under that dealer in the GUI — but "total listings" counts
 * platform presence, not unique physical pieces. See HANDOFF.md.
 *
 * v1 scope: a single search-results page (~14-20 items covering most of the
 * current David Webb inventory on the site). No pagination yet — 1stDibs'
 * page-2+ URL scheme wasn't investigated; add it if the single-page count
 * turns out to consistently undercount the real catalog.
 *
 * Exposes `collect(map, opts)` and `collectAll(map, opts)` for the
 * orchestrator (import-dealers.js). Also runnable standalone:
 *   node import-1stdibs.js
 */

const store = require("./dealer-store");
const bb = require("./browserbase");

const SOURCE = "1stdibs";
const SEARCH_URL = "https://www.1stdibs.com/search/jewelry/?oq=david%20webb&q=david%20webb&st=classified";
const CDN_BASE = "https://a.1stdibscdn.com";
const FALLBACK_DEALER = "1stDibs Seller";

function inferCategory(text) {
  const n = (text || "").toLowerCase();
  if (/bracelet|bangle|cuff(?!link)/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  if (/cufflink/.test(n)) return "cufflinks";
  return "other";
}

function inferEra(text) {
  const m = String(text || "").match(/\b(circa\s*)?(19\d0s|19\d{2}|20\d{2})\b/i);
  return m ? m[0].trim() : "";
}

function isDavidWebb(name) {
  return /david\s*webb/i.test(name || "");
}

// Depth-counting brace scan -- a naive `{[^{}]*}` regex silently fails when
// the target JSON value contains any nested object (confirmed the hard way
// during the probe rounds: ecommerceTrackingParams nests convertedAmounts).
function extractBalancedObjects(text, keyPrefix, max = Infinity) {
  const results = [];
  const marker = `"${keyPrefix}":`;
  let searchFrom = 0;
  while (results.length < max) {
    const markerIdx = text.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;
    const braceStart = text.indexOf("{", markerIdx);
    if (braceStart === -1) break;
    let depth = 0;
    let i = braceStart;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0) results.push(text.slice(braceStart, i + 1));
    searchFrom = markerIdx + marker.length;
  }
  return results;
}

function resolveRecord(blob, key) {
  const matches = extractBalancedObjects(blob, key, 1);
  if (!matches.length) return null;
  try {
    return JSON.parse(matches[0]);
  } catch (_) {
    return null;
  }
}

function resolveSellerName(blob, sellerRef) {
  if (!sellerRef) return null;
  const sellerRecord = resolveRecord(blob, sellerRef);
  if (!sellerRecord || !sellerRecord.sellerProfile) return null;
  const profile = sellerRecord.sellerProfile.__ref
    ? resolveRecord(blob, sellerRecord.sellerProfile.__ref)
    : sellerRecord.sellerProfile;
  if (!profile || !profile.company) return null;
  const company = profile.company.__ref ? resolveRecord(blob, profile.company.__ref) : profile.company;
  return typeof company === "string" && company ? company : null;
}

function resolveImageUrl(blob, photoRef) {
  if (!photoRef) return "";
  const photoRecord = resolveRecord(blob, photoRef);
  if (!photoRecord) return "";
  const path = photoRecord.masterOrZoomPath || photoRecord.smallPath || "";
  if (!path) return "";
  return path.startsWith("http") ? path : `${CDN_BASE}${path}`;
}

// Pull every real listing off one search-results page. Returns raw items
// (id, price, name, pdpUrl, sellerName, imageUrl) -- filtering/mapping into
// store records happens in collect().
async function fetchListings(searchUrl) {
  const result = await bb.withPage(
    async (page) => {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(8000);
      return page.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        const blobs = scripts.map((s) => s.textContent || "").filter((t) => t.length > 2000);
        return { blobs };
      });
    },
    { sessionOpts: { proxies: true } }
  );

  const blob = result.blobs.sort((a, b) => b.length - a.length)[0] || "";
  const rawItems = extractBalancedObjects(blob, "ecommerceTrackingParams")
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    })
    .filter((it) => it && it.id && it.price);

  return rawItems.map((it) => {
    const itemKey = Buffer.from(`Item:${it.id}`).toString("base64");
    const itemRecord = resolveRecord(blob, itemKey);
    const pdpUrl = itemRecord ? itemRecord.localizedPdpUrl : null;
    const sellerRef = itemRecord && itemRecord.seller && itemRecord.seller.__ref;
    const sellerName = resolveSellerName(blob, sellerRef);
    const photosField = itemRecord && Object.keys(itemRecord).find((k) => k.startsWith("photos("));
    const photoRef = photosField && itemRecord[photosField] && itemRecord[photosField].__refs && itemRecord[photosField].__refs[0];
    const imageUrl = resolveImageUrl(blob, photoRef);
    return { id: it.id, price: it.price, name: it.name || "", pdpUrl, sellerName, imageUrl };
  });
}

function mapItem(it) {
  return {
    piece_name: it.name,
    category: inferCategory(it.name),
    era_or_year: inferEra(it.name),
    materials_gemstones: "",
    price_type: "asking",
    asking_price: it.price,
    currency_note: "USD",
    dealer: it.sellerName || FALLBACK_DEALER,
    listing_url: it.pdpUrl ? `https://www.1stdibs.com${it.pdpUrl}` : "",
    image_url: it.imageUrl || "",
    sku: it.id,
    notes: "",
  };
}

// Collect the current David Webb 1stDibs search results into the shared
// store `map`. Returns { seen, matched, added } counts.
async function collect(map, { today, searchUrl = SEARCH_URL } = {}) {
  if (!bb.hasCreds()) {
    throw new Error("Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (add them as secrets).");
  }
  let seen = 0;
  let matched = 0;
  let added = 0;
  const seenIds = new Set();

  const items = await fetchListings(searchUrl);
  seen = items.length;
  for (const it of items) {
    if (!isDavidWebb(it.name)) continue;
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

// 1stDibs has no fixed per-dealer list to iterate (it's one multi-seller
// search) -- this wraps collect() in the same { dealer, seen, matched,
// added } shape import-dealers.js expects from every adapter's collectAll().
const DEALERS = [{ label: "1stDibs (multi-seller marketplace search)" }];

async function collectAll(map, { today } = {}) {
  try {
    const r = await collect(map, { today });
    return [{ dealer: "1stDibs (all sellers)", ...r }];
  } catch (err) {
    return [{ dealer: "1stDibs (all sellers)", error: err.message }];
  }
}

async function main() {
  console.log("1stDibs importer — David Webb search");
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
