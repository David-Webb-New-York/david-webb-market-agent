/**
 * Shared store for the David Webb dealer-listings dataset ("dealer layer").
 *
 * Estate jewelers / secondary-market dealers (e.g. Yafa Signed Jewels) are
 * for-sale inventory, not past auction hammers — they don't belong in
 * output/david-webb-auction-history.* (history-store.js) or in the weekly-scan
 * library (library.js, which is rebuilt from LLM-scan snapshots). This is a
 * third, parallel layer for structured/free dealer imports (Shopify JSON,
 * etc.), following the same collect(map)/upsert/writeStore shape as
 * history-store.js so adapters stay consistent across the codebase.
 *
 *   output/david-webb-dealer-listings.json
 *   output/david-webb-dealer-listings.csv
 */

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");
const LISTINGS_JSON = path.join(OUTPUT_DIR, "david-webb-dealer-listings.json");
const LISTINGS_CSV = path.join(OUTPUT_DIR, "david-webb-dealer-listings.csv");

const LISTING_FIELDS = [
  "piece_name",
  "category",
  "era_or_year",
  "materials_gemstones",
  "price_type",
  "asking_price",
  "currency_note",
  "dealer",
  "listing_url",
  "image_url",
  "sku",
  "notes",
];

const CSV_HEADER = ["id", ...LISTING_FIELDS, "source", "first_seen", "last_seen", "times_seen", "status"];

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

// Stable identity: listing URL if present, else dealer+sku, else dealer+name.
function recordKey(r) {
  const url = normalizeUrl(r.listing_url);
  if (url) return "url:" + url;
  const dealer = (r.dealer || "").toLowerCase().trim();
  if (r.sku) return `sku:${dealer}|${String(r.sku).toLowerCase().trim()}`;
  const name = (r.piece_name || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `meta:${dealer}|${name}`;
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val).replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

function loadStore() {
  if (!fs.existsSync(LISTINGS_JSON)) return new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(LISTINGS_JSON, "utf8"));
    return new Map(arr.map((r) => [r.id || recordKey(r), r]));
  } catch (_) {
    return new Map();
  }
}

// Insert or refresh one record as "seen" in the current run. Returns true if newly added.
function upsert(map, record, meta = {}) {
  const today = meta.today || new Date().toISOString().slice(0, 10);
  const source = meta.source || record.source || "";
  const key = recordKey(record);
  const clean = { id: key };
  for (const f of LISTING_FIELDS) clean[f] = record[f] ?? "";

  if (map.has(key)) {
    const prev = map.get(key);
    const merged = { ...prev };
    for (const f of LISTING_FIELDS) {
      if (clean[f] !== "" && clean[f] !== null && clean[f] !== undefined) merged[f] = clean[f];
    }
    merged.id = key;
    merged.source = prev.source || source;
    merged.first_seen = prev.first_seen || today;
    merged.last_seen = today;
    merged.times_seen = (Number(prev.times_seen) || 0) + (prev.last_seen === today ? 0 : 1);
    merged.status = "active";
    map.set(key, merged);
    return false;
  }

  clean.source = source;
  clean.first_seen = today;
  clean.last_seen = today;
  clean.times_seen = 1;
  clean.status = "active";
  map.set(key, clean);
  return true;
}

// Mark every record not seen in this run's `seenToday` set as inactive
// (still on file, no longer showing as in-stock). Mirrors library.js status logic.
function markMissingInactive(map, seenIds, today) {
  for (const [key, rec] of map) {
    if (!seenIds.has(key) && rec.last_seen !== today) rec.status = "inactive";
  }
}

function writeStore(map) {
  const records = [...map.values()].sort(
    (a, b) => (Number(b.asking_price) || 0) - (Number(a.asking_price) || 0)
  );
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(LISTINGS_JSON, JSON.stringify(records, null, 2) + "\n");
  const lines = [CSV_HEADER.join(",")];
  for (const r of records) lines.push(CSV_HEADER.map((c) => csvEscape(r[c])).join(","));
  fs.writeFileSync(LISTINGS_CSV, lines.join("\n") + "\n");
  return records.length;
}

module.exports = {
  OUTPUT_DIR,
  LISTINGS_JSON,
  LISTINGS_CSV,
  LISTING_FIELDS,
  CSV_HEADER,
  normalizeUrl,
  recordKey,
  csvEscape,
  loadStore,
  upsert,
  markMissingInactive,
  writeStore,
};
