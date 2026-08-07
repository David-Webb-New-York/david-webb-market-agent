#!/usr/bin/env node
/**
 * One-off diagnostic: steel.js's first live test failed with a generic
 * "render failed: Connection error." on two different target URLs within
 * ~1.3s of dispatch -- too fast and too generic to tell whether it's
 * session creation (client.sessions.create()) or the CDP websocket connect
 * (chromium.connectOverCDP) that's actually throwing, or why. This isolates
 * each step and prints full error detail (message, cause, status, stack)
 * instead of letting the error get swallowed into one generic string.
 */
const { chromium } = require("playwright-core");

async function main() {
  const API_KEY = process.env.STEEL_API_KEY;
  console.log("STEEL_API_KEY present:", !!API_KEY, "| length:", API_KEY ? API_KEY.length : 0);

  let Steel;
  try {
    Steel = require("steel-sdk");
  } catch (e) {
    console.error("FATAL: require('steel-sdk') failed:", e.message);
    process.exit(1);
  }
  console.log("typeof Steel (default export):", typeof Steel);
  console.log("typeof Steel.Steel (named export, if any):", typeof Steel.Steel);
  console.log("Object.keys(Steel):", Object.keys(Steel).slice(0, 20));

  const SteelCtor = typeof Steel === "function" ? Steel : Steel.Steel || Steel.default;
  console.log("Using constructor:", SteelCtor === Steel ? "default (module itself)" : SteelCtor === Steel.Steel ? "Steel.Steel (named)" : "Steel.default");

  let client;
  try {
    client = new SteelCtor({ steelAPIKey: API_KEY });
    console.log("Client constructed OK.");
  } catch (e) {
    console.error("FATAL: new Steel(...) failed:", e.message, "\nstack:", e.stack);
    process.exit(1);
  }

  console.log("\n--- Attempting client.sessions.create() ---");
  let session;
  try {
    session = await client.sessions.create({});
    console.log("Session created OK. id:", session.id, "| full object keys:", Object.keys(session));
  } catch (e) {
    console.error("FATAL at sessions.create():");
    console.error("  message:", e.message);
    console.error("  name:", e.name);
    console.error("  status:", e.status);
    console.error("  cause:", e.cause ? (e.cause.message || JSON.stringify(e.cause)) : undefined);
    console.error("  stack:", e.stack);
    try {
      console.error("  full JSON:", JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 2000));
    } catch (_) {}
    process.exit(1);
  }

  console.log("\n--- Attempting chromium.connectOverCDP() ---");
  const cdpUrl = `wss://connect.steel.dev?apiKey=${API_KEY}&sessionId=${session.id}`;
  console.log("CDP URL (key redacted):", cdpUrl.replace(API_KEY, "***"));
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
    console.log("CDP connected OK.");
  } catch (e) {
    console.error("FATAL at connectOverCDP():");
    console.error("  message:", e.message);
    console.error("  stack:", e.stack);
    await client.sessions.release(session.id).catch(() => {});
    process.exit(1);
  }

  console.log("\n--- Attempting a real page load (example.com) ---");
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    const title = await page.title();
    console.log("Page loaded OK. title:", title);
  } catch (e) {
    console.error("FATAL at page.goto():", e.message);
  } finally {
    await browser.close().catch(() => {});
    await client.sessions.release(session.id).catch(() => {});
  }

  console.log("\nAll steps succeeded.");
}

main().catch((e) => {
  console.error("UNCAUGHT:", e.message, "\n", e.stack);
  process.exit(1);
});
