/**
 * Cheap structural summary of a JSON API response: top-level keys, any array
 * field (walked up to 2 levels deep, since search APIs commonly wrap results
 * in an outer object/array), its length, and any sibling numeric fields that
 * look like pagination (nbHits, page, nbPages, hitsPerPage, totalRecords,
 * total_pages, ...). Lets a probe report real hit-counts/pagination evidence
 * in a log line without dumping/guessing at the full (often huge) response
 * body -- shared by bb-probe.js and bb-interactive-probe.js.
 */
const PAGINATION_KEY_RE = /^(nb|total|num)[_-]?(hits|records|pages|results)$|^(page|hitsperpage|pagesize|perpage)$/i;

function summarizeJsonShape(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const findArraysAndPagination = (node, depth) => {
    if (node == null || typeof node !== "object" || depth > 2) return { arrays: [], pagination: {} };
    const arrays = [];
    const pagination = {};
    const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
    for (const [k, v] of entries) {
      if (Array.isArray(v)) arrays.push({ path: k, length: v.length });
      else if (typeof v === "number" && PAGINATION_KEY_RE.test(k)) pagination[k] = v;
    }
    // Also look one level into the first object/array child (e.g. results[0].hits).
    if (depth < 2) {
      const firstChild = Array.isArray(node) ? node[0] : Object.values(node)[0];
      if (firstChild && typeof firstChild === "object") {
        const nested = findArraysAndPagination(firstChild, depth + 1);
        for (const a of nested.arrays) arrays.push({ path: `[nested].${a.path}`, length: a.length });
        Object.assign(pagination, nested.pagination);
      }
    }
    return { arrays, pagination };
  };
  const topLevelKeys = Array.isArray(obj) ? `array[${obj.length}]` : Object.keys(obj);
  const { arrays, pagination } = findArraysAndPagination(obj, 0);
  return { topLevelKeys, arrays, pagination };
}

module.exports = { summarizeJsonShape };
