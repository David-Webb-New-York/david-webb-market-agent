#!/usr/bin/env node
/**
 * Round 3: round 2 confirmed the real per-item data (14 genuine items via
 * ecommerceTrackingParams, price+name+id all correct) and found each item's
 * full record is keyed in the flat Relay store literally as
 * base64("Item:<serviceId>") -- e.g. "SXRlbTpqXzE5NTQ5Mjky" decodes to
 * "Item:j_19549292". That record has `localizedPdpUrl` (real listing path),
 * a `seller` ref, and a `photos(limit:1)` ref -- both refs are themselves
 * base64-encoded keys into the same flat store. This round resolves those
 * refs to get a human-readable seller/gallery name and a real image URL.
 */
const bb = require("./browserbase");

function extractBalancedObjects(text, keyPrefix, max = Infinity) {
  const results = [];
  const marker = `"${keyPrefix}":`;
  let searchFrom = 0;
  while (results.length < max) {
    const markerIdx = text.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;
    const braceStart = text.indexOf("{", markerIdx);
    if (braceStart === -1) break;
    let depth = 0;
    let i = braceStart;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0) results.push(text.slice(braceStart, i + 1));
    searchFrom = markerIdx + marker.length;
  }
  return results;
}

function resolveRecord(blob, key) {
  const matches = extractBalancedObjects(blob, key, 1);
  if (!matches.length) return null;
  try {
    return JSON.parse(matches[0]);
  } catch (_) {
    return null;
  }
}

async function main() {
  const url = process.argv[2] || "https://www.1stdibs.com/search/jewelry/?oq=david%20webb&q=david%20webb&st=classified";
  const result = await bb.withPage(
    async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(8000);
      const data = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        const blobs = scripts.map((s) => s.textContent || "").filter((t) => t.length > 2000);
        return { blobs };
      });
      return data;
    },
    { sessionOpts: { proxies: true } }
  );

  const blob = result.blobs.sort((a, b) => b.length - a.length)[0] || "";
  console.log("largest blob:", blob.length, "bytes");

  const rawItems = extractBalancedObjects(blob, "ecommerceTrackingParams")
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    })
    .filter((it) => it && it.id && it.price);
  console.log(`\nFound ${rawItems.length} real item(s) (schema/query-text false matches filtered out):\n`);

  const NAME_FIELDS = ["name", "displayName", "businessName", "storeName", "sellerName", "title", "sellerBusinessName"];
  const IMAGE_FIELDS = ["masterOrZoomPath", "smallPath", "path", "url", "image", "src", "imageUrl", "imagePath"];
  const IMAGE_CDN_BASE = "https://a.1stdibscdn.com";

  for (const it of rawItems) {
    const itemKey = Buffer.from(`Item:${it.id}`).toString("base64");
    const itemRecord = resolveRecord(blob, itemKey);
    if (!itemRecord) {
      console.log(` - id=${it.id} price=${it.price} name=${JSON.stringify(it.name)} | ITEM RECORD NOT FOUND (key=${itemKey})`);
      continue;
    }

    const pdpUrl = itemRecord.localizedPdpUrl || null;

    let sellerName = null;
    const sellerRef = itemRecord.seller && itemRecord.seller.__ref;
    if (sellerRef) {
      const sellerRecord = resolveRecord(blob, sellerRef);
      if (sellerRecord) {
        for (const f of NAME_FIELDS) {
          if (typeof sellerRecord[f] === "string" && sellerRecord[f]) {
            sellerName = sellerRecord[f];
            break;
          }
        }
        // No direct name field -- sellerProfile nests it one level deeper,
        // either as an inline object or another __ref to resolve.
        if (!sellerName && sellerRecord.sellerProfile) {
          const profile = sellerRecord.sellerProfile.__ref
            ? resolveRecord(blob, sellerRecord.sellerProfile.__ref)
            : sellerRecord.sellerProfile;
          if (profile) {
            for (const f of NAME_FIELDS) {
              if (typeof profile[f] === "string" && profile[f]) {
                sellerName = profile[f];
                break;
              }
            }
            // sellerProfile.company is itself another nested object/ref --
            // one more hop.
            if (!sellerName && profile.company) {
              const company = profile.company.__ref ? resolveRecord(blob, profile.company.__ref) : profile.company;
              if (company) {
                for (const f of NAME_FIELDS) {
                  if (typeof company[f] === "string" && company[f]) {
                    sellerName = company[f];
                    break;
                  }
                }
                if (!sellerName) console.log(`   [company keys for ${sellerRef}]: ${Object.keys(company).join(", ")}`);
              }
            }
            if (!sellerName) console.log(`   [sellerProfile keys for ${sellerRef}]: ${Object.keys(profile).join(", ")}`);
          }
        }
        if (!sellerName) console.log(`   [seller record keys for ${sellerRef}]: ${Object.keys(sellerRecord).join(", ")}`);
      }
    }

    let imageUrl = null;
    const photosField = Object.keys(itemRecord).find((k) => k.startsWith("photos("));
    const photoRef = photosField && itemRecord[photosField] && itemRecord[photosField].__refs && itemRecord[photosField].__refs[0];
    if (photoRef) {
      const photoRecord = resolveRecord(blob, photoRef);
      if (photoRecord) {
        for (const f of IMAGE_FIELDS) {
          if (typeof photoRecord[f] === "string" && photoRecord[f]) {
            imageUrl = photoRecord[f].startsWith("http") ? photoRecord[f] : `${IMAGE_CDN_BASE}${photoRecord[f]}`;
            break;
          }
        }
        if (!imageUrl) console.log(`   [photo record keys for ${photoRef}]: ${Object.keys(photoRecord).join(", ")}`);
      }
    }

    console.log(
      ` - id=${it.id} price=${it.price} name=${JSON.stringify(it.name)}\n` +
        `   pdpUrl=${pdpUrl}\n` +
        `   sellerName=${JSON.stringify(sellerName)} (ref=${sellerRef})\n` +
        `   imageUrl=${JSON.stringify(imageUrl)} (ref=${photoRef})`
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
