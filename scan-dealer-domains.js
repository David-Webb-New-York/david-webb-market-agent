#!/usr/bin/env node
/**
 * Cheap reconnaissance sweep across candidate estate-jeweler/dealer domains
 * (agent.js OPTIONAL_QUERIES — sites that historically yielded nothing via
 * LLM web search, per HANDOFF.md §7.3, but may still expose a free
 * structured product feed like Yafa's Shopify /products.json).
 *
 * Tries a handful of well-known e-commerce platform endpoints per domain
 * (Shopify, Squarespace, WooCommerce/WordPress) with a short timeout, and
 * reports which ones return real product data mentioning "David Webb". No
 * Browserbase / paid API involved — meant to run from an environment with
 * real internet access (this sandbox's network is allowlisted and blocks
 * these domains; run via .github/workflows/scan-dealers.yml on a GitHub
 * Actions runner instead).
 *
 * Usage: node scan-dealer-domains.js [domains.json]
 *   (defaults to the built-in DOMAINS list below)
 */

const fs = require("fs");

const DOMAINS = [
  "oakgem.com",
  "thebackvault.com",
  "vestiairecollective.com",
  "jamesedition.com",
  "rubylane.com",
  "fredleighton.com",
  "kentshire.com",
  "doyledoyle.com",
  "fdgallery.com",
  "ericoriginals.com",
  "saidiansons.com",
  "robinsonsjewelers.com",
  "legacyvintagejewels.com",
  "louismartin.com",
  "circajewels.com",
  "abrandtandson.com",
  "wilsonsestatejewelry.com",
  "langantiques.com",
  "estatediamondjewelry.com",
  "frankpollakandsons.com",
  "rtjewelers.com",
  "alexcooper.com",
  "syl-leeantiques.com",
  "schiffmans.com",
  "macklowegallery.com",
  // Surfaced 2026-08-12 via Google reverse-image search while tracing a
  // Back Vault cross-listing candidate -- a real dealer, confirmed by the
  // user, that we weren't tracking at all.
  "greenleafcrosby.com",
];

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 12000;

const PROBES = [
  {
    platform: "shopify",
    path: "/products.json?limit=5",
    parse: (body) => {
      const data = JSON.parse(body);
      return Array.isArray(data.products) ? data.products.length : 0;
    },
    hasDavidWebb: (body) => /david\s*webb/i.test(body),
  },
  {
    platform: "squarespace",
    path: "/?format=json",
    parse: (body) => {
      const data = JSON.parse(body);
      return data && (data.items || data.collection) ? 1 : 0;
    },
    hasDavidWebb: (body) => /david\s*webb/i.test(body),
  },
  {
    platform: "woocommerce",
    path: "/wp-json/wc/store/products?per_page=5",
    parse: (body) => {
      const data = JSON.parse(body);
      return Array.isArray(data) ? data.length : 0;
    },
    hasDavidWebb: (body) => /david\s*webb/i.test(body),
  },
];

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function probeDomain(domain) {
  const results = [];
  for (const probe of PROBES) {
    const url = `https://${domain}${probe.path}`;
    try {
      const { ok, status, body } = await fetchWithTimeout(url);
      if (!ok) {
        results.push({ platform: probe.platform, url, status, hit: false });
        continue;
      }
      let count = 0;
      let davidWebb = false;
      try {
        count = probe.parse(body);
        davidWebb = probe.hasDavidWebb(body);
      } catch (_) {
        // not JSON / not this platform
      }
      results.push({ platform: probe.platform, url, status, count, davidWebb, hit: count > 0 });
    } catch (err) {
      results.push({ platform: probe.platform, url, error: err.message, hit: false });
    }
  }
  return { domain, results };
}

async function main() {
  const domainsFile = process.argv[2];
  const domains = domainsFile ? JSON.parse(fs.readFileSync(domainsFile, "utf8")) : DOMAINS;
  console.log(`Scanning ${domains.length} domain(s) for structured product feeds...\n`);

  const report = [];
  for (const domain of domains) {
    const r = await probeDomain(domain);
    report.push(r);
    const hit = r.results.find((x) => x.hit);
    if (hit) {
      console.log(
        `HIT  ${domain.padEnd(28)} platform=${hit.platform} count=${hit.count} davidWebb=${hit.davidWebb}`
      );
    } else {
      const statuses = r.results.map((x) => `${x.platform}:${x.status || x.error || "?"}`).join(" ");
      console.log(`---  ${domain.padEnd(28)} ${statuses}`);
    }
  }

  fs.mkdirSync("probe-output", { recursive: true });
  fs.writeFileSync("probe-output/dealer-domain-scan.json", JSON.stringify(report, null, 2));

  const hits = report.filter((r) => r.results.some((x) => x.hit && x.davidWebb));
  console.log(`\n${hits.length} domain(s) with a confirmed David Webb structured feed hit:`);
  for (const h of hits) console.log(`  ${h.domain}`);
  console.log(`\nFull report: probe-output/dealer-domain-scan.json`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
  });
}

module.exports = { DOMAINS, probeDomain };
