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

const OUT_DIR = path.join(__dirname, "probe-output");

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

  // Save EVERY captured JSON XHR response body (not just regex-matched
  // "candidates") so a single CI run yields enough raw material to design an
  // adapter without a second round trip. Capped to keep the artifact sane.
  const MAX_SAVED = 60;
  const responsesIndex = [];
  jsonResponses.slice(0, MAX_SAVED).forEach((r, i) => {
    const file = `${String(i).padStart(3, "0")}.json`;
    fs.writeFileSync(path.join(responsesDir, file), r.body);
    responsesIndex.push({ i, url: r.url, bytes: r.bytes, file });
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
  const candidates = responsesIndex.filter((r) => {
    const body = fs.readFileSync(path.join(responsesDir, r.file), "utf8");
    if (candidateRe.test(body)) return true;
    const trimmed = body.trim();
    return !KNOWN_NOISE_HOSTS.test(r.url) && trimmed.length > 20 && /^[{[]/.test(trimmed);
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
  };
  fs.writeFileSync(path.join(OUT_DIR, `${slug}-summary.json`), JSON.stringify(summary, null, 2));

  console.log("\ncandidate JSON responses (matched lot/price signals):");
  for (const c of candidates) console.log(`  [${c.i}] ${c.bytes}b ${c.url.slice(0, 140)}`);

  console.log(`\nsaved: ${OUT_DIR}/${slug}.html, ${slug}-summary.json, ${responsesDir}/ (${responsesIndex.length} response bodies)`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
