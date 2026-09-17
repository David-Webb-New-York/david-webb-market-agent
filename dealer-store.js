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
const { inferTags } = require("./infer-tags");
const { toUsd } = require("./convert-currency");
const { mergeFields, initialSnapshot } = require("./field-merge");
const { loadConflicts, saveConflicts } = require("./conflict-store");

const OUTPUT_DIR = path.join(__dirname, "output");
const LISTINGS_JSON = path.join(OUTPUT_DIR, "david-webb-dealer-listings.json");
const LISTINGS_CSV = path.join(OUTPUT_DIR, "david-webb-dealer-listings.csv");
const LISTINGS_CONFLICTS_JSON = path.join(OUTPUT_DIR, "dealer-field-conflicts.json");

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
  "history_notes",
  "tags",
  "asking_price_usd",
];

const CSV_HEADER = ["id", ...LISTING_FIELDS, "source", "first_seen", "last_seen", "times_seen", "status"];

// tags and asking_price_usd are fully derived (recomputed below on every
// upsert) -- see history-store.js's DIFFABLE_FIELDS for the reasoning.
const DIFFABLE_FIELDS = LISTING_FIELDS.filter((f) => f !== "tags" && f !== "asking_price_usd");

let conflictsCache = null;
function conflicts() {
  if (!conflictsCache) conflictsCache = loadConflicts(LISTINGS_CONFLICTS_JSON);
  return conflictsCache;
}

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

// The dealer+sku and dealer+name forms -- computed regardless of whether
// a URL is present, so a record captured under a weaker key can still be
// found once a stronger one becomes available (see recordKey()).
function skuKey(r) {
  const dealer = (r.dealer || "").toLowerCase().trim();
  return r.sku ? `sku:${dealer}|${String(r.sku).toLowerCase().trim()}` : null;
}
function nameKey(r) {
  const dealer = (r.dealer || "").toLowerCase().trim();
  const name = (r.piece_name || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `meta:${dealer}|${name}`;
}

// Stable identity: listing URL if present, else dealer+sku, else dealer+name.
function recordKey(r) {
  const url = normalizeUrl(r.listing_url);
  if (url) return "url:" + url;
  return skuKey(r) || nameKey(r);
}

// asking_price_usd is fully derived (like tags) -- see history-store.js's
// usdPrice() for the reasoning. Every dealer source is USD-only today, so
// this is currently always a passthrough; kept symmetric with the auction
// side so a future foreign-currency dealer source doesn't reintroduce the
// same unconverted-price bug. Uses first_seen (falls back to today) as
// the reference date since this is a current asking price, not a
// historical settlement.
function usdPrice(r, today) {
  const converted = toUsd(r.asking_price, r.currency_note, r.first_seen || today);
  if (converted !== null) return converted;
  const n = Number(r.asking_price);
  return Number.isFinite(n) && n > 0 ? n : "";
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

  // A record captured under a weaker key (name-only, then sku, then url)
  // needs to still be found once a stronger one becomes available --
  // otherwise it silently duplicates instead of merging into the original.
  let existingKey = map.has(key) ? key : null;
  if (!existingKey) {
    for (const fallback of [skuKey(record), nameKey(record)]) {
      if (fallback && fallback !== key && map.has(fallback)) {
        existingKey = fallback;
        break;
      }
    }
  }

  if (existingKey) {
    const prev = map.get(existingKey);
    // Three-way merge per field -- see field-merge.js. Preserves a manual
    // edit unless nobody has touched it since the source last supplied a
    // value, in which case the source's update applies safely.
    const merged = mergeFields(prev, clean, DIFFABLE_FIELDS, conflicts(), prev.piece_name || clean.piece_name);
    merged.id = key;
    merged.source = prev.source || source;
    merged.first_seen = prev.first_seen || today;
    merged.last_seen = today;
    merged.times_seen = (Number(prev.times_seen) || 0) + (prev.last_seen === today ? 0 : 1);
    merged.status = "active";
    // tags is fully derived -- always recompute from the final merged text
    // rather than carrying over whichever side's (likely empty) raw value won.
    merged.tags = inferTags(`${merged.piece_name} ${merged.notes}`, merged.era_or_year).join("; ");
    merged.asking_price_usd = usdPrice(merged, today);
    if (existingKey !== key) map.delete(existingKey);
    map.set(key, merged);
    return false;
  }

  clean.source = source;
  clean.first_seen = today;
  clean.last_seen = today;
  clean.times_seen = 1;
  clean.status = "active";
  clean._source_snapshot = initialSnapshot(clean, DIFFABLE_FIELDS);
  clean.tags = inferTags(`${clean.piece_name} ${clean.notes}`, clean.era_or_year).join("; ");
  clean.asking_price_usd = usdPrice(clean, today);
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
    (a, b) => (Number(b.asking_price_usd) || 0) - (Number(a.asking_price_usd) || 0)
  );
  saveConflicts(LISTINGS_CONFLICTS_JSON, conflicts());
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
  LISTINGS_CONFLICTS_JSON,
  LISTING_FIELDS,
  DIFFABLE_FIELDS,
  CSV_HEADER,
  normalizeUrl,
  recordKey,
  skuKey,
  nameKey,
  csvEscape,
  loadStore,
  upsert,
  markMissingInactive,
  writeStore,
};
