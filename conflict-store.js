/**
 * Persists field-merge conflicts (see field-merge.js) across runs, one
 * file per dataset. Keyed by `${id}::${field}` so entries self-heal --
 * loaded fresh at the start of a run, mutated in place by mergeFields()
 * during upserts, then written back as a flat array at the end.
 */

const fs = require("fs");

function loadConflicts(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return new Map(arr.map((c) => [`${c.id}::${c.field}`, c]));
  } catch (_) {
    return new Map();
  }
}

function saveConflicts(filePath, conflictsMap) {
  const arr = [...conflictsMap.values()].sort((a, b) => (a.piece_name || "").localeCompare(b.piece_name || ""));
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2) + "\n");
  return arr.length;
}

module.exports = { loadConflicts, saveConflicts };
