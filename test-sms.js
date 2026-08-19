#!/usr/bin/env node
/**
 * One-off manual test for sms.js -- sends a single real text to confirm
 * the Twilio wiring works end to end (2026-08-19, following up right
 * after the account moved off A2P 10DLC pending review). Not part of the
 * scheduled pipeline; dispatched by hand via test-sms.yml.
 */
const { sendSms, smsConfigured, recipients } = require("./sms");

async function main() {
  console.log("Configured:", smsConfigured());
  console.log("Recipients:", recipients());
  if (!smsConfigured()) {
    console.error("Not fully configured -- see the missing env var(s) logged above/below.");
    process.exit(1);
  }
  const sent = await sendSms(
    "Test message from the David Webb market agent — SMS wiring confirmed."
  );
  console.log(sent ? "Sent." : "Not sent (see errors above).");
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
