#!/usr/bin/env node
/**
 * One-off: fetch Doyle's confirmed-real, confirmed-server-rendered search-
 * results URL with a plain cold fetch() and print the FULL raw HTML for
 * each auction-lot card (from "auction-lot" open to the next sibling card),
 * not just a fixed context window around a keyword match -- needed to see
 * price/estimate/sale-date markup that a narrower window cut off before
 * reaching, for building import-doyle.js.
 */
const url = process.argv[2] || "https://www.doyle.com/auction/search/?st=david+webb&c=1";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

(async () => {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  const html = await res.text();
  console.log("status:", res.status, "| bytes:", html.length);

  const cardStarts = [];
  const re = /<div class="auction-lot">/g;
  let m;
  while ((m = re.exec(html))) cardStarts.push(m.index);
  console.log("auction-lot card count on page:", cardStarts.length);

  for (let i = 0; i < Math.min(3, cardStarts.length); i++) {
    const start = cardStarts[i];
    const end = cardStarts[i + 1] || Math.min(html.length, start + 3000);
    console.log(`\n=== FULL card ${i + 1} (offset ${start}, ${end - start} bytes) ===`);
    console.log(html.slice(start, end));
  }
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
