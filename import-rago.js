#!/usr/bin/env node
/**
 * David Webb — Rago structured importer (source adapter)
 * ------------------------------------------------------
 * Rago's site search is an Inertia.js app that embeds the FULL structured result
 * set as JSON in the page's `data-page` attribute. This reads that directly, so
 * it captures every David Webb lot (hammer result, buyer's-premium price,
 * estimates, sale, lot number, URL) — deterministically and with no API cost.
 *
 * Exposes `collect(map)` for the orchestrator (import-all.js); also runnable
 * standalone:  node import-rago.js ["david webb bracelet"]
 */

const store = require("./history-store");

const SOURCE = "rago-site";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const searchUrl = (term, page) =>
  `https://www.ragoarts.com/search/${encodeURIComponent(term).replace(/%20/g, "+")}/auctions` +
  (page > 1 ? `?page=${page}` : "");

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchProps(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Rago ${res.status} for ${url}`);
  const html = await res.text();
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) throw new Error("Could not find Inertia data-page payload (site markup may have changed).");
  return JSON.parse(decodeEntities(m[1])).props;
}

function inferCategory(name) {
  const n = (name || "").toLowerCase();
  if (/bracelet|bangle|cuff(?!link)/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  if (/cufflink/.test(n)) return "cufflinks";
  return "other";
}

function saleDateFromAlias(alias) {
  const m = String(alias || "").match(/auctions\/(\d{4})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : "";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : "";
}

function mapItem(it) {
  const hammer = num(it.result_amount);
  const premium = num(it.result_premium_amount);
  const saleName = (it.auction && it.auction.title) || (it.session && it.session.title) || "";
  const notes = [];
  if (hammer && premium) notes.push(`Premium price $${premium.toLocaleString("en-US")} (incl. buyer's premium)`);
  if (it.caption_brief) notes.push(String(it.caption_brief).trim());
  if (String(it.passed_lot) === "1") notes.push("Passed / unsold");
  return {
    piece_name: it.name || "",
    category: inferCategory(it.name),
    era_or_year: it.year_designed || it.year_produced || "",
    materials_gemstones: it.material || "",
    price_type: hammer ? "hammer" : num(it.estimate_low) || num(it.estimate_high) ? "estimate" : "",
    sold_price: hammer,
    estimate_low: num(it.estimate_low),
    estimate_high: num(it.estimate_high),
    currency_note: "",
    sale_date: saleDateFromAlias(it.alias),
    auction_house: "Rago",
    sale_name: saleName,
    lot_number: it.lot_number || "",
    listing_url: it.alias ? `https://www.ragoarts.com/${String(it.alias).replace(/^\//, "")}` : "",
    notes: notes.join(" — "),
  };
}

// Collect Rago lots into the shared store `map`. Returns count processed.
async function collect(map, { term = "david webb", today } = {}) {
  let page = 1;
  let collected = 0;
  let total = Infinity;
  while (collected < total) {
    const props = await fetchProps(searchUrl(term, page));
    const paginator = props?.results?.primary_results?.paginator;
    const items = paginator && paginator.items;
    if (!items || !Array.isArray(items.data)) break;
    total = Number(items.total) || items.data.length;
    for (const it of items.data) store.upsert(map, mapItem(it), { source: SOURCE, today });
    collected += items.data.length;
    if (collected >= total || items.data.length === 0) break;
    page++;
    if (page > 50) break; // safety
    await new Promise((r) => setTimeout(r, 400));
  }
  return collected;
}

async function main() {
  const term = (process.argv[2] || "david webb").trim();
  console.log(`Rago importer — term "${term}"`);
  const map = store.loadStore();
  const before = map.size;
  const processed = await collect(map, { term });
  const total = store.writeStore(map);
  console.log(`Done. ${processed} Rago lot(s) processed; ${map.size - before} new; ${total} total records.`);
  console.log(`JSON: ${store.HISTORY_JSON}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  });
}

module.exports = { collect, SOURCE };
