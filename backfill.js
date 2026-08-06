#!/usr/bin/env node
/**
 * David Webb Secondary Market — Historical Auction Backfill (LLM web search)
 * --------------------------------------------------------------------------
 * A broad, fuzzy pass that uses Claude + web search to find PAST David Webb
 * auction results across many houses/aggregators at once. It is good for wide
 * coverage but NOT exhaustive per source (a web search returns only the top
 * snippets). For complete coverage of a specific source, prefer a structured
 * importer such as import-rago.js.
 *
 * Results merge into the shared auction-history dataset (see history-store.js):
 *   output/david-webb-auction-history.{json,csv}
 *
 * SETUP:  export ANTHROPIC_API_KEY=sk-ant-...   then:  node backfill.js
 *
 * COST CONTROLS (env):
 *   MAX_QUERIES=<n>            only run the first n queries (use 1 for a cheap test)
 *   WEB_SEARCH_MAX_USES=<n>    web searches per query (default 5)
 *   MAX_PIECES_PER_QUERY=<n>   cap pieces requested per query (default 20)
 *   BACKFILL_DRY_RUN=1         call the API but do NOT write the history files
 */

const store = require("./history-store");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Run: export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const WEB_SEARCH_MAX_USES = parseInt(process.env.WEB_SEARCH_MAX_USES || "5", 10);
const MAX_PIECES_PER_QUERY = parseInt(process.env.MAX_PIECES_PER_QUERY || "20", 10);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.BACKFILL_DRY_RUN || "");

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
  for (const f of store.HISTORY_FIELDS) rec[f] = p[f] ?? "";
  for (const f of ["sold_price", "estimate_low", "estimate_high"]) {
    const n = Number(rec[f]);
    rec[f] = Number.isFinite(n) && n > 0 ? n : "";
  }
  return rec;
}

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
  const map = store.loadStore();
  const before = map.size;

  console.log(`David Webb historical auction backfill — ${today}`);
  console.log(`${QUERIES.length} query(ies); web_search max_uses=${WEB_SEARCH_MAX_USES}; existing records=${before}\n`);

  let added = 0;
  for (const query of QUERIES) {
    console.log(`Searching: ${query}`);
    const results = await runQuery(query);
    console.log(`  -> ${results.length} lot(s)`);
    for (const r of results) {
      if (store.upsert(map, r, { source: "web-search", today })) added++;
    }
    await new Promise((res) => setTimeout(res, 500));
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would write ${map.size} records (${added} new). Files not modified.`);
    return;
  }

  const total = store.writeStore(map);
  console.log(`\nDone. ${added} new lot(s) added; ${total} total historical records.`);
  console.log(`JSON: ${store.HISTORY_JSON}`);
  console.log(`CSV:  ${store.HISTORY_CSV}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
