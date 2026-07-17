#!/usr/bin/env node
// Serves circuits/build/ + the local snarkjs browser bundle statically and drives a
// page with headless Chromium (Playwright) to measure real in-browser WASM Groth16
// proving time for transfer.circom — the same witness computed by groth16-bench.mjs,
// via witness-inputs.mjs, so the Node and browser numbers are directly comparable.
//
// Usage: node scripts/bench/browser-harness/serve-and-bench.mjs
// Requires: circuits/build/ populated (circuits/scripts/compile.sh), scripts/node_modules
// installed (cd scripts && bun install).

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { buildPoseidon } from "circomlibjs";
import { buildTransferInput } from "../witness-inputs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const BUILD = join(CIRCUITS, "build");

const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".wasm": "application/wasm" };

const ROUTES = {
  "/": join(__dirname, "index.html"),
  "/index.html": join(__dirname, "index.html"),
  "/snarkjs.min.js": join(CIRCUITS, "node_modules", "snarkjs", "build", "snarkjs.min.js"),
  "/transfer.wasm": join(BUILD, "transfer_js", "transfer.wasm"),
  "/transfer_final.zkey": join(BUILD, "transfer_final.zkey"),
  "/transfer_vk.json": join(BUILD, "transfer_vk.json"),
};

for (const [route, path] of Object.entries(ROUTES)) {
  if (!existsSync(path)) {
    console.error(`missing required file for route ${route}: ${path}`);
    console.error("run circuits/scripts/compile.sh first (produces circuits/build/*)");
    process.exit(1);
  }
}

const poseidonInstance = await buildPoseidon();
const transferInput = buildTransferInput(poseidonInstance.F, (arr) => poseidonInstance(arr));

const server = createServer((req, res) => {
  if (req.url === "/transfer_bench_input.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(transferInput));
    return;
  }
  const file = ROUTES[req.url];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
console.log(`serving on http://127.0.0.1:${port}`);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.error("[pageerror]", err));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__benchResult || window.__benchError, undefined, { timeout: 180_000 });

const result = await page.evaluate(() => window.__benchResult || { error: window.__benchError });
console.log("\n=== browser bench result ===");
console.log(JSON.stringify(result, null, 2));

await browser.close();
server.close();
process.exit(result.error ? 1 : 0);
