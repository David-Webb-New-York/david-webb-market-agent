#!/usr/bin/env node
/**
 * Systematic cross-listing check, attempt 3 -- and the one meant to
 * actually work.
 *
 * Attempt 1 (image-dedup-probe.js, dHash) failed: calibration against
 * known true/false pairs (2026-08-12) showed a 64-bit AND 256-bit
 * gradient hash simply can't separate "same piece, different photo
 * processing" from "different piece, similar studio lighting" for this
 * catalog-photography style -- the true and false pairs' distances
 * overlapped completely. See image-dedup-probe.js's header for the data.
 *
 * This attempt swaps pixel math for actual judgment: reuse the cheap
 * price+category+title-word-overlap heuristic (already proven useful
 * elsewhere in this project) to narrow the full active dataset down to a
 * short list of plausible candidates -- NOT full pairwise comparison --
 * then have Claude (vision-capable) look at each candidate pair's two
 * real photos and judge whether they're the same physical piece. Claude
 * understands what it's looking at (gemstone, setting, motif) in a way no
 * hash can. Reuses the same ANTHROPIC_API_KEY already wired into
 * weekly-report.yml -- no new vendor.
 *
 * Cost: ~164 candidates over the current dataset, ~2 images + a short
 * prompt each -- well under $2 at standard Sonnet-class vision pricing.
 * Scales with the dataset, not run count -- re-running after the dataset
 * changes only re-checks new candidates if a cache is added later; for
 * now this is a one-off audit script, not part of the scheduled pipeline.
 */
const fs = require("fs");
const { fetchWithTimeout } = require("./fetch-with-timeout");
const { LISTINGS_JSON } = require("./dealer-store");

const API_KEY = process.env.ANTHROPIC_API_KEY;
const CONCURRENCY = 4;
const PRICE_TOLERANCE = 0.1; // 10%
const MIN_TITLE_SIM = 0.3;
const MIN_SHARED_TOKENS = 1;

const STOPWORDS = new Set([
  "david", "webb", "and", "a", "an", "the", "of", "with", "in", "18k", "18", "karat", "gold", "platinum", "14k",
  "carat", "carats", "ring", "rings", "earrings", "earclips", "clip", "clips", "clip-on", "necklace", "bracelet",
  "bracelets", "brooch", "brooches", "cufflinks", "pendant", "pendants", "hoop", "cocktail", "dome", "tie", "bar",
  "set", "diamond", "diamonds", "enamel", "vintage", "estate", "fine", "jewelry", "pair", "large", "small",
]);

function tokens(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return { j: 0, inter: 0 };
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return { j: inter / (a.size + b.size - inter), inter };
}

function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return url || "";
  }
}

function findCandidates(active) {
  const candidates = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.category !== b.category) continue;
      if (domain(a.listing_url) === domain(b.listing_url)) continue;
      const priceDiff = Math.abs(a.asking_price_usd - b.asking_price_usd) / Math.max(a.asking_price_usd, b.asking_price_usd);
      if (priceDiff > PRICE_TOLERANCE) continue;
      const { j: sim, inter } = jaccard(tokens(a.piece_name), tokens(b.piece_name));
      if (inter >= MIN_SHARED_TOKENS && sim >= MIN_TITLE_SIM) {
        candidates.push({ a, b, sim, priceDiff });
      }
    }
  }
  return candidates;
}

async function fetchImageBase64(url) {
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mediaType: contentType.split(";")[0].trim() };
}

async function askClaude(imgA, imgB, pieceA, pieceB) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Photo A -- listed as "${pieceA}":` },
            { type: "image", source: { type: "base64", media_type: imgA.mediaType, data: imgA.data } },
            { type: "text", text: `Photo B -- listed as "${pieceB}":` },
            { type: "image", source: { type: "base64", media_type: imgB.mediaType, data: imgB.data } },
            {
              type: "text",
              text:
                "Are these two photos of the SAME physical piece of jewelry (possibly re-photographed, cropped, or " +
                "color-corrected differently by different sellers), or two DIFFERENT pieces that merely look similar " +
                "(same style/materials/era but a distinct object)? " +
                'Respond with exactly one line: "SAME" or "DIFFERENT", followed by a dash and a one-sentence reason ' +
                "citing a specific visual detail (a stone's exact shape/placement, a hallmark, a scratch, an asymmetry -- " +
                "not just \"they look alike\").",
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const verdict = /^SAME/i.test(text) ? "SAME" : /^DIFFERENT/i.test(text) ? "DIFFERENT" : "UNCLEAR";
  return { verdict, raw: text };
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
  if (!API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  const dealers = JSON.parse(fs.readFileSync(LISTINGS_JSON, "utf8"));
  const active = dealers.filter((r) => r.status === "active" && r.asking_price_usd && r.image_url);
  console.log(`${active.length} active listing(s) with price+image. Finding candidates...`);

  const candidates = findCandidates(active);
  console.log(`${candidates.length} candidate pair(s) (same category, price within ${PRICE_TOLERANCE * 100}%, title sim >= ${MIN_TITLE_SIM}).`);
  console.log(`Verifying with Claude vision (concurrency=${CONCURRENCY})...\n`);

  const results = await mapConcurrent(candidates, CONCURRENCY, async (c) => {
    const [imgA, imgB] = await Promise.all([fetchImageBase64(c.a.image_url), fetchImageBase64(c.b.image_url)]);
    const verdict = await askClaude(imgA, imgB, c.a.piece_name, c.b.piece_name);
    return { ...c, verdict };
  });

  const errors = results.filter((r) => r.error);
  const judged = results.filter((r) => !r.error);
  const confirmed = judged.filter((r) => r.verdict.verdict === "SAME");
  const rejected = judged.filter((r) => r.verdict.verdict === "DIFFERENT");
  const unclear = judged.filter((r) => r.verdict.verdict === "UNCLEAR");

  console.log(`\n${errors.length} candidate(s) errored (fetch/API failures).`);
  console.log(`${judged.length} judged: ${confirmed.length} SAME, ${rejected.length} DIFFERENT, ${unclear.length} unclear.\n`);

  console.log(`=== CONFIRMED cross-listings ===`);
  for (const r of confirmed) {
    console.log(
      `  [${r.a.dealer}] ${r.a.piece_name} ($${r.a.asking_price_usd}) <-> [${r.b.dealer}] ${r.b.piece_name} ($${r.b.asking_price_usd})`
    );
    console.log(`    ${r.a.listing_url}`);
    console.log(`    ${r.b.listing_url}`);
    console.log(`    Claude: ${r.verdict.raw}`);
  }

  const involvedIds = new Set();
  for (const r of confirmed) {
    involvedIds.add(r.a.id);
    involvedIds.add(r.b.id);
  }
  console.log(
    `\n${involvedIds.size} of ${active.length} active listings (${((involvedIds.size / active.length) * 100).toFixed(2)}%) ` +
      `are part of at least one Claude-confirmed cross-listing (lower bound -- only candidates the price/title filter surfaced were checked).`
  );

  const AGGREGATORS = new Set(["The Back Vault", "The RealReal"]);
  const otherActive = active.filter((r) => !AGGREGATORS.has(r.dealer));
  const otherMatchedAtAggregator = new Set();
  for (const r of confirmed) {
    if (AGGREGATORS.has(r.a.dealer) && !AGGREGATORS.has(r.b.dealer)) otherMatchedAtAggregator.add(r.b.id);
    if (AGGREGATORS.has(r.b.dealer) && !AGGREGATORS.has(r.a.dealer)) otherMatchedAtAggregator.add(r.a.id);
  }
  console.log(
    `Of ${otherActive.length} listings from dealers other than Back Vault/RealReal, ` +
      `${otherMatchedAtAggregator.size} (${((otherMatchedAtAggregator.size / otherActive.length) * 100).toFixed(2)}%) ` +
      `are confirmed also listed at Back Vault or The RealReal.`
  );

  fs.mkdirSync("probe-output", { recursive: true });
  fs.writeFileSync(
    "probe-output/cross-listing-verification.json",
    JSON.stringify(
      {
        activeCount: active.length,
        candidateCount: candidates.length,
        errors: errors.length,
        confirmed: confirmed.map((r) => ({
          a: { dealer: r.a.dealer, piece: r.a.piece_name, price: r.a.asking_price_usd, url: r.a.listing_url },
          b: { dealer: r.b.dealer, piece: r.b.piece_name, price: r.b.asking_price_usd, url: r.b.listing_url },
          reason: r.verdict.raw,
        })),
        rejectedCount: rejected.length,
        unclearCount: unclear.length,
      },
      null,
      2
    )
  );
  console.log(`\nFull report: probe-output/cross-listing-verification.json`);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
