#!/usr/bin/env node
/**
 * David Webb Secondary Market — Weekly Report & Notifier
 * --------------------------------------------------------
 * Reads the structured datasets that history-refresh.yml and
 * dealer-refresh.yml maintain (output/david-webb-auction-history.json,
 * output/david-webb-dealer-listings.json), computes accurate aggregate
 * stats in JS, and assembles the report almost entirely deterministically
 * — Claude writes exactly one paragraph (the executive summary) and a
 * short Slack summary; every table, chart, and count is computed and
 * rendered directly from the data, not narrated. This avoids any risk of
 * the model mis-stating a count or price across what can be a large
 * number of itemized rows (2026-08-13 redesign, per user request: full,
 * un-curated breakdowns of what's new/closed, not top-N highlights).
 *
 * This intentionally does NOT read output/snapshots/ (the older agent.js/
 * library.js LLM web-search pipeline) — that dataset is a different,
 * incompatible schema and isn't wired into weekly-report.yml. See
 * HANDOFF.md for the reasoning.
 *
 * This is the "Pattern A + B" handoff:
 *   A) an auto-generated written report committed to output/reports/
 *   B) a Slack message linking the report + the live database + raw CSVs
 *
 * MODES (so CI can post links only AFTER the commit is pushed):
 *   node analyze.js              generate the report AND post to Slack
 *   node analyze.js --generate   only generate report + write the Slack payload
 *   node analyze.js --notify     only post the previously-generated Slack payload
 *   node analyze.js --dry-run    never POST to Slack; print the payload instead
 *
 * ENV:
 *   ANTHROPIC_API_KEY   required for --generate (and default mode)
 *   SLACK_WEBHOOK_URL   required to actually post (omit for a dry run)
 *   GITHUB_REPOSITORY   e.g. "owner/repo" (auto-set in GitHub Actions)
 *   GITHUB_SERVER_URL   e.g. "https://github.com" (auto-set in GitHub Actions)
 *   REPORT_LINK_BRANCH  branch the committed links point at (default "main")
 *   REPORT_DATABASE_URL live database GUI URL; defaults to this repo's
 *                       GitHub Pages URL (see pages-deploy.yml), override
 *                       only if the GUI moves elsewhere
 *   REPORT_BANNER_NOTE  optional one-off banner shown at the top of the
 *                       Slack post (e.g. "this corrects an earlier post
 *                       today" or "this is an extra run this week for X")
 */

const fs = require("fs");
const path = require("path");
const { HISTORY_JSON, HISTORY_CSV } = require("./history-store");
const { LISTINGS_JSON, LISTINGS_CSV } = require("./dealer-store");
const { computeFlags } = require("./flag-listings");

const args = new Set(process.argv.slice(2));
const MODE_GENERATE = args.has("--generate") || !args.has("--notify");
const MODE_NOTIFY = args.has("--notify") || !args.has("--generate");
const DRY_RUN = args.has("--dry-run");

const OUTPUT_DIR = path.join(__dirname, "output");
const REPORTS_DIR = path.join(OUTPUT_DIR, "reports");
const STATS_HISTORY_JSON = path.join(REPORTS_DIR, "stats-history.json");
const FLAGGED_LISTINGS_JSON = path.join(OUTPUT_DIR, "flagged-listings.json");
const MAX_STATS_HISTORY = 26; // ~6 months of weekly runs

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

const REPO = process.env.GITHUB_REPOSITORY || "David-Webb-New-York/david-webb-market-agent";
const SERVER = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
const BRANCH = process.env.REPORT_LINK_BRANCH || "main";
const DATABASE_URL =
  process.env.REPORT_DATABASE_URL ||
  `https://${REPO.split("/")[0].toLowerCase()}.github.io/${REPO.split("/")[1]}/`;

// ---------- data loading ----------

function loadJson(p) {
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------- shared formatting helpers ----------

function money(n) {
  return n === null || n === undefined ? "n/a" : "$" + Math.round(n).toLocaleString("en-US");
}

function cap(s) {
  const str = String(s || "");
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// When a record's native currency wasn't USD, footnote the original figure
// -- `price` is already the accurate USD-converted number (convert-currency.js).
function nativeSuffix(native) {
  return native ? ` (orig. ${native.currency} ${Math.round(native.amount).toLocaleString("en-US")})` : "";
}

function niceCeil(value, step) {
  return Math.max(step, Math.ceil((value * 1.15) / step) * step);
}

// ---------- aggregate stats (computed in JS so numbers are trustworthy) ----------

// A real David Webb piece essentially never transacts under this --
// below it is almost always a placeholder ("price on request", a Shopify
// $1/$0.01 "sold out" stand-in) rather than a genuine price. Confirmed via
// a real $1 "sold out" placeholder corrupting a category's min-price stat
// (see the same guard, and the reasoning, in flag-listings.js).
const MIN_PLAUSIBLE_PRICE = 50;
const FOUR_WEEKS = 28;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= MIN_PLAUSIBLE_PRICE ? n : null;
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function byCategoryStats(records, priceField) {
  const groups = new Map();
  for (const r of records) {
    const p = num(r[priceField]);
    if (p === null) continue;
    const cat = r.category || "Uncategorized";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(p);
  }
  return [...groups.entries()]
    .map(([category, prices]) => ({
      category,
      count: prices.length,
      min: Math.min(...prices),
      median: median(prices),
      max: Math.max(...prices),
    }))
    .sort((a, b) => b.count - a.count);
}

// Same shape as byCategoryStats, but a record can carry multiple tags
// (piece_name/notes tagged with e.g. both "Zodiac" and "1970s"), so this
// is a one-to-many grouping rather than category's one-to-one.
function byTagStats(records, priceField) {
  const groups = new Map();
  for (const r of records) {
    const p = num(r[priceField]);
    if (p === null) continue;
    for (const tag of String(r.tags || "").split("; ").filter(Boolean)) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(p);
    }
  }
  return [...groups.entries()]
    .map(([tag, prices]) => ({
      tag,
      count: prices.length,
      min: Math.min(...prices),
      median: median(prices),
      max: Math.max(...prices),
    }))
    .sort((a, b) => b.count - a.count);
}

function byDealerStats(records, priceField) {
  const groups = new Map();
  for (const r of records) {
    const p = num(r[priceField]);
    if (p === null) continue;
    const dealer = r.dealer || "Unknown";
    if (!groups.has(dealer)) groups.set(dealer, []);
    groups.get(dealer).push(p);
  }
  return [...groups.entries()]
    .map(([dealer, prices]) => ({ dealer, count: prices.length, median: median(prices) }))
    .sort((a, b) => b.count - a.count);
}

// A flat min/median/max table hides the shape of the distribution --
// confirmed the real distribution is meaningfully right-skewed (median
// ~$25K, max into the $400Ks), so "most pieces sit in the lower bands"
// is a real pattern a plain table doesn't show. This buckets active
// dealer inventory into price bands for a histogram chart instead.
const PRICE_BANDS = [
  { label: "Under $5K", min: 0, max: 5000 },
  { label: "$5K–$15K", min: 5000, max: 15000 },
  { label: "$15K–$30K", min: 15000, max: 30000 },
  { label: "$30K–$60K", min: 30000, max: 60000 },
  { label: "$60K–$120K", min: 60000, max: 120000 },
  { label: "$120K+", min: 120000, max: Infinity },
];

function priceHistogram(records, priceField) {
  const counts = PRICE_BANDS.map(() => 0);
  for (const r of records) {
    const p = num(r[priceField]);
    if (p === null) continue;
    const idx = PRICE_BANDS.findIndex((b) => p >= b.min && p < b.max);
    if (idx >= 0) counts[idx]++;
  }
  return PRICE_BANDS.map((b, i) => ({ label: b.label, count: counts[i] }));
}

function nativeAmount(r, nativePriceField) {
  const cur = String(r.currency_note || "").toUpperCase().trim();
  const amount = Number(r[nativePriceField]);
  if (!cur || cur === "USD" || !Number.isFinite(amount) || amount <= 0) return null;
  return { amount: Math.round(amount), currency: cur };
}

function pickAuctionFields(r) {
  return {
    piece: r.piece_name,
    category: r.category,
    house: r.auction_house,
    sale_date: r.sale_date,
    price: num(r.sold_price_usd),
    native: nativeAmount(r, "sold_price"),
    url: r.listing_url,
  };
}

function pickDealerFields(r) {
  return {
    piece: r.piece_name,
    category: r.category,
    dealer: r.dealer,
    price: num(r.asking_price_usd),
    native: nativeAmount(r, "asking_price"),
    url: r.listing_url,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  };
}

function computeStats(history, dealers, today) {
  const fourWeeksAgo = daysAgoStr(FOUR_WEEKS);
  const recentSaleWindow = daysAgoStr(60);

  const newAuctionRecords = history.filter((r) => (r.first_captured || "") >= fourWeeksAgo);
  const activeDealerListings = dealers.filter((r) => r.status === "active");

  // "New" and "closed" are reported in full, not top-N -- these are
  // naturally bounded windows (4 weeks), unlike "currently available"
  // (which can be thousands of records and gets a stats breakdown
  // instead of an item-by-item list).
  const newDealerListings4wk = dealers
    .filter((r) => (r.first_seen || "") >= fourWeeksAgo)
    .map(pickDealerFields)
    .sort((a, b) => (b.first_seen || "").localeCompare(a.first_seen || ""));
  const closedDealerListings4wk = dealers
    .filter((r) => r.status === "inactive" && (r.last_seen || "") >= fourWeeksAgo)
    .map(pickDealerFields)
    .sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));

  const soldRecords = history.filter((r) => num(r.sold_price_usd) !== null);
  const recentSaleRecords = soldRecords
    .filter((r) => (r.sale_date || "") >= recentSaleWindow)
    .sort((a, b) => (b.sale_date || "").localeCompare(a.sale_date || ""));
  const topSalesEver = [...soldRecords]
    .sort((a, b) => num(b.sold_price_usd) - num(a.sold_price_usd))
    .slice(0, 5)
    .map(pickAuctionFields);

  return {
    date: today,
    isBaselineRun: history.length > 0 && newAuctionRecords.length === history.length,
    totals: {
      auctionRecords: history.length,
      dealerRecords: dealers.length,
      activeDealerListings: activeDealerListings.length,
    },
    newDealerListings4wk,
    closedDealerListings4wk,
    recentSales: {
      windowDays: 60,
      count: recentSaleRecords.length,
      median: median(recentSaleRecords.map((r) => num(r.sold_price_usd)).filter((n) => n !== null)),
      items: recentSaleRecords.map(pickAuctionFields),
    },
    topSalesEver,
    auctionByCategory: byCategoryStats(soldRecords, "sold_price_usd"),
    dealerByCategory: byCategoryStats(activeDealerListings, "asking_price_usd"),
    auctionByTag: byTagStats(soldRecords, "sold_price_usd").filter((t) => t.count >= 5),
    dealerByTag: byTagStats(activeDealerListings, "asking_price_usd").filter((t) => t.count >= 5),
    dealerByDealer: byDealerStats(activeDealerListings, "asking_price_usd"),
    dealerHistogram: priceHistogram(activeDealerListings, "asking_price_usd"),
    dealerAskingMedian: median(
      activeDealerListings.map((r) => num(r.asking_price_usd)).filter((n) => n !== null)
    ),
  };
}

// ---------- longitudinal history (kept for future use; not currently rendered) ----------

function loadStatsHistory() {
  return loadJson(STATS_HISTORY_JSON);
}

// The "Week-over-week trends" section was cut (2026-08-13, user feedback:
// "just isn't useful") -- this longitudinal file is still written each
// run, cheaply, since it's a real historical record that might be worth
// revisiting later; it just isn't rendered into the report anymore.
function appendStatsHistory(stats) {
  const history = loadStatsHistory().filter((s) => s.date !== stats.date);
  history.push({
    date: stats.date,
    auctionRecords: stats.totals.auctionRecords,
    dealerRecords: stats.totals.dealerRecords,
    activeDealerListings: stats.totals.activeDealerListings,
    newDealerListings4wk: stats.newDealerListings4wk.length,
    closedDealerListings4wk: stats.closedDealerListings4wk.length,
    dealerAskingMedian: stats.dealerAskingMedian,
    recentSalesMedian: stats.recentSales.median,
  });
  history.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = history.slice(-MAX_STATS_HISTORY);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(STATS_HISTORY_JSON, JSON.stringify(trimmed, null, 2) + "\n");
  return trimmed;
}

// ---------- deterministic report sections ----------

function renderCurrentlyAvailable(activeCount, byCategory, byDealer, histogram) {
  const top = niceCeil(Math.max(...histogram.map((b) => b.count), 1), 50);
  const chart = [
    "```mermaid",
    "xychart-beta",
    '    title "Current dealer inventory by asking price"',
    `    x-axis [${histogram.map((b) => `"${b.label}"`).join(", ")}]`,
    `    y-axis "Listings" 0 --> ${top}`,
    `    bar [${histogram.map((b) => b.count).join(", ")}]`,
    "```",
  ].join("\n");

  const catTable = [
    "| Category | Count | Min | Median | Max |",
    "|---|---|---|---|---|",
    ...byCategory.map(
      (c) => `| ${cap(c.category)} | ${c.count} | ${money(c.min)} | ${money(c.median)} | ${money(c.max)} |`
    ),
  ].join("\n");

  const dealerTable = [
    "| Dealer | Active Listings | Median Asking |",
    "|---|---|---|",
    ...byDealer.map((d) => `| ${d.dealer} | ${d.count} | ${money(d.median)} |`),
  ].join("\n");

  return [
    "## Currently Available",
    "",
    `_${activeCount.toLocaleString()} active listings across all tracked dealer marketplaces (estate jewelers, 1stDibs, Sotheby's Buy Now, The RealReal). This section is dealer inventory only — there is currently no live, biddable David Webb auction inventory to track; every auction-history record on file is a completed, historical sale (see "Recent Auction Sales" below)._`,
    "",
    "**By price**",
    "",
    chart,
    "",
    "**By category**",
    "",
    catTable,
    "",
    "**By dealer**",
    "",
    dealerTable,
    "",
  ].join("\n");
}

function renderDealerItemTable(items) {
  const link = (r) => (r.url ? `[${r.piece || "(untitled)"}](${r.url})` : r.piece || "(untitled)");
  return [
    "| Piece | Category | Dealer | Price | Date |",
    "|---|---|---|---|---|",
    ...items.map(
      (r) =>
        `| ${link(r)} | ${cap(r.category || "other")} | ${r.dealer || ""} | ${money(r.price)}${nativeSuffix(r.native)} | ${
          r.first_seen || r.last_seen || ""
        } |`
    ),
  ].join("\n");
}

function renderNewListings(items) {
  const lines = [
    "## New in the Last 4 Weeks",
    "",
    `_${items.length.toLocaleString()} dealer listing(s) first seen in the last 28 days, across all sources and price points._`,
    "",
  ];
  if (items.length) lines.push(renderDealerItemTable(items), "");
  else lines.push("_None._", "");
  return lines.join("\n");
}

function renderClosedListings(items) {
  const lines = [
    "## Closed / Sold in the Last 4 Weeks",
    "",
    `_${items.length.toLocaleString()} dealer listing(s) delisted in the last 28 days — "closed" usually but not always means sold (see Data-Quality Caveats)._`,
    "",
  ];
  if (items.length) lines.push(renderDealerItemTable(items), "");
  else lines.push("_None._", "");
  return lines.join("\n");
}

function renderRecentAuctionSales(recentSales) {
  const link = (r) => (r.url ? `[${r.piece || "(untitled)"}](${r.url})` : r.piece || "(untitled)");
  const lines = [
    "## Recent Auction Sales (Past 60 Days)",
    "",
    `_${recentSales.count.toLocaleString()} completed sale(s) in the last 60 days${
      recentSales.median !== null ? `, median hammer ${money(recentSales.median)}` : ""
    }. These are historical results, not current inventory — see "Currently Available" above._`,
    "",
  ];
  if (recentSales.items.length) {
    lines.push(
      "| Piece | House | Sale Date | Price |",
      "|---|---|---|---|",
      ...recentSales.items.map(
        (r) => `| ${link(r)} | ${r.house || ""} | ${r.sale_date || ""} | ${money(r.price)}${nativeSuffix(r.native)} |`
      ),
      ""
    );
  } else {
    lines.push("_None._", "");
  }
  return lines.join("\n");
}

function renderTopSalesEver(items) {
  const link = (r) => (r.url ? `[${r.piece || "(untitled)"}](${r.url})` : r.piece || "(untitled)");
  return [
    "## All-Time Notable Sales",
    "",
    "These benchmark results provide context for current dealer asking prices and collector expectations:",
    "",
    "| Piece | House | Date | Hammer |",
    "|---|---|---|---|",
    ...items.map((r) => `| ${link(r)} | ${r.house || ""} | ${r.sale_date || ""} | ${money(r.price)}${nativeSuffix(r.native)} |`),
    "",
  ].join("\n");
}

// Each tag links back into the live GUI, pre-filtered -- "12 Maltese
// Crosses available, click through to see exactly which ones" (2026-08-13
// user request). docs/app.js reads a ?tag= query param on load.
function renderTagTrends(auctionByTag, dealerByTag, databaseUrl) {
  if (!auctionByTag.length && !dealerByTag.length) return "";
  const tagLink = (tag) => (databaseUrl ? `[${tag}](${databaseUrl}?tag=${encodeURIComponent(tag)})` : tag);

  const table = (rows) =>
    [
      `| Tag | Count | Min | Median | Max |`,
      `|---|---|---|---|---|`,
      ...rows.slice(0, 15).map((r) => `| ${tagLink(r.tag)} | ${r.count} | ${money(r.min)} | ${money(r.median)} | ${money(r.max)} |`),
    ].join("\n");

  const lines = [
    "## Trends by Motif & Material",
    "",
    "_Tags are keyword-matched from each piece's own listing text against David Webb's known design vocabulary (Zodiac, animal/creature pieces, fishscale, rock crystal, enamel, carved hardstone, etc.) — a piece can carry several tags. Tags with fewer than 5 matching records are omitted as too thin to be meaningful. Click a tag to see those exact pieces in the live database._",
    "",
  ];
  if (auctionByTag.length) lines.push("**Auction (sold prices)**", "", table(auctionByTag), "");
  if (dealerByTag.length) lines.push("**Current dealer inventory (asking prices)**", "", table(dealerByTag), "");
  return lines.join("\n");
}

// ---------- listing-quality flags ("worth a second look") ----------

function renderFlags(flags) {
  if (!flags.length) return "";
  const link = (r) => (r.url ? `[${r.piece_name || "(untitled)"}](${r.url})` : r.piece_name || "(untitled) — no link on file for this source");

  const priceFlags = [...flags].sort((a, b) => (a.price || 0) - (b.price || 0)).slice(0, 10);

  const lines = [
    "## Worth a Second Look",
    "",
    `_Implausibly low price for the category — a heuristic signal for a human to check, not a fraud determination. A flagged piece may well be genuine; this just surfaces things worth a closer look before relying on the listing. Click through to validate each one. (${flags.length} total, showing the ${priceFlags.length} cheapest.)_`,
    "",
  ];

  for (const f of priceFlags) {
    lines.push(`- ${link(f)} — ${money(f.price)}${f.native} via ${f.source || "unknown"}. ${f.reason}.`);
  }
  lines.push("");

  return lines.join("\n");
}

// Static -- this doesn't change week to week, so it's not worth an LLM
// call to regenerate it (and removes any risk of it drifting/being
// dropped by the model).
function renderDataQualityCaveats() {
  return [
    "## Data-Quality Caveats",
    "",
    "- **Auction hammer prices exclude buyer's premium** — typically +15–26% depending on the house.",
    "- **Dealer asking prices are not confirmed sale prices** — they're the dealer's current ask, which may be negotiated down or never sell.",
    '- **"Closed" (dealer status: inactive) usually but not always means sold** — could also be a price relist under a new SKU or a data-feed gap.',
    '- **"Currently available" is dealer inventory only.** There is no live, biddable David Webb auction inventory being tracked right now — genuine upcoming auction lots were confirmed absent at the major houses as of the last investigation.',
    '- **A piece can be listed on more than one platform** (e.g. a dealer\'s own site and 1stDibs) — "total listings" counts platform presence, not unique physical pieces.',
    "- **Foreign-currency prices are converted to USD** using approximate historical annual-average exchange rates, not settlement-date-precise figures — the original native-currency amount is footnoted wherever it differs from the displayed USD figure.",
    "",
  ].join("\n");
}

// ---------- Claude (executive summary + Slack summary only) ----------

async function callClaude({ system, user, maxTokens = 1200 }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

const ANALYST_SYSTEM = `You are a secondary-market analyst for David Webb, a luxury jewelry house.
You track two live datasets: auction results (historic, COMPLETED hammer prices) and estate-dealer/
marketplace inventory (current asking prices, refreshed weekly). You will receive PRE-COMPUTED
summary statistics (trust these numbers exactly) — do not invent or restate figures that aren't
given to you, and do not attempt to enumerate individual listings — every table in the report is
assembled separately and deterministically; your only job is scene-setting prose.

If "isBaselineRun" is true, this is an early run of the pipeline and most current inventory will
read as "new" simply because it was recently backfilled, not because of a sudden surge in real
market activity — say so plainly rather than implying unusual growth.

Every price field given to you is already an accurate USD-converted figure — trust it directly,
never re-derive or guess a conversion yourself.

Produce TWO sections separated by the exact delimiter lines shown below. Output nothing else.

===SLACK_SUMMARY===
4-6 short bullet points in Slack mrkdwn (use * for bold, - for bullets). Lead with what's actually
happening in the market (recent auction sales, new/closed dealer listings), then 2-3 genuinely
notable pieces (name + price + source). Keep it under 1500 characters. No preamble.

===EXEC_SUMMARY===
ONE paragraph (3-6 sentences), plain prose, no heading, no markdown list, no sub-sections — a
principal-level scene-setter for the report that follows (which has its own detailed breakdowns of
what's currently available, new, and closed). Reference real totals and 1-2 genuinely notable
pieces. Do not build tables or headings — those are assembled separately.`;

function buildLlmContext(stats) {
  const byPriceDesc = (a, b) => (b.price || 0) - (a.price || 0);
  return {
    date: stats.date,
    isBaselineRun: stats.isBaselineRun,
    totals: stats.totals,
    newDealerListingsCount4wk: stats.newDealerListings4wk.length,
    closedDealerListingsCount4wk: stats.closedDealerListings4wk.length,
    dealerAskingMedian: stats.dealerAskingMedian,
    recentAuctionSales: { windowDays: 60, count: stats.recentSales.count, median: stats.recentSales.median },
    topNewDealerListings: [...stats.newDealerListings4wk].sort(byPriceDesc).slice(0, 5),
    topRecentAuctionSales: [...stats.recentSales.items].sort(byPriceDesc).slice(0, 5),
  };
}

function buildUserPrompt(llmContext) {
  return [`Report date: ${llmContext.date}`, ``, `SUMMARY STATISTICS (JSON):`, JSON.stringify(llmContext, null, 2)].join("\n");
}

function splitSections(text) {
  const slackMatch = text.split("===SLACK_SUMMARY===")[1] || "";
  const [slackPart, execPart] = slackMatch.split("===EXEC_SUMMARY===");
  return {
    slack: (slackPart || "").trim(),
    exec: (execPart || "").trim(),
  };
}

// ---------- links + slack payload ----------

function links(date) {
  return {
    report: `${SERVER}/${REPO}/blob/${BRANCH}/output/reports/${date}.md`,
    database: DATABASE_URL || null,
    auctionCsv: `${SERVER}/${REPO}/raw/${BRANCH}/${path.relative(__dirname, HISTORY_CSV)}`,
    dealerCsv: `${SERVER}/${REPO}/raw/${BRANCH}/${path.relative(__dirname, LISTINGS_CSV)}`,
  };
}

function buildSlackPayload(date, stats, slackSummary, flags = []) {
  const l = links(date);
  const linkParts = [
    `*Report:* <${l.report}|View report>`,
    l.database ? `*Live database:* <${l.database}|Search all listings>` : null,
    `*CSVs:* <${l.auctionCsv}|Auctions> / <${l.dealerCsv}|Dealers>`,
  ].filter(Boolean);

  // Optional one-off banner, e.g. "this corrects an earlier post today"
  // or "this is an extra run this week reflecting a new data source" --
  // set via the REPORT_BANNER_NOTE env var, wired to weekly-report.yml's
  // `banner_note` workflow_dispatch input.
  const bannerNote = (process.env.REPORT_BANNER_NOTE || "").trim();
  const bannerBlock = bannerNote
    ? [
        {
          type: "section",
          text: { type: "mrkdwn", text: `:mega: *${bannerNote}*` },
        },
      ]
    : [];

  const priceFlagCount = flags.length;
  const flagsBlock =
    priceFlagCount
      ? [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `:mag: *Worth a second look:* ${priceFlagCount} implausibly-cheap price flag(s) — see the report for details. Heuristic signal, not a fraud determination.`,
              },
            ],
          },
        ]
      : [];

  return {
    text: `David Webb secondary-market report — ${date}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `David Webb Secondary Market — ${date}`, emoji: true },
      },
      ...bannerBlock,
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${stats.totals.auctionRecords}* auction records · *${stats.totals.activeDealerListings}* active dealer listings ` +
            `· *${stats.recentSales.count}* auction sales in the last 60 days (median ${money(stats.recentSales.median)}) ` +
            `· *${stats.newDealerListings4wk.length}* new / *${stats.closedDealerListings4wk.length}* closed dealer listings in the last 4 weeks`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: slackSummary || "_No summary generated._" } },
      ...flagsBlock,
      {
        type: "section",
        text: { type: "mrkdwn", text: linkParts.join("  ·  ") },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "Generated by `analyze.js` — drop a CSV into Claude for deeper analysis." },
        ],
      },
    ],
  };
}

async function postToSlack(payload) {
  if (!SLACK_WEBHOOK_URL) {
    console.error("SLACK_WEBHOOK_URL not set — skipping Slack post (use --dry-run to preview).");
    return false;
  }
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok || body !== "ok") {
    throw new Error(`Slack webhook responded ${res.status}: ${body}`);
  }
  return true;
}

// ---------- modes ----------

function payloadPath(date) {
  return path.join(REPORTS_DIR, `${date}.slack.json`);
}

async function generate() {
  if (!API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Run: export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }
  const history = loadJson(HISTORY_JSON);
  const dealers = loadJson(LISTINGS_JSON);
  if (history.length === 0 && dealers.length === 0) {
    console.error(
      `No data found in ${HISTORY_JSON} or ${LISTINGS_JSON}. Run history-refresh / dealer-refresh first.`
    );
    process.exit(1);
  }
  const date = todayStr();
  const stats = computeStats(history, dealers, date);
  appendStatsHistory(stats);

  const flags = computeFlags(history, dealers);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(FLAGGED_LISTINGS_JSON, JSON.stringify(flags, null, 2) + "\n");
  console.log(`Flags: ${flags.length} price anomaly`);

  console.log(
    `Analyzing ${date}: ${stats.totals.auctionRecords} auction records, ${stats.totals.activeDealerListings} active dealer listings, ` +
      `${stats.newDealerListings4wk.length} new / ${stats.closedDealerListings4wk.length} closed in the last 4 weeks...`
  );
  const text = await callClaude({
    system: ANALYST_SYSTEM,
    user: buildUserPrompt(buildLlmContext(stats)),
  });
  const { slack, exec } = splitSections(text);
  if (!exec) {
    console.error("Model did not return an EXEC_SUMMARY section. Raw output:\n" + text.slice(0, 800));
    process.exit(1);
  }

  // Order matters here (2026-08-13 user request): available -> new ->
  // closed -> recent/historical auction context -> trends -> flags
  // (penultimate) -> data-quality caveats (final).
  const sections = [
    renderCurrentlyAvailable(stats.totals.activeDealerListings, stats.dealerByCategory, stats.dealerByDealer, stats.dealerHistogram),
    renderNewListings(stats.newDealerListings4wk),
    renderClosedListings(stats.closedDealerListings4wk),
    renderRecentAuctionSales(stats.recentSales),
    renderTopSalesEver(stats.topSalesEver),
    renderTagTrends(stats.auctionByTag, stats.dealerByTag, DATABASE_URL),
    renderFlags(flags),
    renderDataQualityCaveats(),
  ]
    .filter(Boolean)
    .join("\n");

  const reportBody = [`# David Webb Secondary Market — ${date}`, "", "## Executive Summary", "", exec, "", sections].join(
    "\n"
  );

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${date}.md`);
  fs.writeFileSync(reportPath, reportBody + "\n");
  fs.writeFileSync(path.join(REPORTS_DIR, "latest.md"), reportBody + "\n");

  const payload = buildSlackPayload(date, stats, slack, flags);
  fs.writeFileSync(payloadPath(date), JSON.stringify(payload, null, 2));

  console.log(`Report written: ${reportPath}`);
  console.log(`Slack payload written: ${payloadPath(date)}`);
  return { date, payload };
}

async function notify(preloaded) {
  let payload = preloaded && preloaded.payload;
  if (!payload) {
    const date = todayStr();
    const p = payloadPath(date);
    if (!fs.existsSync(p)) {
      console.error(`No Slack payload at ${p}. Run 'node analyze.js --generate' first.`);
      process.exit(1);
    }
    payload = JSON.parse(fs.readFileSync(p, "utf8"));
  }

  if (DRY_RUN) {
    console.log("--- DRY RUN: Slack payload that would be posted ---");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const posted = await postToSlack(payload);
  console.log(posted ? "Posted to Slack." : "Slack post skipped.");
}

async function main() {
  let generated = null;
  if (MODE_GENERATE) generated = await generate();
  if (MODE_NOTIFY) await notify(generated);
}

// Guarded so this file can be require()'d (e.g. for local testing of the
// deterministic helpers below) without kicking off a real API/Slack run.
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = {
  computeStats,
  priceHistogram,
  byDealerStats,
  byCategoryStats,
  byTagStats,
  renderCurrentlyAvailable,
  renderNewListings,
  renderClosedListings,
  renderRecentAuctionSales,
  renderTopSalesEver,
  renderTagTrends,
  renderFlags,
  renderDataQualityCaveats,
};
