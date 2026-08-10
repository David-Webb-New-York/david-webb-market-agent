/**
 * David Webb — listing-quality flags ("worth a second look")
 * -------------------------------------------------------------
 * price_anomaly: the price is implausibly low for a genuine David Webb
 * piece, computed fresh from the current dataset on every report run (NOT
 * baked into the stored records — the thresholds are relative to the
 * current price distribution, which shifts week to week). Works off
 * sold_price_usd/asking_price_usd (convert-currency.js's USD-normalized
 * fields), not the raw native-currency price — otherwise a foreign-
 * currency lot (CHF, GBP, EUR, HKD, ITL...) skews the percentile math and
 * can itself look like a false price anomaly. Two independent tests,
 * either one is enough to flag:
 *   (a) category-relative: below the 15th percentile AND below 25% of
 *       the median for that category (needs >=12 comparable records —
 *       skipped for thin categories, not enough signal to judge)
 *   (b) absolute floor: below the 5th percentile of ALL prices of that
 *       record type (auction/dealer), regardless of category or sample
 *       size — catches a piece that's cheap in an absolute sense even
 *       if it's the only one of its kind on file.
 *
 * This is a SIGNAL FOR A HUMAN TO CHECK, not a fraud determination —
 * worded that way everywhere it's surfaced (report, Slack, GUI).
 *
 * A second flag (unverified_authenticity: no signature/hallmark/
 * certificate mentioned in the listing text) was tried and removed
 * 2026-08-10. It doesn't discriminate: genuine listings routinely skip
 * that language in a short marketing blurb regardless of price, so even
 * gated to active dealer listings $1,000+ it fired on 803 of ~1,382
 * eligible listings (58%) -- too broad to be "worth a second look" rather
 * than just background noise. Not worth re-adding without a materially
 * better signal than a keyword-absence check on free text.
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

// When the record's native currency wasn't USD, footnote the original
// figure alongside the USD-converted one shown everywhere else -- so
// clicking through to validate isn't confusing when the source site shows
// "CHF 15,000" but this report says "$16,700".
function nativeNote(r) {
  const cur = String(r.currency_note || "").toUpperCase().trim();
  const amount = Number(r.sold_price ?? r.asking_price);
  if (!cur || cur === "USD" || !Number.isFinite(amount) || amount <= 0) return "";
  return ` (${cur} ${Math.round(amount).toLocaleString("en-US")})`;
}

function pickFields(r, typeLabel, priceField, sourceField) {
  return {
    type: typeLabel,
    piece_name: r.piece_name || "",
    category: r.category || "other",
    price: num(r[priceField]),
    source: r[sourceField] || "",
    url: r.listing_url || "",
    native: nativeNote(r),
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

// Returns a flat array of price_anomaly flags across both datasets, each
// tagged with `type` ("auction" | "dealer") plus enough fields to display
// standalone.
function computeFlags(history, dealers) {
  const activeDealers = dealers.filter((r) => r.status !== "inactive");
  const soldAuctions = history.filter((r) => num(r.sold_price_usd) !== null);

  return [
    ...computePriceFlags(soldAuctions, "sold_price_usd", "auction_house", "auction"),
    ...computePriceFlags(activeDealers, "asking_price_usd", "dealer", "dealer"),
  ];
}

module.exports = { computeFlags, computePriceFlags, median, percentile };
