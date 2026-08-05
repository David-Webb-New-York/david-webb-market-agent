#!/usr/bin/env node
/**
 * David Webb Secondary Market Agent
 * -----------------------------------
 * Searches the web for David Webb pieces currently on the secondary/resale
 * market (1stDibs, auction houses, consignment dealers) and extracts
 * structured pricing data into a CSV.
 *
 * SETUP:
 *   1. npm install
 *   2. export ANTHROPIC_API_KEY=your_key_here
 *   3. node agent.js
 *
 * OUTPUT:
 *   Appends rows to ./output/david-webb-market-data.csv
 *   Each run is also saved as a timestamped JSON snapshot in ./output/snapshots
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Run: export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, "output");
const SNAPSHOT_DIR = path.join(OUTPUT_DIR, "snapshots");
const CSV_PATH = path.join(OUTPUT_DIR, "david-webb-market-data.csv");

// ---- Search queries to run each pass ----
// CORE_QUERIES are the queries that historically return results and drive
// essentially all of the collected data: 1stDibs category scans, iconic named
// pieces, and the major auction houses (Sotheby's, Christie's, Phillips).
// These run every pass.
const CORE_QUERIES = [
  // Category / iconic piece scans (1stDibs)
  "David Webb bracelet for sale 1stDibs price",
  "David Webb ring for sale 1stDibs price",
  "David Webb earrings for sale 1stDibs price",
  "David Webb brooch for sale 1stDibs price",
  "David Webb necklace for sale 1stDibs price",
  "David Webb zebra bracelet auction result price",
  "David Webb frog bracelet price",
  "David Webb cross pendant price",

  // Major auction houses
  "David Webb jewelry auction result Sotheby's sothebys.com",
  "David Webb jewelry auction result Christie's christies.com",
  "David Webb jewelry auction result Phillips phillips.com"
];

// OPTIONAL_QUERIES are dealer/auction-specific probes that have historically
// returned little or nothing (most David Webb dealer inventory already surfaces
// via the 1stDibs scans above). They are OFF by default to keep per-run cost
// down — each query is a full multi-search API call. Set INCLUDE_OPTIONAL_QUERIES=1
// for an occasional deeper sweep, and promote any dealer that starts yielding
// results up into CORE_QUERIES.
const OPTIONAL_QUERIES = [
  "David Webb jewelry auction result Doyle doyle.com",
  "David Webb jewelry auction result Rago ragoarts.com",
  "David Webb jewelry auction result Heritage ha.com",
  "David Webb jewelry for sale oakgem.com price",
  "David Webb jewelry for sale thebackvault.com price",
  "David Webb jewelry for sale vestiairecollective.com price",
  "David Webb jewelry for sale jamesedition.com price",
  "David Webb jewelry for sale rubylane.com price",
  "David Webb jewelry for sale fredleighton.com price",
  "David Webb jewelry for sale kentshire.com price",
  "David Webb jewelry for sale doyledoyle.com price",
  "David Webb jewelry for sale fdgallery.com price",
  "David Webb jewelry for sale ericoriginals.com price",
  "David Webb jewelry for sale saidiansons.com price",
  "David Webb jewelry for sale robinsonsjewelers.com price",
  "David Webb jewelry for sale legacyvintagejewels.com price",
  "David Webb jewelry for sale louismartin.com price",
  "David Webb jewelry for sale yafasignedjewels.com price",
  "David Webb jewelry for sale circajewels.com price",
  "David Webb jewelry for sale abrandtandson.com price",
  "David Webb jewelry for sale wilsonsestatejewelry.com price",
  "David Webb jewelry for sale langantiques.com price",
  "David Webb jewelry for sale estatediamondjewelry.com price",
  "David Webb jewelry for sale frankpollakandsons.com price",
  "David Webb jewelry for sale rtjewelers.com price",
  "David Webb jewelry for sale alexcooper.com price",
  "David Webb jewelry for sale syl-leeantiques.com price",
  "David Webb jewelry for sale schiffmans.com price",
  "David Webb jewelry for sale macklowegallery.com price"
];

// Cost controls (all optional; defaults preserve normal behavior):
//   INCLUDE_OPTIONAL_QUERIES=1   also run the low-yield OPTIONAL_QUERIES
//   MAX_QUERIES=<n>              only run the first n queries (handy for cheap test runs)
//   WEB_SEARCH_MAX_USES=<n>      cap web searches per query (fewer searches = lower cost)
const INCLUDE_OPTIONAL = /^(1|true|yes)$/i.test(process.env.INCLUDE_OPTIONAL_QUERIES || "");
let QUERIES = INCLUDE_OPTIONAL ? [...CORE_QUERIES, ...OPTIONAL_QUERIES] : [...CORE_QUERIES];

const MAX_QUERIES = parseInt(process.env.MAX_QUERIES || "", 10);
if (Number.isFinite(MAX_QUERIES) && MAX_QUERIES > 0) QUERIES = QUERIES.slice(0, MAX_QUERIES);

const WEB_SEARCH_MAX_USES = parseInt(process.env.WEB_SEARCH_MAX_USES || "", 10);
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" };
if (Number.isFinite(WEB_SEARCH_MAX_USES) && WEB_SEARCH_MAX_USES > 0) {
  WEB_SEARCH_TOOL.max_uses = WEB_SEARCH_MAX_USES;
}

const CSV_HEADER = [
  "date_pulled",
  "query",
  "piece_name",
  "category",
  "era_or_year",
  "materials_gemstones",
  "asking_or_hammer_price",
  "price_type",
  "source_site",
  "listing_url",
  "notes"
];

function ensureDirs() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, CSV_HEADER.join(",") + "\n");
  }
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val).replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

function appendRowsToCsv(rows) {
  const lines = rows.map((row) =>
    CSV_HEADER.map((col) => csvEscape(row[col])).join(",")
  );
  fs.appendFileSync(CSV_PATH, lines.join("\n") + "\n");
}

const PIECE_FIELDS = [
  "piece_name",
  "category",
  "era_or_year",
  "materials_gemstones",
  "asking_or_hammer_price",
  "price_type",
  "source_site",
  "listing_url",
  "notes"
];

const SYSTEM_PROMPT = `You are a market research assistant for David Webb, a luxury jewelry house.
You will be given a search query. Use web search to find CURRENT listings or recent auction
results for David Webb jewelry pieces matching that query.

For each distinct piece you find (max 8), extract:
- piece_name: short descriptive name
- category: bracelet, ring, earrings, brooch, necklace, other
- era_or_year: approximate era/year if stated (e.g. "1960s", "circa 1970"), else ""
- materials_gemstones: brief description (e.g. "18k gold, enamel, diamonds")
- asking_or_hammer_price: numeric price in USD, no symbols or commas (use 0 if unknown)
- price_type: "asking" (dealer listing) or "hammer" (auction result) or "estimate" (auction estimate)
- source_site: domain name (e.g. "1stdibs.com", "sothebys.com")
- listing_url: direct URL to the listing if available, else ""
- notes: anything notable (condition, provenance, signature details)

CRITICAL OUTPUT RULES:
- Your FINAL message must be ONLY a valid JSON array. Nothing else.
- Do not write explanations, summaries, or sentences like "Based on..." before or after the JSON.
- Do not wrap the JSON in markdown fences.
- If you find nothing relevant, output exactly: []`;

async function callClaude({ messages, tools, maxTokens = 4000 }) {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages
  };
  if (tools) body.tools = tools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText}`);
  }

  return res.json();
}

function stripCodeFences(text) {
  return String(text || "")
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Pull a JSON array out of model text that may include prose or fences.
 * Tries full parse, then first-to-last bracket slice, then balanced scan.
 */
function extractJsonArray(text) {
  const cleaned = stripCodeFences(text);
  if (!cleaned) return null;

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {
    /* continue */
  }

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      /* continue */
    }
  }

  // Balanced-bracket scan for the first array that parses
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== "[") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cleaned.slice(i, j + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch (_) {
            break;
          }
        }
      }
    }
  }

  return null;
}

function parsePiecesFromResponse(data) {
  const textBlocks = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter(Boolean);

  if (textBlocks.length === 0) return { pieces: null, raw: "" };

  // Prefer the last text block (often the final answer after tool use),
  // then earlier blocks, then the combined text.
  const candidates = [
    textBlocks[textBlocks.length - 1],
    ...textBlocks.slice(0, -1).reverse(),
    textBlocks.join("\n")
  ];

  for (const candidate of candidates) {
    const pieces = extractJsonArray(candidate);
    if (pieces) return { pieces, raw: candidate };
  }

  return { pieces: null, raw: textBlocks.join("\n") };
}

function normalizePieces(pieces) {
  if (!Array.isArray(pieces)) return [];
  return pieces
    .filter((p) => p && typeof p === "object")
    .map((p) => {
      const row = {};
      for (const field of PIECE_FIELDS) {
        row[field] = p[field] ?? "";
      }
      return row;
    });
}

/**
 * Ask Claude once more (no web search) to turn prose into the JSON array.
 */
async function recoverJsonFromProse(query, rawText) {
  const data = await callClaude({
    maxTokens: 4000,
    messages: [
      {
        role: "user",
        content:
          `The research notes below were collected for this search query:\n` +
          `Search query: ${query}\n\n` +
          `Research notes:\n${rawText.slice(0, 12000)}\n\n` +
          `Convert them into the required JSON array of David Webb pieces. ` +
          `Output ONLY the JSON array (or [] if nothing usable).`
      }
    ]
  });

  const { pieces } = parsePiecesFromResponse(data);
  return pieces;
}

/**
 * Calls Claude with the web_search tool for a single query, asking it to
 * return structured JSON of any David Webb pieces + prices it finds.
 */
async function runQuery(query) {
  let data;
  try {
    data = await callClaude({
      messages: [
        {
          role: "user",
          content:
            `Search query: ${query}\n\n` +
            `After searching, respond with ONLY a JSON array of matching pieces ` +
            `(max 8), using the required fields. No prose.`
        }
      ],
      tools: [WEB_SEARCH_TOOL]
    });
  } catch (err) {
    console.error(`  API error for query "${query}": ${err.message}`);
    return [];
  }

  let { pieces, raw } = parsePiecesFromResponse(data);

  if (!pieces) {
    console.warn(`  Non-JSON reply for "${query}"; attempting recovery...`);
    try {
      pieces = await recoverJsonFromProse(query, raw);
    } catch (err) {
      console.error(`  Recovery API error for "${query}": ${err.message}`);
      pieces = null;
    }
  }

  if (!pieces) {
    console.error(`  Failed to parse JSON for query "${query}"`);
    console.error("  Raw response:", stripCodeFences(raw).slice(0, 500));
    return [];
  }

  return normalizePieces(pieces);
}

async function main() {
  ensureDirs();

  const today = new Date().toISOString().slice(0, 10);
  const allResults = [];

  console.log(`Running David Webb market scan — ${today}`);
  console.log(`${QUERIES.length} queries queued\n`);

  for (const query of QUERIES) {
    console.log(`Searching: ${query}`);
    const pieces = await runQuery(query);
    console.log(`  -> found ${pieces.length} piece(s)`);

    for (const piece of pieces) {
      allResults.push({
        date_pulled: today,
        query,
        ...piece
      });
    }

    // Small delay to be polite to the API / avoid rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  if (allResults.length === 0) {
    console.log("\nNo results found this run.");
    return;
  }

  appendRowsToCsv(allResults);

  const snapshotPath = path.join(SNAPSHOT_DIR, `${today}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(allResults, null, 2));

  console.log(`\nDone. ${allResults.length} pieces logged.`);
  console.log(`CSV:      ${CSV_PATH}`);
  console.log(`Snapshot: ${snapshotPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
