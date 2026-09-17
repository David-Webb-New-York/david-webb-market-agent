#!/usr/bin/env node
/**
 * Applies one editor submission (see editor/api/submit-edit.js) to the
 * matching record, through the same upsert()/writeStore() path every
 * scheduled scrape uses -- the three-way merge in field-merge.js applies
 * automatically, so a genuine conflict (the source changed this exact
 * field independently) still gets flagged instead of silently overwritten.
 *
 * Triggered by process-edit-submission.yml on a labeled issue. Reads the
 * issue body (plain "key: value" lines, written by submit-edit.js) from
 * ISSUE_BODY, finds the record by id, applies whichever of listing_url /
 * history_notes were submitted, writes the store, and reports back via
 * ISSUE_NUMBER + GITHUB_TOKEN (the Action's own token -- Contents+Issues
 * write within this repo -- not the narrower Vercel-side PAT).
 */

const historyStore = require("./history-store");
const dealerStore = require("./dealer-store");

function parseIssueBody(body) {
  const fields = {};
  for (const line of String(body || "").split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

async function commentAndClose(issueNumber, body, close) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo", auto-set in Actions
  if (!token || !repo || !issueNumber) return;
  const base = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;
  await fetch(`${base}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (close) {
    await fetch(base, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });
  }
}

async function main() {
  const issueNumber = process.env.ISSUE_NUMBER;
  const fields = parseIssueBody(process.env.ISSUE_BODY);
  const { record_type, record_id, listing_url, history_notes, submitted_by } = fields;

  if (!record_type || !record_id) {
    console.error("Missing record_type or record_id in issue body.");
    await commentAndClose(issueNumber, "Could not process: missing `record_type` or `record_id`. No changes made.", false);
    process.exit(1);
  }
  if (!listing_url && !history_notes) {
    console.error("Nothing to apply.");
    await commentAndClose(issueNumber, "Could not process: no `listing_url` or `history_notes` present. No changes made.", false);
    process.exit(1);
  }

  const store = record_type === "dealer" ? dealerStore : historyStore;
  const map = store.loadStore();
  const rec = map.get(record_id);
  if (!rec) {
    console.error(`No record found with id: ${record_id}`);
    await commentAndClose(
      issueNumber,
      `Could not find a record with id \`${record_id}\` in ${record_type === "dealer" ? "dealer-listings" : "auction-history"}. No changes made -- the id may be stale if the record's identity changed since the edit link was created.`,
      false
    );
    process.exit(1);
  }

  const update = { ...rec };
  if (listing_url) update.listing_url = listing_url;
  if (history_notes) update.history_notes = history_notes;

  store.upsert(map, update, { source: `editor:${submitted_by || "unknown"}` });
  store.writeStore(map);
  console.log(`Applied edit to ${record_id} from ${submitted_by || "unknown"}.`);

  await commentAndClose(
    issueNumber,
    `Applied — updated \`${record_type}\` record \`${record_id}\`${listing_url ? " (listing_url)" : ""}${history_notes ? " (history_notes)" : ""}. It'll be live on the site within a few minutes.`,
    true
  );
}

main().catch(async (err) => {
  console.error("Fatal:", err.message || err);
  await commentAndClose(process.env.ISSUE_NUMBER, `Failed to process this submission: ${err.message || err}`, false);
  process.exit(1);
});
