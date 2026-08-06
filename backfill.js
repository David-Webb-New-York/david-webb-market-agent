#!/usr/bin/env node
/**
 * David Webb Secondary Market — Historical Auction Backfill
 * ---------------------------------------------------------
 * A ONE-TIME (or occasional) pass that builds a historical record of PAST
 * David Webb auction results — the sales history our weekly "current listings"
 * scan does not reach. It targets the auction aggregators (LiveAuctioneers,
 * Invaluable, Barnebys) and the houses directly (Sotheby's, Christie's,
 * Phillips, Bonhams, Doyle, Rago, Heritage, Freeman's|Hindman).
 *
 * This is intentionally SEPARATE from the active-listings library:
 *   - output/david-webb-library.{json,csv}          = active dealer listings (from weekly scans)
 *   - output/david-webb-auction-history.{json,csv}  = past sold/estimated auction lots (this script)
 * Together they form the full "library". Both are natural Fabric sources.
 *
 * It is safe to re-run: results are merged/deduped into the history file (keyed
 * by listing URL, else house+lot+sale_date+name), so a later, broader pass just
 * extends the record.
 *
 * SETUP:  export ANTHROPIC_API_KEY=sk-ant-...   then:  node backfill.js
 *
 * COST CONTROLS (env):
 *   MAX_QUERIES=<n>            only run the first n queries (use 1 for a cheap test)
 *   WEB_SEARCH_MAX_USES=<n>    web searches per query (default 5 — archives need digging)
 *   MAX_PIECES_PER_QUERY=<n>   cap pieces requested per query (default 20)
 *   BACKFILL_DRY_RUN=1         call the API but do NOT write the history files
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Run: export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, "output");
const HISTORY_JSON = path.join(OUTPUT_DIR, "david-webb-auction-history.json");
const HISTORY_CSV = path.join(OUTPUT_DIR, "david-webb-auction-history.csv");

const WEB_SEARCH_MAX_USES = parseInt(process.env.WEB_SEARCH_MAX_USES || "5", 10);
const MAX_PIECES_PER_QUERY = parseInt(process.env.MAX_PIECES_PER_QUERY || "20", 10);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.BACKFILL_DRY_RUN || "");

// Rago is first so a MAX_QUERIES=1 test directly probes the example the library
// is meant to capture (Rago has many past David Webb lots).
const HISTORY_QUERIES = [
  "David Webb jewelry auction results Rago ragoarts.com sold price lot",
  "David Webb jewelry sold auction results liveauctioneers.com",
  "David Webb jewelry past auction results invaluable.com hammer price",
  "David Webb jewelry auction results barnebys.com",
  "David Webb Sotheby's past auction results jewelry hammer price lot",
  "David Webb Christie's past auction results jewelry lot sold",
  "David Webb Phillips past auction results jewelry sold",
  "David Webb Bonhams auction results jewelry sold price",
  "David Webb Doyle auction results jewelry sold lot",
  "David Webb Heritage auction results jewelry ha.com sold",
  "David Webb Freeman's Hindman auction results jewelry sold",
  "David Webb bracelet auction result sold price history",
  "David Webb brooch auction result sold price history",
  "David Webb ring auction result sold price history",
  "David Webb necklace auction result sold price history",
  "David Webb earrings auction result sold price history",
];

let QUERIES = [...HISTORY_QUERIES];
const MAX_QUERIES = parseInt(process.env.MAX_QUERIES || "", 10);
if (Number.isFinite(MAX_QUERIES) && MAX_QUERIES > 0) QUERIES = QUERIES.slice(0, MAX_QUERIES);

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
];

const CSV_HEADER = ["id", ...HISTORY_FIELDS, "first_captured"];

const SYSTEM_PROMPT = `You are a jewelry auction historian building a record of PAST David Webb auction results.
Given a search query, use web search to find COMPLETED/PAST auction lots for David Webb jewelry
(sold results and, where sold data is unavailable, pre-sale estimates).

For each distinct lot you find (max ${MAX_PIECES_PER_QUERY}), extract:
- piece_name: short descriptive name
- category: bracelet, ring, earrings, brooch, necklace, other
- era_or_year: era/creation year of the PIECE if stated (e.g. "1970s"), else ""
- materials_gemstones: brief description
- price_type: "hammer" (realized/sold price) or "estimate" (only pre-sale estimate known)
- sold_price: realized price in USD, numeric, no symbols/commas (0 if only an estimate is known)
- estimate_low: low pre-sale estimate in USD numeric (0 if unknown)
- estimate_high: high pre-sale estimate in USD numeric (0 if unknown)
- currency_note: if the original figure was not USD, note it (e.g. "GBP 40,000 hammer"), else ""
- sale_date: date of the SALE if known (YYYY-MM-DD or YYYY), else ""
- auction_house: e.g. "Sotheby's", "Rago", "Christie's"
- sale_name: sale/auction title if stated (e.g. "Magnificent Jewels"), else ""
- lot_number: lot number if stated, else ""
- listing_url: direct URL to the lot/result if available, else ""
- notes: anything notable (provenance, signature, condition, premium exclusions)

CRITICAL OUTPUT RULES:
- Your FINAL message must be ONLY a valid JSON array. Nothing else.
- No prose, no markdown fences, no "Based on..." text.
- Only include PAST/COMPLETED auction lots (not current dealer listings for sale).
- If you find nothing relevant, output exactly: []`;

// ---------- Claude + JSON extraction (same robust approach as agent.js) ----------

async function callClaude({ messages, tools, maxTokens = 4000 }) {
  const body = { model: "claude-sonnet-4-6", max_tokens: maxTokens, system: SYSTEM_PROMPT, messages };
  if (tools) body.tools = tools;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

function stripCodeFences(text) {
  return String(text || "").replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
}

function extractJsonArray(text) {
  const cleaned = stripCodeFences(text);
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return null;
}

function parsePieces(data) {
  const texts = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).filter(Boolean);
  const candidates = [texts[texts.length - 1], ...texts.slice(0, -1).reverse(), texts.join("\n")];
  for (const c of candidates) {
    const arr = extractJsonArray(c);
    if (arr) return arr;
  }
  return null;
}

function normalizeRecord(p) {
  const rec = {};
  for (const f of HISTORY_FIELDS) rec[f] = p[f] ?? "";
  // Coerce numeric fields
  for (const f of ["sold_price", "estimate_low", "estimate_high"]) {
    const n = Number(rec[f]);
    rec[f] = Number.isFinite(n) && n > 0 ? n : "";
  }
  if (!rec.auction_house && rec.source_site) rec.auction_house = rec.source_site;
  return rec;
}

// ---------- dedup key + merge ----------

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

function recordKey(r) {
  const url = normalizeUrl(r.listing_url);
  if (url) return "url:" + url;
  const house = (r.auction_house || "").toLowerCase().trim();
  const lot = String(r.lot_number || "").toLowerCase().trim();
  const date = String(r.sale_date || "").trim();
  const name = (r.piece_name || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `meta:${house}|${lot}|${date}|${name}`;
}

function loadExisting() {
  if (!fs.existsSync(HISTORY_JSON)) return new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_JSON, "utf8"));
    return new Map(arr.map((r) => [r.id || recordKey(r), r]));
  } catch (_) {
    return new Map();
  }
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val).replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

function writeOutputs(map) {
  const records = [...map.values()].sort(
    (a, b) => (Number(b.sold_price) || 0) - (Number(a.sold_price) || 0)
  );
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_JSON, JSON.stringify(records, null, 2) + "\n");
  const lines = [CSV_HEADER.join(",")];
  for (const r of records) lines.push(CSV_HEADER.map((c) => csvEscape(r[c])).join(","));
  fs.writeFileSync(HISTORY_CSV, lines.join("\n") + "\n");
  return records.length;
}

// ---------- run ----------

async function runQuery(query) {
  const tool = { type: "web_search_20250305", name: "web_search" };
  if (Number.isFinite(WEB_SEARCH_MAX_USES) && WEB_SEARCH_MAX_USES > 0) tool.max_uses = WEB_SEARCH_MAX_USES;
  let data;
  try {
    data = await callClaude({
      messages: [
        {
          role: "user",
          content:
            `Search query: ${query}\n\n` +
            `Find PAST David Webb auction results. Respond with ONLY a JSON array of lots ` +
            `(max ${MAX_PIECES_PER_QUERY}), using the required fields. No prose.`,
        },
      ],
      tools: [tool],
    });
  } catch (err) {
    console.error(`  API error for "${query}": ${err.message}`);
    return [];
  }
  const pieces = parsePieces(data);
  if (!pieces) {
    console.error(`  Could not parse JSON for "${query}"`);
    return [];
  }
  return pieces.filter((p) => p && typeof p === "object").map(normalizeRecord);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const store = loadExisting();
  const before = store.size;

  console.log(`David Webb historical auction backfill — ${today}`);
  console.log(`${QUERIES.length} query(ies); web_search max_uses=${WEB_SEARCH_MAX_USES}; existing records=${before}\n`);

  let added = 0;
  for (const query of QUERIES) {
    console.log(`Searching: ${query}`);
    const results = await runQuery(query);
    console.log(`  -> ${results.length} lot(s)`);
    for (const r of results) {
      const key = recordKey(r);
      if (store.has(key)) {
        const merged = { ...store.get(key), ...r };
        merged.id = key;
        merged.first_captured = store.get(key).first_captured || today;
        store.set(key, merged);
      } else {
        store.set(key, { id: key, ...r, first_captured: today });
        added++;
      }
    }
    await new Promise((res) => setTimeout(res, 500));
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would write ${store.size} records (${added} new). Files not modified.`);
    return;
  }

  const total = writeOutputs(store);
  console.log(`\nDone. ${added} new lot(s) added; ${total} total historical records.`);
  console.log(`JSON: ${HISTORY_JSON}`);
  console.log(`CSV:  ${HISTORY_CSV}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
