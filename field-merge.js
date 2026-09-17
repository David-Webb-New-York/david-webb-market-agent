/**
 * Shared three-way field merge for the auction-history and dealer-listings
 * stores, replacing the old "new non-empty value wins" upsert rule.
 *
 * The old rule silently overwrote a manually-curated field (a human-fixed
 * category, an added history_notes/listing_url) the next time the same
 * source happened to re-supply its own value for that field -- there was
 * no way to tell "the scraper always says this" apart from "a human just
 * corrected this." This tracks a hidden `_source_snapshot` per record: the
 * last value each diffable field held as supplied directly by an
 * importer/scraper (never a human edit). On each upsert, per field:
 *
 *   - the scraper reports nothing new (empty) for this field this run ->
 *     never erase existing data; skip entirely, snapshot untouched.
 *   - new scraped value === old snapshot value -> the source hasn't
 *     changed since we last saw it; leave the current value alone,
 *     whether or not a human has since edited it.
 *   - new scraped value !== old snapshot, and current value === old
 *     snapshot -> nobody has diverged from the source since last time;
 *     safe to accept the source's update.
 *   - new scraped value !== old snapshot, and current value !== old
 *     snapshot -> genuine conflict: a human changed it AND the source
 *     independently changed it. Keep the human value (never silently
 *     picked over by a re-scrape) but flag it in `conflictsMap` for a
 *     person to review, rather than guessing which side is right.
 *
 * `conflictsMap` is a Map keyed by `${id}::${field}`, self-healing: an
 * entry is deleted the moment that field's conflict resolves (the source
 * catches up, or a human's value starts matching the source again),
 * rather than accumulating stale flags forever.
 */

function mergeFields(prev, clean, diffableFields, conflictsMap, recordLabel) {
  // A record with no snapshot at all is pre-migration (existed before this
  // field ever did) -- there's nothing real to diff its current values
  // against yet. Apply the old "non-empty wins" rule once and seed the
  // snapshot from it, rather than treating every already-populated field
  // as a phantom conflict against an empty baseline. Every later upsert
  // for this record has a real snapshot and gets full three-way merging.
  const isFirstEncounter = prev._source_snapshot === undefined;
  const snapshot = { ...(prev._source_snapshot || {}) };
  const merged = { ...prev };

  for (const f of diffableFields) {
    const newScraped = clean[f] ?? "";
    if (newScraped === "") continue; // scraper reported nothing new -- never act on absence

    if (isFirstEncounter) {
      merged[f] = newScraped;
      snapshot[f] = newScraped;
      continue;
    }

    const oldScraped = snapshot[f] ?? "";
    const conflictKey = `${prev.id}::${f}`;
    const current = prev[f] ?? "";

    if (newScraped === oldScraped) {
      // Source hasn't changed since last time -- but a previously flagged
      // conflict still resolves if the human value has since come to
      // match it (e.g. someone manually accepted the source's number).
      if (current === oldScraped) conflictsMap.delete(conflictKey);
      continue;
    }

    if (current === oldScraped) {
      // No one has diverged from the source since the last scrape.
      merged[f] = newScraped;
      conflictsMap.delete(conflictKey);
    } else {
      // Both the source and a human changed this field independently.
      conflictsMap.set(conflictKey, {
        id: prev.id,
        piece_name: recordLabel,
        field: f,
        human_value: current,
        new_source_value: newScraped,
        detected: new Date().toISOString().slice(0, 10),
      });
      // merged[f] already carries the human value via the initial spread.
    }
    snapshot[f] = newScraped;
  }

  merged._source_snapshot = snapshot;
  return merged;
}

// First time a record is seen, there's nothing to diff against yet -- the
// snapshot starts as a straight copy of whatever the source supplied.
function initialSnapshot(clean, diffableFields) {
  const snapshot = {};
  for (const f of diffableFields) {
    if (clean[f] !== "" && clean[f] !== null && clean[f] !== undefined) snapshot[f] = clean[f];
  }
  return snapshot;
}

module.exports = { mergeFields, initialSnapshot };
