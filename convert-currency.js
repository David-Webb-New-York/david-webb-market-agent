/**
 * Best-effort historical FX conversion to USD.
 * ---------------------------------------------
 * ~12% of the auction-history dataset settles in a currency other than
 * USD (CHF, GBP, EUR, HKD, ITL, SGD -- Christie's/Sotheby's international
 * sale rooms), and until now the raw native-currency number was stored
 * and treated as if it were already USD everywhere downstream (stats,
 * percentiles, "worth a second look" flags, the GUI's sort-by-price).
 * That's a real, confirmed bug, not a display nicety: a 1994 Rome sale of
 * 11,260,000 ITL (~$7,000) was showing as the single highest-priced
 * "sale" on file, ahead of every genuine multi-million-dollar USD lot,
 * purely because 11.26 million looks huge as a raw number. Hong Kong
 * dollar lots (pegged ~7.8 HKD/USD) were similarly inflated ~8x.
 *
 * This is intentionally NOT settlement-date-accurate FX -- it's annual
 * average rates, sourced from general knowledge of widely-published
 * historical FX tables (Federal Reserve / IRS-yearly-average style
 * data), good to roughly the right order of magnitude and usually within
 * a few percent for well-documented recent years. That's exactly enough
 * to stop a foreign-currency figure from silently distorting a percentile,
 * a median, or a "top sale" ranking -- it is NOT tax- or audit-grade
 * precision. Live FX lookups aren't available from this environment
 * (network egress is restricted to a small allowlist), so this table is
 * hand-compiled rather than fetched; treat entries for thin/older years
 * as reasonable estimates, not verified facts.
 *
 * If a new source ever settles in a currency not listed here, toUsd()
 * returns null and the caller falls back to the raw native number rather
 * than guessing a rate -- same "leave it honestly wrong/blank rather than
 * fabricate" precedent as Sotheby's Buy Now shipping without a listing_url.
 */

// USD per 1 unit of foreign currency, annual average, by year.
const RATES = {
  GBP: {
    1990: 1.786, 1991: 1.767, 1992: 1.766, 1993: 1.502, 1994: 1.531,
    1995: 1.578, 1996: 1.562, 1997: 1.638, 1998: 1.657, 1999: 1.618,
    2000: 1.516, 2001: 1.440, 2002: 1.501, 2003: 1.635, 2004: 1.833,
    2005: 1.820, 2006: 1.843, 2007: 2.002, 2008: 1.853, 2009: 1.566,
    2010: 1.546, 2011: 1.604, 2012: 1.585, 2013: 1.565, 2014: 1.648,
    2015: 1.528, 2016: 1.356, 2017: 1.289, 2018: 1.335, 2019: 1.277,
    2020: 1.284, 2021: 1.376, 2022: 1.237, 2023: 1.244, 2024: 1.278,
    2025: 1.280, 2026: 1.300,
  },
  CHF: {
    1996: 0.809, 1997: 0.697, 1998: 0.708, 1999: 0.677, 2000: 0.618,
    2001: 0.591, 2002: 0.663, 2003: 0.744, 2004: 0.805, 2005: 0.807,
    2006: 0.797, 2007: 0.828, 2008: 0.928, 2009: 0.928, 2010: 0.958,
    2011: 1.135, 2012: 1.072, 2013: 1.081, 2014: 1.096, 2015: 1.045,
    2016: 1.015, 2017: 1.016, 2018: 1.023, 2019: 1.006, 2020: 1.064,
    2021: 1.096, 2022: 1.043, 2023: 1.124, 2024: 1.136, 2025: 1.200,
    2026: 1.268,
  },
  EUR: {
    2002: 0.946, 2003: 1.131, 2004: 1.244, 2005: 1.244, 2006: 1.256,
    2007: 1.371, 2008: 1.471, 2009: 1.394, 2010: 1.327, 2011: 1.392,
    2012: 1.286, 2013: 1.328, 2014: 1.329, 2015: 1.110, 2016: 1.107,
    2017: 1.130, 2018: 1.181, 2019: 1.119, 2020: 1.142, 2021: 1.183,
    2022: 1.054, 2023: 1.082, 2024: 1.082, 2025: 1.080, 2026: 1.163,
  },
  // Pegged to USD (~7.75-7.85 HKD/USD) since 1983 -- effectively constant.
  HKD: {
    2000: 0.1284, 2004: 0.1284, 2006: 0.1287, 2011: 0.1286, 2015: 0.1290,
    2018: 0.1276, 2019: 0.1276, 2020: 0.1290, 2021: 0.1284, 2022: 0.1282,
    2024: 0.1282, 2026: 0.1282,
  },
  // Pre-euro; the lira floated until its 1999 fixed conversion into EUR
  // at 1936.27 ITL. Only 1994 is currently needed by the dataset; a small
  // surrounding range is filled in for robustness against nearby years.
  ITL: {
    1992: 0.000825, 1993: 0.000625, 1994: 0.000621, 1995: 0.000605,
    1996: 0.000657, 1997: 0.000582, 1998: 0.000562,
  },
  SGD: {
    1999: 0.5917, 2000: 0.5798, 2001: 0.5535,
  },
};

function nearestYear(table, year) {
  const years = Object.keys(table).map(Number);
  if (!years.length) return null;
  years.sort((a, b) => Math.abs(a - year) - Math.abs(b - year));
  return table[years[0]];
}

// amount: native-currency number; currency: e.g. "CHF" (case-insensitive,
// blank/"USD" is a no-op passthrough); dateStr: "YYYY-MM-DD" or similar,
// used to pick the closest year's annual-average rate.
// Returns a rounded USD number, or null if the amount is invalid or the
// currency isn't in RATES (caller decides the fallback in that case).
function toUsd(amount, currency, dateStr) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cur = String(currency || "").toUpperCase().trim();
  if (!cur || cur === "USD") return Math.round(n);
  const table = RATES[cur];
  if (!table) return null;
  const year = Number(String(dateStr || "").slice(0, 4));
  const rate = nearestYear(table, Number.isFinite(year) && year > 1900 ? year : new Date().getUTCFullYear());
  return rate ? Math.round(n * rate) : null;
}

module.exports = { toUsd, RATES };
