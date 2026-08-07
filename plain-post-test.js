#!/usr/bin/env node
/**
 * One-off test: can a captured browser POST request (URL + JSON body) be
 * replicated with a plain fetch() (no Browserbase/cookies/session)? If yes,
 * the source can get a free structured adapter (like Rago) instead of a
 * costly Browserbase-backed one (like LiveAuctioneers). See
 * plain-fetch-test.js for the GET equivalent.
 *
 * Usage: node plain-post-test.js <url> <json-body-file>
 */
const fs = require("fs");
const url = process.argv[2];
const bodyFile = process.argv[3];
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

if (!url || !bodyFile) {
  console.error("usage: node plain-post-test.js <url> <json-body-file>");
  process.exit(1);
}

(async () => {
  const body = fs.readFileSync(bodyFile, "utf8");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
    },
    body,
  });
  const text = await res.text();
  console.log("status:", res.status);
  console.log("response bytes:", text.length);
  console.log("first 1500 chars:", text.slice(0, 1500));
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
