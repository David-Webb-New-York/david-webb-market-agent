#!/usr/bin/env node
/**
 * One-off: fetch Doyle's confirmed-real search-results URL (found via a
 * live interactive Browserbase probe: typing "david webb" + Enter into the
 * real search box lands here) with a plain cold fetch() -- no Browserbase,
 * no JS -- to check whether it's server-rendered (like Phillips) and, if
 * so, print raw HTML context around "david webb" occurrences to find the
 * real listing-card markup for import-doyle.js.
 */
const url = process.argv[2] || "https://www.doyle.com/auction/search/?st=david+webb&c=1";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

(async () => {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  const html = await res.text();
  console.log("status:", res.status, "| bytes:", html.length);
  console.log('"david webb" occurrences:', (html.match(/david webb/gi) || []).length);
  console.log('"lot" occurrences:', (html.match(/\blot\b/gi) || []).length);
  console.log('"$" occurrences:', (html.match(/\$/g) || []).length);

  const idxLower = html.toLowerCase();
  let idx = idxLower.indexOf("david webb");
  let count = 0;
  while (idx !== -1 && count < 3) {
    const start = Math.max(0, idx - 500);
    const end = Math.min(html.length, idx + 800);
    console.log(`\n=== context around "david webb" occurrence ${count + 1} (offset ${idx}) ===`);
    console.log(html.slice(start, end));
    idx = idxLower.indexOf("david webb", idx + 1);
    count++;
  }
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
