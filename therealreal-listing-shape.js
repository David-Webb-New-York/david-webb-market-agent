#!/usr/bin/env node
/**
 * Attempt 2: plain proxies weren't enough (got a real "Access to this page
 * has been denied" block page, 11.7kb, same shape as Heritage's DataDome
 * block earlier this session). Tries Browserbase advancedStealth first;
 * Heritage's precedent found that 403s ("Verified mode is only available
 * on the Enterprise plan") on this account's Browserbase tier, so this
 * also falls back to Steel.dev's stealthConfig in the same run rather
 * than needing a second dispatch to find out.
 */
const bbBrowserbase = require("./browserbase");
const bbSteel = require("./steel");

const PRICE_CANDIDATES = [
  "price", "Price", "amount", "Amount", "cents", "Cents", "askingPrice",
  "convertedPrice", "displayPrice", "retailPrice", "listingPrice", "itemPrice",
  "sellingPrice", "originalPrice", "priceRange", "formattedPrice", "designer",
  "Designer", "brand", "Brand",
];

async function probe(backendName, sessionOpts) {
  const bb = backendName === "steel" ? bbSteel : bbBrowserbase;
  const url = process.argv[2] || "https://www.therealreal.com/search?keywords=david%20webb";
  return bb.withPage(
    async (page) => {
      let navError = null;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => {
        navError = e.message;
      });
      await page.waitForTimeout(8000);

      const data = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        const blobs = scripts.map((s) => s.textContent || "").filter((t) => t.length > 2000);
        return {
          title: document.title,
          finalUrl: location.href,
          htmlLength: document.documentElement.outerHTML.length,
          bodySnippet: document.body ? document.body.innerText.slice(0, 300) : "",
          totalScripts: scripts.length,
          largeBlobCount: blobs.length,
          largeBlobSizes: blobs.map((b) => b.length),
          blobs,
        };
      });
      data.navError = navError;
      return data;
    },
    { sessionOpts }
  );
}

async function main() {
  console.log("--- Attempt A: Browserbase advancedStealth ---");
  try {
    const a = await probe("browserbase", { proxies: true, browserSettings: { advancedStealth: true, os: "windows" } });
    report("Browserbase+advancedStealth", a);
    if (a.htmlLength > 50000) return; // got real content, no need for fallback
  } catch (err) {
    console.log("Browserbase advancedStealth attempt failed:", err.message);
  }

  console.log("\n--- Attempt B: Steel.dev stealthConfig ---");
  try {
    const b = await probe("steel", { useProxy: true, stealthConfig: { humanizeInteractions: true } });
    report("Steel+stealthConfig", b);
  } catch (err) {
    console.log("Steel stealthConfig attempt failed:", err.message);
  }
}

function report(label, result) {
  console.log(
    `[${label}] title:`, JSON.stringify(result.title),
    "| final URL:", result.finalUrl,
    "| html bytes:", result.htmlLength,
    "| navError:", result.navError
  );
  if (result.bodySnippet) console.log(`[${label}] body snippet:`, JSON.stringify(result.bodySnippet));
  console.log(`[${label}] total <script> tags:`, result.totalScripts, "| large (>2000b) blobs:", result.largeBlobCount, result.largeBlobSizes);

  for (let i = 0; i < result.blobs.length; i++) {
    const blob = result.blobs[i];
    const hits = PRICE_CANDIDATES.filter((c) => blob.includes(c));
    if (hits.length === 0) continue;
    console.log(`[${label}] === blob ${i} (${blob.length}b) matches: ${hits.join(", ")} ===`);
    for (const c of hits.slice(0, 3)) {
      const idx = blob.indexOf(c);
      console.log(`  ...${blob.slice(Math.max(0, idx - 150), idx + 250)}...`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
