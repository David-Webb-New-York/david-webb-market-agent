#!/usr/bin/env node
/**
 * Calibration run for image-dedup-probe.js's dHash approach, using REAL
 * ground truth instead of a synthetic test image. The first full run
 * (2026-08-12) produced ~300 mostly-false-positive "strong" matches at
 * 8x8/64-bit, and missed 3 of 4 pairs already confirmed real via Google
 * reverse-image search. This fetches those same real images directly and
 * reports actual Hamming distances at two hash sizes (8x8/64-bit vs
 * 16x16/256-bit, both normalized to a 0-1 fraction so they're comparable)
 * for known TRUE pairs (same physical piece, confirmed via Google) and
 * known FALSE pairs (different pieces that the 64-bit hash wrongly
 * flagged), to see whether a bigger hash grid actually separates them.
 */
const sharp = require("sharp");
const { fetchWithTimeout } = require("./fetch-with-timeout");

async function dHash(buffer, size) {
  const { data } = await sharp(buffer)
    .resize(size + 1, size, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hash = 0n;
  let bit = 0n;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const left = data[row * (size + 1) + col];
      const right = data[row * (size + 1) + col + 1];
      hash |= (left < right ? 1n : 0n) << bit;
      bit++;
    }
  }
  return hash;
}

function hamming(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

const TRUE_PAIRS = [
  {
    label: "Geodesic Ring (Back Vault <-> Oak Gem)",
    a: "https://cdn.shopify.com/s/files/1/0275/9891/3611/products/RR8312.jpg?v=1756333783",
    b: "https://cdn.shopify.com/s/files/1/1064/3732/files/David_Webb_Geodesic_Diamond_Ruby_Gold_Platinum_Dome_Ring-231-0.jpg?v=1768246953",
  },
  {
    label: "Diamond Gap Ring (Back Vault <-> Wilson's)",
    a: "https://cdn.shopify.com/s/files/1/0275/9891/3611/products/RR7607_56b833a1-1750-4e6a-815a-edc124588a95.jpg?v=1756331229",
    b: "https://cdn.shopify.com/s/files/1/2343/8923/files/DSC_2330_2018409.jpg?v=1750878566",
  },
  {
    label: "Amethyst & Coral Earrings (Back Vault <-> The RealReal)",
    a: "https://cdn.shopify.com/s/files/1/0275/9891/3611/products/RR5401_ea45d084-486a-4d2c-8d8c-ab7399b63628.jpg?v=1756331971",
    b: "https://product-images.therealreal.com/DWB21029_1_enlarged.jpg?auto=webp&width=3840",
  },
];

const FALSE_PAIRS = [
  {
    label: "Enamel Stud Earrings (RealReal) <-> Turquoise Lion Cufflinks (Oak Gem) -- wrongly flagged 1st run",
    a: "https://product-images.therealreal.com/DWB21038_1_enlarged.jpg?auto=webp&width=3840",
    b: "https://cdn.shopify.com/s/files/1/1064/3732/files/OG6.121660.jpg?v=1686680165",
  },
  {
    label: "Pearl & Diamond Bracelet (Saidian) <-> Carved Rock Crystal Ring (Fred Leighton) -- wrongly flagged 1st run",
    a: "https://cdn.shopify.com/s/files/1/0038/5545/0182/files/JS_07.jpg?v=1785433493",
    b: "https://www.fredleighton.com/wp-content/uploads/R-37356-FL-0-0-FL37356-STILL-1500.jpg",
  },
];

async function fetchAndHash(url, sizes) {
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`status ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hashes = {};
  for (const size of sizes) hashes[size] = await dHash(buf, size);
  return hashes;
}

async function main() {
  const sizes = [8, 16];
  console.log(`Comparing at hash sizes: ${sizes.map((s) => `${s}x${s} (${s * s}-bit)`).join(", ")}\n`);

  for (const [label, pairs] of [
    ["TRUE (confirmed same piece via Google reverse-image search)", TRUE_PAIRS],
    ["FALSE (different pieces, wrongly flagged by 1st run's 64-bit hash)", FALSE_PAIRS],
  ]) {
    console.log(`=== ${label} ===`);
    for (const p of pairs) {
      try {
        const [ha, hb] = await Promise.all([fetchAndHash(p.a, sizes), fetchAndHash(p.b, sizes)]);
        const parts = sizes.map((size) => {
          const dist = hamming(ha[size], hb[size]);
          const frac = (dist / (size * size)).toFixed(3);
          return `${size}x${size}: dist=${dist}/${size * size} (${frac})`;
        });
        console.log(`  ${p.label}\n    ${parts.join(" | ")}`);
      } catch (err) {
        console.log(`  ${p.label}\n    ERROR: ${err.message}`);
      }
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
