#!/usr/bin/env node
/**
 * Debug follow-up: verify-cross-listings.js's first real run (2026-08-12)
 * correctly generated candidates for 3 pairs already confirmed real via
 * Google reverse-image search (Geodesic Ring/Oak Gem, Gap Ring/Wilson's,
 * Half-Hoop Earrings/Macklowe) -- but Claude judged all 3 as DIFFERENT,
 * disagreeing with Google. Before trusting the main run's aggregate
 * numbers, see Claude's actual full reasoning on these specific pairs to
 * understand whether that's a real false-negative or a legitimate call
 * (e.g. genuinely different photo angles/crops making it hard to be sure).
 */
const { fetchImageBase64, askClaude } = require("./verify-cross-listings");

const PAIRS = [
  {
    label: "Geodesic Ring (Back Vault vs Oak Gem) -- Google-confirmed SAME",
    aUrl: "https://cdn.shopify.com/s/files/1/0275/9891/3611/products/RR8312.jpg?v=1756333783",
    aName: "David Webb Platinum & 18K Yellow Gold Geodesic Diamond And Ruby Cocktail Ring",
    bUrl: "https://cdn.shopify.com/s/files/1/1064/3732/files/David_Webb_Geodesic_Diamond_Ruby_Gold_Platinum_Dome_Ring-231-0.jpg?v=1768246953",
    bName: "David Webb Geodesic Diamond Ruby Gold Platinum Dome Ring",
  },
  {
    label: "Diamond Gap Ring (Back Vault vs Wilson's) -- Google-confirmed SAME",
    aUrl: "https://cdn.shopify.com/s/files/1/0275/9891/3611/products/RR7607_56b833a1-1750-4e6a-815a-edc124588a95.jpg?v=1756331229",
    aName: "David Webb Platinum & 18K Yellow Gold Diamond Gap Ring",
    bUrl: "https://cdn.shopify.com/s/files/1/2343/8923/files/DSC_2330_2018409.jpg?v=1750878566",
    bName: "David Webb Diamond Black Enamel Platinum 18 Karat Yellow Gold Gap Ring",
  },
  {
    label: "Half-Hoop Earrings (Macklowe Gallery vs Macklowe Gallery Jewelry/1stDibs) -- identical title, same dealer family",
    aUrl: "https://cdn.shopify.com/s/files/1/0479/4420/4448/files/ER-22002_0.jpg?v=1785790991",
    aName: "David Webb Half-Hoop Earrings",
    bUrl: "https://a.1stdibscdn.com/david-webb-half-hoop-earrings-for-sale/j_89/j_273560821757709640060/j_27356082_1757709640532_bg_processed.jpg",
    bName: "David Webb Half-Hoop Earrings",
  },
];

async function main() {
  for (const p of PAIRS) {
    console.log(`\n########## ${p.label} ##########`);
    const [imgA, imgB] = await Promise.all([fetchImageBase64(p.aUrl), fetchImageBase64(p.bUrl)]);
    const verdict = await askClaude(imgA, imgB, p.aName, p.bName);
    console.log(`Verdict: ${verdict.verdict}`);
    console.log(`Full response: ${verdict.raw}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
