#!/usr/bin/env node
/**
 * scripts/bench/browser-prove.mjs — measures transfer.circom Groth16 proving
 * latency inside a real headless Chromium tab (snarkjs.min.js UMD build,
 * same wasm/zkey artifacts as the Node benchmark), to compare against
 * scripts/bench/prove-latency.mjs (Node/CLI proving).
 *
 * Serves scripts/bench/browser-harness/ over local HTTP (fetch() needs a
 * server, not file://) and drives it with Playwright + the pre-installed
 * Chromium at /opt/pw-browsers/chromium.
 *
 * Usage: node scripts/bench/browser-prove.mjs
 */
import { chromium } from "playwright";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(__dirname, "browser-harness");
// snarkjs.min.js is not vendored into the repo — served straight from the
// installed dependency so there's one copy to keep in sync, not two.
const SNARKJS_MIN_JS = join(__dirname, "..", "node_modules", "snarkjs", "build", "snarkjs.min.js");
const PORT = 8934;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".zkey": "application/octet-stream" };

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const path = req.url === "/" ? "/index.html" : req.url;
        const filePath = path === "/snarkjs.min.js" ? SNARKJS_MIN_JS : join(HARNESS_DIR, path);
        const data = await readFile(filePath);
        res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const executablePath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--no-sandbox"] });
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("[page]", msg.text()));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__BENCH_RESULT__ || window.__BENCH_ERROR__, { timeout: 120000 });
  const error = await page.evaluate(() => window.__BENCH_ERROR__);
  if (error) {
    console.error("Browser bench FAILED:", error);
    await browser.close();
    server.close();
    process.exit(1);
  }
  const result = await page.evaluate(() => window.__BENCH_RESULT__);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
