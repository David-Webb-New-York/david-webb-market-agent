#!/usr/bin/env node
/**
 * Browserbase probe — investigate how a site delivers its data.
 * Renders a URL in a Browserbase cloud browser and reports embedded state
 * blobs, JSON XHR responses, and lot/price signals in the rendered HTML.
 * Use it to design a per-site importer (the "same analysis as Rago", for JS/
 * anti-bot sites).
 *
 * Usage:  node bb-probe.js "https://www.liveauctioneers.com/search/?keyword=david+webb"
 *         node bb-probe.js <url> --proxies      (requires a paid Browserbase plan)
 */

const fs = require("fs");
const bb = require("./browserbase");

async function main() {
  const url = process.argv[2];
  const useProxies = process.argv.includes("--proxies");
  if (!url) {
    console.error('usage: node bb-probe.js "<url>" [--proxies]');
    process.exit(1);
  }
  if (!bb.hasCreds()) {
    console.error("Missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID (add them as secrets).");
    process.exit(1);
  }

  console.log("probing:", url, useProxies ? "(proxies on)" : "");
  const { title, html, state, jsonResponses } = await bb.renderAndExtract(url, {
    captureJson: true,
    // proxies flow through session options when requested (paid plans only)
  }).catch((e) => {
    console.error("render failed:", e.message);
    process.exit(1);
  });

  console.log("title:", JSON.stringify(title), "| rendered html bytes:", html.length);
  for (const [k, v] of Object.entries(state)) if (v) console.log("embedded state:", k, "->", v.length, "bytes");
  console.log("json XHR responses:", jsonResponses.length);
  for (const r of jsonResponses.slice(0, 15)) {
    if (/david webb|"(lots|items|hits|results|catalog)"|"(salePrice|priceResult|estimate|hammer)"/i.test(r.body)) {
      console.log(`  candidate ${r.bytes}b: ${r.url.slice(0, 130)}`);
    }
  }

  const signals = ['"itemId"', '"lotNumber"', '"salePrice"', '"priceResult"', '"soldPrice"', '"isSold":true', "david webb"];
  console.log("HTML signals:");
  for (const s of signals) {
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    console.log(`  ${s.padEnd(16)} ${(html.match(re) || []).length}`);
  }

  fs.writeFileSync("/tmp/bb-probe.html", html);
  for (const [k, v] of Object.entries(state)) if (v) fs.writeFileSync(`/tmp/bb-probe-${k.replace(/\W/g, "")}.json`, v);
  console.log("saved: /tmp/bb-probe.html (+ embedded state json)");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
