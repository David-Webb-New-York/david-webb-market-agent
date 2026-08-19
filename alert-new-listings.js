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
 *   ALERT_PRICE_THRESHOLD   USD; default 5000 -- override for a noisier/
 *                           quieter feed without editing code
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER /
 *   SMS_RECIPIENT_PHONE     optional -- one recipient (2026-08-17 request)
 *                           gets this same alert as a text instead of
 *                           relying on the shared Slack channel. See
 *                           sms.js. Missing any of these skips the SMS
 *                           quietly, same as SLACK_WEBHOOK_URL above.
 *
 * Usage: node alert-new-listings.js [--dry-run]
 */

const { LISTINGS_JSON } = require("./dealer-store");
const { sendSms, smsConfigured } = require("./sms");
const fs = require("fs");

const DRY_RUN = process.argv.includes("--dry-run");
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const PRICE_THRESHOLD = Number(process.env.ALERT_PRICE_THRESHOLD) || 5000;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function money(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

// A brand-new dealer source's very first import stamps first_seen=today
// on its ENTIRE catalog at once -- that's a one-time backfill artifact,
// not real day-to-day market activity, and would otherwise flood this
// alert (confirmed as a real, not theoretical, problem: onboarding The
// RealReal on 2026-08-11 landed 120 records in one run, 102 of them
// above the $5K threshold -- every one would have alerted as "new today"
// on the very next run with no fix). Detected generically so this
// self-corrects for any future new source too, not just this one: if
// EVERY currently-active record for a dealer was first seen today, and
// there's more than a handful of them, it reads as an initial backfill
// and is excluded from today's alert. Self-limiting -- by tomorrow those
// records' first_seen dates are in the past, so normal day-to-day
// new-listing detection resumes automatically, no manual cleanup needed.
// The weekly report isn't affected -- it has its own isBaselineRun
// framing for exactly this situation.
const BACKFILL_SUSPECT_COUNT = 10;

function loadNewListings(today) {
  if (!fs.existsSync(LISTINGS_JSON)) return [];
  const records = JSON.parse(fs.readFileSync(LISTINGS_JSON, "utf8"));
  const active = records.filter((r) => r.status === "active");

  const byDealer = new Map();
  for (const r of active) {
    if (!byDealer.has(r.dealer)) byDealer.set(r.dealer, []);
    byDealer.get(r.dealer).push(r);
  }
  const backfillingDealers = new Set();
  for (const [dealer, recs] of byDealer) {
    if (recs.length > BACKFILL_SUSPECT_COUNT && recs.every((r) => r.first_seen === today)) {
      backfillingDealers.add(dealer);
      console.log(
        `  (suppressing ${dealer} from today's alert -- all ${recs.length} of its active listings were first seen today, reads as an initial backfill, not real day-to-day new listings)`
      );
    }
  }

  // asking_price_usd (convert-currency.js, computed centrally in
  // dealer-store.js) rather than raw asking_price -- every dealer source
  // is USD-only today, but this keeps the threshold comparison correct if
  // that ever changes, same reasoning as the weekly report's price flags.
  return active
    .filter((r) => r.first_seen === today && !backfillingDealers.has(r.dealer))
    .map((r) => ({ ...r, asking_price: Number(r.asking_price_usd || r.asking_price) || 0 }))
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

// Plain-text, trimmed further than the Slack version (top 5, not 15) --
// SMS gets billed/split per ~160-char segment, and a text is read in a
// glance, not scrolled like Slack.
function buildSmsText(listings, today) {
  const top = listings
    .slice(0, 5)
    .map((r) => `${money(r.asking_price)} ${r.piece_name || "(untitled)"} (${r.dealer || "unknown dealer"})`)
    .join("\n");
  const overflow = listings.length > 5 ? `\n...and ${listings.length - 5} more.` : "";
  return `David Webb — ${listings.length} new listing(s) today (${today}) ≥ ${money(PRICE_THRESHOLD)}:\n${top}${overflow}`;
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
  const smsText = buildSmsText(listings, today);
  if (DRY_RUN) {
    console.log("\n--- DRY RUN: Slack payload that would be posted ---");
    console.log(JSON.stringify(payload, null, 2));
    if (smsConfigured()) {
      console.log("\n--- DRY RUN: SMS that would be sent ---");
      console.log(smsText);
    }
    return;
  }
  const posted = await postToSlack(payload);
  console.log(posted ? "Posted to Slack." : "Slack post skipped.");

  const texted = await sendSms(smsText);
  console.log(texted ? "Texted recipient." : "SMS skipped.");
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
