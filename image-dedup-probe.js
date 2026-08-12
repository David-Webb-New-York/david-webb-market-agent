#!/usr/bin/env node
/**
 * Systematic cross-dealer duplicate check, at full scale.
 *
 * The 2026-08-12 Back Vault spot-check (backvault-crosscheck-probe.js)
 * hand-picked 5 "close" candidates and confirmed 4 via Google reverse-image
 * search -- real evidence, but a tiny, deliberately-biased sample. The
 * user's real question is bigger: could EVERY dealer's inventory also be
 * sitting on The Back Vault and/or The RealReal, meaning the market-size
 * total in the report is overstated by as much as 2-3x?
 *
 * That's directly testable with data we already have, for free, no Google
 * or Browserbase needed: every active listing carries an image_url
 * (~1,525 of 1,567). If two listings are the same physical piece, they
 * near-always share the same product photograph (confirmed by the 4
 * Google-verified matches this session -- all were literally the same
 * photo file, just re-hosted). So: hash every image (perceptual
 * difference-hash via sharp), compare every cross-dealer pair, and see how
 * much of the ACTIVE, TRACKED inventory is really duplicated -- across the
 * whole dataset, not a hand-picked sample.
 *
 * This only catches duplication BETWEEN dealers we already track. It can't
 * see a piece that's on Back Vault and ALSO on a dealer we don't track at
 * all (that's what backvault-crosscheck-probe.js's Google searches are
 * for, and how Greenleaf & Crosby got found). But it directly answers "how
 * much of what's already in our own dataset is the same piece counted
 * twice" -- the part of the 2-3x fear we can actually measure precisely.
 *
 * Dispatched via image-dedup-probe.yml (needs a longer timeout than the
 * other debug probes -- downloading/hashing ~1,500 images takes a few
 * minutes even with concurrency).
 *
 * RESULT (2026-08-12, first real run): inconclusive. A 64-bit dHash isn't
 * a fine enough fingerprint for this catalog-photography style (centered
 * object, plain background, similar studio lighting across many DIFFERENT
 * pieces) -- it produced ~300 "strong" matches, and manual inspection
 * found most were false positives (e.g. an earring matched to an unrelated
 * cufflink). Worse, of the 4 pairs already confirmed real via Google
 * reverse-image search, only 1 (the Gap Ring / Wilson's Estate Jewelry
 * pair) showed up in the flagged list at all -- the other 3 didn't hash
 * close enough to match, likely because each site's own image pipeline
 * (crop/watermark/compression) diverges more than an 8x8 hash can absorb.
 * Not deleted -- kept as documented tooling and a base to improve on (a
 * larger hash grid, or a proper perceptual-hash library with crop/
 * rotation tolerance) -- but its numbers should NOT be treated as a
 * reliable duplicate count without that follow-up work.
 */
const fs = require("fs");
const sharp = require("sharp");
const { fetchWithTimeout } = require("./fetch-with-timeout");
const { LISTINGS_JSON } = require("./dealer-store");

const CONCURRENCY = 16;
const HASH_SIZE = 8; // 8x8 -> 64-bit dHash
// Calibrated against a synthetic re-encode/resize test (same image put
// through a second JPEG compression + resize, as a CDN re-hosting a photo
// would do): same-image distance ~10/64, a genuinely different image
// ~33/64 -- wide separation, so a threshold of 10 stays well clear of false
// negatives without drifting into "different but similarly-lit jewelry
// photo" false-positive territory.
const STRONG_THRESHOLD = 10; // out of 64 bits -- "same photo"
const LOOSE_THRESHOLD = 18; // logged separately for manual review, not counted as confirmed

function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return url || "";
  }
}

async function dHash(buffer) {
  const { data } = await sharp(buffer)
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hash = 0n;
  let bit = 0n;
  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const left = data[row * (HASH_SIZE + 1) + col];
      const right = data[row * (HASH_SIZE + 1) + col + 1];
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

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err.message || String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const dealers = JSON.parse(fs.readFileSync(LISTINGS_JSON, "utf8"));
  const active = dealers.filter((r) => r.status === "active" && r.image_url);
  console.log(`${active.length} active listing(s) with an image_url. Hashing (concurrency=${CONCURRENCY})...`);

  const hashResults = await mapConcurrent(active, CONCURRENCY, async (r) => {
    const res = await fetchWithTimeout(r.image_url, {}, 15000);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return dHash(buf);
  });

  const records = active
    .map((r, i) => ({ ...r, hash: hashResults[i], hashError: hashResults[i] && hashResults[i].error }))
    .filter((r) => !r.hashError && typeof r.hash === "bigint");

  const failed = active.length - records.length;
  console.log(`Hashed ${records.length} image(s) successfully (${failed} failed -- 404s, timeouts, decode errors).\n`);

  // Bucket by dealer to report per-dealer stats; compare every cross-domain pair
  const strongPairs = [];
  const loosePairs = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];
      const da = domain(a.listing_url);
      const db = domain(b.listing_url);
      if (da === db) continue; // same platform -- not a cross-listing question
      const dist = hamming(a.hash, b.hash);
      if (dist <= STRONG_THRESHOLD) strongPairs.push({ a, b, dist });
      else if (dist <= LOOSE_THRESHOLD) loosePairs.push({ a, b, dist });
    }
  }

  console.log(`Strong matches (Hamming <= ${STRONG_THRESHOLD}/64, same photo): ${strongPairs.length} pair(s)`);
  console.log(`Loose matches (<= ${LOOSE_THRESHOLD}/64, worth a manual look): ${loosePairs.length} pair(s)\n`);

  const involvedIds = new Set();
  for (const p of strongPairs) {
    involvedIds.add(p.a.id);
    involvedIds.add(p.b.id);
  }
  console.log(
    `${involvedIds.size} of ${records.length} hashed listings (${((involvedIds.size / records.length) * 100).toFixed(1)}%) ` +
      `are part of at least one confirmed cross-dealer photo match.`
  );

  // Per-dealer breakdown: of THIS dealer's listings, how many have a strong match at ANY other dealer?
  const byDealerInvolved = new Map();
  const byDealerTotal = new Map();
  for (const r of records) {
    byDealerTotal.set(r.dealer, (byDealerTotal.get(r.dealer) || 0) + 1);
  }
  for (const p of strongPairs) {
    byDealerInvolved.set(p.a.dealer, (byDealerInvolved.get(p.a.dealer) || 0) + 1);
    byDealerInvolved.set(p.b.dealer, (byDealerInvolved.get(p.b.dealer) || 0) + 1);
  }
  console.log(`\nPer-dealer: how many of each dealer's listings are part of a confirmed cross-dealer match?`);
  const dealerRows = [...byDealerTotal.entries()]
    .map(([dealer, total]) => ({ dealer, total, involved: byDealerInvolved.get(dealer) || 0 }))
    .sort((a, b) => b.involved / b.total - a.involved / a.total || b.total - a.total);
  for (const row of dealerRows) {
    if (row.involved === 0) continue;
    console.log(`  ${row.dealer}: ${row.involved}/${row.total} (${((row.involved / row.total) * 100).toFixed(1)}%)`);
  }

  // Specifically test the user's fear: of every OTHER dealer's listings (not Back Vault, not The RealReal),
  // how many have a strong match specifically AT Back Vault or The RealReal?
  const AGGREGATORS = new Set(["The Back Vault", "The RealReal"]);
  const otherDealerRecords = records.filter((r) => !AGGREGATORS.has(r.dealer));
  const otherMatchedAtAggregator = new Set();
  for (const p of strongPairs) {
    if (AGGREGATORS.has(p.a.dealer) && !AGGREGATORS.has(p.b.dealer)) otherMatchedAtAggregator.add(p.b.id);
    if (AGGREGATORS.has(p.b.dealer) && !AGGREGATORS.has(p.a.dealer)) otherMatchedAtAggregator.add(p.a.id);
  }
  console.log(
    `\nOf ${otherDealerRecords.length} listings from dealers OTHER than Back Vault/RealReal, ` +
      `${otherMatchedAtAggregator.size} (${((otherMatchedAtAggregator.size / otherDealerRecords.length) * 100).toFixed(1)}%) ` +
      `also have a confirmed photo match at Back Vault or The RealReal.`
  );

  console.log(`\nAll confirmed strong matches:`);
  for (const p of strongPairs) {
    console.log(
      `  dist=${p.dist} | [${p.a.dealer}] ${p.a.piece_name} ($${p.a.asking_price_usd}) <-> [${p.b.dealer}] ${p.b.piece_name} ($${p.b.asking_price_usd})`
    );
    console.log(`    ${p.a.listing_url}`);
    console.log(`    ${p.b.listing_url}`);
  }

  fs.mkdirSync("probe-output", { recursive: true });
  fs.writeFileSync(
    "probe-output/image-dedup-report.json",
    JSON.stringify(
      {
        totalActive: active.length,
        hashed: records.length,
        hashFailed: failed,
        strongMatches: strongPairs.map((p) => ({
          dist: p.dist,
          a: { dealer: p.a.dealer, piece: p.a.piece_name, price: p.a.asking_price_usd, url: p.a.listing_url },
          b: { dealer: p.b.dealer, piece: p.b.piece_name, price: p.b.asking_price_usd, url: p.b.listing_url },
        })),
        looseMatchCount: loosePairs.length,
        byDealer: dealerRows,
      },
      null,
      2
    )
  );
  console.log(`\nFull report: probe-output/image-dedup-report.json`);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
