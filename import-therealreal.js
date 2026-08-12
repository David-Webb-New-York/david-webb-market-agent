#!/usr/bin/env node
/**
 * David Webb — The RealReal importer (source adapter)
 * -----------------------------------------------------
 * TheRealReal blocks direct access with PerimeterX (confirmed via the
 * block page's own JS: `window._pxAppId = 'PXev56mY37'` -- an earlier
 * investigation round mislabeled this as "DataDome-style"; it's a
 * different named vendor). Every content path was tested and blocked
 * IDENTICALLY -- same 403, same "Press & Hold" captcha page -- via both
 * a plain fetch() (no browser, no automation markers to fingerprint) AND
 * Steel.dev's real browser with stealth config, which points to
 * IP-reputation blocking of datacenter/cloud ranges (GitHub Actions,
 * Browserbase, Steel), not (only) browser-fingerprint detection.
 * Browserbase's own advancedStealth mode is separately gated behind
 * their paid Enterprise plan regardless.
 *
 * The real fix, found 2026-08-11 night: https://r.jina.ai/<url> -- a
 * free public "reader" proxy (no API key/signup needed, ~20 req/min free
 * per Jina's own docs) fetches server-side from ITS OWN infrastructure
 * and returns the rendered page as clean markdown. It is NOT blocked --
 * confirmed with real current inventory (real prices, real titles,
 * "Published Time" dated days ago) across TWO different designer
 * category pages (David Webb and, as a sanity check, Van Cleef & Arpels),
 * so this isn't a fluke tied to one URL. This is a genuine third-party
 * dependency outside this project's control -- if Jina ever rate-limits,
 * changes ToS, or shuts the free reader down, this source breaks. That's
 * an accepted, documented risk in exchange for $0/month versus a paid
 * browser-automation service.
 *
 * KNOWN GAP, left blank rather than guessed (same practice as Sotheby's
 * Buy Now's missing listing_url): materials_gemstones, era_or_year, and
 * sku are NOT pulled from the category page -- they're only available on
 * each item's own product page (confirmed via a live probe: real fields
 * like "18K Yellow Gold", gemstone cut/weight/color, "Marks: Designer
 * Signature, No Hallmark...", and "Item #: DWB21125"), which would mean
 * ~120+ additional r.jina.ai fetches per run. Not pulled in this version
 * to keep a run fast and comfortably inside the free rate limit; worth
 * revisiting if per-item detail (especially the "Marks"/hallmark field --
 * a real, professionally-curated authenticity signal, unlike the
 * keyword-absence heuristic removed from flag-listings.js) turns out to
 * matter enough to justify the extra fetches.
 *
 * Exposes `collect(map, opts)` and `collectAll(map, opts)` for the
 * orchestrator (import-dealers.js). Also runnable standalone:
 *   node import-therealreal.js
 */
const store = require("./dealer-store");
const { fetchWithTimeout } = require("./fetch-with-timeout");

const SOURCE = "therealreal";
const CATEGORY_URL = "https://www.therealreal.com/designers/david-webb/jewelry";
const DEALER = "The RealReal";
const PRODUCT_URL_RE = /https:\/\/www\.therealreal\.com\/products\/[^\s)]+/;

function inferCategory(text) {
  const n = (text || "").toLowerCase();
  if (/bracelet|bangle|cuff(?!link)/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip|earclip|hoop|stud/.test(n)) return "earrings";
  if (/brooch|pin\b|clip\b/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  if (/cufflink/.test(n)) return "cufflinks";
  return "other";
}

// The category page's markdown links a product image directly to its
// product URL: [![Image N: <alt>](<imgUrl>)](<productUrl>). Building a
// URL-keyed map decouples image lookup from the products' own text-block
// parsing below -- more robust than assuming a fixed line-position
// relationship between an image and the product that follows it (several
// products, especially the first few "Editors' Pick" slots, have no
// image markdown at all -- left blank for those rather than guessed).
function buildImageMap(markdown) {
  const map = new Map();
  const re = /\[!\[Image \d+:[^\]]*\]\((https:\/\/[^\s)]+)\)\]\((https:\/\/www\.therealreal\.com\/products\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(markdown))) map.set(m[2], m[1]);
  return map;
}

// Splits the category page's markdown into one block per product,
// anchored on the exact "[David Webb](<product url>)" link line -- a
// literal, specific pattern that only appears for this designer's own
// products, so no separate brand filter is needed (same reasoning as
// import-sothebys-buynow.js's regex-anchor precedent).
function splitProductBlocks(markdown) {
  const anchorRe = /\[David Webb\]\((https:\/\/www\.therealreal\.com\/products\/[^\s)]+)\)\n([^\n]+)/g;
  const blocks = [];
  let m;
  const matches = [];
  while ((m = anchorRe.exec(markdown))) matches.push({ index: m.index, url: m[1], title: m[2].trim(), matchLen: m[0].length });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].matchLen;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    blocks.push({ url: matches[i].url, title: matches[i].title, body: markdown.slice(start, end) });
  }
  return blocks;
}

// The current asking price is the only dollar figure in a product block
// that carries cents (e.g. "$14,995.00") -- "Est. Retail $37,500" and
// "~~Was: $8,500~~" are always whole-dollar. Confirmed against every
// price-line shape seen live: plain "$X.00", "N% Off Est. Retail $Y" +
// "$X.00", and "Est. Retail $Y" + "~~Was: $Z~~$X.00" + "Now N% off".
function extractPrice(body) {
  const matches = [...body.matchAll(/\$([\d,]+\.\d{2})/g)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1][1].replace(/,/g, ""));
}

function extractRetailNote(body) {
  const discountMatch = body.match(/(\d+)%\s*Off Est\. Retail \$([\d,]+)/);
  if (discountMatch) return `${discountMatch[1]}% off Est. Retail $${discountMatch[2]}`;
  const retailMatch = body.match(/Est\. Retail \$([\d,]+)/);
  return retailMatch ? `Est. Retail $${retailMatch[1]}` : "";
}

function parseListings(markdown) {
  const imageMap = buildImageMap(markdown);
  const blocks = splitProductBlocks(markdown);
  const items = [];
  for (const b of blocks) {
    const price = extractPrice(b.body);
    if (price === null || price <= 0) continue;
    items.push({
      title: b.title,
      url: b.url,
      price,
      imageUrl: imageMap.get(b.url) || "",
      note: extractRetailNote(b.body),
    });
  }
  return items;
}

function mapItem(it) {
  return {
    piece_name: it.title,
    category: inferCategory(it.title),
    era_or_year: "",
    materials_gemstones: "",
    price_type: "asking",
    asking_price: it.price,
    currency_note: "USD",
    dealer: DEALER,
    listing_url: it.url,
    image_url: it.imageUrl,
    sku: "",
    notes: it.note,
  };
}

async function fetchListings(categoryUrl) {
  const res = await fetchWithTimeout(`https://r.jina.ai/${categoryUrl}`, {}, 30000);
  if (!res.ok) throw new Error(`r.jina.ai ${res.status} for ${categoryUrl}`);
  const markdown = await res.text();
  return parseListings(markdown);
}

// Collect the current David Webb TheRealReal results into the shared
// store `map`. Returns { seen, matched, added } counts.
async function collect(map, { today, categoryUrl = CATEGORY_URL } = {}) {
  let matched = 0;
  let added = 0;
  const seenIds = new Set();

  const items = await fetchListings(categoryUrl);
  const seen = items.length;
  for (const it of items) {
    if (!PRODUCT_URL_RE.test(it.url)) continue; // defensive; parseListings should already guarantee this
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

// Single fixed category page, like Sotheby's Buy Now -- no per-dealer
// list to iterate. Wraps collect() in the shape import-dealers.js expects.
const DEALERS = [{ label: "The RealReal (David Webb jewelry)" }];

async function collectAll(map, { today } = {}) {
  try {
    const r = await collect(map, { today });
    return [{ dealer: DEALER, ...r }];
  } catch (err) {
    return [{ dealer: DEALER, error: err.message }];
  }
}

async function main() {
  console.log("The RealReal importer — David Webb jewelry (via r.jina.ai)");
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

module.exports = { collect, collectAll, parseListings, mapItem, DEALERS, SOURCE };
