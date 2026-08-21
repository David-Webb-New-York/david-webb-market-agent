#!/usr/bin/env node
/**
 * One-off: sends the exact opt-in confirmation text registered with Twilio's
 * A2P 10DLC campaign (now approved, 2026-08-20) to every number in
 * SMS_RECIPIENT_PHONE. Not part of the scheduled pipeline -- daily-alert.yml
 * and weekly-report.yml already call sendSms() with their own message
 * bodies going forward; this just fires the opt-in message once so
 * recipients get the same confirmation text Twilio has on file.
 */
const { sendSms, smsConfigured, recipients } = require("./sms");

const OPT_IN_TEXT =
  "You're now subscribed to David Webb Market Agent alerts — new secondary-market listings and weekly summaries. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.";

async function main() {
  console.log("Configured:", smsConfigured());
  console.log("Recipients:", recipients());
  if (!smsConfigured()) {
    console.error("Not fully configured -- see the missing env var(s) logged above/below.");
    process.exit(1);
  }
  const sent = await sendSms(OPT_IN_TEXT);
  console.log(sent ? "Sent." : "Not sent (see errors above).");
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
