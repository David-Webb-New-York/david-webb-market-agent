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

// Find the first `{...}` balanced object at/after `fromIdx`, brace/string-aware
// (so braces inside string values don't confuse depth counting). Returns
// {start, end, text} or null.
function findBalancedObject(text, fromIdx) {
  const braceStart = text.indexOf("{", fromIdx);
  if (braceStart === -1) return null;
  let depth = 0;
  let inStr = false;
  let strCh = "";
  let esc = false;
  let end = -1;
  for (let i = braceStart; i < text.length; i++) {
    const c = text[i];
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
  if (end === -1) return null;
  return { start: braceStart, end, text: text.slice(braceStart, end + 1) };
}

// A JS object literal dumped into a page isn't strict JSON — `undefined`
// (unlike `null`) breaks JSON.parse. Confirmed via an actual parse error on
// LiveAuctioneers ("errorMessage":undefined); only fixing what's been
// observed to actually occur, not guessing at every possible JS-literal
// quirk.
function sanitizeJsLiteral(text) {
  return text.replace(/:(\s*)undefined\b/g, ":$1null");
}

// Extract `window.NAME = {...}` blobs directly from raw HTML text. Returns,
// per name, the raw (pre-parse) text alongside the parse result — a caller
// can fall back to a more targeted extraction (see extractKeyObject) from
// the raw text if the full blob fails to parse (observed on LiveAuctioneers:
// unrelated debug telemetry elsewhere in the same tree, e.g. a serialized
// `Array.prototype` reference, can break a whole-blob JSON.parse even though
// the actual data we want is well-formed).
function extractInlineWindowVars(html, names) {
  const found = {};
  for (const name of names) {
    const marker = `window.${name}=`;
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const searchFrom = idx + marker.length;
    const obj = findBalancedObject(html, searchFrom);
    if (!obj || obj.start - searchFrom > 5) continue; // must immediately follow the `=` (allow a little whitespace)
    const rawText = obj.text;
    const jsonText = sanitizeJsLiteral(rawText);
    try {
      found[name] = { ok: true, value: JSON.parse(jsonText), bytes: rawText.length, rawText };
    } catch (e) {
      found[name] = { ok: false, error: e.message, bytes: rawText.length, rawText };
    }
  }
  return found;
}

// Within a raw (possibly unparseable as a whole) JS-object-literal text,
// find a `"keyName": {...}` occurrence and parse just that balanced
// sub-object — narrowing the surface area for JS-literal quirks down to the
// one slice we actually need, instead of the entire blob.
function extractKeyObject(rawText, keyName) {
  const marker = `"${keyName}":`;
  const idx = rawText.indexOf(marker);
  if (idx === -1) return { ok: false, error: `key "${keyName}" not found` };
  const obj = findBalancedObject(rawText, idx + marker.length);
  if (!obj) return { ok: false, error: `no balanced object found after "${keyName}"` };
  const jsonText = sanitizeJsLiteral(obj.text);
  try {
    return { ok: true, value: JSON.parse(jsonText), bytes: obj.text.length };
  } catch (e) {
    return { ok: false, error: e.message, bytes: obj.text.length };
  }
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

module.exports = { findBalancedObject, sanitizeJsLiteral, extractInlineWindowVars, extractKeyObject, findLotLikeObjects };
