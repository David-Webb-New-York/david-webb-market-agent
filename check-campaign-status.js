#!/usr/bin/env node
/**
 * One-off diagnostic (2026-08-20): combines the two checks from earlier
 * rounds -- (1) pull the actual saved campaign record from Twilio's API,
 * which names the exact `fields` that failed review (more specific than
 * the templated rejection email), and (2) fetch the live privacy-policy
 * and terms-of-service pages the way a non-browser reviewer/crawler would,
 * to confirm the content Twilio actually sees. Not part of the scheduled
 * pipeline; dispatched by hand after each new rejection.
 */
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const MESSAGING_SERVICE_SID = process.env.MESSAGING_SERVICE_SID;

const URLS = [
  "https://www.davidwebb.com/policies/privacy-policy",
  "https://www.davidwebb.com/policies/terms-of-service",
];

const REQUIRED_PHRASES = [
  "not be sold",
  "not sold",
  "third part",
  "affiliate",
  "message and data rates may apply",
  "message frequency",
  "reply stop",
  "reply help",
];

async function checkCampaignRecord() {
  console.log("========== Twilio campaign record ==========");
  const url = `https://messaging.twilio.com/v1/Services/${MESSAGING_SERVICE_SID}/Compliance/Usa2p`;
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  const data = await res.json().catch(() => ({}));
  console.log("Status:", res.status);
  const campaign = (data.compliance || [])[0];
  if (!campaign) {
    console.log("No campaign record found:", JSON.stringify(data, null, 2));
    return;
  }
  console.log("campaign_status:", campaign.campaign_status);
  console.log("date_created:", campaign.date_created);
  console.log("date_updated:", campaign.date_updated);
  console.log("description:", campaign.description);
  console.log("errors:", JSON.stringify(campaign.errors, null, 2));
  console.log("message_flow:", campaign.message_flow);
}

async function checkUrl(url) {
  console.log(`\n=== ${url} ===`);
  const res = await fetch(url, {
    headers: { "User-Agent": "TwilioComplianceCheck/1.0" },
    redirect: "follow",
  });
  console.log("Status:", res.status, res.statusText);
  const body = await res.text();
  console.log("Body length:", body.length);
  const lower = body.toLowerCase();
  for (const phrase of REQUIRED_PHRASES) {
    console.log(`  contains "${phrase}":`, lower.includes(phrase));
  }
}

async function main() {
  await checkCampaignRecord();
  console.log("\n========== Live page content ==========");
  for (const url of URLS) {
    try {
      await checkUrl(url);
    } catch (err) {
      console.log(`\n=== ${url} ===`);
      console.error("Fetch failed:", err.message || err);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
