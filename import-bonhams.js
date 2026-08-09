#!/usr/bin/env node
/**
 * David Webb — Bonhams importer (source adapter)
 * --------------------------------------------------------
 * Bonhams' search page fires a POST to
 * https://api01.bonhams.com/search-proxy/multi_search (a Typesense-backed
 * search API) with the search text in a "q" field. Confirmed via Browserbase
 * probe (2026-08-07): `?search_term=` on the page URL does NOT populate the
 * query (site sends "q":"" — generic unfiltered results come back), but
 * `?q=` does flow through correctly.
 *
 * Unlike Invaluable, this endpoint sits behind an authenticated nginx gate —
 * confirmed via plain_post_test.js: replaying the exact captured POST body
 * with a bare fetch() gets a 401 "Authorization Required" (nginx), meaning
 * the real request carries auth material (header/token) a bare fetch lacks.
 * So this adapter renders the real search page in Browserbase (with
 * proxies, since Bonhams was previously Cloudflare-blocked on plain HTTP)
 * and captures the JSON response the authenticated browser session actually
 * receives, rather than trying to replicate the auth.
 *
 * Confirmed real response shape (Typesense's own envelope, NOT Algolia's --
 * different field names): results[0].{found, hits[]}, each hit has a
 * `.document` object with real fields: auctionId, auctionStatus, brand
 * (Bonhams' sub-house, e.g. "skinner"), country, currency.iso_code,
 * department.name, hammerTime.timestamp (unix seconds), id, lotNo.full,
 * price.{estimateLow, estimateHigh, hammerPrice} (native currency, NOT the
 * GBP-converted display fields), slug, status, styledDescription, title.
 *
 * KNOWN LIMITATIONS (honest gaps, not guesses):
 * - The one query tested used filter_by:"(status:=[`NEW`])" and found only 1
 *   David Webb hit. Whether other `status` values exist (e.g. for
 *   sold/historical lots) and how to request them is unconfirmed -- this
 *   adapter only gets whatever the site's own default search-page query
 *   returns for "NEW" status.
 * - No confirmed listing_url pattern (no anchor href was captured pointing
 *   to a lot detail page) -- left blank rather than guessed.
 * - Pagination beyond the single page the site requests by default (page 1,
 *   45 per page) is untested for this source.
 *
 * Exposes `collect(map, opts)` for the orchestrator (import-all.js); also
 * runnable standalone: node import-bonhams.js ["david webb"]
 */

const store = require("./history-store");
const bb = require("./browserbase");

const SOURCE = "bonhams-site";
const SEARCH_PROXY_RE = /search-proxy\/multi_search/;

const searchUrl = (term) => `https://www.bonhams.com/search/?q=${encodeURIComponent(term).replace(/%20/g, "+")}`;

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

function stripHtmlTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function mapItem(doc) {
  const title = doc.title || "";
  const sold = num(doc.price && doc.price.hammerPrice);
  const desc = stripHtmlTags(doc.styledDescription);
  const notes = [];
  if (desc && desc !== title) notes.push(desc);
  if (doc.department && doc.department.name) notes.push(`Department: ${doc.department.name}`);
  if (doc.auctionStatus) notes.push(`Auction status: ${doc.auctionStatus}`);
  const price = doc.price || {};
  return {
    piece_name: title,
    category: inferCategory(title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: sold ? "hammer" : num(price.estimateLow) || num(price.estimateHigh) ? "estimate" : "",
    sold_price: sold,
    estimate_low: num(price.estimateLow),
    estimate_high: num(price.estimateHigh),
    currency_note: (doc.currency && doc.currency.iso_code) || "",
    sale_date: dateFromUnixSeconds(doc.hammerTime && doc.hammerTime.timestamp),
    auction_house: doc.brand ? doc.brand.charAt(0).toUpperCase() + doc.brand.slice(1) : "Bonhams",
    sale_name: "",
    lot_number: (doc.lotNo && doc.lotNo.full) || "",
    listing_url: "",
    notes: notes.join(" — "),
  };
}

// Render the search page in Browserbase and pull every lot document out of
// the captured search-proxy/multi_search response(s) -- the site sometimes
// fires more than one near-duplicate request per render (observed on
// Invaluable), so every match is parsed and hits are de-duped by document.id.
async function fetchLots(term) {
  if (!bb.hasCreds()) {
    throw new Error("Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID (add them as secrets).");
  }
  const { jsonResponses } = await bb.renderAndExtract(searchUrl(term), {
    waitMs: 10000,
    captureJson: true,
    sessionOpts: { proxies: true },
  });
  const matches = jsonResponses.filter((r) => SEARCH_PROXY_RE.test(r.url));
  if (!matches.length) throw new Error("No search-proxy/multi_search response captured");

  const seenIds = new Set();
  const docs = [];
  for (const m of matches) {
    let json;
    try {
      json = JSON.parse(m.body);
    } catch (_) {
      continue;
    }
    const result = json && json.results && json.results[0];
    if (!result || !Array.isArray(result.hits)) continue;
    for (const hit of result.hits) {
      const doc = hit.document;
      if (!doc || !doc.id || seenIds.has(doc.id)) continue;
      seenIds.add(doc.id);
      docs.push(doc);
    }
  }
  return docs;
}

// Collect Bonhams lots into the shared store `map`. Returns count processed.
async function collect(map, { term = "david webb", today } = {}) {
  const docs = await fetchLots(term);
  for (const doc of docs) store.upsert(map, mapItem(doc), { source: SOURCE, today });
  return docs.length;
}

async function main() {
  const term = (process.argv[2] || "david webb").trim();
  console.log(`Bonhams importer — term "${term}"`);
  const map = store.loadStore();
  const before = map.size;
  const processed = await collect(map, { term });
  const total = store.writeStore(map);
  console.log(`Done. ${processed} Bonhams lot(s) processed; ${map.size - before} new; ${total} total records.`);
  console.log(`JSON: ${store.HISTORY_JSON}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, mapItem, SOURCE };
