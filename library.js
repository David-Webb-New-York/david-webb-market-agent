#!/usr/bin/env node
/**
 * David Webb Secondary Market — Library builder (dedup / "silver" layer)
 * ---------------------------------------------------------------------
 * The raw CSV (output/david-webb-market-data.csv) is an append-only log — one
 * row every time a piece is seen in any scan (your Fabric "bronze" source).
 *
 * This script folds every per-run snapshot into a DEDUPLICATED catalog keyed by
 * a stable id (the listing URL when present, else a source+name+price fallback),
 * tracking each piece's lifecycle over time:
 *   - first_seen / last_seen / times_seen (distinct scan dates)
 *   - status: "active" (present in the latest scan) or "inactive" (gone)
 *   - first_price / current_price / min_price / max_price
 *
 * It is idempotent: it rebuilds the library from scratch from the snapshots on
 * every run, so it also backfills history from whatever snapshots already exist.
 *
 * OUTPUT:
 *   output/david-webb-library.json   (array of catalog records)
 *   output/david-webb-library.csv    (same, for Excel / Power BI / Fabric silver)
 */

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");
const SNAPSHOT_DIR = path.join(OUTPUT_DIR, "snapshots");
const LIB_JSON = path.join(OUTPUT_DIR, "david-webb-library.json");
const LIB_CSV = path.join(OUTPUT_DIR, "david-webb-library.csv");

const LIB_HEADER = [
  "id",
  "piece_name",
  "category",
  "era_or_year",
  "materials_gemstones",
  "price_type",
  "source_site",
  "listing_url",
  "first_price",
  "current_price",
  "min_price",
  "max_price",
  "first_seen",
  "last_seen",
  "times_seen",
  "status",
  "notes",
];

function listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort(); // YYYY-MM-DD.json sorts chronologically (oldest -> newest)
}

function loadSnapshot(file) {
  const pieces = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, file), "utf8"));
  return Array.isArray(pieces) ? pieces : [];
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

// Stable identity for a piece. Prefer the listing URL; otherwise fall back to a
// source + name + price-type + price composite (best-effort for auction results
// that often have no public URL).
function pieceKey(p) {
  const url = normalizeUrl(p.listing_url);
  if (url) return "url:" + url;
  const name = (p.piece_name || "").toLowerCase().replace(/\s+/g, " ").trim();
  const src = (p.source_site || "").toLowerCase().trim();
  const price = Number(p.asking_or_hammer_price) || 0;
  return `meta:${src}|${name}|${(p.price_type || "").toLowerCase()}|${price}`;
}

function validPrice(p) {
  const n = Number(p.asking_or_hammer_price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val).replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

function buildLibrary() {
  const snaps = listSnapshots();
  if (snaps.length === 0) {
    console.error(`No snapshots found in ${SNAPSHOT_DIR}. Run agent.js first.`);
    process.exit(1);
  }
  const latestDate = snaps[snaps.length - 1].replace(/\.json$/, "");

  const lib = new Map();
  let rawRows = 0;

  for (const file of snaps) {
    const date = file.replace(/\.json$/, "");
    for (const p of loadSnapshot(file)) {
      rawRows++;
      const key = pieceKey(p);
      const price = validPrice(p);
      let rec = lib.get(key);
      if (!rec) {
        rec = {
          id: key,
          piece_name: p.piece_name || "",
          category: p.category || "",
          era_or_year: p.era_or_year || "",
          materials_gemstones: p.materials_gemstones || "",
          price_type: p.price_type || "",
          source_site: p.source_site || "",
          listing_url: p.listing_url || "",
          first_price: price,
          current_price: price,
          min_price: price,
          max_price: price,
          first_seen: date,
          last_seen: date,
          notes: p.notes || "",
          _dates: new Set([date]),
        };
        lib.set(key, rec);
      } else {
        // Snapshots iterate oldest -> newest, so latest values win.
        rec.last_seen = date;
        rec._dates.add(date);
        if (p.piece_name) rec.piece_name = p.piece_name;
        if (p.category) rec.category = p.category;
        if (p.era_or_year) rec.era_or_year = p.era_or_year;
        if (p.materials_gemstones) rec.materials_gemstones = p.materials_gemstones;
        if (p.price_type) rec.price_type = p.price_type;
        if (p.source_site) rec.source_site = p.source_site;
        if (p.listing_url) rec.listing_url = p.listing_url;
        if (p.notes) rec.notes = p.notes;
        if (price !== null) {
          rec.current_price = price;
          rec.min_price = rec.min_price === null ? price : Math.min(rec.min_price, price);
          rec.max_price = rec.max_price === null ? price : Math.max(rec.max_price, price);
        }
      }
    }
  }

  const records = [...lib.values()]
    .map((r) => {
      const { _dates, ...rest } = r;
      return {
        ...rest,
        times_seen: _dates.size,
        status: r.last_seen === latestDate ? "active" : "inactive",
      };
    })
    .sort((a, b) => (b.current_price || 0) - (a.current_price || 0) || a.piece_name.localeCompare(b.piece_name));

  return { records, rawRows, latestDate, snapshotCount: snaps.length };
}

function writeOutputs(records) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(LIB_JSON, JSON.stringify(records, null, 2) + "\n");
  const lines = [LIB_HEADER.join(",")];
  for (const r of records) {
    lines.push(LIB_HEADER.map((col) => csvEscape(r[col])).join(","));
  }
  fs.writeFileSync(LIB_CSV, lines.join("\n") + "\n");
}

function main() {
  const { records, rawRows, latestDate, snapshotCount } = buildLibrary();
  writeOutputs(records);

  const active = records.filter((r) => r.status === "active").length;
  const inactive = records.length - active;
  const newInLatest = records.filter((r) => r.first_seen === latestDate).length;

  console.log(`Library rebuilt from ${snapshotCount} snapshot(s):`);
  console.log(`  raw sightings:        ${rawRows}`);
  console.log(`  unique pieces:        ${records.length}  (deduped ${rawRows - records.length} repeat sightings)`);
  console.log(`  active (in ${latestDate}): ${active}`);
  console.log(`  inactive (gone):      ${inactive}`);
  console.log(`  new in ${latestDate}:      ${newInLatest}`);
  console.log(`Wrote ${LIB_JSON}`);
  console.log(`Wrote ${LIB_CSV}`);
}

main();
