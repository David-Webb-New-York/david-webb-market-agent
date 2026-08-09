/**
 * David Webb — listing-quality flags ("worth a second look")
 * -------------------------------------------------------------
 * Two heuristic, best-effort flags computed fresh from the current dataset
 * on every report run (NOT baked into the stored records — the thresholds
 * are relative to the current price distribution, which shifts week to
 * week):
 *
 *   - price_anomaly: the price is implausibly low for a genuine David Webb
 *     piece. Two independent tests, either one is enough to flag:
 *       (a) category-relative: below the 15th percentile AND below 25% of
 *           the median for that category (needs >=12 comparable records —
 *           skipped for thin categories, not enough signal to judge)
 *       (b) absolute floor: below the 5th percentile of ALL prices of that
 *           record type (auction/dealer), regardless of category or sample
 *           size — catches a piece that's cheap in an absolute sense even
 *           if it's the only one of its kind on file.
 *   - unverified_authenticity: the listing's own description text doesn't
 *     mention a signature, hallmark, maker's mark, or certificate. Only
 *     evaluated when there IS description text to check — several sources
 *     (Phillips, 1stDibs, often Doyle) carry no free-text description at
 *     all, and an empty field is absence of evidence, not evidence of a
 *     problem; flagging those would just be systematic noise (see
 *     HANDOFF.md's Invaluable/Rago notes-field discussion for the same
 *     per-source caveat pattern).
 *
 * These are SIGNALS FOR A HUMAN TO CHECK, not fraud determinations —
 * worded that way everywhere they're surfaced (report, Slack, GUI).
 */

// A real David Webb piece -- even the smallest single cufflink or ring --
// essentially never transacts under this. Below it is almost always a
// placeholder ("price on request", a $1/$0.01 Shopify "sold out" stand-in)
// rather than a genuine price, so it's excluded entirely rather than
// treated as real data: including it would both mislabel a data artifact
// as a fraud signal AND drag down the percentile math for every other
// flagged item (confirmed via a real $1 "sold out" placeholder in the data).
const MIN_PLAUSIBLE_PRICE = 50;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= MIN_PLAUSIBLE_PRICE ? n : null;
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(nums, p) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function money(n) {
  return n === null || n === undefined ? "n/a" : "$" + Math.round(n).toLocaleString("en-US");
}

function pickFields(r, typeLabel, priceField, sourceField) {
  return {
    type: typeLabel,
    piece_name: r.piece_name || "",
    category: r.category || "other",
    price: num(r[priceField]),
    source: r[sourceField] || "",
    url: r.listing_url || "",
    _id: recordIdentity(r),
  };
}

const MIN_CATEGORY_SAMPLE = 12;
const CATEGORY_PERCENTILE = 15;
const CATEGORY_RATIO = 0.25;
const GLOBAL_PERCENTILE = 5;

function computePriceFlags(records, priceField, sourceField, typeLabel) {
  const priced = records.map((r) => ({ r, price: num(r[priceField]) })).filter((x) => x.price !== null);
  if (!priced.length) return [];

  const globalFloor = percentile(
    priced.map((x) => x.price),
    GLOBAL_PERCENTILE
  );

  const byCategory = new Map();
  for (const x of priced) {
    const cat = x.r.category || "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(x.price);
  }

  const flags = [];
  for (const x of priced) {
    const cat = x.r.category || "other";
    const catPrices = byCategory.get(cat);
    const catMedian = median(catPrices);
    let reason = null;

    if (catPrices.length >= MIN_CATEGORY_SAMPLE) {
      const catFloor = percentile(catPrices, CATEGORY_PERCENTILE);
      if (x.price <= catFloor && catMedian && x.price < catMedian * CATEGORY_RATIO) {
        reason = `${money(x.price)} is well below the typical range for "${cat}" (${catPrices.length} comparable ${typeLabel} records, median ${money(catMedian)})`;
      }
    }
    if (!reason && globalFloor !== null && x.price <= globalFloor) {
      reason = `${money(x.price)} is in the bottom ${GLOBAL_PERCENTILE}% of all ${typeLabel} prices on file, regardless of category`;
    }
    if (reason) {
      flags.push({ ...pickFields(x.r, typeLabel, priceField, sourceField), flag: "price_anomaly", reason });
    }
  }
  return flags;
}

const AUTH_KEYWORDS = /\b(sign(?:ed|ature)?|hallmark(?:ed)?|stamp(?:ed)?|marked|maker'?s?\s*mark|certificat(?:e|ed|ion)?|provenance)\b/i;

// Christie's and Sotheby's international sale catalogs are frequently
// written in Italian/Chinese/French/etc, not just English (confirmed via a
// real test run: a $11.26M Christie's lot got flagged purely because its
// description said "timbrata" instead of "stamped") -- the English-only
// keyword regex can't tell "no mention" from "mentioned in another
// language", so it's excluded here rather than producing systematic
// false positives on exactly the highest-value lots in the dataset.
const AUTH_EXCLUDED_SOURCES = new Set(["Christie's", "Sotheby's"]);

function recordIdentity(r) {
  return r.listing_url || `${r.piece_name || ""}|${r.auction_house || r.dealer || ""}`;
}

// Only evaluated against records ALREADY flagged as price anomalies --
// confirmed empirically that "doesn't mention a signature" is too weak a
// signal standalone: a real test run found only ~40% of obviously genuine
// dealer listings (Yafa, Fred Leighton, etc.) happen to use one of these
// words in their short marketing blurb, so alone this flagged ~73% of all
// active dealer inventory -- noise, not signal. Combined with an already-
// suspicious price, "cheap AND no verification language" is a real signal;
// "normally priced but the blurb didn't say 'signed'" isn't.
function computeAuthenticityFlags(records, priceField, sourceField, typeLabel, priceFlaggedIds) {
  const flags = [];
  for (const r of records) {
    if (!priceFlaggedIds.has(recordIdentity(r))) continue;
    if (AUTH_EXCLUDED_SOURCES.has(r[sourceField])) continue;
    const text = (r.notes || "").trim();
    if (!text) continue; // no description to check -- not evidence either way
    if (!AUTH_KEYWORDS.test(text)) {
      flags.push({
        ...pickFields(r, typeLabel, priceField, sourceField),
        flag: "unverified_authenticity",
        reason: "Also: listing description doesn't mention a signature, hallmark, maker's mark, or certificate",
      });
    }
  }
  return flags;
}

// Combine both flag types across both datasets. Returns a flat array, each
// item tagged with `flag` ("price_anomaly" | "unverified_authenticity") and
// `type` ("auction" | "dealer") plus enough fields to display standalone.
function computeFlags(history, dealers) {
  const activeDealers = dealers.filter((r) => r.status !== "inactive");
  const soldAuctions = history.filter((r) => num(r.sold_price) !== null);

  const auctionPriceFlags = computePriceFlags(soldAuctions, "sold_price", "auction_house", "auction");
  const dealerPriceFlags = computePriceFlags(activeDealers, "asking_price", "dealer", "dealer");
  const priceFlaggedIds = new Set([...auctionPriceFlags, ...dealerPriceFlags].map((f) => f._id));

  const all = [
    ...auctionPriceFlags,
    ...dealerPriceFlags,
    ...computeAuthenticityFlags(soldAuctions, "sold_price", "auction_house", "auction", priceFlaggedIds),
    ...computeAuthenticityFlags(activeDealers, "asking_price", "dealer", "dealer", priceFlaggedIds),
  ];
  return all.map(({ _id, ...rest }) => rest);
}

module.exports = { computeFlags, computePriceFlags, computeAuthenticityFlags, median, percentile };
