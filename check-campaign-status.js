#!/usr/bin/env node
/**
 * One-off diagnostic (2026-08-20): the campaign's Privacy Policy URL and
 * Terms of Service URL are confirmed correctly set in the Twilio Console
 * (screenshot-verified), yet the campaign keeps rejecting on 30908
 * (privacy policy can't be verified compliant) / 30909 (message flow/CTA
 * unverified). Testing whether an automated, non-browser client (like
 * Twilio's compliance crawler) actually sees the real page content, or
 * gets blocked/challenged the way The RealReal blocks Browserbase-less
 * fetches elsewhere in this project (see import-therealreal.js). Not part
 * of the scheduled pipeline; dispatched by hand.
 */
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
];

async function checkUrl(url) {
  console.log(`\n=== ${url} ===`);
  const res = await fetch(url, {
    headers: {
      // A generic non-browser UA on purpose -- this is what a compliance
      // crawler looks like, not what a human's browser sends.
      "User-Agent": "TwilioComplianceCheck/1.0",
    },
    redirect: "follow",
  });
  console.log("Status:", res.status, res.statusText);
  console.log("Final URL:", res.url);
  console.log("Content-Type:", res.headers.get("content-type"));
  const body = await res.text();
  console.log("Body length:", body.length);
  const lower = body.toLowerCase();
  const looksBlocked =
    /just a moment|checking your browser|attention required|access denied|captcha|cloudflare|perimeterx|px-captcha|bot detection/i.test(
      body
    );
  console.log("Looks like a bot-challenge/block page:", looksBlocked);
  for (const phrase of REQUIRED_PHRASES) {
    console.log(`  contains "${phrase}":`, lower.includes(phrase));
  }
  console.log("First 500 chars of body:\n", body.slice(0, 500));
}

async function main() {
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
