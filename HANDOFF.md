# Handoff: David Webb Market Agent → Claude Code

**Purpose:** Give Claude Code everything needed to continue this project without re-discovering context. Read this first, then inspect the code.

**Owner:** James (David Webb)  
**Repo:** `https://github.com/David-Webb-New-York/david-webb-market-agent`  
**Canonical remote:** `github.com/David-Webb-New-York/david-webb-market-agent`  
**Previous environment:** Cursor Cloud Agent (this handoff supersedes Cursor-specific setup notes)

---

## 1. What this project is

A Node.js pipeline that tracks **David Webb jewelry on the secondary market**:

1. **Weekly scan** — find currently listed / recently sold pieces via Claude + web search → append-only CSV + dated JSON snapshots.
2. **Library (silver layer)** — dedupe snapshots into a stable piece catalog with lifecycle (`first_seen` / `last_seen` / `status`).
3. **Analysis + Slack** — Claude writes a Markdown report with week-over-week Mermaid charts; posts to Slack `#secondary-market` with links to report + CSV + JSON (Pattern A + B: auto-report + interactive handoff into Claude).
4. **Historical auction library** — past sold lots (separate from live listings), starting with a complete Rago import and a framework to add other houses + estate jewelers.

Target consumers: Excel / Power BI / Microsoft Fabric (bronze = raw CSV, silver = library + auction history).

---

## 2. Branch / PR state (as of handoff)

| Branch | Status | Contents |
| --- | --- | --- |
| `main` | Live | Weekly scan, cost controls, analyze+Slack, trend charts, library layer, historical backfill, Rago importer, shared history store, `import-all`, Browserbase integration (PRs #4–#7 merged) |
| `claude/immediate-next-work-i15bgw` | In progress (this session) | Estate-jeweler dealer layer (`import-shopify.js`+`dealer-store.js`, §9 P0); LiveAuctioneers Browserbase importer + Invaluable free structured importer (`import-liveauctioneers.js`, `import-invaluable.js`, `inline-state.js`, §9 P1); Bonhams proxies+search-API confirmed, adapter not yet built (§9 P2) |

**Action for Claude Code:** PR #7 is merged; `main` is the current base. Do **not** recreate deleted branches `cursor/setup-dev-environment-0e2f`, `cursor/slack-claude-report-pipeline-0e2f`, or `cursor/historical-backfill-0e2f` (already merged).

GitHub tip for the user: merging a PR from Cursor’s UI *is* the GitHub merge — no second merge on github.com. After merge, delete the feature branch.

---

## 3. Secrets (required)

| Name | Used by | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `agent.js`, `analyze.js`, `backfill.js` | Already in GitHub Actions + Cursor. Needs Anthropic billing/credits. |
| `SLACK_WEBHOOK_URL` | `analyze.js --notify` | Incoming webhook → `#secondary-market` in `dwjewels.slack.com`. Must also be a **GitHub Actions** secret for the scheduled run. |
| `BROWSERBASE_API_KEY` | `browserbase.js`, `bb-probe.js` | Must start with `bb_`. User upgraded to paid (~$20) for proxies. |
| `BROWSERBASE_PROJECT_ID` | same | UUID of the Browserbase project. |

**Important distinctions (already tripped us up):**
- GitHub repo secrets ≠ Cursor/Claude Code secrets. Actions only see GitHub secrets; local/agent VMs only see their own secret store.
- Browserbase needs **both** API key (`bb_…`) and Project ID (UUID). Don’t put the UUID in the API key slot.
- Secrets should be **runtime secrets** (injected as env vars), not plain committed env files.

Claude Code: confirm these env vars are available in its environment before running paid or Browserbase paths.

---

## 4. Repo layout

```
agent.js                 # Weekly active-listings scan (Claude + web_search)
analyze.js               # Report + Slack notify (--generate / --notify / --dry-run)
library.js               # Deduped active library from snapshots
backfill.js              # Broad LLM historical auction sweep (collect(map) adapter)
import-rago.js           # Complete Rago structured importer (free HTTP)
import-all.js            # Orchestrator: structured importers + optional --with-llm
history-store.js         # Shared auction-history load/dedupe/write
import-shopify.js        # Dealer layer: Shopify /products.json importer (Yafa + registry); also collectAll()
dealer-store.js          # Shared dealer-listings load/dedupe/write (first_seen/last_seen/status)
browserbase.js           # Browserbase + Playwright helper
bb-probe.js              # Probe a URL in Browserbase; dump embedded state / XHRs
.cursor/environment.json # Cloud env: { "install": "npm install" } — Cursor-specific
.github/workflows/
  weekly-scan.yml        # Mon 8am ET: scan → library → report → commit → Slack
  history-refresh.yml    # Monthly free structured refresh; manual can --with-llm
output/
  david-webb-market-data.csv      # Append-only bronze log (live scan rows)
  snapshots/YYYY-MM-DD.json       # Per-run raw results
  david-webb-library.{json,csv}   # Deduped active catalog (silver)
  david-webb-auction-history.*    # Past auction lots (Rago 85 committed on PR #7)
  david-webb-dealer-listings.*    # Estate-jeweler for-sale inventory (Shopify importer; Yafa first)
  reports/YYYY-MM-DD.md           # Claude-written report + Mermaid charts
```

Node **≥ 18** (built-in `fetch`). Package manager: **npm** (`package-lock.json`).

```bash
npm install
npm run scan          # agent.js
npm run library       # library.js
npm run analyze       # analyze.js
npm run backfill      # LLM historical sweep
npm run import:rago   # Rago only (free)
npm run import:all    # structured (+ optional -- --with-llm)
npm run import:dealers # Shopify dealer layer, all registered dealers (free)
npm run bb:probe -- "https://..."
```

Cost knobs on `agent.js` / `backfill.js`:
- `MAX_QUERIES`, `WEB_SEARCH_MAX_USES`, `INCLUDE_OPTIONAL_QUERIES=1`, `MAX_PIECES_PER_QUERY`, `BACKFILL_DRY_RUN=1`

Weekly workflow sets `WEB_SEARCH_MAX_USES=3`.

---

## 5. Data model (two tracks — keep them separate)

### A) Active / current market
- **Bronze:** `output/david-webb-market-data.csv` — append-only; duplicates across weeks are expected.
- **Silver:** `output/david-webb-library.{json,csv}` — one row per unique piece.
  - ID: normalized listing URL, else `source|name|price_type|price`
  - Fields: `first_seen`, `last_seen`, `times_seen`, `status` (`active`|`inactive`), `first_price` / `current_price` / `min_price` / `max_price`
- Built by `library.js` from `output/snapshots/*.json` (idempotent rebuild).

### B) Historical auction results
- `output/david-webb-auction-history.{json,csv}`
- Fields: `sold_price`, `estimate_low`/`high`, `sale_date`, `auction_house`, `sale_name`, `lot_number`, `listing_url`, `price_type` (`hammer`|`estimate`), `source`, `first_captured`
- Shared store: `history-store.js` (all importers upsert into the same files)

Do **not** force sold lots into the active library; they are different entities. A combined Fabric/Claude view can come later.

### C) Dealer listings (estate-jeweler for-sale inventory)
- `output/david-webb-dealer-listings.{json,csv}`
- Third track, separate from both A and B: for-sale inventory scraped directly from a dealer’s own structured feed (e.g. Shopify `/products.json`), not from the weekly LLM scan and not an auction result.
- Fields: `piece_name`, `category`, `era_or_year`, `materials_gemstones`, `price_type` (`asking`), `asking_price`, `currency_note`, `dealer`, `listing_url`, `sku`, `notes`, plus lifecycle `first_seen`/`last_seen`/`times_seen`/`status` (`active`|`inactive`) — same lifecycle shape as the library (A), so it can be unioned with it later for a combined view.
- Shared store: `dealer-store.js`. Adapter: `import-shopify.js` (`collect(map, {shop, dealer, currency})` for one dealer, `collectAll(map)` for every dealer in its `DEALERS` registry). Resolves §13’s open question: dealer inventory gets its **own layer**, not forced into the active library or auction history.

---

## 6. What’s done (validated)

| Area | Status |
| --- | --- |
| Cloud env | `.cursor/environment.json` with `npm install`; Node 22 on default image is fine |
| Weekly scan | Works end-to-end; ~$14 uncapped → **~$2–4** with CORE_QUERIES + `WEB_SEARCH_MAX_USES=3` |
| Analyze + Slack | Live post to `#secondary-market` succeeded; report includes Mermaid WoW charts |
| Library layer | 144 raw sightings → 100 unique pieces (validated) |
| Rago historical import | **85/85 lots** via Inertia `data-page` JSON (free). Committed on PR #7 |
| Browserbase | Auth works (`bb_` key + project UUID). Paid plan; proxies confirmed working (Bonhams). |
| Estate-jeweler dealer layer | **1,397 dealer listings** across 16 dealers (Shopify+WooCommerce), verified live (§9 P0) |
| LiveAuctioneers historical import | **Real, verified live**: Browserbase-rendered `window.__data` extraction, confirmed pagination, 93 lots/3 pages in latest run (§9 P1) |
| Invaluable historical import | **Real, verified live**: free (no Browserbase) Algolia POST replay, 133/133 lots (exact `nbHits` match) (§9 P1) |
| Sotheby's historical import | **Real, verified live**: free (no Browserbase) Algolia search, **1,000 lots** — largest single source this session, real hammer/sold prices (§9 P1) |
| Bonhams historical import | **Real, verified live**: Browserbase-captured Typesense search API, 1 lot (honestly limited by an unresolved `status` filter) (§9 P2) |
| Heritage (ha.com) | Confirmed blocked by a named vendor (DataDome device-check challenge), not a mystery — documented, not pursued further (§9 P2) |
| Total auction-history records | **1,332** (up from 85 at session start), verified live via `history-refresh.yml` |
| Cost review | 29/40 original queries never returned data; moved to `OPTIONAL_QUERIES` |

### Cost numbers (measured)
- Full uncapped weekly scan (~40 queries): **~$14.21** (3.85M input, 49k output, 192 web searches)
- Capped single query (`WEB_SEARCH_MAX_USES=2`): **~$0.066**, still 8 pieces
- Rago LLM probe: **~$0.18** for 12 lots (incomplete vs structured 85)
- Analyze step: a few cents (text-only, no web search)

Pricing reference used: Sonnet 4.6 ≈ $3/M input, $15/M output; web search $10/1000.

---

## 7. Critical findings (do not re-learn the hard way)

### 7.1 LLM web search ≠ complete site coverage
Web search returns top snippets. It found **12 of Rago’s 85** lots. For complete coverage, use **structured importers** (site’s own JSON) or a **rendered browser** (Browserbase), not more web-search queries.

### 7.2 Per-auctioneer feasibility (plain HTTP)

| Source | Feasibility |
| --- | --- |
| **Rago** | ✅ Server-embeds full results (Inertia `data-page`). Importer done. |
| LiveAuctioneers | ❌ Plain GET = ~957-byte stub. ✅ Browserbase renders; lots in `window.__data`. Default keyword search = **upcoming** (`salePrice: 0`); sold/historical view not yet found. |
| Invaluable | Algolia-loaded SPA |
| Barnebys | Next.js SPA |
| Sotheby’s | SPA redirect |
| Christie’s | `api.christies.com` (key-gated) |
| Phillips / Doyle | SPA shells |
| Bonhams / Heritage | Cloudflare **403** — need Browserbase **proxies** (paid) |
| Freeman’s / Hindman | Nuxt; results via API |

**Only Rago** was directly importable like Rago. Everything else needs Browserbase (or an official API / headless adapter).

### 7.3 Estate jewelers — DO NOT DROP THEM
User priority: estate jewelers (e.g. **Yafa Signed Jewels**) matter even when listing counts are small.

They were moved to `OPTIONAL_QUERIES` in `agent.js` because **web search couldn’t extract them**, not because the inventory is worthless. Restore coverage via **direct importers**, not by blindly turning all optional queries back on (that would re-burn ~$10/run for little yield).

**Proven path for Yafa:** Shopify store.  
`https://yafasignedjewels.com/products.json?limit=250` returns structured products; filter vendor/title/tags for “David Webb” → **22 pieces** with prices (e.g. Zebra ring $22,500, Chevron Pentagon earrings $39,000). Same pattern likely works for other Shopify dealers.

Optional-query list (still in `agent.js` `OPTIONAL_QUERIES`) includes dealers such as: oakgem, thebackvault, vestiairecollective, jamesedition, rubylane, fredleighton, kentshire, doyledoyle, fdgallery, ericoriginals, saidiansons, robinsonsjewelers, legacyvintagejewels, louismartin, **yafasignedjewels**, circajewels, abrandtandson, wilsonsestatejewelry, langantiques, estatediamondjewelry, frankpollakandsons, rtjewelers, alexcooper, syl-leeantiques, schiffmans, macklowegallery, plus Doyle/Rago/Heritage auction probes.

### 7.4 Browserbase gotchas
- Free plan: **proxies return 402**. User upgraded (~$20/mo) — proxies should work; verify with a session `{ proxies: true }`.
- ~~LiveAuctioneers: intercept/parse `window.__data`~~ — **corrected 2026-08-07**: a real Browserbase probe of `/search/?keyword=david+webb` found real content (270 "david webb" mentions, 26 `salePrice`, 28 `lotNumber`) but `window.__data` was empty — nothing was in any window global or XHR response. The data appears server-inlined directly in the HTML; don't trust this line's original claim, trust the next probe's actual findings instead (`bb-probe.js` now does an HTML deep-dive for exactly this situation).
- Prefer: navigate → wait → read embedded state / capture JSON responses → map into `history-store` (same pattern as Rago). `browserbase.js`'s `renderAndExtract()` had a bug where `sessionOpts` (incl. `--proxies`) was never actually forwarded to the session — fixed 2026-08-06, verify proxy-gated sites (Bonhams/Heritage) with a fresh probe, not assumptions from before that fix.

### 7.5 Cursor-specific (ignore if on Claude Code)
- Dashboard “Save environment” `[invalid_argument]` can be ignored: env is **repo-managed** via `.cursor/environment.json`.
- Cursor secrets ≠ GitHub Actions secrets.

### 7.6 Claude Code web sandbox can't reach target sites OR Browserbase — probe via CI instead
This session's own network is allowlisted and blocks essentially everything except npm/pypi registries and the Anthropic API — `fetch` to any target site (`yafasignedjewels.com`, `api.browserbase.com`, even `githubstatus.com`) returns `403 Host not in allowlist`. This is **different** from the previous Cursor session, which had open egress.

**Workaround, already built:** a CI-driven probing pipeline that runs on GitHub Actions runners (which have real internet):
- `.github/workflows/probe-source.yml` — runs `bb-probe.js` against a URL via Browserbase, prints a structured summary + all captured JSON responses + embedded state to the job log (readable via `mcp__github__get_job_logs` without downloading artifacts), and uploads the full `probe-output/` as a build artifact for deep dives.
- `.github/workflows/scan-dealers.yml` / `scan-dealer-domains.js` — free (no Browserbase) sweep of candidate dealer domains for a Shopify/Squarespace/WooCommerce feed.
- `.github/workflows/dealer-refresh.yml` — runs `import-dealers.js` for real (weekly on schedule once merged to `main`; also push-triggered on the importer files themselves for pre-merge verification) and uploads results as an artifact.

**Triggering pre-merge:** `workflow_dispatch` can't be dispatched via API/UI until a workflow file exists on the default branch (a real GitHub limitation, confirmed the hard way) — so all three workflows above are **also** `push`-triggered on specific file paths (`probe-request.json` for probes, the importer `.js` files + workflow file itself for dealer-refresh). To probe a new URL from a feature branch: edit `probe-request.json` (`{url, proxies, wait_ms}`) and push — do **not** just edit `bb-probe.js`/`print-probe-findings.js` and expect it to trigger, those aren't in the path filter, `probe-request.json` must also change.

**GitHub Actions outage, 2026-08-06 ~15:52–~00:47 UTC (next day):** hit a genuine multi-hour GitHub-wide Actions incident (status.github.com confirmed: "capacity remains constrained... recovers gradually", webhook deliveries delayed) mid-session — jobs stuck `queued` forever with `runner_id: 0` / empty `runner_group_name`, then auto-cancelled by GitHub after exactly 15 minutes. Ruled out (in order tried): Browserbase-specific (no — a pure-HTTP workflow failed identically), our workflow YAML (no — same `runs-on: ubuntu-latest` had worked minutes earlier), Actions minutes (no — 4/2000 used), missing org billing (no — added, didn't help either). It was genuinely GitHub's outage; resolved on its own once GitHub's status page said so. If this happens again: check https://www.githubstatus.com/ (not reachable from this sandbox — ask the user to check and paste it) before assuming it's something in this repo.

---

## 8. Agreed architecture / principles

1. **Adapter pattern:** each source exports `collect(map)` and upserts via `history-store.js`. Register in `import-all.js`.
2. **Two collection modes:**
   - Structured / free (HTTP JSON) when the site allows — prefer this.
   - Browserbase for JS/anti-bot sites.
   - LLM web-search as broad catch-all only (`--with-llm`), not for complete per-site coverage.
3. **Cost discipline:** keep weekly scan on `CORE_QUERIES` + search cap; don’t re-enable all `OPTIONAL_QUERIES` by default.
4. **Don’t commit secrets.** Don’t modify application code just to hide env issues.
5. **Idempotent importers:** re-runs merge/dedupe; safe to re-execute.

---

## 9. Immediate next work (priority order)

User’s last direction: upgrade done; **don’t lose estate jewelers**; continue auctioneer coverage via Browserbase.

### P0 — Estate jewelers (user-flagged) — ✅ Done, verified live
1. **Verified against the live internet** (2026-08-07, via `dealer-refresh.yml` on GitHub Actions — this sandbox's own network can't reach these sites, see §7.6). `import-shopify.js` + `import-woocommerce.js` + `dealer-store.js` + `import-dealers.js` orchestrator all confirmed working end-to-end. Real run: **1,397 David Webb dealer listings** across 15 registered dealers (13 Shopify + 2 WooCommerce), sample titles spot-checked and confirmed genuine (not false positives):
   | Dealer | Scanned | David Webb | Notes |
   |---|---|---|---|
   | The Back Vault | 3,414 | **952** | Match rate 27.9% looked implausible at first — sample titles confirm it's real, they're a heavy David Webb specialist |
   | Yafa Signed Jewels | 421 | 66 | Full pagination found 3x the ~22 an earlier 5-item sample suggested |
   | Oak Gem | 1,410 | 114 | |
   | Saidian & Sons | 1,381 | 90 | |
   | Eric Originals & Antiques | 1,730 | 84 | |
   | Wilson's Estate Jewelry | 10,000 | 38 | **[TRUNCATED]** — hit the 10,000-product pagination cap, real catalog is larger |
   | Legacy Vintage Jewels | 619 | 14 | |
   | Macklowe Gallery | 584 | 11 | |
   | Fred Leighton (WooCommerce) | 1,376 | 8 | |
   | Estate Diamond Jewelry (WooCommerce) | 2,604 | 7 | |
   | Kentshire | 2,619 | 6 | |
   | Louis Martin | 4,452 | 4 | |
   | A. Brandt + Son | 3,375 | 3 | |
   | Doyle & Doyle | 1,317 | 0 | |
   | Robinson's Jewelers | 10,000 | 0 | **[TRUNCATED]** |
   | Schiffman's | 10,000 | 0 | **[TRUNCATED]** |
   - `import-shopify.js`/`import-woocommerce.js` now detect stalled pagination (Shopify's legacy `?page=` sometimes re-serves the same page instead of erroring on huge catalogs) and flag `truncated: true` rather than silently under/over-counting. Three dealers above hit the real `MAX_PAGES` cap (40 × 250) — their true catalogs exceed 10,000 products; raise `MAX_PAGES` in `import-shopify.js` if fuller coverage of those three specifically is wanted (costs more requests/CI time).
   - `import-dealers.js` prints sample matched titles inline whenever a dealer's match rate exceeds 15%, so a bad title/vendor/tag filter is visible in the log immediately rather than silently trusted.
2. Probe other `OPTIONAL_QUERIES` domains for Shopify / Squarespace / public JSON — `scan-dealer-domains.js` covers this cheaply (see §7.6); add confirmed Shopify/WooCommerce hits to the `DEALERS` array in `import-shopify.js`/`import-woocommerce.js`.
3. For non-Shopify/WooCommerce dealers, use Browserbase + `bb-probe` the same way as LiveAuctioneers (§7.6).

### P1 — Aggregators (highest auction ROI)
1. **LiveAuctioneers — ✅ Done, `import-liveauctioneers.js` built and registered in `import-all.js`.**
   - Confirmed via Browserbase probes on 2026-08-07 (not guessed): behind Incapsula bot-protection (`plain-fetch-test.js` proved a plain `fetch()` gets a 960-byte JS-challenge stub — Browserbase is required, not optional). `/search/?keyword=david+webb` server-embeds the full Redux state as `<script>window.__data={...}</script>`, but the app's own client hydration reads and clears that global before `page.evaluate()` can see it — `inline-state.js` extracts it directly from the raw rendered HTML instead (balanced-brace, string-aware scan).
   - Real lot records live at `window.__data.itemSummary.byId.<itemId>`, found by structural shape (`findLotLikeObjects`) rather than a guessed path. Confirmed real field shape: `itemId, lotNumber, title, slug, slugWithLocation, catalogId, catalogTitle, sellerName, currency, salePrice, buyNowPrice, leadingBid, startPrice, lowBidEstimate, highBidEstimate, isSold, isPassed, isAvailable, saleStartTs` (unix seconds). Price fields are plain dollar amounts, not cents (cross-checked against realistic jewelry prices).
   - Confirmed `listing_url` pattern via a real `<a href>` in the rendered HTML (not inferred from general site knowledge): `https://www.liveauctioneers.com/item/{itemId}_{slugWithLocation}`.
   - Confirmed pagination: the site's own `catalogItems.pagination` Redux slice is always empty/unrelated, but `&page=N` on the search URL is real — a probe of `&page=2` returned a different `<title>` and genuinely different lots than page 1. `collect()` pages through `&page=N` until a page returns nothing new (capped at 25 pages as a safety backstop, not a real limit).
   - The ~80KB `window.__data` blob can fail a whole-tree `JSON.parse` due to unrelated debug telemetry elsewhere in the tree (observed once: a serialized `Array.prototype` reference under `apiPerformanceStats`, nothing to do with lot data). `inline-state.js` now exposes `extractKeyObject()` so the adapter falls back to parsing just the `itemSummary` sub-object when the full blob fails — narrows the failure surface to data we actually need.
   - Wired into `.github/workflows/history-refresh.yml` (now weekly, `--with-browserbase` gates the Browserbase-costing sources) with a push-trigger on the importer files for pre-merge verification, same pattern as `dealer-refresh.yml`.
   - **Verified end-to-end against the live internet** (2026-08-07, `history-refresh.yml` run `31139385926`): `Rago 85 lots + LiveAuctioneers 94 lots (3 pages) = 179 total historical records`, real dollar amounts and lot numbers, not synthetic.
   - Not yet done: `materials_gemstones`/`era_or_year` are left blank (not cleanly available as structured fields — `shortDescription` has prose but extracting would require guessing).
2. **Invaluable — ✅ Done, `import-invaluable.js` built and registered as a "structured" (free, no Browserbase) source in `import-all.js`.**
   - Confirmed via Browserbase probe (2026-08-07): the search page POSTs to `https://www.invaluable.com/catResults` with a captured, real Algolia multi-index request body (`{"requests":[{"indexName":"upcoming_lots_prod","params":{...,"query":"david webb","page":0,"hitsPerPage":96,...}}],"isCatalogPageRequest":false}`) and gets back a standard Algolia envelope: `results[0].{hits[], nbHits, page, nbPages, hitsPerPage}` (confirmed real values: `nbHits:133, nbPages:2, hitsPerPage:96`).
   - **Critical finding: this same POST replays successfully with a bare Node `fetch()` — 200 status, real data, no cookies/session/Browserbase required** (`plain-post-test.js`, new general-purpose POST-replay diagnostic tool, sibling to `plain-fetch-test.js`). So Invaluable gets a free structured adapter like Rago, not a costly Browserbase one.
   - Real hit field shape (confirmed, not guessed): `lotNumber, lotRef, estimateHigh, estimateLow, currentBid, bidCount, priceResult, houseName, saleType, dateTimeUTCUnix, currencyCode, currencySymbol, lotTitle, objectID, _highlightResult.lotDescription.value` (full plain-text description, HTML-highlight-tagged — adapter strips the tags).
   - **Known limitation:** the index name `upcoming_lots_prod` (and `priceResult:0` on every observed hit) implies this only covers not-yet-sold lots. A single guessed sibling index `past_lots_prod` returned a 504 Gateway Timeout (inconclusive — not pursued further to avoid guessing index names). No confirmed `listing_url` pattern either (no anchor href was ever captured pointing to a lot detail page) — left blank rather than guessed.
   - **Verified end-to-end** inside the full `import-all.js --with-browserbase` orchestrator run (not just standalone) via `history-refresh.yml` on 2026-08-07.
3. **Sotheby's — ✅ Done, `import-sothebys.js` built and registered as a "structured" (free, no Browserbase) source — the single biggest source found this session.**
   - Confirmed via Browserbase probe (2026-08-07): the search page queries an Algolia index directly (`o28sy4q7wu-dsn.algolia.net`, indexName `bsp_dotcom_prod_en`). A query for "david webb" filtered to `type:"Lot"` returned **real historical/sold auction data** — not just current retail listings: `hammerPrice, salePrice, soldStatus:"SOLD", highEstimate, lowEstimate, estimateCurrency, saleNumber, endDate` (unix milliseconds), `auctionType, auctionLocations, guaranteeLine` (concise item title), `fullText` (long description incl. provenance).
   - **This replays successfully with a bare Node `fetch()`** using a public search-only API key extracted directly from Sotheby's own embedded page config (`shared.sothebys.com/syndicate` response, fields `algoliaApiKey`/`algoliaAppId`) — no Browserbase needed. Public Algolia search keys are meant to be client-embeddable by design, this isn't a secret being exfiltrated.
   - **Verified end-to-end live: 1000 lots** in a single `history-refresh.yml` run (2026-08-07) — by far the largest single-source count of the session (more than Rago+Invaluable+LiveAuctioneers+Bonhams combined in that run).
   - **Known limitation:** Algolia's standard search API refuses to page past result position 1000 regardless of the true `nbHits` — confirmed in practice (got exactly 1000, not partial-page-short of some other number). If Sotheby's genuinely has more than 1000 matching Lot records, the remainder isn't reachable via this adapter as written.
   - **Known gaps (honest, not guessed):** no `lotNumber` field was present on the one real hit inspected (Sotheby's identifies by `saleNumber` instead, at least in this index) — `lot_number` left blank. No confirmed `listing_url` pattern for Lot-type items either (their retail "Buy Now" items DO have a real `url` field: `https://sothebys.com/en/buy/_{slug}`, confirmed real, but that wasn't observed on a Lot-type hit) — left blank.
   - Not pursued: the site's own "Buy Now"/retail inventory (same Algolia index, `type:"Buy Now"`) — real, confirmed field shape captured (`title, sku, listPrice, currency, url, image, ...`) but not imported anywhere; would fit better as a dealer-style current-listings source than auction history, and wasn't built given time.

### P2 — Houses
- **Bonhams — ✅ Done, `import-bonhams.js` built, registered as a "browserbase" source, and verified live.**
  - Browserbase + proxies (paid plan) reach Bonhams cleanly now that the `sessionOpts`-forwarding bug is fixed — confirmed via a real probe: title `"Bonhams : Search"`, 638KB of genuine Next.js app HTML, no Cloudflare block.
  - First attempt (`?search_term=david+webb`) didn't actually populate the search — the real backend call (`POST https://api01.bonhams.com/search-proxy/multi_search`, a Typesense-backed API) received an empty `"q":""` and returned generic site-wide facet counts. Second attempt (`?q=david+webb`, matching Typesense's own param name) worked — `"q":"david webb"` flowed through and returned a real David-Webb-matching hit (Skinner/Bonhams lot 28190-114, "DAVID WEBB: A PAIR OF 18K GOLD GEM-SET EARCLIPS").
  - **Unlike Invaluable, this endpoint is NOT plain-fetch-replayable:** `plain-post-test.js` against the exact captured POST body got a **401 "Authorization Required" (nginx)** — the real request carries auth material a bare fetch lacks. So the adapter renders the actual search page in Browserbase and captures the JSON response the authenticated browser session receives, rather than replaying the request itself.
  - Confirmed real field shape (Typesense's own envelope — NOT Algolia's, different names): `results[0].{found, hits[].document}`, document fields: `auctionId, auctionStatus, brand` (Bonhams' sub-house, e.g. "skinner"), `country, currency.iso_code, department.name, hammerTime.timestamp` (unix seconds), `id, lotNo.full, price.{estimateLow,estimateHigh,hammerPrice}` (native currency — GBP-converted display fields also present but not used), `slug, status, styledDescription, title`.
  - **Verified end-to-end** via `history-refresh.yml` on 2026-08-07: **1 real lot** ("DAVID WEBB: A PAIR OF 18K GOLD GEM-SET EARCLIPS", Skinner). This matches the probe's own `"found":1` for the same query — a real, honestly-limited result, not a bug.
  - **Known limitation (the reason the count is so low):** the query used `filter_by:"(status:=[\`NEW\`])"`. What other `status` values exist (needed for full/historical coverage — the one hit found had `hammerPrice:0.0` despite `auctionStatus:"FINISHED"`, so `status:NEW` looks like a "currently listed" filter, not "unsold vs sold") is unconfirmed — not guessed at further. No confirmed `listing_url` pattern either (no anchor href captured) — left blank. Pagination beyond the site's own default (page 1, 45/page) is untested.
- **Heritage (ha.com) — re-tested with proxies, confirmed still blocked, and now know exactly why.**
  - Browserbase + proxies got back a genuine, tiny (3,965-byte) page titled just `"ha.com"` — no lot signals, no JSON XHRs, no embedded state. `bb-probe.js` now prints the full raw HTML whenever a rendered page is under 10KB (too small to be real, small enough to just show directly) instead of requiring an artifact download, and that revealed the real cause: a **DataDome device-check challenge** — `<iframe ... src="https://geo.captcha-delivery.com/interstitial/?..." title="DataDome Device Check">`, with a `var dd={cid,hsh,b,s,e,cookie}` bootstrap payload and a `ct.captcha-delivery.com/i.js` fingerprinting script. This is a real, named anti-bot vendor doing browser/device fingerprinting, not IP-reputation-based blocking — proxy rotation alone (already tried) doesn't get past it. Treating this as blocked for now rather than continuing to re-probe with the same approach; further attempts would need DataDome-specific stealth/evasion, not just a different proxy or URL.
- **Christie's — probed twice (`?entry=`, `?query=`), both times a real unblocked page rendered but zero results populated and zero search-API XHRs fired.** Unlike Bonhams/Sotheby's/Invaluable, no URL query-param variant triggered the actual search — the only JSON traffic captured was OneTrust cookie-consent plumbing. This suggests Christie's search needs real UI interaction (typing into a search box) rather than a URL param, which the current probe tooling (navigate + wait) doesn't simulate. Not pursued further this session — would need probe tooling extended to simulate typing/clicking before another attempt is worthwhile.
- **Doyle — probed three times, all missed.** `/auctions/search?query=` → generic "Auction Details" page. `/search?q=` → real but wrong: this is Doyle's site-wide CMS/blog search (found a blog post *about* David Webb the designer, zero lot data). `/auction/search?q=` (found via a `data-url="/auction/search"` attribute on the site's search box, looked promising) → rendered the generic homepage instead, no lot API fired (one near-miss XHR, `/CMS/LotDataRefresh/`, returned only 16 empty-looking bytes). Site sits behind Akamai Bot Manager + reCAPTCHA per its own CookieYes cookie-audit data, though neither was observed triggering. Treating as unresolved for now — would need manual inspection of the live search UI to find the real endpoint/interaction.
- **Freeman's/Hindman — probed once, wrong URL.** `freemanshindman.com/search?q=` rendered a real, substantial (185KB) page, but titled just the bare hostname and with zero "david webb" occurrences and zero search API XHRs — the search never executed. Domain itself is plausibly right (real content rendered, not a DNS/redirect failure), but the URL path is wrong. Not retried further this session.
- **Barnebys — probed once, clean 404** (`/search?q=` doesn't exist; confirmed via a literal "404: This page could not be found" title, and a working, cleanly-responding first-party `/api/auth/check` endpoint proving the app itself works normally). Not a bot-block. Needs the real search URL found before retrying.
- **Phillips — probed twice.** First attempt got a suspicious small (34.8KB) page titled `"Phillips Auction | We apologize for the inconvenience"`; bumped the tiny-HTML-dump threshold from 10KB to 50KB and re-probed to see the actual content (result pending/not yet folded into this doc at time of writing — check the most recent probe-source.yml run for Phillips before treating this as blocked or just a bad URL).
- Keep LLM sweep as fallback for all of the above.

### P3 — Product polish
- Enrich Rago `materials_gemstones` from lot captions (often blank).
- Combined view (active library + auction history) for Fabric/Claude.
- Confirm `SLACK_WEBHOOK_URL` is set in **GitHub Actions** secrets.
- Merge PR #7 when ready; keep `main` as single source of truth.

---

## 10. How to run the important flows

### Weekly scan (local)
```bash
export ANTHROPIC_API_KEY=...
npm run scan
npm run library
npm run analyze -- --generate   # then --notify if Slack webhook set
```

### Historical / import
```bash
npm run import:rago             # free, complete Rago
npm run import:all              # structured only
npm run import:all -- --with-llm   # + paid LLM sweep (~$3–6)
```

### Browserbase probe
```bash
export BROWSERBASE_API_KEY=bb_...
export BROWSERBASE_PROJECT_ID=<uuid>
npm run bb:probe -- "https://www.liveauctioneers.com/search/?keyword=david+webb"
# Inspect /tmp/bb-probe.html and /tmp/bb-probe-*.json
```

### Shopify dealer check (Yafa pattern)
```bash
curl -sL "https://yafasignedjewels.com/products.json?limit=250" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  const p=JSON.parse(d).products||[];
  console.log(p.filter(x=>/david webb/i.test([x.title,x.vendor,x.tags].join(" "))).length);
});'
```

---

## 11. Slack message contract

`analyze.js` posts Block Kit with: header, piece counts + price range, insight bullets, links to:
- Report: `output/reports/<date>.md`
- CSV: `output/david-webb-market-data.csv`
- Snapshot JSON: `output/snapshots/<date>.json`  

Notify runs **after** git push in CI so links resolve. Payload written to `output/reports/<date>.slack.json` (gitignored).

---

## 12. What Claude Code should do on day 1

1. Clone/open the repo; checkout `cursor/historical-backfill-0e2f` (or merge PR #7 into `main` if user wants).
2. `npm install`; verify secrets in env.
3. Read this file + `import-all.js` + `history-store.js` + `agent.js` (CORE vs OPTIONAL queries).
4. Confirm Browserbase proxies work (session create with `proxies: true`).
5. Implement **Shopify dealer importer** starting with Yafa (user priority); register in `import-all` or a parallel dealer import path.
6. Then LiveAuctioneers sold-results via Browserbase.
7. Keep reporting costs honestly; don’t re-run the full ~$14 scan unless asked.

---

## 13. Open questions / decisions for the user

- ~~Should estate-jeweler inventory live in the active library, a new dealer listings file, or both?~~ **Decided this session:** new dealer layer (`output/david-webb-dealer-listings.*`, §5C) — kept separate since these are for-sale prices from a single dealer's own feed, not LLM-scan sightings or auction hammers. Revisit "both" (a combined view) once there's more than one source feeding it.
- Approve Browserbase proxy spend + continued per-site adapter work vs. also pursuing licensed data (artnet)?
- PR #7 is merged into `main`. Next PR (this session's Shopify/dealer-layer work) — merge when ready.

---

## 14. Contact / product context

- Slack workspace: `dwjewels.slack.com`, channel `#secondary-market`
- Anthropic console billing must have credits (was blocked once with “credit balance too low”)
- Fabric/Power BI: treat CSVs as bronze/silver sources (see README)

---

*Generated as a handoff from the Cursor Cloud Agent session that built env setup, Slack/report pipeline, library layer, Rago import, Browserbase integration, and the estate-jeweler Shopify finding (Yafa: 22 David Webb products via `products.json`).*
