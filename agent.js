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
// Edit this list to add/remove categories or sources.
const QUERIES = [
  "David Webb bracelet for sale 1stDibs price",
  "David Webb ring for sale 1stDibs price",
  "David Webb earrings for sale 1stDibs price",
  "David Webb brooch for sale 1stDibs price",
  "David Webb necklace for sale 1stDibs price",
  "David Webb zebra bracelet auction result price",
  "David Webb Sotheby's jewelry auction result",
  "David Webb Christie's jewelry auction result",
  "David Webb frog bracelet price",
  "David Webb cross pendant price"
];

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

/**
 * Calls Claude with the web_search tool for a single query, asking it to
 * return structured JSON of any David Webb pieces + prices it finds.
 */
async function runQuery(query) {
  const systemPrompt = `You are a market research assistant for David Webb, a luxury jewelry house.
You will be given a search query. Use web search to find CURRENT listings or recent auction
results for David Webb jewelry pieces matching that query.

For each distinct piece you find (max 8), extract:
- piece_name: short descriptive name
- category: bracelet, ring, earrings, brooch, necklace, other
- era_or_year: approximate era/year if stated (e.g. "1960s", "circa 1970"), else ""
- materials_gemstones: brief description (e.g. "18k gold, enamel, diamonds")
- asking_or_hammer_price: numeric price in USD, no symbols or commas
- price_type: "asking" (dealer listing) or "hammer" (auction result) or "estimate" (auction estimate)
- source_site: domain name (e.g. "1stdibs.com", "sothebys.com")
- listing_url: direct URL to the listing if available, else ""
- notes: anything notable (condition, provenance, signature details)

Respond with ONLY a JSON array of objects with exactly these fields. No markdown fences, no preamble.
If you find nothing relevant, respond with an empty array: []`;

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: `Search query: ${query}` }],
    tools: [{ type: "web_search_20250305", name: "web_search" }]
  };

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
    console.error(`  API error for query "${query}": ${res.status} ${errText}`);
    return [];
  }

  const data = await res.json();

  // Collect all text blocks (final answer may span multiple text blocks
  // after tool use turns)
  const textBlocks = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const cleaned = textBlocks.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    console.error(`  Failed to parse JSON for query "${query}":`, err.message);
    console.error("  Raw response:", cleaned.slice(0, 500));
    return [];
  }
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
