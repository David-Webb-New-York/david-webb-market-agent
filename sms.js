/**
 * SMS delivery via Twilio's REST API (plain fetch, no SDK -- same pattern
 * as postToSlack in analyze.js/alert-new-listings.js).
 *
 * One recipient (2026-08-17 user request) gets a text instead of relying
 * on the shared Slack channel -- Twilio, not a true-iMessage gateway,
 * since this pipeline runs on GitHub Actions Linux runners with no way to
 * drive the Messages app, and a paid iMessage-gateway vendor wasn't
 * wanted for one recipient. Functionally the same experience on their end
 * (SMS/RCS vs. iMessage), just not a blue bubble.
 *
 * ENV (all required to actually send; missing any of them skips quietly,
 * matching SLACK_WEBHOOK_URL's behavior elsewhere in this codebase):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER   the Twilio number sending the text (E.164, e.g. +15551234567)
 *   SMS_RECIPIENT_PHONE  who receives it (E.164)
 */

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TO_NUMBER = process.env.SMS_RECIPIENT_PHONE;

function smsConfigured() {
  return Boolean(ACCOUNT_SID && AUTH_TOKEN && FROM_NUMBER && TO_NUMBER);
}

// Twilio numbers are expected in E.164 (+15551234567). Accept a bare
// 10-digit US number too (e.g. from a phone number typed in chat) so a
// human-entered secret doesn't silently fail.
function normalizePhone(n) {
  const digits = String(n || "").replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(n || "").startsWith("+") ? n : `+${digits}`;
}

async function sendSms(body) {
  if (!smsConfigured()) {
    console.error("Twilio env vars not fully set — skipping SMS.");
    return false;
  }
  const to = normalizePhone(TO_NUMBER);
  const from = normalizePhone(FROM_NUMBER);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Twilio API ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return true;
}

module.exports = { sendSms, smsConfigured, normalizePhone };
