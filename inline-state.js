/**
 * Helpers for extracting client-side app state that's embedded directly in
 * server-rendered HTML as `<script>window.NAME = {...};</script>` — used by
 * both bb-probe.js (investigation) and per-site importers (production
 * extraction) so the balanced-brace scanner isn't duplicated.
 *
 * Some sites clear these globals via client hydration before a headless
 * browser's page.evaluate() can read them (observed on LiveAuctioneers:
 * window.__data is real in the raw HTML but empty after render). Extracting
 * directly from static HTML sidesteps that race entirely.
 */

// Extract `window.NAME = {...}` blobs directly from raw HTML text.
function extractInlineWindowVars(html, names) {
  const found = {};
  for (const name of names) {
    const marker = `window.${name}=`;
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const searchFrom = idx + marker.length;
    const braceStart = html.indexOf("{", searchFrom);
    if (braceStart === -1 || braceStart - searchFrom > 5) continue; // must immediately follow the `=` (allow a little whitespace)
    let depth = 0;
    let inStr = false;
    let strCh = "";
    let esc = false;
    let end = -1;
    for (let i = braceStart; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        strCh = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const rawText = html.slice(braceStart, end + 1);
    // This is a JS object literal dumped into the page, not strict JSON —
    // `undefined` (unlike `null`) isn't valid JSON and breaks JSON.parse.
    // Confirmed via an actual parse error on LiveAuctioneers
    // ("errorMessage":undefined); only fixing what's been observed to
    // actually occur, not guessing at every possible JS-literal quirk.
    const jsonText = rawText.replace(/:(\s*)undefined\b/g, ":$1null");
    try {
      found[name] = { ok: true, value: JSON.parse(jsonText), bytes: rawText.length };
    } catch (e) {
      found[name] = { ok: false, error: e.message, bytes: rawText.length };
    }
  }
  return found;
}

// Recursively search a parsed state tree for objects that look like real
// lot/item records (have both a lot-number-ish and a price-ish field),
// rather than guessing a top-level path — state trees from Redux-hydrated
// apps nest data under source-specific slice names we can't predict.
function findLotLikeObjects(obj, pathStr, results, opts) {
  if (results.length >= opts.maxResults || opts.visited.count >= opts.maxVisited) return;
  if (obj == null || typeof obj !== "object") return;
  opts.visited.count++;
  if (!Array.isArray(obj)) {
    const keys = Object.keys(obj);
    const hasLot = keys.some((k) => /^lotnumber$/i.test(k));
    const hasPrice = keys.some((k) => /^(saleprice|priceresult|soldprice|currentbid|lowbidestimate)$/i.test(k));
    if (hasLot && hasPrice) {
      results.push({ path: pathStr, value: obj });
      return; // don't descend into a matched lot object
    }
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findLotLikeObjects(v, `${pathStr}[${i}]`, results, opts));
  } else {
    for (const [k, v] of Object.entries(obj)) findLotLikeObjects(v, `${pathStr}.${k}`, results, opts);
  }
}

module.exports = { extractInlineWindowVars, findLotLikeObjects };
