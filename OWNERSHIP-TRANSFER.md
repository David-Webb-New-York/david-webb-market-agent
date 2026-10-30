# Ownership Transfer: David Webb Market Agent

**From:** James Weiss
**To:** Max Medina and Aymun Imran — both getting full technical leadership
access, not just one primary owner.

This is the practical checklist for moving this system off James's personal
accounts and onto something Max and Aymun both actually control. See
`README.md` for what the system does and `HANDOFF.md` for build history —
this doc is just the handoff mechanics.

---

## Already in good shape — no action needed

- **GitHub repo access.** `aymunDW` already has Admin access. James's
  org-linked identity (`jamesweiss-dw`) is also Admin. **Max still needs to
  be added** — get his GitHub username and add him under Settings →
  Collaborators and teams → Admin role.
- **GitHub Pages / Actions / the database GUI itself.** All of it lives
  inside the repo — no separate hosting account. Admin repo access already
  covers this fully.
- **Twilio / SMS alerts.** The code (`sms.js`) exists and was built and
  tested, but `SMS_RECIPIENT_PHONE` and the Twilio secrets were never added
  to this repo's GitHub Actions secrets — the feature has never actually
  fired in production. There is no live account or credential to transfer.
  If the team wants to turn this on later, that's a fresh setup (new Twilio
  account, new A2P 10DLC campaign registration), not a handoff of anything
  existing.

## Needs action: accounts currently under James's personal ownership

### 1. Vercel (hosts the "Suggest an edit" page)

Lives under James's personal Vercel account (a Hobby/personal namespace,
not a Team) at `david-webb-market-agent-editor.vercel.app`. A personal
Vercel account can't have multiple members, so Max/Aymun can't get real
access to it as-is.

**Steps:**
1. Create a (free) Vercel Team.
2. Transfer the `david-webb-market-agent-editor` project into that Team.
3. Invite Max and Aymun as Team members.
4. After the transfer, confirm Settings → Build and Deployment → Root
   Directory is still set to `editor` and that all env vars (below)
   carried over — they should, but verify with a test deploy.

### 2. The GitHub token the editor uses to file edits

`editor/api/submit-edit.js` holds a `GITHUB_TOKEN` env var in Vercel — a
GitHub fine-grained Personal Access Token, scoped to `Issues: write` on
just this one repo, generated under James's personal GitHub account. It
will stop working if his account access to the repo is ever revoked, and
neither Max nor Aymun can see or rotate it today.

**Steps:**
1. Max or Aymun generates their own fine-grained PAT: GitHub → Settings →
   Developer settings → Fine-grained tokens → scope to
   `David-Webb-New-York/david-webb-market-agent` only, `Issues: write`
   permission only (nothing else).
2. Swap it into the Vercel project's `GITHUB_TOKEN` env var, redeploy.
3. Test with one real "Suggest an edit" submission before removing James's
   old token.

### 3. Google Cloud OAuth client

Powers the "Sign in with Google" gate on the editor (restricted to
`@davidwebb.com` accounts via the `hd` claim). Client ID
`180509401519-3mc56t8j2vfi0lug8knui318n7tbdv5s.apps.googleusercontent.com`
lives in a Google Cloud project under James's Google account.

**Steps:**
1. Confirm which Google account owns the GCP project (James's personal
   Google account, set up during initial build).
2. Add Max and Aymun as Owners under IAM & Admin → IAM → Grant Access, so
   they can manage the OAuth consent screen and authorized origins without
   depending on James.

### 4. Anthropic API key

Used by `analyze.js` to write the weekly Slack/report narrative. Currently
a key under James's personal Anthropic account, stored as the
`ANTHROPIC_API_KEY` GitHub Actions secret.

**Steps:**
1. Issue a new key from an account the team controls (ideally a shared or
   org Anthropic account, not another individual's personal one).
2. Update the `ANTHROPIC_API_KEY` repo secret (Settings → Secrets and
   variables → Actions).
3. Confirm the next `weekly-report.yml` run succeeds before revoking
   James's old key.

### 5. Browserbase account

Paid account (~$20/mo) used for JS-rendered sources (1stDibs, Sotheby's Buy
Now, LiveAuctioneers/Christie's/Bonhams). Currently under James's personal
Browserbase account, stored as `BROWSERBASE_API_KEY` /
`BROWSERBASE_PROJECT_ID`.

**Steps:**
1. Either invite Max/Aymun to James's existing Browserbase account (if the
   plan supports multiple members), or create a new team-owned account.
2. Update both GitHub Actions secrets if the account changes.
3. Confirm the next `history-refresh.yml` / `dealer-refresh.yml` run
   succeeds.

### 6. Slack webhook

`SLACK_WEBHOOK_URL` posts to `#secondary-market` in `dwjewels.slack.com`.
Incoming webhooks are normally workspace/channel-level, not tied to an
individual's account, so this likely needs no action — but worth
confirming with a Slack admin that it wasn't created under a personal App
install tied to James specifically.

---

## Suggested order of operations (avoid downtime)

1. Add Max as a GitHub collaborator (Admin) — quick, no risk.
2. Create the Vercel Team, invite Max + Aymun, transfer the project in.
3. Generate a new fine-grained GitHub PAT under Max's or Aymun's account,
   swap into Vercel's `GITHUB_TOKEN`, redeploy, verify with a real test
   submission.
4. Add Max + Aymun as Owners on the Google Cloud project.
5. Re-issue the Anthropic and Browserbase credentials under
   team-controlled accounts, update the two GitHub Actions secrets,
   confirm the next scheduled run of each succeeds.
6. Once everything above is verified working on the new credentials,
   James's personal tokens/keys/accounts can be safely revoked or removed.

## Open questions for Max / Aymun / James to settle together

- Single shared Anthropic/Browserbase account for this project going
  forward, or per-person keys?
- Does James stay on as a fallback contact once the above is done, or step
  away from technical ownership entirely?
