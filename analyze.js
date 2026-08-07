#!/usr/bin/env node
/**
 * David Webb Secondary Market — Weekly Report & Notifier
 * --------------------------------------------------------
 * Reads the structured datasets that history-refresh.yml and
 * dealer-refresh.yml maintain (output/david-webb-auction-history.json,
 * output/david-webb-dealer-listings.json), computes accurate aggregate
 * stats in JS, asks Claude to turn them into a written report (Markdown)
 * plus a short Slack summary, and posts a notification to Slack.
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
 *   REPORT_PAGES_URL    live database GUI URL (default the org's GitHub Pages URL)
 */

const fs = require("fs");
const path = require("path");
const { HISTORY_JSON, HISTORY_CSV } = require("./history-store");
const { LISTINGS_JSON, LISTINGS_CSV } = require("./dealer-store");

const args = new Set(process.argv.slice(2));
const MODE_GENERATE = args.has("--generate") || !args.has("--notify");
const MODE_NOTIFY = args.has("--notify") || !args.has("--generate");
const DRY_RUN = args.has("--dry-run");

const OUTPUT_DIR = path.join(__dirname, "output");
const REPORTS_DIR = path.join(OUTPUT_DIR, "reports");
const STATS_HISTORY_JSON = path.join(REPORTS_DIR, "stats-history.json");
const MAX_STATS_HISTORY = 26; // ~6 months of weekly runs

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

const REPO = process.env.GITHUB_REPOSITORY || "David-Webb-New-York/david-webb-market-agent";
const SERVER = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
const BRANCH = process.env.REPORT_LINK_BRANCH || "main";
const PAGES_URL =
  process.env.REPORT_PAGES_URL ||
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

// ---------- aggregate stats (computed in JS so numbers are trustworthy) ----------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
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

function pickAuctionFields(r) {
  return {
    piece: r.piece_name,
    category: r.category,
    house: r.auction_house,
    sale_date: r.sale_date,
    price: num(r.sold_price),
    currency: r.currency_note || "",
    url: r.listing_url,
  };
}

function pickDealerFields(r) {
  return {
    piece: r.piece_name,
    category: r.category,
    dealer: r.dealer,
    price: num(r.asking_price),
    currency: r.currency_note || "",
    url: r.listing_url,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  };
}

function computeStats(history, dealers, today) {
  const weekAgo = daysAgoStr(7);
  const recentSaleWindow = daysAgoStr(60);
  const delistWindow = daysAgoStr(10);

  const newAuctionRecords = history.filter((r) => (r.first_captured || "") >= weekAgo);
  const newDealerListings = dealers.filter((r) => (r.first_seen || "") >= weekAgo);
  const activeDealerListings = dealers.filter((r) => r.status === "active");
  const recentlyDelisted = dealers.filter(
    (r) => r.status === "inactive" && (r.last_seen || "") >= delistWindow
  );

  const soldRecords = history.filter((r) => num(r.sold_price) !== null);
  const recentSales = soldRecords
    .filter((r) => (r.sale_date || "") >= recentSaleWindow)
    .sort((a, b) => (b.sale_date || "").localeCompare(a.sale_date || ""));
  const topRecentSales = [...recentSales]
    .sort((a, b) => num(b.sold_price) - num(a.sold_price))
    .slice(0, 8)
    .map(pickAuctionFields);
  const topSalesEver = [...soldRecords]
    .sort((a, b) => num(b.sold_price) - num(a.sold_price))
    .slice(0, 5)
    .map(pickAuctionFields);

  const topNewListings = [...newDealerListings]
    .filter((r) => num(r.asking_price) !== null)
    .sort((a, b) => num(b.asking_price) - num(a.asking_price))
    .slice(0, 8)
    .map(pickDealerFields);
  const delistedSample = recentlyDelisted.slice(0, 8).map(pickDealerFields);

  return {
    date: today,
    isBaselineRun: history.length > 0 && newAuctionRecords.length === history.length,
    totals: {
      auctionRecords: history.length,
      dealerRecords: dealers.length,
      activeDealerListings: activeDealerListings.length,
    },
    newThisWeek: {
      windowDays: 7,
      auctionRecords: newAuctionRecords.length,
      dealerListings: newDealerListings.length,
      topNewListings,
    },
    recentSales: {
      windowDays: 60,
      count: recentSales.length,
      median: median(recentSales.map((r) => num(r.sold_price)).filter((n) => n !== null)),
      top: topRecentSales,
    },
    recentlyDelisted: {
      windowDays: 10,
      count: recentlyDelisted.length,
      sample: delistedSample,
    },
    topSalesEver,
    auctionByCategory: byCategoryStats(soldRecords, "sold_price"),
    dealerByCategory: byCategoryStats(activeDealerListings, "asking_price"),
    dealerAskingMedian: median(
      activeDealerListings.map((r) => num(r.asking_price)).filter((n) => n !== null)
    ),
  };
}

// ---------- week-over-week trends (deterministic; not model-generated) ----------

function loadStatsHistory() {
  return loadJson(STATS_HISTORY_JSON);
}

function appendStatsHistory(stats) {
  const history = loadStatsHistory().filter((s) => s.date !== stats.date);
  history.push({
    date: stats.date,
    auctionRecords: stats.totals.auctionRecords,
    dealerRecords: stats.totals.dealerRecords,
    activeDealerListings: stats.totals.activeDealerListings,
    newAuctionThisWeek: stats.newThisWeek.auctionRecords,
    newDealerThisWeek: stats.newThisWeek.dealerListings,
    dealerAskingMedian: stats.dealerAskingMedian,
    recentSalesMedian: stats.recentSales.median,
  });
  history.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = history.slice(-MAX_STATS_HISTORY);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(STATS_HISTORY_JSON, JSON.stringify(trimmed, null, 2) + "\n");
  return trimmed;
}

function niceCeil(value, step) {
  return Math.max(step, Math.ceil((value * 1.15) / step) * step);
}

function renderTrends(series) {
  if (series.length < 2) return "";
  const money = (n) => (n === null || n === undefined ? "n/a" : "$" + n.toLocaleString("en-US"));

  const table = [
    "| Week | Auction records | Dealer records | Active listings | New (auction/dealer) |",
    "|---|---|---|---|---|",
    ...series.map(
      (s) =>
        `| ${s.date} | ${s.auctionRecords} | ${s.dealerRecords} | ${s.activeDealerListings} | ${s.newAuctionThisWeek}/${s.newDealerThisWeek} |`
    ),
  ].join("\n");

  const xaxis = series.map((s) => `"${s.date}"`).join(", ");
  const totals = series.map((s) => s.dealerRecords);
  const active = series.map((s) => s.activeDealerListings);
  const top = niceCeil(Math.max(...totals, ...active, 1), 100);

  const chart = [
    "```mermaid",
    "xychart-beta",
    '    title "Dealer inventory tracked (bar = total, line = active)"',
    `    x-axis [${xaxis}]`,
    `    y-axis "Listings" 0 --> ${top}`,
    `    bar [${totals.join(", ")}]`,
    `    line [${active.join(", ")}]`,
    "```",
  ].join("\n");

  return ["## Week-over-week trends", "", table, "", chart, ""].join("\n");
}

// Defensively remove any trends heading + placeholder the model may still emit,
// so the deterministic section (inserted below) is the only one.
function stripModelTrends(report) {
  const lines = report.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,4}\s+.*week-over-week\s+trends/i.test(lines[i])) {
      i++;
      while (
        i < lines.length &&
        (lines[i].trim() === "" || /automated|inserted here|chart|data table|placeholder/i.test(lines[i]))
      ) {
        i++;
      }
      i--; // let the loop's increment land on the next real line
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

function insertAfterH1(report, section) {
  if (!section) return report;
  const cleaned = stripModelTrends(report);
  const m = cleaned.match(/^# .*$/m);
  if (!m) return section + "\n\n" + cleaned;
  const end = m.index + m[0].length;
  return cleaned.slice(0, end) + "\n\n" + section + cleaned.slice(end);
}

// ---------- Claude ----------

async function callClaude({ system, user, maxTokens = 4000 }) {
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
You track two live datasets: auction results (historic hammer prices from Rago, LiveAuctioneers,
Christie's, Doyle, Phillips, etc.) and estate-dealer inventory (current asking prices from Fred
Leighton, Yafa Signed Jewels, and other dealers, refreshed weekly). You will receive PRE-COMPUTED
statistics (trust these numbers exactly) — do not invent or restate figures that aren't given to you.

If "isBaselineRun" is true, this is the FIRST run of the pipeline: nearly everything is "new" simply
because it was just backfilled, not because the market moved this week. Say so plainly in the
executive summary and lean on "recentSales" (auction sale_date within the last 60 days) and
"recentlyDelisted"/"newThisWeek" dealer activity for genuine market signal instead of the raw
newThisWeek.auctionRecords count. In later (non-baseline) runs, newThisWeek IS the meaningful
week-over-week signal.

Produce TWO sections separated by the exact delimiter lines shown below. Output nothing else.

===SLACK_SUMMARY===
4-6 short bullet points in Slack mrkdwn (use * for bold, - for bullets). Lead with what's actually
happening in the market this week (recent sales, new/delisted dealer inventory), then 2-3 genuinely
notable pieces (name + price + source). Keep it under 1500 characters. No preamble.

===REPORT_MD===
A polished Markdown report a principal would actually read. Include:
- an H1 title with the report date and a one-paragraph executive summary (referencing the
  week-over-week trend if TREND SERIES has more than one point; otherwise note this is the
  baseline run and future reports will show real trends),
- a "Recent auction activity" section built from recentSales (sale_date within 60 days) — note the
  count and median, and list the notable ones with house + date + price + link,
- a "Dealer market this week" section: how many listings are newly on the market
  (newThisWeek.topNewListings) and how many recently came off the market (recentlyDelisted.sample),
  with prices and dealer names,
- a "Price snapshot by category" Markdown table for BOTH auction results and current dealer asking
  prices (category, count, min, median, max), using the provided numbers verbatim, formatted as USD
  with thousands separators,
- an "All-time notable sales" section using topSalesEver for context,
- a short "Data-quality caveats" note (auction hammer prices exclude buyer's premium; dealer asking
  prices are not confirmed sale prices; "closed" status for dealer items means delisted, which
  usually but not always means sold).
Prices must match the provided stats; do not invent figures. Every piece you name must include its
url as a Markdown link if one is present in the data.
Do NOT build your own trend charts or week-over-week tables, and do NOT add a "Week-over-week
trends" heading, placeholder, or note anywhere — that entire section is inserted automatically
right after your H1 title. Begin your report body with a "## Executive Summary" section.`;

function buildUserPrompt(stats, trendSeries) {
  return [
    `Report date: ${stats.date}`,
    ``,
    `PRE-COMPUTED STATS (JSON):`,
    JSON.stringify(stats, null, 2),
    ``,
    `TREND SERIES across recent weekly reports (oldest -> newest; empty or single-item if this is early days):`,
    JSON.stringify(trendSeries, null, 2),
  ].join("\n");
}

function splitSections(text) {
  const slackMatch = text.split("===SLACK_SUMMARY===")[1] || "";
  const [slackPart, reportPart] = slackMatch.split("===REPORT_MD===");
  return {
    slack: (slackPart || "").trim(),
    report: (reportPart || "").trim(),
  };
}

// ---------- links + slack payload ----------

function links(date) {
  return {
    report: `${SERVER}/${REPO}/blob/${BRANCH}/output/reports/${date}.md`,
    database: PAGES_URL,
    auctionCsv: `${SERVER}/${REPO}/raw/${BRANCH}/${path.relative(__dirname, HISTORY_CSV)}`,
    dealerCsv: `${SERVER}/${REPO}/raw/${BRANCH}/${path.relative(__dirname, LISTINGS_CSV)}`,
  };
}

function buildSlackPayload(date, stats, slackSummary) {
  const l = links(date);
  const money = (n) => (n === null || n === undefined ? "n/a" : "$" + n.toLocaleString("en-US"));

  return {
    text: `David Webb secondary-market report — ${date}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `David Webb Secondary Market — ${date}`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${stats.totals.auctionRecords}* auction records · *${stats.totals.activeDealerListings}* active dealer listings ` +
            `· *${stats.recentSales.count}* sales in the last 60 days (median ${money(stats.recentSales.median)}) ` +
            `· *${stats.newThisWeek.dealerListings}* new / *${stats.recentlyDelisted.count}* delisted this week`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: slackSummary || "_No summary generated._" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Report:* <${l.report}|View report>  ·  *Live database:* <${l.database}|Search all listings>  ·  *CSVs:* <${l.auctionCsv}|Auctions> / <${l.dealerCsv}|Dealers>`,
        },
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
  const trendSeries = appendStatsHistory(stats);

  console.log(
    `Analyzing ${date}: ${stats.totals.auctionRecords} auction records, ${stats.totals.activeDealerListings} active dealer listings...`
  );
  const text = await callClaude({
    system: ANALYST_SYSTEM,
    user: buildUserPrompt(stats, trendSeries),
    maxTokens: 4000,
  });
  const { slack, report } = splitSections(text);
  if (!report) {
    console.error("Model did not return a REPORT_MD section. Raw output:\n" + text.slice(0, 800));
    process.exit(1);
  }

  // Insert the deterministic (accurate) trend charts right after the H1 title.
  const reportWithTrends = insertAfterH1(report, renderTrends(trendSeries));

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${date}.md`);
  fs.writeFileSync(reportPath, reportWithTrends + "\n");
  fs.writeFileSync(path.join(REPORTS_DIR, "latest.md"), reportWithTrends + "\n");

  const payload = buildSlackPayload(date, stats, slack);
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

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
