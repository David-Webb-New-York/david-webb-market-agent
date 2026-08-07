#!/usr/bin/env node
/**
 * One-off test: can a captured GET JSON API URL be replicated with a plain
 * fetch() (no Browserbase/cookies/session)? Generic counterpart to
 * plain-post-test.js for GET-based JSON APIs (e.g. Christie's
 * apim.christies.com endpoints, captured via bb-interactive-probe.js).
 *
 * Usage: node plain-json-get-test.js <url> ["Header-Name: value" ...]
 */
const url = process.argv[2];
const extraHeaders = process.argv.slice(3);
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

if (!url) {
  console.error('usage: node plain-json-get-test.js <url> ["Header-Name: value" ...]');
  process.exit(1);
}

const headers = { "User-Agent": UA, Accept: "application/json" };
for (const h of extraHeaders) {
  const idx = h.indexOf(":");
  if (idx === -1) continue;
  headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
}

(async () => {
  const res = await fetch(url, { headers });
  const text = await res.text();
  console.log("status:", res.status);
  console.log("response bytes:", text.length);
  console.log("first 2000 chars:", text.slice(0, 2000));
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
