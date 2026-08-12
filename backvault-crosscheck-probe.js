#!/usr/bin/env node
/**
 * Manual cross-listing trace: pick a handful of Back Vault (thebackvault.com)
 * listings whose price + wording are unusually close to a listing we
 * already track from a DIFFERENT dealer, open the real Back Vault page in a
 * Browserbase browser (this sandbox's plain fetch/network can't reach it --
 * see HANDOFF.md §7.6), pull its actual product photo, and try to trace
 * that piece elsewhere via a reverse-image search and a text search --
 * looking for whether it also surfaces under another dealer's name (which
 * The Back Vault's own listing never discloses -- see
 * backvault-model-probe.js: no per-item seller/consignor byline on the
 * page itself).
 *
 * This is exploratory/manual verification, not a production import -- one
 * Browserbase session is reused across all candidates to keep cost down.
 */
const bb = require("./browserbase");

// Candidates picked from a local price+title-similarity pass over the
// committed dataset (loose net: category match, price within 15%, >=1
// shared distinctive word) -- these are the CLOSEST candidate matches
// found between a Back Vault listing and something we already track from
// a different dealer. "Close" here does not mean confirmed -- that's what
// this probe is checking.
const CANDIDATES = [
  {
    bvUrl: "https://thebackvault.com/products/david-webb-platinum-turquoise-and-diamond-ring-rr7841",
    bvPiece: "David Webb Platinum Turquoise And Diamond Ring",
    bvPrice: 25600,
    otherDealer: "Kentshire",
    otherPiece: "Turquoise and diamond ring, David Webb",
    otherPrice: 22500,
    otherUrl: "https://kentshire.com/products/turquoise-and-diamond-ring-david-webb",
  },
  {
    bvUrl: "https://thebackvault.com/products/david-webb-platinum-18k-yellow-gold-liberty-head-coin-necklace-rr8371",
    bvPiece: "David Webb Platinum & 18K Yellow Gold Liberty Head Coin Necklace",
    bvPrice: 30800,
    otherDealer: "Sotheby's (Buy Now)",
    otherPiece: "Gold, Platinum, Diamond and Liberty Head Coin Necklace",
    otherPrice: 30000,
    otherUrl: null,
  },
  {
    bvUrl: "https://thebackvault.com/products/david-webb-platinum-18k-yellow-gold-geodesic-diamond-and-ruby-cocktail-ring-rr8312",
    bvPiece: "David Webb Platinum & 18K Yellow Gold Geodesic Diamond And Ruby Cocktail Ring",
    bvPrice: 37000,
    otherDealer: "Oak Gem",
    otherPiece: "David Webb Geodesic Diamond Ruby Gold Platinum Dome Ring",
    otherPrice: 36000,
    otherUrl: "https://oakgem.com/products/david-webb-geodesic-diamond-ruby-gold-platinum-dome-ring",
  },
  {
    bvUrl: "https://thebackvault.com/products/david-webb-platinum-18k-yellow-gold-diamond-gap-ring-rr7607",
    bvPiece: "David Webb Platinum & 18K Yellow Gold Diamond Gap Ring",
    bvPrice: 7400,
    otherDealer: "Wilson's Estate Jewelry",
    otherPiece: "David Webb Diamond Black Enamel Platinum 18 Karat Yellow Gold Gap Ring",
    otherPrice: 7200,
    otherUrl: "https://wilsonsestatejewelry.com/products/david-webb-diamond-black-enamel-platinum-18-karat-yellow-gold-gap-ring",
  },
  {
    bvUrl: "https://thebackvault.com/products/david-webb-18k-yellow-gold-amethyst-coral-with-enamel-earrings-rr5401",
    bvPiece: "David Webb 18K Yellow Gold Amethyst & Coral With Enamel Earrings",
    bvPrice: 22100,
    otherDealer: "The RealReal",
    otherPiece: "18K Coral & Amethyst Clip-On Earrings",
    otherPrice: 23375,
    otherUrl: "https://www.therealreal.com/products/jewelry/earrings/clip-on/david-webb-18k-coral-amethyst-clip-on-earrings-u3j7b",
  },
];

async function extractBackVaultListing(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const img = document.querySelector('meta[property="og:image"]')?.content
      || document.querySelector(".product__media img, .product-single__photo img")?.src
      || null;
    const price = document.querySelector('[class*="price"]')?.textContent?.trim() || null;
    const bodyText = document.body.innerText.slice(0, 3000);
    return { img, price, bodyText, title: document.title };
  });
}

async function reverseImageSearch(page, imageUrl) {
  if (!imageUrl) return { error: "no image URL" };
  const searchUrl = `https://www.google.com/searchbyimage?image_url=${encodeURIComponent(imageUrl)}&sbisrc=cr_1_5_2`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a")]
      .map((a) => ({ href: a.href, text: a.textContent?.trim().slice(0, 120) }))
      .filter((l) => l.href && l.href.startsWith("http") && !l.href.includes("google.com"));
    // de-dupe by hostname, keep first occurrence
    const seen = new Set();
    const domains = [];
    for (const l of links) {
      try {
        const host = new URL(l.href).hostname.replace(/^www\./, "");
        if (!seen.has(host)) {
          seen.add(host);
          domains.push({ host, sample: l.text });
        }
      } catch (_) {}
    }
    return { pageTitle: document.title, domains: domains.slice(0, 15) };
  });
}

async function textSearch(page, query) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a")]
      .map((a) => a.href)
      .filter((h) => h && h.startsWith("http") && !h.includes("google.com") && !h.includes("gstatic.com"));
    const seen = new Set();
    const domains = [];
    for (const href of links) {
      try {
        const host = new URL(href).hostname.replace(/^www\./, "");
        if (!seen.has(host)) {
          seen.add(host);
          domains.push(host);
        }
      } catch (_) {}
    }
    return { pageTitle: document.title, domains: domains.slice(0, 15) };
  });
}

async function main() {
  await bb.withPage(async (page) => {
    for (const c of CANDIDATES) {
      console.log(`\n\n########## ${c.bvPiece} ##########`);
      console.log(`Back Vault: $${c.bvPrice} | ${c.bvUrl}`);
      console.log(`Candidate match: ${c.otherDealer} -- "${c.otherPiece}" -- $${c.otherPrice}${c.otherUrl ? " -- " + c.otherUrl : " (no URL on file)"}`);

      const listing = await extractBackVaultListing(page, c.bvUrl);
      console.log(`\n-- Back Vault page --`);
      console.log("title:", listing.title);
      console.log("displayed price:", listing.price);
      console.log("main image:", listing.img);
      console.log("body text (first 500 chars):", (listing.bodyText || "").slice(0, 500).replace(/\s+/g, " "));

      const imgResult = await reverseImageSearch(page, listing.img);
      console.log(`\n-- Reverse image search --`);
      console.log(JSON.stringify(imgResult, null, 2));

      const query = `"David Webb" ${c.bvPiece.replace(/^David Webb\s*/i, "").replace(/[^\w\s]/g, " ")}`.trim();
      const textResult = await textSearch(page, query);
      console.log(`\n-- Text search: ${query} --`);
      console.log(JSON.stringify(textResult, null, 2));
    }
  });
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
