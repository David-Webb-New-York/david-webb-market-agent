# David Webb Secondary Market Agent

Tracks David Webb jewelry on the secondary market — past auction results and
current estate-dealer inventory — and turns it into three things your team
actually uses:

1. **A searchable database (GUI)** — every piece, sortable/filterable by
   date, source, price, status, category, with a thumbnail and a link to the
   original listing.
2. **A weekly written report + Slack post** — what sold recently, what's new
   on the market, notable pieces, price ranges by category.
3. **Raw CSVs** — for anyone who wants to pull the data into Excel, Power BI,
   or drop it into Claude for deeper analysis.

All of it refreshes automatically every Monday morning. Nobody needs to run
anything by hand.

## Where to find things

| What | Where |
| --- | --- |
| Searchable database | `https://david-webb-new-york.github.io/david-webb-market-agent/` |
| Weekly report | Posted to the `#secondary-market` Slack channel every Monday; also committed to `output/reports/YYYY-MM-DD.md` |
| Raw data | `output/david-webb-auction-history.csv` (past sales) and `output/david-webb-dealer-listings.csv` (current inventory) |

## How it works, end to end

Three scheduled GitHub Actions workflows, chained together — nobody needs to
trigger any of this manually:

1. **`history-refresh.yml`** (Monday ~8:15am ET) — pulls new auction results
   from Rago, Sotheby's, Christie's, Phillips, Doyle, Invaluable, LiveAuctioneers,
   and Bonhams into `output/david-webb-auction-history.json`.
2. **`dealer-refresh.yml`** (Monday ~8:30am ET) — pulls current for-sale
   inventory from estate-jeweler sites (Yafa, The Back Vault, Fred Leighton,
   and a dozen others) plus the 1stDibs and Sotheby's Buy Now marketplaces
   into `output/david-webb-dealer-listings.json`. Then it waits for step 1
   to actually finish, deploys the refreshed database GUI, and kicks off
   step 3.
3. **`weekly-report.yml`** — reads both datasets, writes the report, commits
   it, and posts to Slack.

Everything upserts into the same two files week over week (deduplicated by
listing URL), so re-runs are cheap and safe — the only real "new" data most
weeks is current dealer inventory changing; auction history is mostly a
settled backlog after the initial backfill.

There's also a fourth, **manual-only** workflow, `market-scan-llm.yml` — an
open-ended Claude + web-search sweep that can surface a dealer or source the
structured importers above don't know about yet. It doesn't run on a
schedule and isn't wired into the report; dispatch it by hand from the
Actions tab when you want to go fishing for something new.

**`daily-alert.yml`** (Tue–Fri, 8am ET) is the near-term complement to the
weekly digest: refreshes dealer inventory and posts an immediate Slack ping
for any piece that's new *today* and priced at or above `$20,000` (override
with the `price_threshold` input on a manual dispatch, or
`ALERT_PRICE_THRESHOLD` as an env var). Quiet by default — posts nothing if
nothing clears the threshold. Skips Monday since `dealer-refresh.yml` +
the weekly report already cover that day.

## Running things locally / by hand

```bash
npm install

# Pull fresh auction history (add --with-browserbase for LiveAuctioneers/Christie's/Bonhams)
node import-all.js --with-browserbase

# Pull fresh dealer inventory
node import-dealers.js

# Generate the weekly report (writes output/reports/<date>.md + Slack payload)
node analyze.js --generate
# ...then actually post it:
node analyze.js --notify
# ...or preview without posting:
node analyze.js --dry-run
```

Needs `ANTHROPIC_API_KEY` (report writing), `BROWSERBASE_API_KEY` +
`BROWSERBASE_PROJECT_ID` (headless-browser sources), and `SLACK_WEBHOOK_URL`
(posting) as environment variables locally, or as GitHub Actions repo
secrets for the scheduled runs. `VERCEL_TOKEN`/`VERCEL_ORG_ID` are no longer
used — the GUI deploys via GitHub Pages now (`pages-deploy.yml`).

## Data model

Two separate datasets, deliberately not merged into one:

- **`output/david-webb-auction-history.*`** — past sales. Fields include
  `piece_name`, `category`, `sold_price`, `estimate_low`/`estimate_high`,
  `sale_date`, `auction_house`, `lot_number`, `listing_url`, `first_captured`.
  Managed by `history-store.js`.
- **`output/david-webb-dealer-listings.*`** — current for-sale inventory.
  Fields include `piece_name`, `category`, `asking_price`, `dealer`,
  `listing_url`, `image_url`, `first_seen`/`last_seen`/`status`
  (`active`/`inactive` — a listing that disappears from a dealer's site
  gets marked inactive, not deleted). Managed by `dealer-store.js`.

Both also carry a **USD-normalized price** (`sold_price_usd` /
`asking_price_usd`) alongside the original native-currency figure — most
records are already USD, but ~12% of auction-history records settle in
CHF/GBP/EUR/HKD/ITL (Christie's/Sotheby's international sale rooms), and
every stat, flag, and GUI sort uses the converted field so a foreign-
currency number can't masquerade as an outlier (or hide one). Conversion
uses hand-compiled historical annual-average FX rates (`convert-currency.js`)
— order-of-magnitude accurate, not settlement-precise.

Both carry a **`tags`** field (`;`-separated) — design motif/material/decade
tags (Zodiac, Animal/Creature, Fishscale, Rock Crystal, Enamel, Carved
Hardstone, Cuff/Bangle, `1970s`, etc.), keyword-matched from the piece's own
listing text via `infer-tags.js`. Computed centrally inside each store's
`upsert()` — not duplicated per-importer — so it's always in sync and only
needs updating in one place. Filterable in the GUI, and charted (count +
min/median/max price per tag) in the weekly report's "Trends by motif &
material" section.

The GUI (`docs/`) unions both into one browsable table client-side, tagging
each row `auction` or `dealer` so the distinction stays visible.

A third file, **`output/flagged-listings.json`**, is computed fresh on
every report run (not a stored dataset — thresholds shift with the current
price distribution) by `flag-listings.js`: a heuristic "worth a second
look" signal for an implausibly low price for the category. This is a
signal for a human to check, not a fraud determination. Surfaced in the
weekly report (with a link back to the source listing whenever one is on
file), a Slack line, and a "Worth a second look only" filter + badge in
the GUI. (An earlier second flag — no signature/hallmark/certificate
mentioned in the listing text — was tried and removed 2026-08-10: it
didn't discriminate genuine listings from anything else, see HANDOFF.md.)

## Data-quality notes

- **Auction hammer prices exclude buyer's premium** — typically +15–26%
  depending on the house.
- **Dealer asking prices are not confirmed sale prices** — they're the
  dealer's current ask, which may be negotiated down or never sell.
- **"Delisted" (dealer status: inactive)** usually but not always means
  sold — could also be a price relist under a new SKU or a data-feed gap.
- Every importer that queries a source's own free-text search (Invaluable,
  and defensively LiveAuctioneers) filters results for an actual "David
  Webb" mention before keeping them — full-text search on an aggregator
  spanning hundreds of unrelated auction houses otherwise returns real
  noise (confirmed and fixed 2026-08-08: 134 of Invaluable's 140 raw hits
  were unrelated lots that happened to share a word with the query).
  Sources that query by a structured maker/attribution field (Rago,
  Phillips, Sotheby's, Christie's, Doyle) don't need this and aren't
  filtered — their titles legitimately don't always spell out "David Webb"
  even when the piece is genuine.
- **1stDibs listings can duplicate a dealer's own-site listing.** A dealer
  may list the same physical piece both on their own storefront (picked up
  by the Shopify/WooCommerce adapters) and on 1stDibs (picked up by
  `import-1stdibs.js`) — there's no reliable way to match those as one
  piece, so they're kept as separate records. **"Total listings" counts
  platform presence, not unique physical pieces.**
- **Some already-committed Doyle records still carry a broken listing
  URL.** A bug (fixed 2026-08-10) stripped the query string off Doyle's
  confirmed-working href before storing it, which doesn't resolve on its
  own. New/re-scraped Doyle records get the corrected full URL; already-
  committed ones self-correct the next time `history-refresh.yml` runs
  (matched and updated in place, not duplicated).
- **Sotheby's Buy Now listings have no confirmed listing URL.** Live
  investigation across five probe rounds couldn't recover a working
  per-item detail-page URL (the site's backing API carries no pricing/URL
  data; DOM scraping for it also failed) — these records show no "View
  original listing" link in the GUI. That's expected, not a bug. This
  source is Sotheby's fixed-price retail marketplace, not bid-based
  auction lots — genuine *upcoming* auction lots were confirmed absent
  for David Webb at both Christie's and Sotheby's as of this writing.

## Extending it

- **New auction house or dealer site**: add an adapter file (see
  `import-rago.js` for the simplest structured example,
  `import-shopify.js`/`import-woocommerce.js` for the dealer-layer pattern
  against a structured feed, or `import-1stdibs.js` for a JS-rendered
  marketplace needing Browserbase) exporting `collect(map, opts)`, register
  it in `import-all.js` or `import-dealers.js`.
- **GUI changes**: `docs/index.html` / `docs/style.css` / `docs/app.js` —
  plain HTML/CSS/JS, no build step. Redeploys automatically on push via
  `pages-deploy.yml`.
- **Report changes**: `analyze.js` — stats are computed deterministically in
  JS (trustworthy numbers), then handed to Claude to narrate; Claude is
  explicitly told not to invent figures.

See `HANDOFF.md` for the deeper technical history of how each source's
adapter was built (what was tried, what worked, known limitations per
source) — useful before touching any individual importer.
