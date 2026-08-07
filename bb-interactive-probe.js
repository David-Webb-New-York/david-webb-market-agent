#!/usr/bin/env node
/**
 * Interactive Browserbase probe — for sites where a URL query param doesn't
 * trigger the real search (confirmed on Christie's, Doyle: real pages
 * render, but zero results/API calls fire for any guessed `?param=` value).
 * Navigates to a base URL, simulates typing into the site's own search box
 * and pressing Enter, then reports what fired -- same signal/candidate
 * analysis as bb-probe.js, reusing inline-state.js for embedded-state
 * extraction.
 *
 * Usage: node bb-interactive-probe.js <base-url> <search-term> \
 *          --selectors=sel1,sel2  [--open-selectors=sel1,sel2] [--wait=8000]
 */
const fs = require("fs");
const path = require("path");
const bb = require("./browserbase");
const { extractInlineWindowVars, findLotLikeObjects } = require("./inline-state");

const OUT_DIR = path.join(__dirname, "probe-output");

function slugFor(url) {
  try {
    return new URL(url).host.replace(/[^a-z0-9.]/gi, "_") + "-interactive";
  } catch (_) {
    return "interactive-probe";
  }
}

async function main() {
  const baseUrl = process.argv[2];
  const term = process.argv[3];
  const selectorsArg = process.argv.find((a) => a.startsWith("--selectors="));
  const openSelectorsArg = process.argv.find((a) => a.startsWith("--open-selectors="));
  const postSearchSelectorsArg = process.argv.find((a) => a.startsWith("--post-search-selectors="));
  const htmlGrepArg = process.argv.find((a) => a.startsWith("--html-grep="));
  const waitArg = process.argv.find((a) => a.startsWith("--wait="));
  // CSS attribute selectors (e.g. input[placeholder*='lot' i]) contain their
  // own `=` characters -- splitting on every `=` in the arg truncates them.
  // Only the first `=` (after "--selectors") delimits the flag from its value.
  const afterFirstEquals = (arg) => (arg ? arg.slice(arg.indexOf("=") + 1) : "");
  const searchSelectors = selectorsArg ? afterFirstEquals(selectorsArg).split(",") : [];
  const openTriggerSelectors = openSelectorsArg ? afterFirstEquals(openSelectorsArg).split(",") : [];
  const postSearchClickSelectors = postSearchSelectorsArg ? afterFirstEquals(postSearchSelectorsArg).split(",") : [];
  const htmlGrepTerms = htmlGrepArg ? afterFirstEquals(htmlGrepArg).split(",").filter(Boolean) : [];
  const waitMs = waitArg ? parseInt(waitArg.split("=")[1], 10) : 8000;

  if (!baseUrl || !term || !searchSelectors.length) {
    console.error(
      'usage: node bb-interactive-probe.js "<base-url>" "<term>" --selectors=sel1,sel2 [--open-selectors=sel] [--post-search-selectors=sel] [--html-grep=term1,term2] [--wait=ms]'
    );
    process.exit(1);
  }
  if (!bb.hasCreds()) {
    console.error("Missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID.");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slug = slugFor(baseUrl);

  console.log("interactive probe:", baseUrl, "| term:", term, "| selectors:", searchSelectors, "| wait:", waitMs);
  const started = Date.now();
  const { title, html, url, jsonResponses, interactionLog } = await bb
    .interactAndExtract(baseUrl, term, {
      searchSelectors,
      openTriggerSelectors,
      postSearchClickSelectors,
      waitMs,
      sessionOpts: { proxies: true },
    })
    .catch((e) => {
      console.error("interact failed:", e.message);
      process.exit(1);
    });
  const elapsedMs = Date.now() - started;

  console.log("\ninteraction log:");
  for (const line of interactionLog) console.log("  " + line);

  console.log(`\nfinal title: ${JSON.stringify(title)} | final url: ${url} | html bytes: ${html.length} | ${elapsedMs}ms`);
  console.log("json XHR responses captured:", jsonResponses.length);

  const termLower = term.toLowerCase();
  const signals = ['"itemId"', '"lotNumber"', '"salePrice"', '"priceResult"', '"soldPrice"', '"isSold":true', termLower];
  const signalCounts = {};
  for (const s of signals) {
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    signalCounts[s] = (html.match(re) || []).length;
  }
  console.log("\nHTML signals (after interaction):");
  for (const [s, n] of Object.entries(signalCounts)) console.log(`  ${s.padEnd(16)} ${n}`);

  const TINY_HTML_THRESHOLD = 50000;
  if (html.length < TINY_HTML_THRESHOLD) {
    console.log(`\n--- rendered HTML is only ${html.length}b (< ${TINY_HTML_THRESHOLD}b), printing in full ---`);
    console.log(html);
  }
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.html`), html);

  const inlineVars = extractInlineWindowVars(html, ["__data", "__PRELOADED_STATE__", "__APOLLO_STATE__", "__INITIAL_STATE__", "__NUXT__"]);
  const inlineVarsSummary = [];
  const lotLikeObjects = [];
  for (const [name, result] of Object.entries(inlineVars)) {
    if (result.ok) {
      inlineVarsSummary.push({ name, bytes: result.bytes, topLevelKeys: Array.isArray(result.value) ? `array[${result.value.length}]` : Object.keys(result.value) });
      findLotLikeObjects(result.value, `window.${name}`, lotLikeObjects, { maxResults: 8, maxVisited: 200000, visited: { count: 0 } });
    } else {
      inlineVarsSummary.push({ name, error: result.error, bytes: result.bytes });
    }
  }
  if (inlineVarsSummary.length) {
    console.log("\ninline window vars found in raw HTML:");
    for (const v of inlineVarsSummary) console.log(`  window.${v.name}:`, v.error ? `PARSE ERROR - ${v.error}` : `${v.bytes}b, keys: ${JSON.stringify(v.topLevelKeys).slice(0, 300)}`);
  }
  if (lotLikeObjects.length) {
    console.log(`\nlot-like objects found (${lotLikeObjects.length}):`);
    for (const o of lotLikeObjects) console.log(`  ${o.path}`);
  }

  // Print raw HTML context around caller-specified substrings -- useful for
  // finding the real markup/selector for an element that a guessed CSS
  // selector list failed to match (e.g. a tab control), without needing to
  // download the full HTML artifact separately.
  if (htmlGrepTerms.length) {
    console.log(`\nHTML context search (${htmlGrepTerms.length} term(s)):`);
    const lowerHtml = html.toLowerCase();
    for (const term of htmlGrepTerms) {
      const needle = term.toLowerCase();
      let idx = -1;
      let count = 0;
      while (count < 5) {
        idx = lowerHtml.indexOf(needle, idx + 1);
        if (idx === -1) break;
        const start = Math.max(0, idx - 200);
        console.log(`\n>>> "${term}" occurrence ${count + 1} (offset ${idx}):`);
        console.log(html.slice(start, idx + 300));
        count++;
      }
      if (count === 0) console.log(`\n>>> "${term}": not found in rendered HTML`);
    }
  }

  const responsesDir = path.join(OUT_DIR, `${slug}-responses`);
  fs.mkdirSync(responsesDir, { recursive: true });
  const KNOWN_NOISE_HOSTS = /cookiebot|amplitude|sail-personalize|sail-track|openreplay|google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.(io|com)|mixpanel|fullstory|sentry\.io|bugsnag|onetrust|cookielaw|cookieyes|list-manage|ahrefs|signalr/i;
  const candidateRe = new RegExp(`${termLower}|"(lots?|items?|hits?|results?|catalogs?|auctionlots?)"\\s*:|salePrice|priceResult|estimate\\b|hammer\\b|soldPrice|lotNumber`, "i");
  console.log(`\nall JSON XHR responses (${jsonResponses.length}):`);
  // Console output truncates URLs to 140b for log readability -- save full,
  // untruncated url/headers/postData per response too, so a real query
  // string (with every param) can be reconstructed for a plain-fetch replay
  // test without needing another probe round just to see the full URL.
  const fullIndex = [];
  jsonResponses.forEach((r, i) => {
    const file = `${String(i).padStart(3, "0")}.json`;
    fs.writeFileSync(path.join(responsesDir, file), r.body);
    const isNoise = KNOWN_NOISE_HOSTS.test(r.url);
    const isCandidate = candidateRe.test(r.body) || (!isNoise && r.body.trim().length > 20 && /^[{[]/.test(r.body.trim()));
    console.log(`  [${i}]${isCandidate ? " CANDIDATE" : ""} ${r.method} ${r.bytes}b ${r.url.slice(0, 140)}`);
    if (r.postData) console.log(`      postData: ${r.postData.slice(0, 500)}`);
    if (r.headers && Object.keys(r.headers).length) console.log(`      notable headers: ${JSON.stringify(r.headers)}`);
    if (isCandidate) console.log(`      body (first 1000b): ${r.body.slice(0, 1000)}`);
    fullIndex.push({ i, url: r.url, method: r.method, bytes: r.bytes, file, postData: r.postData || null, headers: r.headers || {}, isCandidate });
  });
  fs.writeFileSync(path.join(responsesDir, "index.json"), JSON.stringify(fullIndex, null, 2));

  console.log(`\nsaved: ${OUT_DIR}/${slug}.html, ${responsesDir}/ (${jsonResponses.length} response bodies + index.json with full urls/headers)`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
