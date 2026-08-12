#!/usr/bin/env node
/**
 * Round 4: r.jina.ai (a free public "reader" proxy) completely bypassed
 * the PerimeterX block in round 3 -- real, current David Webb inventory
 * came back from the designer category page (real prices, real titles,
 * "Published Time" dated days ago). This round checks what's needed to
 * build a real importer against it:
 *   1. Full category-page content -- pagination? total item count?
 *      image URLs present in the markdown (Jina strips most HTML, need
 *      to confirm images survive)?
 *   2. An individual product page via the same proxy -- does it carry
 *      fields a detail page would (materials, era, condition/notes) that
 *      the category page doesn't?
 *   3. A second, different category page (a different designer or the
 *      broader jewelry category) -- confirm this isn't a one-off fluke
 *      tied to this specific URL.
 */
const { fetchWithTimeout } = require("./fetch-with-timeout");

async function jina(url, label) {
  console.log(`\n=== ${label} ===`);
  console.log(url);
  try {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, {}, 30000);
    const text = await res.text();
    console.log(`status: ${res.status} | bytes: ${text.length}`);
    return text;
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return "";
  }
}

async function main() {
  const category = await jina(
    "https://www.therealreal.com/designers/david-webb/jewelry",
    "1. Full category page (David Webb jewelry)"
  );
  if (category) {
    console.log("--- FULL CONTENT ---");
    console.log(category);
    console.log("--- END FULL CONTENT ---");
    console.log("\nimage-like markdown (![...]) count:", (category.match(/!\[/g) || []).length);
    console.log("pagination-ish keywords found:", ["Next", "Page 2", "pagination", "Load more", "results"].filter((k) => category.includes(k)));
  }

  await new Promise((r) => setTimeout(r, 1500));

  const product = await jina(
    "https://www.therealreal.com/products/jewelry/brooches/pendant/david-webb-turquoise-diamond-brooch-pendant-vmnbw",
    "2. Individual product page (real URL from round 3's results)"
  );
  if (product) {
    console.log("--- FULL CONTENT ---");
    console.log(product);
    console.log("--- END FULL CONTENT ---");
  }

  await new Promise((r) => setTimeout(r, 1500));

  const otherDesigner = await jina(
    "https://www.therealreal.com/designers/van-cleef-arpels/jewelry",
    "3. Sanity check -- a different designer's category page (Van Cleef & Arpels)"
  );
  if (otherDesigner) {
    console.log("bytes:", otherDesigner.length, "| mentions 'Van Cleef':", (otherDesigner.match(/Van Cleef/gi) || []).length);
    console.log("first 600 bytes:", JSON.stringify(otherDesigner.slice(0, 600)));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
