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
| `main` | Live | Weekly scan, cost controls, analyze+Slack, trend charts, library layer (PRs #4–#6 merged) |
| `cursor/historical-backfill-0e2f` | **Open [PR #7](https://github.com/David-Webb-New-York/david-webb-market-agent/pull/7)** | Historical backfill, Rago importer, shared history store, `import-all`, Browserbase integration |

**Action for Claude Code:** Continue work on PR #7 (or merge it into `main` first if the user prefers a clean base). Do **not** recreate deleted branches `cursor/setup-dev-environment-0e2f` or `cursor/slack-claude-report-pipeline-0e2f` (already merged).

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

---

## 6. What’s done (validated)

| Area | Status |
| --- | --- |
| Cloud env | `.cursor/environment.json` with `npm install`; Node 22 on default image is fine |
| Weekly scan | Works end-to-end; ~$14 uncapped → **~$2–4** with CORE_QUERIES + `WEB_SEARCH_MAX_USES=3` |
| Analyze + Slack | Live post to `#secondary-market` succeeded; report includes Mermaid WoW charts |
| Library layer | 144 raw sightings → 100 unique pieces (validated) |
| Rago historical import | **85/85 lots** via Inertia `data-page` JSON (free). Committed on PR #7 |
| Browserbase | Auth works (`bb_` key + project UUID). Renders LiveAuctioneers. `bb-probe` works. Paid plan for proxies. |
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
- LiveAuctioneers: intercept/parse `window.__data`; don’t assume a separate lots XHR.
- Prefer: navigate → wait → read embedded state / capture JSON responses → map into `history-store` (same pattern as Rago).

### 7.5 Cursor-specific (ignore if on Claude Code)
- Dashboard “Save environment” `[invalid_argument]` can be ignored: env is **repo-managed** via `.cursor/environment.json`.
- Cursor secrets ≠ GitHub Actions secrets.

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

### P0 — Estate jewelers (user-flagged)
1. Build `import-shopify.js` (or `import-yafa.js` first) using `/{products.json}` (+ pagination `/products.json?page=N&limit=250`).
2. Map products → history or a **dealer-listings** store (decide: active library vs separate dealer CSV — recommend feeding **active library** / a dealer layer since these are for-sale, not past auction hammers).
3. Probe other `OPTIONAL_QUERIES` domains for Shopify / Squarespace / public JSON; build adapters for the ones that expose feeds.
4. For non-Shopify dealers, use Browserbase + `bb-probe` the same way as LiveAuctioneers.

### P1 — Aggregators (highest auction ROI)
1. With Browserbase (+ proxies), find LiveAuctioneers **sold / price-results** URL or UI path (default search is upcoming only).
2. Parse `window.__data` → upsert into auction history.
3. Repeat for Invaluable (Algolia — capture network JSON in probe).

### P2 — Houses
- Proxies on: Bonhams, Heritage.
- SPA probes: Doyle, Phillips, Christie’s API, Freeman’s/Hindman.
- Expect partial success on Sotheby’s/Christie’s; keep LLM sweep as fallback.

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

- Should estate-jeweler inventory live in the **active library**, a new **dealer listings** file, or both?
- Approve Browserbase proxy spend + continued per-site adapter work vs. also pursuing licensed data (artnet)?
- Merge PR #7 now vs. after first LiveAuctioneers/Shopify importer lands?

---

## 14. Contact / product context

- Slack workspace: `dwjewels.slack.com`, channel `#secondary-market`
- Anthropic console billing must have credits (was blocked once with “credit balance too low”)
- Fabric/Power BI: treat CSVs as bronze/silver sources (see README)

---

*Generated as a handoff from the Cursor Cloud Agent session that built env setup, Slack/report pipeline, library layer, Rago import, Browserbase integration, and the estate-jeweler Shopify finding (Yafa: 22 David Webb products via `products.json`).*
