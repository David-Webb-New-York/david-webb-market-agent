/**
 * Permanent exclusion list -- confirmed non-jewelry "David Webb" homonym
 * noise (a footballer, a book co-editor, astronaut autographs, Magnum
 * photobook lots, a brooch by the unrelated jeweler David Andersen of
 * Norway) that keyword-search sources like Doyle legitimately surface
 * because they search on the literal text "David Webb"/"Webb", not a
 * structured maker field -- see HANDOFF.md's "Non-jewelry noise" entries.
 *
 * These were first removed as one-off manual deletions from the committed
 * JSON (2026-08-09), which didn't stick: a later full re-scrape re-added
 * every one of them, because nothing in the importer code actually knew
 * they were noise. This list is the fix -- checked once per URL, remembered
 * forever, instead of re-discovering and re-deleting the same handful of
 * records after every fresh import.
 *
 * Deliberately a URL blocklist, NOT a keyword filter: a keyword rule broad
 * enough to catch "eds." or "autograph" would also catch genuine David
 * Webb jewelry lots that happen to share a word (see the Invaluable
 * false-positive discussion in HANDOFF.md for exactly why keyword
 * filtering on free text is the wrong tool here).
 */
// Small standalone copy of history-store.js's normalizeUrl (not required
// from there directly, to avoid a require() cycle -- history-store.js
// needs this module too, to check every upsert against the blocklist).
function normalizeUrl(u) {
  if (!u) return "";
  const raw = String(u).trim();
  try {
    const url = new URL(raw);
    return (url.host + url.pathname).toLowerCase().replace(/\/+$/, "");
  } catch (_) {
    return raw.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

const EXCLUDED_URLS = [
  // Astronaut autograph lots ("[ASTRONAUTS] COOPER, L. GORDON., Jr. Autograph...")
  "https://www.doyle.com/auction/lot/lot-6---astronauts-cooper-l-gordon-jr-autograph/",
  "https://www.doyle.com/auction/lot/lot-213---astronauts-cooper-l-gordon-jr-autograph/",
  // Magnum-signed photobook lots
  "https://www.doyle.com/auction/lot/lot-504---magnum-signed-photobook-lardinois-brigitte-/",
  "https://www.doyle.com/auction/lot/lot-505---magnum-signed-photobook-halberstam/",
  "https://www.doyle.com/auction/lot/lot-506---magnum-signed-photobook-magnum-stories-new/",
  "https://www.doyle.com/auction/lot/lot-507---magnum-signed-photobook-new-yorkers-as-seen/",
  // Book citing "WEBB, DAVID K. and STEVENS, JOHN M., eds." (a book
  // co-editor, not the jewelry house)
  "https://www.doyle.com/auction/lot/lot-275---webb-david-k-and-stevens-john-m-eds/",
  // "Spider's Webb" brooch explicitly attributed to David Andersen of
  // Norway -- a different jewelry house
  "https://www.doyle.com/auction/lot/lot-477---gold-and-cabochon-amethyst-spiders-webb-brooch-david-andersen-norway/",
];

const EXCLUDED_SET = new Set(EXCLUDED_URLS.map(normalizeUrl));

function isExcludedListing(url) {
  return EXCLUDED_SET.has(normalizeUrl(url));
}

module.exports = { isExcludedListing, EXCLUDED_URLS };
