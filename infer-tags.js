/**
 * David Webb — trend tags (design motif / material / decade)
 * ---------------------------------------------------------------
 * Lightweight keyword tagging over a record's own piece_name/notes/
 * era_or_year, grounded in David Webb's actual, well-documented design
 * vocabulary (Zodiac series, animal/creature pieces, fishscale texture,
 * bombé forms, door-knocker earrings, carved hardstone, etc.) rather than
 * a generic catch-all — the goal is tags specific enough to be genuinely
 * interesting for trend charts ("median price of Zodiac-tagged pieces over
 * time"), not so broad they tag everything (deliberately excludes
 * near-universal terms like "diamond" or "gold" that wouldn't
 * differentiate anything).
 *
 * DELIBERATELY CENTRALIZED (unlike category/era_or_year, which are
 * duplicated per-importer and had a real bug from that duplication — see
 * HANDOFF.md's 2026-08-09 entry): this is called ONCE, from inside
 * history-store.js/dealer-store.js's own upsert(), computed fresh from the
 * record's own already-set fields on every upsert. No importer needs to
 * know this exists.
 */

const MOTIF_TAGS = [
  { tag: "Zodiac", re: /zodiac|\baries\b|\btaurus\b|\bgemini\b|\bcancer\b|\bleo\b|\bvirgo\b|\blibra\b|\bscorpio\b|\bsagittarius\b|\bcapricorn\b|\baquarius\b|\bpisces\b/i },
  { tag: "Animal/Creature", re: /\bfrog\b|\belephant\b|\bgiraffe\b|\bduck\b|\blion\b|\btiger\b|\bpanther\b|\bdragon\b|\bseahorse\b|\bfish\b|\bsnake\b|\bserpent\b|\bbird\b|\bowl\b|\bram\b|\bzebra\b|\bleopard\b|\bmonkey\b|\bturtle\b|\bcrab\b|\bscarab\b/i },
  { tag: "Fishscale", re: /fish[\s-]?scale/i },
  { tag: "Hammered Gold", re: /hammered/i },
  { tag: "Rock Crystal", re: /rock\s*crystal/i },
  { tag: "Enamel", re: /enamel/i },
  { tag: "Bombé", re: /bomb[eé]/i },
  { tag: "Door Knocker", re: /door\s*knocker/i },
  { tag: "Shell/Starfish", re: /starfish|\bshell\b|\bscallop\b/i },
  { tag: "Maltese Cross", re: /maltese/i },
  { tag: "Cuff/Bangle", re: /\bcuff\b|\bbangle\b/i },
];

const MATERIAL_TAGS = [
  { tag: "Carved Hardstone", re: /\bcarved\b|\bcoral\b|\bturquoise\b|\bjade\b|\blapis\b/i },
  { tag: "Cabochon", re: /cabochon/i },
];

const ALL_TAGS = [...MOTIF_TAGS, ...MATERIAL_TAGS];

// David Webb's active/vintage design period; a year outside this range is
// more likely a parsing artifact than a real era, so no decade tag is
// generated for it (the raw era_or_year field is unaffected either way).
// Matches both an explicit decade ("1970s") and any specific year in range
// ("circa 1965", "1965") -- floored to its decade.
const YEAR_RE = /\b(19[4-9]\d)s?\b/;

function decadeTag(eraText) {
  const m = String(eraText || "").match(YEAR_RE);
  if (!m) return null;
  return `${m[1].slice(0, 3)}0s`;
}

// `text` = piece_name + notes (or equivalent free text); `eraText` = the
// record's own era_or_year field. Returns a de-duplicated tag array.
function inferTags(text, eraText) {
  const hay = String(text || "");
  const tags = [];
  for (const { tag, re } of ALL_TAGS) {
    if (re.test(hay)) tags.push(tag);
  }
  const decade = decadeTag(eraText);
  if (decade) tags.push(decade);
  return tags;
}

module.exports = { inferTags, decadeTag, MOTIF_TAGS, MATERIAL_TAGS, ALL_TAGS };
