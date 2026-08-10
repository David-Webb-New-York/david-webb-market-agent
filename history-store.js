/**
 * Shared store for the David Webb auction-history dataset.
 *
 * Both the LLM web-search backfill (backfill.js) and the deterministic
 * source importers (e.g. import-rago.js) write into the SAME files via this
 * module, using an identical dedup key so their records merge cleanly:
 *   output/david-webb-auction-history.json
 *   output/david-webb-auction-history.csv
 */

const fs = require("fs");
const path = require("path");
const { inferTags } = require("./infer-tags");
const { toUsd } = require("./convert-currency");
const { isExcludedListing } = require("./excluded-listings");

const OUTPUT_DIR = path.join(__dirname, "output");
const HISTORY_JSON = path.join(OUTPUT_DIR, "david-webb-auction-history.json");
const HISTORY_CSV = path.join(OUTPUT_DIR, "david-webb-auction-history.csv");

const HISTORY_FIELDS = [
  "piece_name",
  "category",
  "era_or_year",
  "materials_gemstones",
  "price_type",
  "sold_price",
  "estimate_low",
  "estimate_high",
  "currency_note",
  "sale_date",
  "auction_house",
  "sale_name",
  "lot_number",
  "listing_url",
  "notes",
  "tags",
  "sold_price_usd",
];

const CSV_HEADER = ["id", ...HISTORY_FIELDS, "source", "first_captured"];

function normalizeUrl(u) {
  if (!u) return "";
  const raw = String(u).trim();
  try {
    const url = new URL(raw);
    return (url.host + url.pathname).toLowerCase().replace(/\/+$/, "");
  } catch (_) {
    return raw.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

// Stable identity: listing URL if present, else house+lot+sale_date+name.
function recordKey(r) {
  const url = normalizeUrl(r.listing_url);
  if (url) return "url:" + url;
  const house = (r.auction_house || "").toLowerCase().trim();
  const lot = String(r.lot_number || "").toLowerCase().trim();
  const date = String(r.sale_date || "").trim();
  const name = (r.piece_name || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `meta:${house}|${lot}|${date}|${name}`;
}

// sold_price_usd is fully derived (like tags) -- always recomputed from
// sold_price + currency_note + sale_date rather than trusting whatever an
// importer happened to set, so every record stays consistent regardless
// of which source touched it last. Falls back to the raw native number if
// the currency isn't one convert-currency.js has a rate table for (rare;
// better than silently dropping a real price out of every stat).
function usdPrice(r) {
  const converted = toUsd(r.sold_price, r.currency_note, r.sale_date);
  if (converted !== null) return converted;
  const n = Number(r.sold_price);
  return Number.isFinite(n) && n > 0 ? n : "";
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val).replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

function loadStore() {
  if (!fs.existsSync(HISTORY_JSON)) return new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_JSON, "utf8"));
    return new Map(arr.map((r) => [r.id || recordKey(r), r]));
  } catch (_) {
    return new Map();
  }
}

// Insert or merge one record. Returns true if it was newly added.
function upsert(map, record, meta = {}) {
  const key = recordKey(record);
  if (isExcludedListing(record.listing_url)) {
    // Confirmed non-jewelry homonym noise (see excluded-listings.js) --
    // never (re-)add it, and purge it if it's already on file from before
    // this list existed, so re-imports are self-cleaning rather than
    // needing the same manual deletion redone after every fresh scrape.
    map.delete(key);
    return false;
  }
  const today = meta.today || new Date().toISOString().slice(0, 10);
  const source = meta.source || record.source || "";
  const clean = { id: key };
  for (const f of HISTORY_FIELDS) clean[f] = record[f] ?? "";
  if (map.has(key)) {
    const prev = map.get(key);
    // Keep non-empty existing values unless the new record fills a gap or updates a price.
    const merged = { ...prev };
    for (const f of HISTORY_FIELDS) {
      if (clean[f] !== "" && clean[f] !== null && clean[f] !== undefined) merged[f] = clean[f];
    }
    merged.id = key;
    merged.source = prev.source || source;
    merged.first_captured = prev.first_captured || today;
    // tags is fully derived -- always recompute from the final merged text
    // rather than carrying over whichever side's (likely empty) raw value won.
    merged.tags = inferTags(`${merged.piece_name} ${merged.notes}`, merged.era_or_year).join("; ");
    merged.sold_price_usd = usdPrice(merged);
    map.set(key, merged);
    return false;
  }
  clean.source = source;
  clean.first_captured = today;
  clean.tags = inferTags(`${clean.piece_name} ${clean.notes}`, clean.era_or_year).join("; ");
  clean.sold_price_usd = usdPrice(clean);
  map.set(key, clean);
  return true;
}

function writeStore(map) {
  const records = [...map.values()].sort(
    (a, b) => (Number(b.sold_price_usd) || 0) - (Number(a.sold_price_usd) || 0)
  );
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_JSON, JSON.stringify(records, null, 2) + "\n");
  const lines = [CSV_HEADER.join(",")];
  for (const r of records) lines.push(CSV_HEADER.map((c) => csvEscape(r[c])).join(","));
  fs.writeFileSync(HISTORY_CSV, lines.join("\n") + "\n");
  return records.length;
}

module.exports = {
  OUTPUT_DIR,
  HISTORY_JSON,
  HISTORY_CSV,
  HISTORY_FIELDS,
  CSV_HEADER,
  normalizeUrl,
  recordKey,
  csvEscape,
  loadStore,
  upsert,
  writeStore,
};
