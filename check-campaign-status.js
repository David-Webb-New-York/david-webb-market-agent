#!/usr/bin/env node
/**
 * One-off diagnostic: fetches the actual saved A2P 10DLC campaign record
 * from Twilio's API (not the templated rejection email) so we can see the
 * literal current state -- message_flow, opt-in fields, and often a more
 * specific failureReason than the email gives (2026-08-20, after three
 * console-field checks came back clean but the campaign kept rejecting on
 * the same 30908/30909 codes). Not part of the scheduled pipeline;
 * dispatched by hand via check-campaign-status.yml.
 */
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const MESSAGING_SERVICE_SID = process.env.MESSAGING_SERVICE_SID;
const CAMPAIGN_SID = process.env.CAMPAIGN_SID;

async function main() {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !MESSAGING_SERVICE_SID || !CAMPAIGN_SID) {
    console.error("Missing one of TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / MESSAGING_SERVICE_SID / CAMPAIGN_SID.");
    process.exit(1);
  }
  const url = `https://messaging.twilio.com/v1/Services/${MESSAGING_SERVICE_SID}/Compliance/Usa2p`;
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  console.log("GET", url);
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  const text = await res.text();
  console.log("Status:", res.status);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
