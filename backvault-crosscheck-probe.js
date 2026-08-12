#!/usr/bin/env node
/**
 * Manual cross-listing trace, round 2: pick a handful of Back Vault
 * (thebackvault.com) listings whose price + wording are unusually close to
 * a listing we already track from a DIFFERENT dealer, and try to trace the
 * piece elsewhere via a reverse-image search and a text search -- looking
 * for whether it also surfaces under another dealer's name (which The Back
 * Vault's own listing never discloses -- see backvault-model-probe.js: no
 * per-item seller/consignor byline on the page itself).
 *
 * Round 1 (backvault-crosscheck-probe.js, first version) drove EVERYTHING
 * through Browserbase, including the Back Vault page loads -- and Back
 * Vault's own bot-check (a Cloudflare-style "Just a moment..." challenge)
 * blocked the Browserbase/Playwright browser fingerprint specifically, on
 * all 5 candidates. Ironic reversal of The RealReal's case: there, plain
 * fetch() was blocked and a real browser was the workaround; here, plain
 * fetch() already works fine (confirmed in backvault-model-probe.js) and
 * it's the real browser that gets walled off. So this round uses plain
 * fetch() for the Back Vault side (reliable, free) and reserves Browserbase
 * only for the Google side, which needs real browser interaction -- with
 * explicit CAPTCHA/consent-wall detection this time, since round 1's empty
 * "domains: []" results were ambiguous (genuine no-results vs. blocked).
 */
const { fetchWithTimeout } = require("./fetch-with-timeout");
const bb = require("./browserbase");

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

// -- Back Vault side: plain fetch, no browser needed (confirmed working) --

async function fetchBackVaultListing(url) {
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) return { error: `status ${res.status}` };
  const html = await res.text();
  const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
  const priceMatch = html.match(/\$[\d,]+\.\d{2}/);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return {
    img: imgMatch ? imgMatch[1] : null,
    price: priceMatch ? priceMatch[0] : null,
    textSnippet: text.slice(0, 400),
  };
}

// -- Google side: needs a real browser -- with explicit wall detection --

const WALL_MARKERS = [
  "unusual traffic",
  "detected unusual traffic",
  "before you continue to google",
  "our systems have detected",
  "verify you're human",
  "verify you are human",
  "recaptcha",
];

function detectWall(bodyText, pageTitle) {
  const lower = `${bodyText} ${pageTitle}`.toLowerCase();
  const hit = WALL_MARKERS.find((m) => lower.includes(m));
  return hit || null;
}

async function tryAcceptConsent(page) {
  // Google's EU/cookie-consent interstitial commonly shows an "Accept all" button
  for (const text of ["Accept all", "I agree", "Accept"]) {
    try {
      const btn = page.getByRole("button", { name: text, exact: false }).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function extractGoogleResults(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a")]
      .map((a) => ({ href: a.href, text: a.textContent?.trim().slice(0, 120) }))
      .filter((l) => l.href && l.href.startsWith("http") && !l.href.includes("google.com") && !l.href.includes("gstatic.com"));
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
    return { pageTitle: document.title, bodyText: document.body.innerText.slice(0, 600), domains: domains.slice(0, 15) };
  });
}

async function googleSearch(page, url, label) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await tryAcceptConsent(page);
  await page.waitForTimeout(1500);
  const result = await extractGoogleResults(page);
  const wall = detectWall(result.bodyText, result.pageTitle);
  return { label, wall, ...result };
}

async function reverseImageSearch(page, imageUrl) {
  if (!imageUrl) return { label: "reverse-image", error: "no image URL to search" };
  const url = `https://www.google.com/searchbyimage?image_url=${encodeURIComponent(imageUrl)}&sbisrc=cr_1_5_2`;
  return googleSearch(page, url, "reverse-image");
}

async function textSearch(page, query) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  return googleSearch(page, url, "text-search");
}

async function main() {
  console.log("=== Step 1: fetch each Back Vault listing directly (plain fetch) ===");
  const listings = [];
  for (const c of CANDIDATES) {
    const listing = await fetchBackVaultListing(c.bvUrl);
    listings.push({ ...c, listing });
    console.log(`\n${c.bvPiece}`);
    console.log("  image:", listing.img || listing.error);
    console.log("  price on page:", listing.price);
    console.log("  text:", listing.textSnippet);
  }

  console.log("\n\n=== Step 2: Google reverse-image + text search (Browserbase) ===");
  await bb.withPage(async (page) => {
    for (const c of listings) {
      console.log(`\n\n########## ${c.bvPiece} ##########`);
      console.log(`Back Vault: $${c.bvPrice} | ${c.bvUrl}`);
      console.log(`Candidate match: ${c.otherDealer} -- "${c.otherPiece}" -- $${c.otherPrice}${c.otherUrl ? " -- " + c.otherUrl : " (no URL on file)"}`);

      const imgResult = await reverseImageSearch(page, c.listing.img);
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
