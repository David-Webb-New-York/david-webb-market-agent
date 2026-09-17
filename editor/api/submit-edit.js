/**
 * Vercel serverless function: receives a curated-edit submission from
 * editor/index.html, verifies the signed-in Google account belongs to the
 * allowed Workspace domain, and opens a labeled GitHub issue with the
 * submission. A GitHub Action (process-edit-submission.yml) does the
 * actual data write, using the same upsert()/history-store.js /
 * dealer-store.js path as every scheduled scrape -- this function never
 * touches the repo's data directly, and holds a token scoped to
 * Issues:write only (see ENV below), never Contents.
 *
 * ENV (set in Vercel project settings, never committed):
 *   GOOGLE_CLIENT_ID   the OAuth client id from Google Cloud Console --
 *                      must match the one embedded in index.html
 *   ALLOWED_DOMAIN     Workspace domain allowed to submit (davidwebb.com)
 *   GITHUB_TOKEN       fine-grained PAT, Issues:write only, scoped to
 *                      just this one repo
 *   GITHUB_OWNER       David-Webb-New-York
 *   GITHUB_REPO        david-webb-market-agent
 */

const { OAuth2Client } = require("google-auth-library");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "davidwebb.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "David-Webb-New-York";
const GITHUB_REPO = process.env.GITHUB_REPO || "david-webb-market-agent";

const client = new OAuth2Client(CLIENT_ID);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { idToken, recordType, recordId, pieceName, listingUrl, historyNotes, clearListingUrl, clearHistoryNotes } = req.body || {};

    if (!idToken || !recordType || !recordId) {
      res.status(400).json({ error: "Missing idToken, recordType, or recordId" });
      return;
    }
    if (recordType !== "auction" && recordType !== "dealer") {
      res.status(400).json({ error: "recordType must be 'auction' or 'dealer'" });
      return;
    }
    if (!listingUrl && !historyNotes && !clearListingUrl && !clearHistoryNotes) {
      res.status(400).json({ error: "Nothing to submit" });
      return;
    }

    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: CLIENT_ID });
      payload = ticket.getPayload();
    } catch (_) {
      res.status(401).json({ error: "Invalid sign-in" });
      return;
    }
    if (!payload || !payload.email_verified || payload.hd !== ALLOWED_DOMAIN) {
      res.status(403).json({ error: `Not authorized -- must sign in with a ${ALLOWED_DOMAIN} account` });
      return;
    }
    const submittedBy = payload.email;

    if (!GITHUB_TOKEN) {
      res.status(500).json({ error: "Server misconfigured: GITHUB_TOKEN not set" });
      return;
    }

    const bodyLines = [
      `record_type: ${recordType}`,
      `record_id: ${recordId}`,
      listingUrl ? `listing_url: ${listingUrl}` : null,
      historyNotes ? `history_notes: ${historyNotes}` : null,
      clearListingUrl ? `clear_listing_url: true` : null,
      clearHistoryNotes ? `clear_history_notes: true` : null,
      `submitted_by: ${submittedBy}`,
    ].filter(Boolean);

    const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `[editor] ${recordType}: ${pieceName || recordId}`,
        body: bodyLines.join("\n"),
        labels: ["editor-submission"],
      }),
    });

    if (!ghRes.ok) {
      const detail = await ghRes.text();
      res.status(502).json({ error: "Failed to submit to GitHub", detail });
      return;
    }

    const issue = await ghRes.json();
    res.status(200).json({ ok: true, issueUrl: issue.html_url });
  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
