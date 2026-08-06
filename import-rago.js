#!/usr/bin/env node
/**
 * David Webb — Rago structured importer
 * -------------------------------------
 * Rago's site search (https://www.ragoarts.com/search/david+webb/auctions) is an
 * Inertia.js app that embeds the FULL, structured result set as JSON in the page's
 * `data-page` attribute. Unlike the LLM web-search backfill (which only sees the
 * top few snippets a search engine returns), this reads Rago's own data directly,
 * so it captures every David Webb lot — with hammer result, buyer's-premium price,
 * estimates, sale, lot number, and a direct URL.
 *
 * Deterministic and free (no LLM / API key needed — just HTTP GET + JSON parse).
 * Results merge into the shared auction-history dataset (see history-store.js).
 *
 * Usage:  node import-rago.js            (default term: "david webb")
 *         node import-rago.js "david webb bracelet"
 */

const store = require("./history-store");

const TERM = (process.argv[2] || "david webb").trim();
const SEARCH_URL = (term, page) =>
  `https://www.ragoarts.com/search/${encodeURIComponent(term).replace(/%20/g, "+")}/auctions` +
  (page > 1 ? `?page=${page}` : "");
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchPageProps(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
  if (!res.ok) throw new Error(`Rago ${res.status} for ${url}`);
  const html = await res.text();
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) throw new Error("Could not find Inertia data-page payload (site markup may have changed).");
  return JSON.parse(decodeEntities(m[1])).props;
}

function inferCategory(name) {
  const n = (name || "").toLowerCase();
  if (/bracelet|bangle|cuff/.test(n)) return "bracelet";
  if (/necklace|pendant|choker|collar|chain/.test(n)) return "necklace";
  if (/earring|ear clip|ear-clip/.test(n)) return "earrings";
  if (/brooch|pin\b|clip/.test(n)) return "brooch";
  if (/ring\b/.test(n)) return "ring";
  return "other";
}

// item.alias looks like "auctions/2026/06/summer-jewels-watches/197"
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
  const estLow = num(it.estimate_low);
  const estHigh = num(it.estimate_high);
  const saleName = (it.auction && it.auction.title) || (it.session && it.session.title) || "";
  const noteParts = [];
  if (hammer && premium) noteParts.push(`Premium price $${premium.toLocaleString("en-US")} (incl. buyer's premium)`);
  if (it.caption_brief) noteParts.push(String(it.caption_brief).trim());
  if (String(it.passed_lot) === "1") noteParts.push("Passed / unsold");

  return {
    piece_name: it.name || "",
    category: inferCategory(it.name),
    era_or_year: it.year_designed || it.year_produced || "",
    materials_gemstones: it.material || "",
    price_type: hammer ? "hammer" : estLow || estHigh ? "estimate" : "",
    sold_price: hammer,
    estimate_low: estLow,
    estimate_high: estHigh,
    currency_note: "",
    sale_date: saleDateFromAlias(it.alias),
    auction_house: "Rago",
    sale_name: saleName,
    lot_number: it.lot_number || "",
    listing_url: it.alias ? `https://www.ragoarts.com/${String(it.alias).replace(/^\//, "")}` : "",
    notes: noteParts.join(" — "),
  };
}

async function main() {
  console.log(`Rago importer — term "${TERM}"`);
  const map = store.loadStore();
  const before = map.size;

  let page = 1;
  let collected = 0;
  let total = Infinity;

  while (collected < total) {
    const props = await fetchPageProps(SEARCH_URL(TERM, page));
    const paginator = props.results && props.results.primary_results && props.results.primary_results.paginator;
    const itemsBlock = paginator && paginator.items;
    if (!itemsBlock || !Array.isArray(itemsBlock.data)) {
      console.log("  no items block found; stopping.");
      break;
    }
    total = Number(itemsBlock.total) || itemsBlock.data.length;
    const perPage = Number(itemsBlock.per_page) || itemsBlock.data.length || 1;

    for (const it of itemsBlock.data) {
      if ((it.artist_name || "").toLowerCase().includes("david webb") || /david webb/i.test(it.name || "")) {
        store.upsert(map, mapItem(it), { source: "rago-site" });
      } else {
        store.upsert(map, mapItem(it), { source: "rago-site" });
      }
    }
    collected += itemsBlock.data.length;
    console.log(`  page ${page}: ${itemsBlock.data.length} item(s) (running ${collected}/${total})`);

    if (collected >= total || itemsBlock.data.length === 0 || perPage <= 0) break;
    page++;
    if (page > 50) break; // safety
    await new Promise((r) => setTimeout(r, 400));
  }

  const total_records = store.writeStore(map);
  const added = map.size - before;
  console.log(`\nDone. ${collected} Rago lot(s) processed; ${added} new; ${total_records} total historical records.`);
  console.log(`JSON: ${store.HISTORY_JSON}`);
  console.log(`CSV:  ${store.HISTORY_CSV}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
