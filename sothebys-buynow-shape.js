#!/usr/bin/env node
/**
 * Round 3 of the Sotheby's investigation. Rounds 1-2 already settled the
 * core question: searching "david webb" on Sotheby's live site returns 34
 * results, ALL of them "Buy now" fixed-price retail items (confirmed via
 * page text -- every single one shows a "Buy now" CTA + fixed USD price,
 * none show a bid/estimate/lot-number/sale-date), backed by a GraphQL
 * query literally named `retailItemBySlug` -- unambiguous: this is
 * Sotheby's fixed-price Buy Now marketplace, not bid-based upcoming
 * auction lots. Functionally this is a dealer listing (Sotheby's acting
 * as seller at a fixed ask), not an auction-history record.
 *
 * This round gets the DOM structure needed to build a real importer:
 * result-card markup (to reliably pair each item's title+price+url
 * together, not just a flat text dump that could misalign), and the
 * detail-page URL pattern for listing_url.
 */
const bb = require("./browserbase");

async function main() {
  const url = "https://www.sothebys.com/en/search?query=david+webb";
  const result = await bb.withPage(
    async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(7000);

      return page.evaluate(() => {
        // Find anchors that look like item detail links near "Buy now" text.
        const anchors = [...document.querySelectorAll("a[href]")]
          .filter((a) => /\/buy\/|\/rtl\/|\/item\/|retail/i.test(a.getAttribute("href") || ""))
          .slice(0, 10)
          .map((a) => ({ href: a.getAttribute("href"), text: a.textContent.trim().slice(0, 100) }));

        // Fallback: any anchor whose text or nearby text mentions "Buy now" or a $ amount.
        const priceAnchors = [...document.querySelectorAll("a[href]")]
          .filter((a) => /\d,\d{3}|buy now/i.test(a.textContent || ""))
          .slice(0, 10)
          .map((a) => ({ href: a.getAttribute("href"), text: a.textContent.trim().slice(0, 150) }));

        // Grab one full result-card's outerHTML by finding an element containing "Buy now" text and walking up a few levels.
        let cardHtml = null;
        const buyNowEls = [...document.querySelectorAll("*")].filter(
          (el) => el.children.length === 0 && /buy now/i.test(el.textContent || "")
        );
        if (buyNowEls.length) {
          let node = buyNowEls[0];
          for (let i = 0; i < 5 && node.parentElement; i++) node = node.parentElement;
          cardHtml = node.outerHTML.slice(0, 3000);
        }

        return {
          totalAnchors: document.querySelectorAll("a[href]").length,
          candidateAnchors: anchors,
          priceAnchors,
          cardHtml,
        };
      });
    },
    { sessionOpts: { proxies: true } }
  );

  console.log("Total <a href> on page:", result.totalAnchors);
  console.log("\nCandidate item-detail anchors (matched /buy|rtl|item|retail/ in href):");
  console.log(JSON.stringify(result.candidateAnchors, null, 2));
  console.log("\nAnchors with a price-like or 'Buy now' text:");
  console.log(JSON.stringify(result.priceAnchors, null, 2));
  console.log("\nSample result-card outerHTML (first 3000 chars):");
  console.log(result.cardHtml);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
