#!/usr/bin/env node
/**
 * One-off debug script: after triggering Christie's real search via UI
 * interaction (type + Enter, confirmed working), does an in-browser
 * fetch() from that SAME authenticated page context succeed against
 * apim.christies.com/search-client, even though a cold external fetch
 * (no cookies/session) got a 404? If yes, this is the pagination strategy
 * for import-christies.js: one Browserbase session, N in-page fetches.
 */
const bb = require("./browserbase");

async function main() {
  const term = process.argv[2] || "david webb";
  const result = await bb.withPage(
    async (page) => {
      await page.goto("https://www.christies.com", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const input = page.locator("input[type='search']").first();
      await input.click({ timeout: 5000 });
      await input.fill(term, { timeout: 5000 });
      await page.waitForTimeout(300);
      await input.press("Enter");
      await page.waitForTimeout(6000);

      const url = `https://apim.christies.com/search-client?keyword=${encodeURIComponent(term)}&page=1&is_past_lots=True&sortby=relevance&language=en&geocountrycode=US`;
      const inBrowserResult = await page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { headers: { Accept: "application/json" } });
          const text = await res.text();
          return { status: res.status, bytes: text.length, body: text.slice(0, 4000) };
        } catch (e) {
          return { error: e.message };
        }
      }, url);
      return inBrowserResult;
    },
    { sessionOpts: { proxies: true } }
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
