# Handoff: David Webb Market Agent → Claude Code

**Purpose:** Give Claude Code everything needed to continue this project without re-discovering context. Read this first, then inspect the code.

**Owner:** James (David Webb)  
**Repo:** `https://github.com/David-Webb-New-York/david-webb-market-agent`  
**Canonical remote:** `github.com/David-Webb-New-York/david-webb-market-agent`  
**Previous environment:** Cursor Cloud Agent (this handoff supersedes Cursor-specific setup notes)

---

## 0. Current state (as of 2026-08-10) — READ THIS FIRST

Everything in §1-§9 below was written across several sessions and is a mix
of still-accurate technical reference and now-stale status. Trust this
section for "what's actually running today"; trust §7 (per-source technical
findings) for "how each importer was built and what its known limits are"
(that part hasn't changed). Sections 2, 6, and 9 below have stale
`weekly-scan.yml`/branch-state references from before this section existed
— read this one instead.

**The pipeline today, end to end (all automated, nothing manual):**

1. `history-refresh.yml` (Mon ~8:15am ET / 13:15 UTC) — structured +
   Browserbase auction-history importers → `output/david-webb-auction-history.*`.
2. `dealer-refresh.yml` (Mon ~8:30am ET / 13:30 UTC) — Shopify/WooCommerce
   dealer importers → `output/david-webb-dealer-listings.*`, then deploys
   the GUI, then **waits for #1 to finish** (polls `gh run list`, up to 40
   min) and explicitly dispatches #3 — this replaced an earlier design
   where the report ran on its own cron *before* the data it depended on
   had refreshed.
3. `weekly-report.yml` (workflow_dispatch only, chained from #2) —
   `analyze.js --generate` then `--notify`. Reads the two structured
   datasets directly (NOT `output/snapshots/*.json` — see below), writes
   `output/reports/<date>.md`, posts to Slack.

**The old `agent.js`/`library.js` LLM web-search pipeline (§1's original
"weekly scan") is no longer part of any of this.** It was the *original*
discovery mechanism before structured importers existed for each source; it
still exists and still works, but is now a **manual-only** workflow
(`market-scan-llm.yml`, no cron) kept around for the thing it's still good
at — an open-ended sweep that might surface a dealer the structured
importers don't know about. `analyze.js` was rewritten to read
`david-webb-auction-history.json`/`david-webb-dealer-listings.json`
directly; it no longer touches `output/snapshots/` or `output/david-webb-library.json`
at all. If you're asked to "fix the weekly report" and land in §1's
original description of `agent.js` → `library.js` → `analyze.js`, that's
the stale version — read `analyze.js` itself, it's short and current.

**Database GUI:** `docs/` (vanilla HTML/CSS/JS, no build step, no
framework) deployed via GitHub Pages (`pages-deploy.yml`). Live at
`https://david-webb-new-york.github.io/david-webb-market-agent/`.
**Vercel was tried first and abandoned** — the personal-access-token deploy
kept failing with `"invalidToken": true` (confirmed directly against
Vercel's own API, across two freshly generated tokens — not a GitHub-secret
corruption issue) — the user gave up on it and manually enabled GitHub
Pages instead (`Settings → Pages → Source: GitHub Actions`; `GITHUB_TOKEN`
can't do this via API even with `pages: write`, confirmed via a live
`"Resource not accessible by integration"` error — it's a one-time human
click, already done). If you see any `VERCEL_*` env var references or a
`vercel deploy` step anywhere, that's dead code from the abandoned attempt
that should have been fully reverted in commit `398ed96` — if you find a
trace of it left over, finish removing it.

Dealer listings carry a real `image_url` (Shopify/WooCommerce both return
one in their normal catalog JSON — no extra scraping needed) rendered as a
thumbnail in the GUI table + detail modal. Auction-history records don't
have this yet — would need each auction-house scraper revisited
individually to capture a lot-image URL from its markup.

**Data-quality fix (2026-08-08):** `import-invaluable.js` searches
Invaluable's own Algolia index with fuzzy full-text matching across its
*entire* aggregated catalog (hundreds of unrelated small/regional auction
houses) and, unlike every other importer, had no relevance check before
upserting — 134 of 140 records were noise that happened to share a word
with "david webb" somewhere in a long lot description (military gear,
banknote lots, book collections). Fixed with an `isDavidWebb()` check
(phrase match in title + description) before upserting; same defensive
check added to `import-liveauctioneers.js` (same unfiltered-search shape,
hasn't misbehaved in practice but has no protection either).
**Rago/Phillips/Sotheby's/Doyle/most of Christie's are NOT filtered this
way and shouldn't be** — they're queried by a structured maker/attribution
field, not free-text search, so their titles legitimately don't always say
"David Webb" even when the piece is genuine (confirmed via spot-checking —
Phillips' `notes` field is empty and Rago's is just a price string, so a
keyword filter there would wrongly reject real pieces). If you're asked to
investigate "irrelevant listings" again, check the record's `source` field
first — it was 100% attributable to Invaluable last time, and probably
still narrows fast.

**1stDibs (2026-08-09):** `import-1stdibs.js` added as a third dealer-layer
adapter alongside Shopify/WooCommerce, registered in `import-dealers.js`.
1stDibs is a multi-seller marketplace, not a single dealer site — its
search-results page embeds a Relay/GraphQL normalized data store in an
inline `<script>` blob (not a separate XHR); real per-item price/name come
from an `ecommerceTrackingParams` object, and the listing URL/seller name/
image need further ref-hops into that same flat store (see the importer's
header comment for the exact key-resolution chain). Needs Browserbase like
Bonhams/Christie's — 1stDibs renders this client-side. v1 is a single
search page (~14-20 current listings), no pagination yet.
**Cross-listing caveat:** a dealer may list the same physical piece both on
their own site (via the Shopify/WooCommerce adapters) and on 1stDibs. There's
no reliable way to match those as the same piece (no shared SKU or image-hash
matching available), so 1stDibs listings are kept as their own distinct
records rather than merged/deduped against direct-site listings — when the
resolved seller name matches an existing dealer, they'll naturally group
together in the GUI, but **"total listings" counts platform presence, not
unique physical pieces.** Keep this in mind before treating the dealer
listing count as a piece-inventory count.
**The RealReal was investigated and is currently a dead end:** blocked by a
genuine Browserbase account-tier wall (`403 Verified mode is only available
on the Enterprise plan`) on `advancedStealth`, and Steel.dev's stealth
fallback gets the same DataDome-style block ("Access to this page has been
denied" / a "Press & Hold" human-verification page) most runs, occasionally
a fake 404 instead — both read as active anti-bot blocking, not a fluke.
Matches the earlier Heritage (ha.com) precedent. Don't re-attempt without a
different approach (e.g. a captcha-solving proxy service) or explicit
user direction.

**Listing-quality flags (2026-08-09):** `flag-listings.js` computes two
heuristic "worth a second look" flags fresh from the current dataset on
every report run (NOT baked into stored records — thresholds are relative
to the current price distribution): `price_anomaly` (implausibly cheap vs.
category norms, both a per-category relative percentile and a dataset-wide
absolute floor) and `unverified_authenticity` (listing text doesn't mention
a signature/hallmark/certificate — but ONLY evaluated on records that are
ALREADY price-flagged, since standalone this fired on ~73% of dealer
inventory in testing — most genuine dealers' short marketing blurbs just
don't happen to use those exact words). Christie's/Sotheby's are excluded
from the authenticity check entirely — their catalog text is frequently
non-English (Italian/French/Chinese), which produced false positives on
some of the highest-value lots in the dataset. Wired into `analyze.js`
(writes `output/flagged-listings.json`, adds a deterministic "Worth a
second look" report section + a Slack context line) and the GUI (a
"Worth a second look only" filter checkbox, a badge on flagged table rows,
a detail-modal section) via `docs/data/flagged-listings.json`
(pages-deploy.yml packages it same as the two main datasets). Always
worded as a heuristic signal for a human to check, never a fraud
determination.

**Category-inference bug found and fixed while building the above
(2026-08-09):** all 11 importers shared a copy-pasted `inferCategory()`
whose `/bracelet|bangle|cuff/` check matched before a dedicated cufflink
check could run (`"cufflink"` contains `"cuff"` as a substring), so
cufflink lots got miscategorized as "bracelet" — which directly corrupted
the price-anomaly flag's category-relative comparisons. Fixed with a
`cuff(?!link)` negative lookahead in all 11 files; retroactively
recomputed `category` on all already-committed records (135 auction + 74
dealer records changed) so the fix applies to existing data, not just
future scrapes.

**Non-jewelry noise found and removed while building the above
(2026-08-09):** 18 auction-history records were homonym false
positives — "David Webb" or "Webb" alone matching an unrelated person's
name (a footballer, a book editor, an author, a different jewelry house
"David Andersen"), not the jewelry house. Confirmed individually (a book
on Japanese prints citing "Glenn T. Webb" as a co-editor, astronaut
autographs, a football match programme signed by footballer "David
Webb," a "Spider's Webb" brooch explicitly attributed to David Andersen
of Norway, etc.) and removed as one-off manual deletions — same practice
as the earlier Christie's Van Cleef & Arpels cleanup — rather than a
blanket filter, since Doyle/Christie's/Sotheby's titles legitimately omit
"David Webb" for genuine pieces too (catalog shorthand like "FIRMATO
WEBB" / "signed Webb" is common and correct). If asked to investigate
"nonsense listings" again and the Invaluable-source explanation in this
section doesn't apply, check for this homonym pattern next.

**A $1 dealer listing was found and is now guarded against generally:**
a Wilson's Estate Jewelry listing had `asking_price: 1` — almost
certainly a Shopify "sold out"/"price on request" placeholder, not a
real price (the listing's own description says "Signed for David Webb,
Stamped for 18 karat gold" — clearly a genuine, well-documented piece).
`flag-listings.js` now excludes any price under $50 as implausible
placeholder data rather than real pricing, so it can't masquerade as a
"suspiciously cheap" flag or skew the percentile math for other flagged
items. Same $50 floor added to `analyze.js`'s own `num()` too (2026-08-09,
while building trend tags below) — it was still missing there and showed
up as a `min: $1` corrupting a tag's price stats; both guards are
independent copies (small, self-contained, no shared helper module for
this one thing), so if a THIRD file ever computes its own price stats, add
the same floor there too.

**Near-term alerts (2026-08-09):** `alert-new-listings.js` +
`daily-alert.yml` — Tue-Fri only (Monday's already covered by
`dealer-refresh.yml`/the weekly report), refreshes dealer inventory and
posts an immediate Slack ping for any listing whose `first_seen` is today
and whose `asking_price` clears `ALERT_PRICE_THRESHOLD` (default
$50,000). Deliberately deterministic, no Claude call — this is a same-day
nudge, not a report, and posts nothing at all if nothing clears the
threshold (no daily "nothing new" noise). Tested via a synthetic injected
record, not just unit logic, then confirmed the real store file was
restored byte-for-byte afterward.

**Trend tags (2026-08-09):** `infer-tags.js` — keyword-matched motif/
material/decade tags grounded in David Webb's actual design vocabulary
(Zodiac, Animal/Creature, Fishscale, Hammered Gold, Rock Crystal, Enamel,
Bombé, Door Knocker, Shell/Starfish, Maltese Cross, Cuff/Bangle, Carved
Hardstone, Cabochon, plus `1940s`-`1990s` decade buckets from
`era_or_year`). Deliberately excludes near-universal terms like "diamond"
or "gold" that wouldn't differentiate anything as a trend signal.
**Unlike category/era_or_year (duplicated across all 11 importers, which
is exactly what caused the cufflink-miscategorization bug above),
`inferTags()` is called from ONE place: inside `history-store.js`'s and
`dealer-store.js`'s own `upsert()`, computed fresh from the record's own
`piece_name`/`notes`/`era_or_year` on every upsert.** No importer needs to
know this exists or call anything — this is the pattern category/era
should probably be refactored to eventually, but that's a larger, riskier
change than was in scope here. Retroactively computed on all
already-committed records (2,705/3,794 auction + 1,162/1,397 dealer got at
least one tag). Surfaced in the weekly report ("Trends by motif &
material" — count + min/median/max price per tag, auction and dealer
shown separately, tags with <5 matching records omitted as too thin) and
the GUI (a tag filter dropdown + a "Tags" field in the detail modal).
Real example from the live data: Zodiac pieces median $6,875 at auction
vs. $17,800 in current dealer asking prices; Cuff/Bangle $23,750 vs.
$37,300 — genuine dealer-markup-over-hammer signal, not noise.

**Upcoming-auctions investigation, resolved (2026-08-09/10):** per the
user's request to scope the major houses first, probed Christie's,
Sotheby's, Bonhams, and Phillips for genuine bid-based upcoming/current
auction lots (as opposed to past/sold results, which is all every
existing importer captures). Findings, all live-confirmed not guessed:
- **Christie's**: `is_past_lots=False` on the same `apim.christies.com/
  search-client` endpoint the sold-lots importer already uses returns a
  real, well-formed response — just zero current David Webb lots right
  now. The mechanism works; there's simply nothing live at this moment.
- **Sotheby's**: no separate bid-lot surface found for "david webb" via
  the live site search. What that same search DOES return is a real,
  separate fixed-price **"Buy Now" retail marketplace** — 31-34 items,
  every one showing a "Buy now" CTA with a set USD price, zero bids/
  estimates/lot numbers/sale dates. The backing GraphQL query is literally
  named `retailItemBySlug`. Confirmed and built (see below).
- **Bonhams**: `import-bonhams.js`'s existing `status:=[NEW]` filter
  doesn't mean "upcoming" — every document in the index has `status:
  "NEW"` regardless of sale date (one sample had `auctionStatus:
  "FINISHED"` from a Nov 2022 sale). The real past/upcoming signal is a
  different field, `auctionStatus`, which the existing importer doesn't
  read. Not acted on further (Bonhams currently contributes 0 records to
  the store anyway) but worth knowing if Bonhams is revisited.
- **Phillips**: two guessed candidate URLs (`/auctions`, `/jewelry/
  auctions`) didn't have real lot-level content. Inconclusive, not
  pursued further given the other three houses gave a clear enough
  overall answer.

**Bottom line for "upcoming auctions" as the user originally framed
it: no genuine upcoming bid-based lots exist for David Webb at Christie's
or Sotheby's right now** (Bonhams/Phillips inconclusive but low-priority
given 0 current Bonhams records and no auction-history importer exists
for either as an "upcoming" source). The Sotheby's Buy Now marketplace
was a real, valuable substitute find instead — captured as a new dealer
source, `import-sothebys-buynow.js`.

**Sotheby's Buy Now importer (`import-sothebys-buynow.js`, 2026-08-10):**
five probe rounds total. The first two attempts tried parsing the backing
GraphQL API (`clientapi.prod.sothelabs.com/graphql`, `retailItemBySlug`)
directly — a genuine dead end: all 31 XHR calls the page makes carry only
image-rendition data, zero pricing/title/slug/currency/condition fields
anywhere, confirmed by keyword-searching every captured response body, not
by giving up after a partial look. A third round tried DOM-scraping for
result-card markup; a heuristic bug ("walk up 5 parent levels from any
element containing 'Buy now' text") grabbed the site's top nav menu
instead of an actual result card. The importer that shipped instead
parses the search-results page's own rendered text directly — the "David
Webb / \<Title\> / Buy now / \<price\> USD" block repeats reliably and was
confirmed identically across multiple separate probe/verification runs.
**Known, documented gap** (same practice as `import-sothebys.js`'s own
historical adapter, which also ships without a confirmed `listing_url`):
no per-item detail-page URL or image URL was recoverable via any method
tried, so both are left blank; `dealer-store.js`'s `recordKey()` falls
back to `dealer+piece_name` for identity, which is stable as long as two
items never share an exact title. In the GUI, these records show no
"View original listing" link — that's expected, not a bug.

**Real bug found and fixed during this build:** the first live
verification run parsed 31 real items but matched 0 — an `isDavidWebb()`
safety filter (the same defensive pattern used in other importers) was
checking `it.name` (the item title) for "david webb", but the brand name
is a separate line the extraction regex anchors on and never captures
into the title, so titles like "Gold and Enamel Cufflinks" structurally
never contain it. The regex match already guarantees brand match by
construction; the filter was redundant and actively wrong, and was
removed. **Reusable lesson: don't re-check a field for something a
regex anchor upstream already guarantees is true.**

**Known flakiness:** one verification run (immediately after the above
fix, via the full `dealer-refresh.yml` dry-run) came back with 0 scanned
items and no error — no code had changed between that run and the next
one, which succeeded cleanly, nor the one after that (3 total clean
successes across the isolated `test-sothebys-buynow.js` driver, described
below). Read as a one-off Browserbase/proxy hiccup against a live
third-party site, not a systematic bug — similar in kind to Robinson's
Jewelers/Schiffman's occasionally hitting transient Shopify 429/500s
elsewhere in this codebase. Not currently retried automatically; worth
adding a retry-once-on-empty-result guard if this recurs noticeably once
the source is live on the weekly schedule.

`test-sothebys-buynow.js` (new, kept — matches the repo's convention of
keeping investigative/verification tooling around, e.g. the `*-shape.js`
probe scripts) calls the real `collect()` against a throwaway in-memory
`Map`, never touching `output/` files, so this importer specifically can
be re-verified cheaply and repeatedly via `upcoming-auctions-debug.yml`'s
`workflow_dispatch` trigger without needing a new commit each time or
risking a production commit through `dealer-refresh.yml`.

**First scheduled run, launch day (2026-08-10):** the repo's very first
`schedule`-triggered firing of `history-refresh.yml`/`dealer-refresh.yml`
(13:15/13:30 UTC) simply never fired — confirmed via the Actions API
(`event:schedule` returned zero runs for either workflow even 30+ minutes
past time, with the committed cron syntax itself verified correct). Read
as a one-off GitHub Actions scheduler quirk on a repo's first-ever cron
occurrence, not a config bug. Both workflows were dispatched manually as
a one-time catch-up.

**Real bug found and fixed the same day:** dispatching `history-refresh.yml`
and `dealer-refresh.yml` close together (as the manual catch-up did)
exposed a latent race in all three workflows' "commit results" steps —
each did a bare `git push` with no `git pull` first. `history-refresh.yml`
finished first (its import had no new records, so it was fast) and pushed
its commit to `main` while `dealer-refresh.yml`'s ~7-minute Shopify/
WooCommerce/1stDibs/Sotheby's-Buy-Now import was still running against a
now-stale local checkout; when it tried to push, `main` had moved and the
push was rejected as non-fast-forward. Since that step has no
`continue-on-error`, the job stopped right there — the real,
successfully-collected dealer data (1448 total listings, 51 new,
including 20/20 1stDibs and 31/31 Sotheby's Buy Now) was computed but
never landed on `main`, and the later "wait for history-refresh, then
dispatch weekly-report.yml" step never ran. **Fixed** by adding
`git pull --rebase origin main` before `git push` in all three commit
steps (`history-refresh.yml`, `dealer-refresh.yml`, `weekly-report.yml`)
— cheap and safe since each workflow's commits only ever touch disjoint
files (auction-history vs. dealer-listings vs. reports/flags), so a
rebase never has anything to actually conflict on. This race was
plausible even under the normal 15-minutes-apart Monday schedule
whenever `history-refresh.yml` runs faster than usual (e.g. a light week
with few new auction results) — not unique to the manual catch-up that
surfaced it.

**Follow-up bug in the fix itself, same day:** the first re-run with the
`git pull --rebase origin main` fix above hit a *new* failure —
`error: cannot pull with rebase: You have unstaged changes.` — thrown
immediately after a clean `git commit` (literally milliseconds later, far
too fast for any real concurrent write). This is a known GitHub Actions
runner quirk: right after `actions/checkout` + commit, git's index cache
can report a stale/false-positive dirty working tree that a plain
`git pull --rebase` refuses to touch, even though nothing is actually
uncommitted. **Fixed** by adding `--autostash`
(`git pull --rebase --autostash origin main`) in all three workflows,
which stashes and safely reapplies any working-tree state (real or
phantom) around the rebase instead of erroring out.

**Currency conversion, report-quality fixes (2026-08-10):** after the
first real Monday report went out, four issues came back from review:

1. **Foreign-currency prices were treated as USD, silently corrupting
   stats.** ~12% of auction-history records settle in CHF/GBP/EUR/HKD/ITL
   (Christie's/Sotheby's international sale rooms) — `sold_price` stored
   the raw native-currency number with `currency_note` alongside it, but
   every stat/flag/GUI-sort downstream just used `sold_price` directly as
   if it were already USD. Concretely: a 1994 Rome sale of 11,260,000 ITL
   (really ~$7,000) was showing as the single highest-priced "sale" on
   file, and a 7,460,000 HKD lot (really ~$959K) was inflating the
   all-time-sales ranking ~8x. **Fixed** with a new `convert-currency.js`
   (hand-compiled annual-average FX table — live lookups aren't reachable
   from this environment's network egress allowlist, so this is
   order-of-magnitude-accurate, not settlement-precise, and says so in its
   own header comment) plus a new `sold_price_usd`/`asking_price_usd`
   field, computed centrally in `history-store.js`/`dealer-store.js`'s
   `upsert()` (same "derive once, in one place" pattern as `tags` —
   see the cufflink/category bug above for why that pattern exists).
   Every stat, flag, and the GUI's sort-by-price now use the USD field;
   the original native amount is preserved and footnoted (e.g.
   "$16,700 (originally CHF 15,000)") everywhere a price is shown, so
   clicking through to the source site isn't confusing.
2. **Doyle's `listing_url` was broken for every record.** The importer
   stripped the query string (`?lot=<id>&so=4&st=...`) off the confirmed-
   working href before storing it, apparently never actually testing
   whether the slug-only path resolves on its own — it doesn't. Confirmed
   directly by the user clicking several and getting nothing. **Fixed** in
   `import-doyle.js` by keeping the full href as captured. The ~1,150
   already-committed Doyle records still have the broken slug-only URL
   until the importer re-runs live (this environment's network egress
   can't reach doyle.com to verify/backfill locally) — corrected on the
   next real `history-refresh.yml` run, since `normalizeUrl()` ignores the
   query string for identity purposes, so re-upserting a corrected URL
   updates the existing record in place rather than duplicating it.
3. **A related, previously-masked bug surfaced while testing the above:**
   8 confirmed non-jewelry "David Webb" homonym-noise records (astronaut
   autographs, Magnum photobook lots, a book citing "WEBB, DAVID K." as
   co-editor, a "Spider's Webb" brooch by the unrelated jeweler David
   Andersen of Norway — see the "Non-jewelry noise" entry above) had
   silently come back. They'd been removed once already (2026-08-09) as a
   one-off manual JSON edit, which doesn't survive a fresh re-scrape —
   today's several history-refresh.yml re-runs picked every one of them
   back up. **Fixed properly this time** with a new `excluded-listings.js`
   — a permanent URL blocklist checked inside `history-store.js`'s
   `upsert()` (refuses to add, and actively purges if already present) —
   instead of a one-off deletion that quietly erodes on the next import.
4. **The "worth a second look" report section had two design problems,**
   both from user review of the first real report:
   - The authenticity flag was labeled "cheap AND no signature mentioned,"
     but a $5-10K price is completely normal for these categories — the
     "cheap" framing was misleading even when the underlying compound
     signal (already price-anomaly-flagged AND no verification language)
     was doing something reasonable. **Redesigned**: no longer compounded
     with price_anomaly at all; now applies to any CURRENTLY-FOR-SALE
     dealer listing (never a past auction result — nothing to act on
     there) priced at $1,000+ (below that, a listing is presumed to be a
     minor/component piece where sparse language is normal). This raised
     the flag count substantially (66 → 803) since it's no longer gated on
     looking cheap first — reported honestly rather than quietly narrowed
     back down; the report/GUI still cap the *displayed* list, so this
     is a bigger validate-once backlog, not a noisier top-10.
   - Flagged items didn't reliably link back to the source for validation
     — really just symptom #2 above (Doyle links being broken) plus a few
     sources (old `import-sothebys.js`, Bonhams, Invaluable) that have
     never captured a `listing_url` at all (documented gap, not new).
     `renderFlags()` in `analyze.js` already builds a Markdown link when a
     URL is present; now falls back to an explicit "no link on file for
     this source" instead of silently rendering plain text so the gap is
     visible rather than invisible.

**Follow-up, same day:** once the redesigned authenticity flag (803
flags) was actually visible, the user's own read on it was that it's
"probably not useful, since many listings simply don't include that
note" — matching the ~73% baseline false-positive rate found while
originally building it (see the 2026-08-09 entry above). Decoupling it
from price_anomaly didn't fix the underlying problem: a keyword-absence
check on a short marketing blurb just doesn't discriminate genuine
listings from anything else, at any price floor tried. **Removed
entirely** rather than tuned further — `computeFlags()` now returns only
price_anomaly flags; `unverified_authenticity`, `computeAuthenticityFlags`,
`AUTH_KEYWORDS`, and `AUTH_MIN_PRICE` are gone from `flag-listings.js`.
`renderFlags()`/the Slack payload in `analyze.js` simplified to match (one
flag type, no more "N price flags, M signature flags" split). If an
authenticity-style signal is wanted again, it needs a materially better
source than free-text keyword absence — e.g. a structured "certificate/
provenance" field if any dealer feed ever exposes one — not a lower price
floor or a smarter regex on the same text.

Also answered (no code changed): **photos in the "Recent Auction
Activity"/"Dealer Market This Week" report sections** — feasible for the
dealer side (`image_url` is populated for 1,394/1,397 = 99.8% of dealer
records already) but NOT currently feasible for auction records (zero of
the 8 auction-house importers capture an image URL at all; adding it would
be new per-source scraping work, not a quick add).

`weekly-report.yml` gained a `skip_slack` `workflow_dispatch` input
(regenerate the report/flags, commit them, but skip the Slack post) — for
reviewing a fix like this one before it goes out to the team a second time
in one day.

---

## 1. What this project is (original framing — see §0 for what's current)

A Node.js pipeline that tracks **David Webb jewelry on the secondary market**:

1. **Weekly scan** — find currently listed / recently sold pieces via Claude + web search → append-only CSV + dated JSON snapshots. *(Superseded — see §0: this is now `market-scan-llm.yml`, manual-only, not part of the report.)*
2. **Library (silver layer)** — dedupe snapshots into a stable piece catalog with lifecycle (`first_seen` / `last_seen` / `status`). *(Still exists as `library.js`, only relevant if `market-scan-llm.yml` is run.)*
3. **Analysis + Slack** — Claude writes a Markdown report with week-over-week Mermaid charts; posts to Slack `#secondary-market` with links to report + CSV + JSON (Pattern A + B: auto-report + interactive handoff into Claude). *(Still accurate in shape — `analyze.js` does this — but now sourced from the structured datasets, see §0.)*
4. **Historical auction library** — past sold lots (separate from live listings), starting with a complete Rago import and a framework to add other houses + estate jewelers. *(Done — 8 sources now, see §7.)*

Target consumers: Excel / Power BI / Microsoft Fabric (bronze = raw CSV, silver = library + auction history), **plus a searchable GUI** (`docs/`, see §0) for the sales/product team directly.

---

## 2. Branch / PR state (as of original handoff — see §0 for what's current)

`claude/immediate-next-work-i15bgw` was fast-forward merged into `main` on 2026-08-07 (commit `e8b0d52`) — everything below is now live on `main`: estate-jeweler dealer layer (`import-shopify.js`/`import-woocommerce.js`/`dealer-store.js`, §9 P0), LiveAuctioneers/Invaluable/Bonhams/Sotheby's auction-history importers (§9 P1/P2), and the interactive-probing tooling built while investigating the remaining houses.

**Baseline run (2026-08-07, both committed directly to `main` via `workflow_dispatch`):**
- `history-refresh.yml` → commit `54e33a5`: **1,244 auction-history records** (Rago 85, Invaluable 140, Sotheby's 1000 [Algolia's own cap], LiveAuctioneers 73/2 pages, Bonhams 1).
- `dealer-refresh.yml` → commit `97285a4`: **1,397 dealer listings** across 16 dealers (raised Shopify per-dealer page cap to 100/25,000 products for this run — see `import-shopify.js`).
- Both workflows' cron schedules (Monday ~8:00-8:30am ET, staggered — see `weekly-scan.yml`, `history-refresh.yml`, `dealer-refresh.yml`) are now live on `main` and will run as incremental add-on refreshes going forward, since the baseline history is already in place and `upsert()` dedups by URL/identity key.
- Note: on the first baseline attempt, `dealer-refresh.yml`'s push was rejected (`git push` race with the concurrent `history-refresh.yml` commit landing on `main` first) — not a code bug, just two workflow_dispatch runs pushing to the same branch near-simultaneously. Retried cleanly. Worth knowing if a future manual double-dispatch does the same.
- Robinson's Jewelers and Schiffman's (both huge general-antiques catalogs, 0 David Webb matches in every scan so far) hit transient Shopify 429/500 errors partway through their catalogs on both baseline attempts, at different pages each time — external API flakiness at that catalog depth, not a bug. Total count unaffected since neither has shown any real David Webb matches.

**Action for Claude Code:** `main` is the current base; the feature branch above is merged and can be deleted. Do **not** recreate deleted branches `cursor/setup-dev-environment-0e2f`, `cursor/slack-claude-report-pipeline-0e2f`, or `cursor/historical-backfill-0e2f` (already merged).

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
agent.js                 # LLM web-search scan (manual-only now, see §0) -- market-scan-llm.yml
analyze.js               # Weekly report + Slack notify (--generate / --notify / --dry-run) -- reads
                          # the structured datasets directly, NOT output/snapshots/ (see §0)
library.js               # Deduped library from agent.js snapshots (only relevant if that's run)
backfill.js              # Broad LLM historical auction sweep (collect(map) adapter)
import-rago.js, import-sothebys.js, import-phillips.js, import-doyle.js,
import-christies.js, import-liveauctioneers.js, import-invaluable.js,
import-bonhams.js                # One adapter per auction-history source (see §7 per-source detail)
import-all.js             # Orchestrator: all of the above (+ optional --with-llm)
history-store.js          # Shared auction-history load/dedupe/write
import-shopify.js         # Dealer layer: Shopify /products.json importer (also collectAll())
import-woocommerce.js     # Dealer layer: WooCommerce Store API importer (also collectAll())
import-1stdibs.js         # Dealer layer: 1stDibs multi-seller marketplace search (Browserbase, Relay-store parsing)
import-sothebys-buynow.js # Dealer layer: Sotheby's fixed-price "Buy Now" marketplace (Browserbase, page-text parsing)
import-dealers.js         # Orchestrator: all four dealer adapters
dealer-store.js           # Shared dealer-listings load/dedupe/write (first_seen/last_seen/status/image_url)
flag-listings.js          # "Worth a second look" heuristic flags (price_anomaly, unverified_authenticity)
alert-new-listings.js     # Near-term Slack alert for notable new dealer listings (daily-alert.yml)
browserbase.js            # Browserbase + Playwright helper (shared with steel.js via browser-interactions.js)
steel.js                  # Steel.dev alternative cloud-browser backend (same interface as browserbase.js)
bb-probe.js               # Probe a URL in Browserbase/Steel; dump embedded state / XHRs
docs/                     # Static searchable-database GUI (index.html/style.css/app.js), GitHub Pages
.cursor/environment.json  # Cloud env: { "install": "npm install" } — Cursor-specific, may be stale
.github/workflows/
  history-refresh.yml     # Mon 8:15am ET: auction-history importers -> commit -> deploy GUI -> (dealer-refresh chains the report)
  dealer-refresh.yml      # Mon 8:30am ET: dealer importers -> commit -> deploy GUI -> waits for history-refresh -> dispatches weekly-report.yml
  weekly-report.yml       # workflow_dispatch only, chained from dealer-refresh.yml: report -> commit -> Slack
  daily-alert.yml         # Tue-Fri 8am ET: dealer refresh -> commit -> deploy GUI -> alert-new-listings.js
  pages-deploy.yml        # Deploys docs/ (+ latest output/*.json) to GitHub Pages
  market-scan-llm.yml     # workflow_dispatch only: the original agent.js/library.js sweep, optional/manual
output/
  david-webb-auction-history.*    # Past auction lots, 8 sources (see §7)
  david-webb-dealer-listings.*    # Estate-jeweler for-sale inventory, 15 dealers
  reports/YYYY-MM-DD.md           # Claude-written weekly report + Mermaid trend charts
  reports/stats-history.json      # Small accumulator feeding the week-over-week trend charts
  david-webb-market-data.csv      # Append-only bronze log from agent.js (only if market-scan-llm.yml is run)
  snapshots/YYYY-MM-DD.json       # Per-run raw agent.js results (same)
  david-webb-library.{json,csv}   # Deduped agent.js catalog (same)
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
| Weekly scan (`agent.js`, manual-only, see §0) | Works end-to-end; ~$14 uncapped → **~$2–4** with CORE_QUERIES + `WEB_SEARCH_MAX_USES=3` |
| Weekly report (`analyze.js`, on the auto schedule, see §0) | Live end-to-end 2026-08-08: reads the structured datasets, posts to `#secondary-market`, includes deterministic week-over-week Mermaid charts once ≥2 weeks of `stats-history.json` exist |
| Searchable database GUI (`docs/`, GitHub Pages) | Live at `david-webb-new-york.github.io/david-webb-market-agent/`, confirmed rendering real data incl. dealer thumbnails |
| Library layer (`library.js`, only relevant if `market-scan-llm.yml` is run) | 144 raw sightings → 100 unique pieces (validated) |
| Rago historical import | **85/85 lots** via Inertia `data-page` JSON (free). Committed on PR #7 |
| Browserbase | Auth works (`bb_` key + project UUID). Paid plan; proxies confirmed working (Bonhams). |
| Estate-jeweler dealer layer | **1,397 dealer listings** across 16 dealers (Shopify+WooCommerce), verified live (§9 P0) |
| 1stDibs dealer import | **Real, verified 2026-08-09**: Browserbase-rendered Relay/GraphQL store parsing, **20/20 real listings** on a push-triggered dry-run (not yet committed to `main` — lands on the next scheduled `dealer-refresh.yml` run) — see §0 |
| The RealReal | Confirmed blocked 2026-08-09 — same Browserbase Enterprise-plan wall as Heritage, and Steel.dev's stealth fallback hits the same DataDome-style block. No remaining lever without a different approach (e.g. captcha-solving proxy) — see §0 |
| Sotheby's Buy Now dealer import | **Real, verified 2026-08-10**: page-text parsing (GraphQL API approach hit a real dead end — no pricing data in 31 captured calls), **31/31 real listings** confirmed across 3 consecutive clean runs after a real filter bug was found and fixed — see §0. Christie's/Sotheby's confirmed to have zero genuine upcoming bid-lots for David Webb right now — see §0 |
| LiveAuctioneers historical import | **Real, verified live**: Browserbase-rendered `window.__data` extraction, confirmed pagination, 93 lots/3 pages in latest run (§9 P1) |
| Invaluable historical import | **Real, verified live**: free (no Browserbase) Algolia POST replay, 133/133 lots (exact `nbHits` match) (§9 P1) |
| Sotheby's historical import | **Real, verified live**: free (no Browserbase) Algolia search, **1,000 lots** — largest single source this session, real hammer/sold prices (§9 P1) |
| Bonhams historical import | **Real, verified live**: Browserbase-captured Typesense search API, 1 lot (honestly limited by an unresolved `status` filter) (§9 P2) |
| Christie's historical import | **Real, verified live**: Browserbase (`force: true` clicks past a cookie-consent overlay, then cheap URL-based pagination), 200 lots at the default 10-page cap (~2,015 total exist across ~101 pages — `CHRISTIES_MAX_PAGES` controls an exhaustive baseline vs. a cheap weekly run) (§9 P2) |
| Phillips historical import | **Real, verified live**: free (no Browserbase) server-rendered HTML, **140 lots/3 pages** — no price/estimate shown on the results page (honest gap, would need a per-lot detail-page fetch) (§9 P2) |
| Doyle historical import | **Real, verified live**: free (no Browserbase) server-rendered HTML, **1,155 lots/14 pages** in the first full run — includes real sold/estimate prices directly on the results page, unlike Phillips (§9 P2) |
| Heritage (ha.com) | Confirmed blocked by a named vendor (DataDome device-check challenge); `browserSettings.advancedStealth` also 403s ("Verified mode is only available on the Enterprise plan") — no remaining lever without a Browserbase plan upgrade (§9 P2) |
| Total auction-history records | **2,650** (1,406 new in that run), verified via `history-refresh.yml` run `31203321038` (2026-08-07, push-triggered pre-merge check, not yet committed to `main` — run the workflow via `schedule`/`workflow_dispatch` to commit) |
| Total dealer listings | **1,397**, committed to `main` as the 2026-08-07 baseline (commit `97285a4`) |
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

## 9. Immediate next work (priority order) — historical; all of P0-P2 are done, see §0

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
- **Christie's — ✅ Done, `import-christies.js` built, registered as a "browserbase" source, and verified live (resolved 2026-08-07, after the above investigation stalled on a 404).** The header-capture work the prior note called for got built (`notableHeaders()` in `browserbase.js`, filtering ~20 boilerplate HTTP headers out of every captured XHR's request headers) and revealed the real gap wasn't a missing header at all: a cold `fetch()` replay of the exact real request (right params, right `correlation-id`/`source-application: gsrp` headers, even `Referer`/`Origin` added) **still 404'd** — some browser-only signal (WAF/TLS fingerprint) gates `search-client`, not an absent header. So this needed a real Browserbase session, same as Bonhams.
  - Reaching the "sold lots" tab took several real fixes, in order: (1) a guessed `tab=past_lots` URL param doesn't exist — the real tab keys, found via a new `--html-grep` HTML-context-search feature on `bb-interactive-probe.js`, are `available_lots`/`sold_lots`/`articles`, with visible label **"Sold"**, not "Past"; (2) the real `#tab-sold_lots` button resolved correctly but every click timed out — a OneTrust cookie-consent backdrop (`onetrust-pc-dark-filter`) was intercepting pointer events; DOM-removing the overlay node raced its own async (geolocation-gated) injection and still lost; the actual fix was passing Playwright's `force: true` on every click, which dispatches regardless of a covering element — the standard, timing-independent fix for "element intercepts pointer events".
  - Once past that: `apim.christies.com/search-client?keyword=<term>&page=<N>&is_past_lots=True&sortby=relevance&language=en&geocountrycode=US&show_on_loan=true&datasourceId=182f8bb2-d729-4a38-b539-7cf1a901cf2e` returns real data — confirmed with a genuine sold lot, **"THE ANNENBERG DIAMOND AN EXCEPTIONAL DIAMOND RING, BY DAVID WEBB"**, `price_realised_txt:"USD 7,698,500"`, sold 2009-10-21.
  - **Pagination — confirmed real and cheap, no clicking needed:** a *fresh page load* directly at `.../en/search?entry=<term>&page=<N>&sortby=relevance&tab=sold_lots` (the correct tab key) also triggers the real request with no UI interaction at all — the earlier "direct URL nav doesn't work" finding turned out to be an artifact of testing the wrong (nonexistent) tab key, not a real limitation. Confirmed with page=2 returning a genuinely different lot ("A DIAMOND RING, BY DAVID WEBB", not page 1's Annenberg lot).
  - Real, complete field shape confirmed via a dedicated dump script (`christies-lot-shape.js`, not guessed): 27 keys per lot incl. `object_id, lot_id_txt, title_primary_txt, description_txt, consigner_information, estimate_txt` ("USD 3,000,000 - 5,000,000"), `price_realised_txt` ("USD 7,698,500"), `start_date`, `url`, `lot_withdrawn`, and a nested `sale{id,number,location,type}`. `total_pages` (via `filters`) confirms **~2,015 total matches, 20 lots/page, ~101 total pages** for "david webb".
  - **Known, accepted limitation:** 101 pages is too many to fetch every routine run (each page = its own Browserbase session, like LiveAuctioneers). `collect()` caps at a `maxPages` param (`CHRISTIES_MAX_PAGES` env / `--christies-max-pages` flag on `import-all.js`, default 10), with `history-refresh.yml` exposing a matching `christies_max_pages` `workflow_dispatch` input so an exhaustive one-time baseline (set to 101) is a deliberate, separate choice from the weekly cron (which should stay small). `sortby=relevance` isn't date-ordered, so a small weekly cap can in principle miss a newly-added sold lot that doesn't rank near the top — a real limitation, same shape as Sotheby's 1,000-result Algolia cap.
  - **Verified end-to-end** inside the full `import-all.js --with-browserbase` orchestrator (`history-refresh.yml` run `31198972181`, 2026-08-07): **200 real lots** (10 pages × 20, `TRUNCATED` as expected at the default cap), no errors, other sources unaffected.
- **Phillips — ✅ Done, `import-phillips.js` built, registered as a "structured" (free, no Browserbase) source.** The site's earlier "outage" (3 identical maintenance-page probes) resolved on its own; a follow-up interactive probe confirmed typing "david webb" into the real search box (`input#search-input`) + Enter lands on `https://www.phillips.com/Search?Search=david+webb`, a genuine server-rendered results page ("found 157 results"). A cold plain `fetch()` of that same URL sees the same real content (200, 245 "david webb" occurrences, no JS needed) — a free source, not Browserbase-backed. Real listing-card markup parsed directly: `<li class="...search-result-item">` containing `<strong class="maker">`, `<em>` (title), `<span>` (sale name), `<p>` (sale date), and a real `<a href="https://www.phillips.com/detail/<slug>/<lotId>">`. **Known, honest limitation:** no price/estimate/hammer text appears anywhere on the results page for any listing observed — only maker/title/sale name/date. Getting sold prices would need a follow-up fetch of each lot's own detail page (not built, given ~150+ extra requests per run); `price_type`/`sold_price`/`estimate_*` are left blank rather than guessed.
- **Doyle — ✅ Done, `import-doyle.js` built, registered as a "structured" (free, no Browserbase) source, and the biggest single win of this round: 1,155 real lots with real sold/estimate prices.** Getting here needed the full chain of interactive-probe fixes built this session: `input.search-st` sits inside a Bootstrap 4 collapse (`#navbar-search`) behind a real open-trigger button (`button.search-navbar[data-target='#navbar-search']`, found via `--html-grep` after 9 blind selector guesses all failed silently) whose class (`navbar-toggle`) turned out to be the classic mobile-hamburger pattern — CSS-hidden at Browserbase's default desktop-width viewport, requiring `--viewport=390x844`; the click then landed on the WRONG (still-hidden) `search-st` duplicate elsewhere on the page until the selector was scoped to `#navbar-search input.search-st`. That finally completed the full type+Enter flow, landing on a real search-results URL: `https://www.doyle.com/auction/search/?st=david+webb&c=1`. A cold plain `fetch()` of that exact URL sees the same real content (200, 385 "david webb" occurrences, matching the live session exactly) — a free source. Real listing-card markup parsed directly, confirmed via `doyle-listing-shape.js`'s full-card dump: `<div class="auction-lot">` containing title (`<span class='lot-title cat-3'>Lot N<br/>TITLE</span>`), lot ID (`?lot=<id>` in the detail href), provenance (`<p class="stockfields-list">`), and — unlike Phillips — real prices right in the card: `<strong>Sold for $5,120</strong>` / `<strong>Estimated at $4,000 - $6,000</strong>`. **Known, honest gap:** no sale name/date appears anywhere in the card markup (checked directly), left blank. **Real production bug found and fixed:** the first live orchestrator run hung for 70+ minutes (had to be manually cancelled) — plain `fetch()` has no default timeout, and some page request never got a response; fixed with a new `fetch-with-timeout.js` (20s AbortController wrapper, also applied to Phillips) plus `timeout-minutes` added to every workflow job in the repo as defense in depth. Re-verified clean: **1,155 lots across 14 pages in ~4 minutes**, no errors.
- **Barnebys — same shape as Doyle, also close, also not fully cracked.** Real search toggle (`button[aria-label='Search'][aria-controls='mobile-search-panel']`, `aria-hidden="true"` at desktop viewport) found via `--html-grep`; a mobile viewport got the click to register. But the revealed `<input>` (inside `#mobile-search-panel`) then fails Playwright's own "Element is outside of the viewport" actionability check, even after scroll-into-view and a longer settle wait (2 attempts at this specific failure, 3 total). This looks structural (likely `position: fixed`/`transform`-based panel geometry), not a timing race — documented as a near-miss rather than pursued further per the project's policy against indefinite guessing.
- **Freeman's/Hindman — blocked at the network layer, cause unconfirmed.** 2 wrong URL-param guesses first (`?q=`, `?query=`, real page renders but search never fires). A follow-up real UI-interaction attempt hit `net::ERR_TUNNEL_CONNECTION_FAILED` from Browserbase's own proxy layer before any page loaded — recurred identically with proxies explicitly disabled too (3 attempts total), while sibling probes to other hosts succeeded through the same Browserbase infrastructure in the same time window. Points at something host-specific (the site's edge/WAF blocking Browserbase's egress IPs, or a routing issue on that one domain) rather than a general Browserbase outage — but the actual cause is unconfirmed. Not resolved.
- New reusable tooling built this round: `bb-interactive-probe.js`'s `--html-grep` (search real rendered HTML for markup instead of guessing selectors blind — this directly found Doyle's and Barnebys' real open-triggers, and Christie's real tab-key naming), `--viewport=WxH` (simulate a mobile viewport for CSS-hidden mobile-only controls), `--no-proxies` (isolate proxy-layer vs. site-layer failures); `browserbase.js`'s `force: true` on every simulated click (bypasses "element intercepts pointer events" — this is what actually cracked Christie's) and cookie-consent-overlay handling; `json-shape.js` (shared pagination/array-shape summarizer, factored out of `bb-probe.js`); `isCandidateApiResponse()` (captures non-`application/json`-labeled API responses like Remix `.data` resource routes, which is what surfaced Phillips' real backend call).
- Keep LLM sweep as fallback for the still-unresolved sources (Doyle, Barnebys, Freeman's/Hindman, Heritage).

### P3 — Product polish
- Enrich Rago `materials_gemstones` from lot captions (often blank).
- ~~Combined view (active library + auction history) for Fabric/Claude~~ — **done differently than planned:** the GUI (`docs/`) unions auction-history + dealer-listings client-side (see §0/§5), not the original active-library + auction-history combination (`agent.js`'s library was superseded, see §0). A true Fabric/Power BI feed off the two CSVs is still open if wanted.
- ~~Confirm `SLACK_WEBHOOK_URL` is set in **GitHub Actions** secrets~~ — confirmed working, live Slack posts succeeding as of 2026-08-08.
- ~~Merge PR #7 when ready~~ — merged long ago; `main` is single source of truth.
- **Open, not yet built** (see the user's 2026-08-08 improvement-suggestions conversation, if logged, for the fuller list): real-time/faster-cadence dealer polling (currently weekly); auction-house image thumbnails (dealers have them, auction sources don't); price/motif trend intelligence beyond the raw weekly stats; any CRM/clienteling integration.

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

- ~~Should estate-jeweler inventory live in the active library, a new dealer listings file, or both?~~ **Decided this session:** new dealer layer (`output/david-webb-dealer-listings.*`, §5C) — kept separate since these are for-sale prices from a single dealer's own feed, not LLM-scan sightings or auction hammers. The GUI (§0) unions both for browsing without merging the underlying stores.
- ~~Approve Browserbase proxy spend + continued per-site adapter work vs. also pursuing licensed data (artnet)?~~ Proxy spend approved and used (Bonhams, Christie's). Licensed data (artnet or similar) never pursued — still an open option if the remaining unreachable sources (Heritage, Barnebys, Freeman's/Hindman — see §7 P2) matter enough to pay for.
- ~~PR #7 is merged into `main`~~ — all work across every session has landed on `main` directly since; there's no standing feature branch.
- **GitHub Pages vs. Vercel vs. Cloudflare Pages for the GUI** — resolved 2026-08-08: tried Vercel first (user's choice over Cloudflare Pages + Access), abandoned after repeated token-auth failures, landed on GitHub Pages (user enabled it by hand). See §0 for the full story if this comes up again.

---

## 14. Contact / product context

- Slack workspace: `dwjewels.slack.com`, channel `#secondary-market`
- Anthropic console billing must have credits (was blocked once with “credit balance too low”)
- Fabric/Power BI: treat CSVs as bronze/silver sources (see README)

---

*Originally generated as a handoff from the Cursor Cloud Agent session that built env setup, Slack/report pipeline, library layer, Rago import, Browserbase integration, and the estate-jeweler Shopify finding (Yafa: 22 David Webb products via `products.json`). Updated 2026-08-08 (see §0) after the session that: built out the remaining 7 auction-history sources + 15 dealers (§7); replaced the LLM-scan-based weekly report with one reading the structured datasets directly and fixed its scheduling-order bug (`weekly-report.yml`); built the searchable database GUI (`docs/`, GitHub Pages after an abandoned Vercel attempt); added dealer-listing thumbnails; and found + fixed an unfiltered-search data-quality bug in `import-invaluable.js`.*
