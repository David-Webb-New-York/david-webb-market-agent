#!/usr/bin/env node
/**
 * One-off diagnostic (2026-08-26): confirms the new public SMS opt-in
 * landing page (docs/sms-opt-in.html) is actually live on GitHub Pages
 * and contains the expected consent checkbox/disclosures, before handing
 * Twilio the URL as proof of a real opt-in flow. Also re-checks the
 * campaign record. Not part of the scheduled pipeline.
 */
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const MESSAGING_SERVICE_SID = process.env.MESSAGING_SERVICE_SID;

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
  console.log("date_updated:", campaign.date_updated);
  console.log("errors:", JSON.stringify(campaign.errors, null, 2));
}

async function checkOptInPage() {
  console.log("\n========== Opt-in page ==========");
  const url = "https://david-webb-new-york.github.io/david-webb-market-agent/sms-opt-in.html";
  const res = await fetch(url, { headers: { "User-Agent": "TwilioComplianceCheck/1.0" } });
  console.log("Status:", res.status, res.statusText);
  const body = await res.text();
  console.log("Body length:", body.length);
  const checks = [
    ['type="checkbox"', "checkbox present"],
    ['type="tel"', "phone field present"],
    ["Message frequency varies", "frequency disclosure"],
    ["Message and data rates may apply", "rates disclosure"],
    ["STOP", "STOP mention"],
    ["HELP", "HELP mention"],
    ["privacy-policy", "privacy policy link"],
    ["terms-of-service", "terms link"],
  ];
  for (const [needle, label] of checks) {
    console.log(`  ${label}:`, body.includes(needle));
  }
}

async function main() {
  await checkCampaignRecord();
  await checkOptInPage();
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
