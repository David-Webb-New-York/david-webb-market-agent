#!/usr/bin/env node
/**
 * One-off test: does LiveAuctioneers serve window.__data in the raw
 * server-rendered HTML via a plain fetch() (no Browserbase/JS execution)?
 * bb-probe.js confirmed the data is real in Browserbase-rendered HTML and
 * NOT reachable via page.evaluate() (cleared by hydration) — but that
 * doesn't tell us whether it's present pre-hydration in the initial
 * server response too, or only injected by client JS after the browser
 * starts executing. If plain fetch works, we can skip Browserbase
 * entirely for this source (cheaper, faster, no proxy costs).
 */
const url = process.argv[2] || "https://www.liveauctioneers.com/search/?keyword=david+webb";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

(async () => {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
  });
  const html = await res.text();
  console.log("status:", res.status);
  console.log("html bytes:", html.length);
  const idx = html.indexOf("window.__data=");
  console.log("window.__data= present:", idx !== -1, idx !== -1 ? `at offset ${idx}` : "");
  console.log('"david webb" occurrences:', (html.match(/david webb/gi) || []).length);
  console.log('"itemSummary" occurrences:', (html.match(/itemSummary/g) || []).length);
  console.log('"lotNumber" occurrences:', (html.match(/lotNumber/g) || []).length);
  console.log("first 500 chars:", html.slice(0, 500));
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
