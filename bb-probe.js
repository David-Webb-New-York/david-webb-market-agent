#!/usr/bin/env node
/**
 * Browserbase probe — investigate how a site delivers its data.
 * Renders a URL in a Browserbase cloud browser and reports embedded state
 * blobs, JSON XHR responses, and lot/price signals in the rendered HTML.
 * Use it to design a per-site importer (the "same analysis as Rago", for JS/
 * anti-bot sites).
 *
 * Writes everything to ./probe-output/ (gitignored) so a CI runner can
 * upload it as a build artifact for offline review — this is meant to be run
 * from an environment with real internet access (GitHub Actions, local
 * machine), since Browserbase + most target sites are unreachable from a
 * network-allowlisted sandbox.
 *
 * Usage:  node bb-probe.js "https://www.liveauctioneers.com/search/?keyword=david+webb"
 *         node bb-probe.js <url> --proxies      (requires a paid Browserbase plan)
 *         node bb-probe.js <url> --wait=12000    (override render wait, ms)
 */

const fs = require("fs");
const path = require("path");
const bb = require("./browserbase");
const { extractInlineWindowVars, findLotLikeObjects } = require("./inline-state");

const OUT_DIR = path.join(__dirname, "probe-output");

// Cheap structural summary of a candidate JSON response: top-level keys, any
// array field (walked up to 2 levels deep, since search APIs commonly wrap
// results in an outer object/array), its length, and any sibling numeric
// fields that look like pagination (nbHits, page, nbPages, hitsPerPage,
// totalRecords, ...). Lets a probe report real hit-counts/pagination
// evidence without dumping/guessing at the full (often huge) response body.
const PAGINATION_KEY_RE = /^(nb|total|num)(hits|records|pages|results)$|^(page|hitsperpage|pagesize|perpage)$/i;
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

function slugFor(url) {
  try {
    return new URL(url).host.replace(/[^a-z0-9.]/gi, "_");
  } catch (_) {
    return "probe";
  }
}

async function main() {
  const url = process.argv[2];
  const useProxies = process.argv.includes("--proxies");
  const waitArg = process.argv.find((a) => a.startsWith("--wait="));
  const waitMs = waitArg ? parseInt(waitArg.split("=")[1], 10) : 8000;
  if (!url) {
    console.error('usage: node bb-probe.js "<url>" [--proxies] [--wait=ms]');
    process.exit(1);
  }
  if (!bb.hasCreds()) {
    console.error("Missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID (add them as secrets).");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slug = slugFor(url);
  const responsesDir = path.join(OUT_DIR, `${slug}-responses`);
  fs.mkdirSync(responsesDir, { recursive: true });

  console.log("probing:", url, useProxies ? "(proxies on)" : "", `wait=${waitMs}ms`);
  const started = Date.now();
  const { title, html, state, jsonResponses } = await bb
    .renderAndExtract(url, {
      captureJson: true,
      waitMs,
      sessionOpts: useProxies ? { proxies: true } : {},
    })
    .catch((e) => {
      console.error("render failed:", e.message);
      process.exit(1);
    });
  const elapsedMs = Date.now() - started;

  console.log("title:", JSON.stringify(title), "| rendered html bytes:", html.length, `| ${elapsedMs}ms`);
  for (const [k, v] of Object.entries(state)) if (v) console.log("embedded state:", k, "->", v.length, "bytes");
  console.log("json XHR responses captured:", jsonResponses.length);

  // A suspiciously tiny rendered page (bot-block interstitials, CAPTCHA
  // stubs, and minimal error shells are all typically well under this) is
  // small enough to just print in full -- no need for a second probe round
  // or an artifact download to see what actually came back.
  const TINY_HTML_THRESHOLD = 50000;
  if (html.length < TINY_HTML_THRESHOLD) {
    console.log(`\n--- rendered HTML is only ${html.length}b (< ${TINY_HTML_THRESHOLD}b), printing in full ---`);
    console.log(html);
  }

  const signals = [
    '"itemId"',
    '"lotNumber"',
    '"salePrice"',
    '"priceResult"',
    '"soldPrice"',
    '"isSold":true',
    "david webb",
  ];
  const signalCounts = {};
  for (const s of signals) {
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    signalCounts[s] = (html.match(re) || []).length;
  }
  console.log("HTML signals:");
  for (const [s, n] of Object.entries(signalCounts)) console.log(`  ${s.padEnd(16)} ${n}`);

  // Save the full rendered HTML + embedded state blobs.
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.html`), html);
  const stateSaved = [];
  for (const [k, v] of Object.entries(state)) {
    if (!v) continue;
    const file = `${slug}-${k.replace(/\W/g, "")}.json`;
    fs.writeFileSync(path.join(OUT_DIR, file), v);
    stateSaved.push({ key: k, file, bytes: v.length });
  }

  // Also extract inline `window.NAME = {...}` state directly from the raw
  // HTML (see extractInlineWindowVars) — catches state that's real in the
  // static markup but empty by the time page.evaluate() runs.
  const inlineVars = extractInlineWindowVars(html, [
    "__data",
    "__PRELOADED_STATE__",
    "__APOLLO_STATE__",
    "__INITIAL_STATE__",
    "__NUXT__",
  ]);
  const inlineVarsSummary = [];
  const lotLikeObjects = [];
  for (const [name, result] of Object.entries(inlineVars)) {
    const file = `${slug}-inline-${name.replace(/\W/g, "")}.json`;
    if (result.ok) {
      fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(result.value, null, 2));
      inlineVarsSummary.push({
        name,
        bytes: result.bytes,
        file,
        topLevelKeys: Array.isArray(result.value) ? `array[${result.value.length}]` : Object.keys(result.value),
      });
      findLotLikeObjects(result.value, `window.${name}`, lotLikeObjects, {
        maxResults: 8,
        maxVisited: 200000,
        visited: { count: 0 },
      });
    } else {
      inlineVarsSummary.push({ name, error: result.error, bytes: result.bytes });
    }
  }
  if (lotLikeObjects.length) {
    fs.writeFileSync(path.join(OUT_DIR, `${slug}-lot-objects.json`), JSON.stringify(lotLikeObjects, null, 2));
  }

  // Save EVERY captured JSON XHR response body (not just regex-matched
  // "candidates") so a single CI run yields enough raw material to design an
  // adapter without a second round trip. Capped to keep the artifact sane.
  const MAX_SAVED = 60;
  const responsesIndex = [];
  jsonResponses.slice(0, MAX_SAVED).forEach((r, i) => {
    const file = `${String(i).padStart(3, "0")}.json`;
    fs.writeFileSync(path.join(responsesDir, file), r.body);
    const entry = { i, url: r.url, bytes: r.bytes, file, method: r.method };
    // POST-body search APIs (no query string on the URL itself, e.g.
    // Algolia-style endpoints) are otherwise invisible to a probe that only
    // logs response bodies -- save the request body alongside so an adapter
    // can be built to replicate the real request, not guess its shape.
    if (r.postData) entry.postData = r.postData.length > 4000 ? r.postData.slice(0, 4000) + "...(truncated)" : r.postData;
    responsesIndex.push(entry);
  });
  fs.writeFileSync(path.join(responsesDir, "index.json"), JSON.stringify(responsesIndex, null, 2));

  // Broad on purpose: plural/casing variants ("catalogs" vs "catalog") and
  // real backend APIs that don't happen to mention these exact keys have
  // both caused missed candidates before. Any non-trivial JSON response from
  // a host that isn't obviously 3rd-party analytics/tracking noise also
  // counts — better to over-flag (bodies are truncated to 3KB in the log
  // anyway) than silently miss the real endpoint.
  const candidateRe = /david\s*webb|"(lots?|items?|hits?|results?|catalogs?|auctionlots?)"\s*:|salePrice|priceResult|estimate\b|hammer\b|soldPrice|lotNumber/i;
  const KNOWN_NOISE_HOSTS =
    /cookiebot|amplitude|sail-personalize|sail-track|openreplay|google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.(io|com)|mixpanel|fullstory|sentry\.io|bugsnag/i;
  const candidates = responsesIndex
    .filter((r) => {
      const body = fs.readFileSync(path.join(responsesDir, r.file), "utf8");
      if (candidateRe.test(body)) return true;
      const trimmed = body.trim();
      return !KNOWN_NOISE_HOSTS.test(r.url) && trimmed.length > 20 && /^[{[]/.test(trimmed);
    })
    .map((r) => {
      const body = fs.readFileSync(path.join(responsesDir, r.file), "utf8");
      const jsonShape = summarizeJsonShape(body);
      return jsonShape ? { ...r, jsonShape } : r;
    });

  const summary = {
    url,
    title,
    elapsedMs,
    proxies: useProxies,
    htmlBytes: html.length,
    signalCounts,
    embeddedState: stateSaved,
    jsonResponseCount: jsonResponses.length,
    jsonResponsesSaved: responsesIndex.length,
    candidateResponses: candidates,
    inlineWindowVars: inlineVarsSummary,
    lotLikeObjects,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${slug}-summary.json`), JSON.stringify(summary, null, 2));

  console.log("\ncandidate JSON responses (matched lot/price signals):");
  for (const c of candidates) {
    console.log(`  [${c.i}] ${c.method || "GET"} ${c.bytes}b ${c.url.slice(0, 140)}`);
    if (c.postData) console.log(`      postData: ${c.postData.slice(0, 500)}`);
    if (c.jsonShape) {
      if (c.jsonShape.arrays.length) console.log(`      arrays: ${JSON.stringify(c.jsonShape.arrays)}`);
      if (Object.keys(c.jsonShape.pagination).length) console.log(`      pagination fields: ${JSON.stringify(c.jsonShape.pagination)}`);
    }
  }

  if (inlineVarsSummary.length) {
    console.log("\ninline window vars found in raw HTML (not via page.evaluate):");
    for (const v of inlineVarsSummary) {
      if (v.error) console.log(`  window.${v.name}: PARSE ERROR (${v.bytes}b) — ${v.error}`);
      else console.log(`  window.${v.name}: ${v.bytes}b, top-level keys: ${JSON.stringify(v.topLevelKeys).slice(0, 300)}`);
    }
  }
  if (lotLikeObjects.length) {
    console.log(`\nlot-like objects found (${lotLikeObjects.length}, full JSON in ${slug}-lot-objects.json):`);
    for (const o of lotLikeObjects) console.log(`  ${o.path}`);
  }

  console.log(`\nsaved: ${OUT_DIR}/${slug}.html, ${slug}-summary.json, ${responsesDir}/ (${responsesIndex.length} response bodies)`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
