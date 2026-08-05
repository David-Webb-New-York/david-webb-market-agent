#!/usr/bin/env node
/**
 * David Webb Secondary Market — Analyzer & Notifier
 * --------------------------------------------------
 * Reads the most recent scan snapshot produced by agent.js, computes accurate
 * aggregate stats in JS, asks Claude to turn them into a written report
 * (Markdown) plus a short Slack summary, and posts a notification to Slack.
 *
 * This is the "Pattern A + B" handoff:
 *   A) an auto-generated written report committed to output/reports/
 *   B) a Slack message linking the report + the raw CSV so the data can be
 *      dropped straight into Claude for deeper, interactive analysis.
 *
 * MODES (so CI can post links only AFTER the commit is pushed):
 *   node analyze.js              generate the report AND post to Slack
 *   node analyze.js --generate   only generate report + write the Slack payload
 *   node analyze.js --notify     only post the previously-generated Slack payload
 *   node analyze.js --dry-run    never POST to Slack; print the payload instead
 *
 * ENV:
 *   ANTHROPIC_API_KEY   required for --generate (and default mode)
 *   SLACK_WEBHOOK_URL    required to actually post (omit for a dry run)
 *   GITHUB_REPOSITORY    e.g. "owner/repo" (auto-set in GitHub Actions)
 *   GITHUB_SERVER_URL    e.g. "https://github.com" (auto-set in GitHub Actions)
 *   REPORT_LINK_BRANCH   branch the committed links point at (default "main")
 */

const fs = require("fs");
const path = require("path");

const args = new Set(process.argv.slice(2));
const MODE_GENERATE = args.has("--generate") || (!args.has("--notify"));
const MODE_NOTIFY = args.has("--notify") || (!args.has("--generate"));
const DRY_RUN = args.has("--dry-run");

const OUTPUT_DIR = path.join(__dirname, "output");
const SNAPSHOT_DIR = path.join(OUTPUT_DIR, "snapshots");
const REPORTS_DIR = path.join(OUTPUT_DIR, "reports");
const CSV_PATH = "output/david-webb-market-data.csv";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

const REPO = process.env.GITHUB_REPOSITORY || "David-Webb-New-York/david-webb-market-agent";
const SERVER = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
const BRANCH = process.env.REPORT_LINK_BRANCH || "main";

// ---------- snapshot loading ----------

function listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort(); // YYYY-MM-DD.json sorts chronologically
}

function loadSnapshot(file) {
  const pieces = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, file), "utf8"));
  return Array.isArray(pieces) ? pieces : [];
}

// ---------- aggregate stats (computed in JS so numbers are trustworthy) ----------

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function priceOf(piece) {
  const n = Number(piece.asking_or_hammer_price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function computeStats(pieces) {
  const withPrice = pieces.map(priceOf).filter((n) => n !== null);
  const byCategory = {};
  const byPriceType = {};

  for (const p of pieces) {
    const cat = (p.category || "other").toLowerCase();
    const type = (p.price_type || "unknown").toLowerCase();
    byPriceType[type] = (byPriceType[type] || 0) + 1;

    if (!byCategory[cat]) byCategory[cat] = { count: 0, prices: [] };
    byCategory[cat].count++;
    const price = priceOf(p);
    if (price !== null) byCategory[cat].prices.push(price);
  }

  const categoryTable = Object.entries(byCategory)
    .map(([category, v]) => ({
      category,
      count: v.count,
      priced: v.prices.length,
      min: v.prices.length ? Math.min(...v.prices) : null,
      median: median(v.prices),
      max: v.prices.length ? Math.max(...v.prices) : null,
    }))
    .sort((a, b) => b.count - a.count);

  const topPieces = pieces
    .filter((p) => priceOf(p) !== null)
    .sort((a, b) => priceOf(b) - priceOf(a))
    .slice(0, 10)
    .map((p) => ({
      piece_name: p.piece_name,
      category: p.category,
      price: priceOf(p),
      price_type: p.price_type,
      source_site: p.source_site,
      listing_url: p.listing_url,
      era_or_year: p.era_or_year,
      materials_gemstones: p.materials_gemstones,
    }));

  return {
    total: pieces.length,
    priced: withPrice.length,
    overallMin: withPrice.length ? Math.min(...withPrice) : null,
    overallMedian: median(withPrice),
    overallMax: withPrice.length ? Math.max(...withPrice) : null,
    byPriceType,
    categoryTable,
    topPieces,
  };
}

// ---------- week-over-week trends (deterministic; not model-generated) ----------

function buildTrendSeries(maxPoints = 12) {
  return listSnapshots()
    .slice(-maxPoints)
    .map((file) => {
      const st = computeStats(loadSnapshot(file));
      return {
        date: file.replace(/\.json$/, ""),
        total: st.total,
        priced: st.priced,
        median: st.overallMedian,
        max: st.overallMax,
      };
    });
}

function niceCeil(value, step) {
  return Math.max(step, Math.ceil((value * 1.15) / step) * step);
}

function renderTrends(series) {
  if (series.length === 0) return "";
  const money = (n) => (n === null || n === undefined ? "n/a" : "$" + n.toLocaleString("en-US"));

  const table = [
    "| Scan | Pieces | Priced | Median | Max |",
    "|---|---|---|---|---|",
    ...series.map((s) => `| ${s.date} | ${s.total} | ${s.priced} | ${money(s.median)} | ${money(s.max)} |`),
  ].join("\n");

  const xaxis = series.map((s) => `"${s.date}"`).join(", ");
  const totals = series.map((s) => s.total);
  const priced = series.map((s) => s.priced);
  const medians = series.map((s) => s.median || 0);
  const piecesTop = niceCeil(Math.max(...totals, ...priced, 1), 10);
  const medianTop = niceCeil(Math.max(...medians, 1), 5000);

  // Mermaid xychart-beta renders natively on GitHub. The table above is the
  // fallback if a viewer does not support the chart.
  const chartPieces = [
    "```mermaid",
    "xychart-beta",
    '    title "Pieces per scan (bar = total, line = priced)"',
    `    x-axis [${xaxis}]`,
    `    y-axis "Pieces" 0 --> ${piecesTop}`,
    `    bar [${totals.join(", ")}]`,
    `    line [${priced.join(", ")}]`,
    "```",
  ].join("\n");

  const chartMedian = [
    "```mermaid",
    "xychart-beta",
    '    title "Median listed price per scan (USD)"',
    `    x-axis [${xaxis}]`,
    `    y-axis "USD" 0 --> ${medianTop}`,
    `    line [${medians.join(", ")}]`,
    "```",
  ].join("\n");

  return ["## Week-over-week trends", "", table, "", chartPieces, "", chartMedian, ""].join("\n");
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
You will receive PRE-COMPUTED statistics (trust these numbers exactly) plus a list of the
highest-value pieces from the latest market scan, and summary counts from the previous scan.

Produce TWO sections separated by the exact delimiter lines shown below. Output nothing else.

===SLACK_SUMMARY===
4-6 short bullet points in Slack mrkdwn (use * for bold, - for bullets). Lead with the headline
numbers (pieces found, price range, median), then 2-3 genuinely notable pieces (name + price +
source), and any notable change vs the previous scan. Keep it under 1500 characters. No preamble.

===REPORT_MD===
A polished Markdown report a principal would actually read. Include:
- an H1 title with the scan date and a one-paragraph executive summary that references the
  week-over-week trend (use the provided TREND SERIES for direction and magnitude),
- a "Price ranges by category" Markdown table (category, count, priced, min, median, max) using
  the provided numbers verbatim, formatting prices as USD with thousands separators,
- a "Notable pieces" section highlighting the standout listings with their source and a link,
- an "Asking vs. auction" note contrasting dealer asking prices with any hammer/estimate results,
- a short "Data-quality caveats" note (asking prices are retail-resale comps, auction hammer
  excludes buyer's premium, occasional miscategorization).
Prices must match the provided stats; do not invent figures.
Do NOT build your own trend charts or scan-over-scan tables, and do NOT add a "Week-over-week
trends" heading, placeholder, or note anywhere — that entire section is inserted automatically
right after your H1 title. Begin your report body with a "## Executive Summary" section.`;

function buildUserPrompt(date, stats, trendSeries) {
  return [
    `Latest scan date: ${date}`,
    ``,
    `PRE-COMPUTED STATS (JSON):`,
    JSON.stringify(stats, null, 2),
    ``,
    `TREND SERIES across recent scans (oldest -> newest; use for week-over-week commentary):`,
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
    csv: `${SERVER}/${REPO}/raw/${BRANCH}/${CSV_PATH}`,
    snapshot: `${SERVER}/${REPO}/raw/${BRANCH}/output/snapshots/${date}.json`,
  };
}

function buildSlackPayload(date, stats, slackSummary) {
  const l = links(date);
  const money = (n) => (n === null ? "n/a" : "$" + n.toLocaleString("en-US"));
  const range =
    stats.priced > 0
      ? `${money(stats.overallMin)}–${money(stats.overallMax)} (median ${money(stats.overallMedian)})`
      : "no priced pieces";

  return {
    text: `David Webb secondary-market scan complete — ${date} (${stats.total} pieces)`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `David Webb Secondary Market — ${date}`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${stats.total}* pieces this scan · *${stats.priced}* priced · ${range}`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: slackSummary || "_No summary generated._" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Report:* <${l.report}|View report>  ·  *CSV (all history):* <${l.csv}|Download>  ·  *This scan (JSON):* <${l.snapshot}|Download>`,
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "Generated by `analyze.js` — drop the CSV into Claude for deeper analysis & slides." },
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
  const snaps = listSnapshots();
  if (snaps.length === 0) {
    console.error(`No snapshots found in ${SNAPSHOT_DIR}. Run agent.js first.`);
    process.exit(1);
  }
  const latestFile = snaps[snaps.length - 1];
  const date = latestFile.replace(/\.json$/, "");
  const pieces = loadSnapshot(latestFile);
  const stats = computeStats(pieces);
  const trendSeries = buildTrendSeries();

  console.log(`Analyzing ${date}: ${stats.total} pieces (${stats.priced} priced)...`);
  const text = await callClaude({
    system: ANALYST_SYSTEM,
    user: buildUserPrompt(date, stats, trendSeries),
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
    const snaps = listSnapshots();
    if (snaps.length === 0) {
      console.error("No snapshots found; nothing to notify about.");
      process.exit(1);
    }
    const date = snaps[snaps.length - 1].replace(/\.json$/, "");
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
