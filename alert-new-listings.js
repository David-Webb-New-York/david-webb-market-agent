#!/usr/bin/env node
/**
 * David Webb — near-term high-value listing alert
 * -------------------------------------------------
 * The weekly report (analyze.js, via weekly-report.yml) is the once-a-week
 * digest. This is the faster, narrower complement: run daily-alert.yml
 * dispatches this after a fresh `node import-dealers.js`, and it posts an
 * IMMEDIATE Slack ping for any notable piece that showed up on the market
 * TODAY — so a major new listing doesn't sit unnoticed until Monday.
 *
 * Deliberately simple and deterministic (no ANTHROPIC_API_KEY, no written
 * prose) -- this is a same-day nudge, not a report. Quiet by default: if
 * nothing new clears the price threshold, it posts nothing at all (no
 * daily "nothing new" noise in Slack).
 *
 * "New today" = dealer-store records whose first_seen is today's date
 * (dealer-store.js already tracks this on every upsert -- no separate
 * state file needed).
 *
 * ENV:
 *   SLACK_WEBHOOK_URL       required to actually post (omit for a dry run)
 *   ALERT_PRICE_THRESHOLD   USD; default 50000 -- override for a noisier/
 *                           quieter feed without editing code
 *
 * Usage: node alert-new-listings.js [--dry-run]
 */

const { LISTINGS_JSON } = require("./dealer-store");
const fs = require("fs");

const DRY_RUN = process.argv.includes("--dry-run");
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const PRICE_THRESHOLD = Number(process.env.ALERT_PRICE_THRESHOLD) || 50000;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function money(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function loadNewListings(today) {
  if (!fs.existsSync(LISTINGS_JSON)) return [];
  const records = JSON.parse(fs.readFileSync(LISTINGS_JSON, "utf8"));
  return records
    .filter((r) => r.status === "active" && r.first_seen === today)
    .map((r) => ({ ...r, asking_price: Number(r.asking_price) || 0 }))
    .filter((r) => r.asking_price >= PRICE_THRESHOLD)
    .sort((a, b) => b.asking_price - a.asking_price);
}

function buildPayload(listings, today) {
  const lines = listings
    .slice(0, 15)
    .map((r) => {
      const link = r.listing_url ? `<${r.listing_url}|${r.piece_name || "(untitled)"}>` : r.piece_name || "(untitled)";
      return `• ${link} — *${money(r.asking_price)}* via ${r.dealer || "unknown dealer"}`;
    })
    .join("\n");
  const overflow = listings.length > 15 ? `\n_...and ${listings.length - 15} more._` : "";

  return {
    text: `${listings.length} new David Webb listing(s) today above ${money(PRICE_THRESHOLD)}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `New on the market today — ${today}`, emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${listings.length}* new listing(s) above ${money(PRICE_THRESHOLD)}:\n\n${lines}${overflow}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Alert threshold ${money(PRICE_THRESHOLD)} (set ALERT_PRICE_THRESHOLD to change). Full weekly digest posts Mondays.`,
          },
        ],
      },
    ],
  };
}

async function postToSlack(payload) {
  if (!SLACK_WEBHOOK_URL) {
    console.error("SLACK_WEBHOOK_URL not set — skipping Slack post.");
    return false;
  }
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok || body !== "ok") throw new Error(`Slack webhook responded ${res.status}: ${body}`);
  return true;
}

async function main() {
  const today = todayStr();
  const listings = loadNewListings(today);

  if (!listings.length) {
    console.log(`No new dealer listings today (${today}) at or above ${money(PRICE_THRESHOLD)} — nothing to post.`);
    return;
  }

  console.log(`${listings.length} new listing(s) today above ${money(PRICE_THRESHOLD)}:`);
  for (const r of listings) console.log(`  ${money(r.asking_price)} — ${r.piece_name} (${r.dealer})`);

  const payload = buildPayload(listings, today);
  if (DRY_RUN) {
    console.log("\n--- DRY RUN: Slack payload that would be posted ---");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const posted = await postToSlack(payload);
  console.log(posted ? "Posted to Slack." : "Slack post skipped.");
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
