// Drives scripts/bench/browser-harness/index.html in real headless Chromium (not Node) via
// Playwright, to measure Groth16 fullProve latency under an actual browser WASM/JS engine —
// the same code path the frontend's useProofGeneration.ts hook uses client-side.
//
// Usage: (from repo root) node scripts/bench/run-browser-bench.mjs
// Requires a static file server rooted at the repo root serving /circuits/build/* and
// /scripts/bench/browser-harness/* (e.g. `npx http-server -p 8977 .` from repo root).
import { chromium } from "playwright";

const BASE_URL = process.env.BENCH_BASE_URL ?? "http://127.0.0.1:8977";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.error("[pageerror]", err));

await page.goto(`${BASE_URL}/scripts/bench/browser-harness/index.html`);
await page.waitForFunction(() => document.title === "DONE" || document.title === "ERROR", { timeout: 120_000 });

const title = await page.title();
if (title === "ERROR") {
  const err = await page.evaluate(() => window.__ERROR);
  console.error("Browser bench failed:", err);
  await browser.close();
  process.exit(1);
}

const results = await page.evaluate(() => window.__RESULTS);
console.log(JSON.stringify(results, null, 2));
await browser.close();
