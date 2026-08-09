#!/usr/bin/env node
/**
 * One-off investigation: do the major auction houses we already have
 * sold-lot adapters for (Christie's, Sotheby's, Bonhams, Phillips) also
 * expose UPCOMING/current lots through infrastructure we've already
 * reverse-engineered, or something close to it? Tests four specific,
 * grounded hypotheses rather than guessing blind:
 *
 *   - Christie's: import-christies.js's own comment already documents the
 *     real tab keys as available_lots/sold_lots/articles -- we only ever
 *     use sold_lots. Try available_lots directly.
 *   - Sotheby's: import-sothebys.js's Algolia index (bsp_dotcom_prod_en,
 *     type:"Lot") returns zero future-dated records in our real committed
 *     data -- looks like a historical-only archive. Probe the live site
 *     for a separate "upcoming sales" surface.
 *   - Bonhams: import-bonhams.js already filters status:=[`NEW`] and
 *     explicitly flags in its own comment that other status values are
 *     unconfirmed. Query without that filter to see what statuses exist.
 *   - Phillips: our current data has zero future-dated records despite no
 *     explicit past/sold filter in the importer -- check for a distinct
 *     upcoming-auctions URL section.
 */
const bb = require("./browserbase");

async function probeChristiesAvailableLots() {
  const url = "https://www.christies.com/en/search?entry=david%20webb&page=1&sortby=relevance&tab=available_lots";
  return bb.withPage(
    async (page) => {
      const jsonResponses = [];
      page.on("response", async (res) => {
        if (res.url().includes("apim.christies.com/search-client")) {
          try {
            jsonResponses.push({ url: res.url(), body: await res.text() });
          } catch (_) {}
        }
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(8000);
      return { jsonResponses };
    },
    { sessionOpts: { proxies: true } }
  );
}

async function probeSothebysUpcoming() {
  const url = "https://www.sothebys.com/en/search?query=david+webb";
  return bb.withPage(
    async (page) => {
      const xhrs = [];
      page.on("response", async (res) => {
        const u = res.url();
        if (/algolia|search|api/i.test(u) && res.request().method() !== "OPTIONS") {
          try {
            const ct = res.headers()["content-type"] || "";
            if (ct.includes("json")) xhrs.push({ url: u, bytes: (await res.text()).length });
          } catch (_) {}
        }
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      return { xhrs, bodyText, finalUrl: page.url() };
    },
    { sessionOpts: { proxies: true } }
  );
}

async function probeBonhamsStatuses() {
  const url = "https://www.bonhams.com/search/?q=david+webb";
  return bb.withPage(
    async (page) => {
      const hits = [];
      page.on("response", async (res) => {
        if (res.url().includes("search-proxy/multi_search")) {
          try {
            hits.push({ url: res.url(), body: await res.text() });
          } catch (_) {}
        }
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(6000);
      return { hits };
    },
    { sessionOpts: { proxies: true } }
  );
}

async function probePhillipsUpcoming() {
  const candidates = [
    "https://www.phillips.com/auctions",
    "https://www.phillips.com/jewelry/auctions",
  ];
  const results = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const text = await res.text();
      results.push({ url, status: res.status, bytes: text.length, hasDavidWebb: /david\s*webb/i.test(text) });
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }
  return results;
}

async function main() {
  console.log("=== Christie's: tab=available_lots ===");
  try {
    const r = await probeChristiesAvailableLots();
    console.log(`Captured ${r.jsonResponses.length} apim.christies.com/search-client response(s)`);
    for (const jr of r.jsonResponses) {
      console.log("URL:", jr.url);
      try {
        const data = JSON.parse(jr.body);
        console.log("  lots:", Array.isArray(data.lots) ? data.lots.length : "n/a", "| total_pages:", data.total_pages);
        if (Array.isArray(data.lots) && data.lots.length) {
          const sample = data.lots[0];
          console.log("  sample lot title:", sample.title_primary_txt);
          console.log("  sample is_auction_over:", sample.is_auction_over, "| start_date:", sample.start_date, "| end_date:", sample.end_date);
          console.log("  sample price_realised_txt:", sample.price_realised_txt, "| estimate_txt:", sample.estimate_txt);
        }
      } catch (e) {
        console.log("  (failed to parse JSON:", e.message, ") raw sample:", jr.body.slice(0, 300));
      }
    }
  } catch (err) {
    console.log("Christie's probe failed:", err.message);
  }

  console.log("\n=== Sotheby's: live site search for an upcoming-sales surface ===");
  try {
    const r = await probeSothebysUpcoming();
    console.log("final URL:", r.finalUrl);
    console.log("XHR/fetch responses seen:", r.xhrs.length);
    for (const x of r.xhrs.slice(0, 15)) console.log(" -", x.url, `(${x.bytes}b)`);
    console.log("body text sample:", JSON.stringify(r.bodyText.slice(0, 500)));
  } catch (err) {
    console.log("Sotheby's probe failed:", err.message);
  }

  console.log("\n=== Bonhams: search-proxy response without assuming NEW-only ===");
  try {
    const r = await probeBonhamsStatuses();
    console.log(`Captured ${r.hits.length} search-proxy response(s)`);
    for (const h of r.hits) {
      try {
        const data = JSON.parse(h.body);
        const result = data.results && data.results[0];
        console.log("found:", result && result.found);
        const statuses = new Set();
        for (const hit of (result && result.hits) || []) {
          const doc = hit.document || {};
          statuses.add(doc.status || doc.auctionStatus || "(none)");
        }
        console.log("distinct status values observed:", [...statuses]);
        const sample = result && result.hits && result.hits[0] && result.hits[0].document;
        if (sample) console.log("sample doc:", JSON.stringify(sample).slice(0, 500));
      } catch (e) {
        console.log("  (failed to parse:", e.message, ")", h.body.slice(0, 300));
      }
    }
  } catch (err) {
    console.log("Bonhams probe failed:", err.message);
  }

  console.log("\n=== Phillips: candidate upcoming-auctions URLs (plain fetch) ===");
  try {
    const results = await probePhillipsUpcoming();
    for (const r of results) console.log(JSON.stringify(r));
  } catch (err) {
    console.log("Phillips probe failed:", err.message);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
