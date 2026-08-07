#!/usr/bin/env node
/**
 * Prints a compact, log-friendly view of ./probe-output/ (written by
 * bb-probe.js) — summary, all captured response URLs, and candidate response
 * bodies (truncated). Used by the probe-source.yml CI workflow so results are
 * readable straight from job logs (via the GitHub API) without needing to
 * download/unzip the artifact for the common case.
 */

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "probe-output");
const BODY_PREVIEW_BYTES = 3000;

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.log("(no probe-output/ — probe likely failed before writing anything)");
    return;
  }
  const summaryFiles = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith("-summary.json"));
  if (summaryFiles.length === 0) {
    console.log("(no *-summary.json found in probe-output/)");
    return;
  }

  for (const sf of summaryFiles) {
    const slug = sf.replace(/-summary\.json$/, "");
    const summary = JSON.parse(fs.readFileSync(path.join(OUT_DIR, sf), "utf8"));
    console.log("=".repeat(70));
    console.log(`SUMMARY: ${slug}`);
    console.log("=".repeat(70));
    console.log(JSON.stringify(summary, null, 2));

    const responsesDir = path.join(OUT_DIR, `${slug}-responses`);
    const indexPath = path.join(responsesDir, "index.json");
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      console.log(`\n--- all captured JSON response URLs (${index.length}) ---`);
      for (const r of index) console.log(`  [${r.i}] ${r.bytes}b ${r.url}`);
    }

    const embeddedState = summary.embeddedState || [];
    console.log(`\n--- embedded state blobs (${embeddedState.length}, truncated to ${BODY_PREVIEW_BYTES}b) ---`);
    for (const es of embeddedState) {
      const file = path.join(OUT_DIR, es.file);
      console.log(`\n>>> window.${es.key} (${es.bytes}b)`);
      if (fs.existsSync(file)) {
        const body = fs.readFileSync(file, "utf8");
        console.log(body.slice(0, BODY_PREVIEW_BYTES));
        if (body.length > BODY_PREVIEW_BYTES) console.log(`... (${body.length - BODY_PREVIEW_BYTES} more bytes, see artifact)`);
      } else {
        console.log("(file missing)");
      }
    }

    const candidates = summary.candidateResponses || [];
    console.log(`\n--- candidate response bodies (${candidates.length}, truncated to ${BODY_PREVIEW_BYTES}b) ---`);
    for (const c of candidates) {
      const file = path.join(responsesDir, c.file);
      console.log(`\n>>> [${c.i}] ${c.url}`);
      if (fs.existsSync(file)) {
        const body = fs.readFileSync(file, "utf8");
        console.log(body.slice(0, BODY_PREVIEW_BYTES));
        if (body.length > BODY_PREVIEW_BYTES) console.log(`... (${body.length - BODY_PREVIEW_BYTES} more bytes, see artifact)`);
      } else {
        console.log("(file missing)");
      }
    }

    // Deep-dive into the raw HTML when the page clearly has real content
    // (e.g. "salePrice" appears in signalCounts) but nothing was captured as
    // embedded state or a candidate XHR — the data is likely inline in a
    // <script> tag our state-scraping doesn't recognize by name.
    const htmlFile = path.join(OUT_DIR, `${slug}.html`);
    const looksLikeRealData = Object.entries(summary.signalCounts || {}).some(
      ([k, v]) => v > 0 && !/david webb/i.test(k)
    );
    if (looksLikeRealData && embeddedState.length === 0 && candidates.length === 0 && fs.existsSync(htmlFile)) {
      const html = fs.readFileSync(htmlFile, "utf8");
      console.log(`\n--- HTML deep-dive: signals present but no embedded state/candidate XHR captured ---`);
      const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1].trim());
      const namedOrTyped = scriptTags.filter((attrs) => /\bid=|\btype=(?!"text\/javascript"|"application\/javascript")/i.test(attrs));
      console.log(`<script> tags: ${scriptTags.length} total, ${namedOrTyped.length} with an id or non-JS type:`);
      for (const attrs of namedOrTyped.slice(0, 30)) console.log(`  <script ${attrs}>`);

      for (const needle of ["salePrice", "lotNumber", "itemId"]) {
        const idx = html.indexOf(needle);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 150);
        console.log(`\n>>> context around first "${needle}" (html offset ${idx}):`);
        console.log(html.slice(start, idx + 250));
      }
    }
  }
}

main();
