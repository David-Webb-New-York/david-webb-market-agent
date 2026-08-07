#!/usr/bin/env node
/**
 * One-off: fetch Phillips' real, confirmed-working search-results URL
 * (plain fetch, no Browserbase -- confirmed server-rendered, 200, real
 * content) and print raw HTML context around each real listing link
 * (/detail/<maker-slug>/<id>) so import-phillips.js's parser can be built
 * from the real markup instead of guessed CSS classes.
 */
const url = process.argv[2] || "https://www.phillips.com/Search?Search=david+webb";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

(async () => {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  const html = await res.text();
  console.log("status:", res.status, "| bytes:", html.length);

  const re = /\/detail\/[a-z0-9-]+\/\d+/gi;
  const seen = new Set();
  let count = 0;
  let m;
  while ((m = re.exec(html)) && count < 4) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    count++;
    const start = Math.max(0, m.index - 400);
    const end = Math.min(html.length, m.index + 1200);
    console.log(`\n=== context around "${m[0]}" (occurrence ${count}) ===`);
    console.log(html.slice(start, end));
  }

  const countMatch = html.match(/found\s+([\d,]+)\s+results?/i);
  console.log("\nresult-count text found:", countMatch ? countMatch[0] : "none");

  const pagMatches = [...html.matchAll(/\/search\/\d+\/\?search=[^"'\s]+/gi)].slice(0, 3);
  console.log("pagination hrefs sample:", pagMatches.map((x) => x[0]));
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
