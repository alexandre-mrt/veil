#!/usr/bin/env node
/**
 * browser-proving-bench.mjs — measures Groth16 proving latency for
 * transfer.circom inside a real browser engine (headless Chromium via
 * Playwright), as opposed to Node's V8. Run 0 is cold (fresh page load,
 * wasm/zkey fetched over local HTTP); runs 1-2 are warm (same page).
 *
 * This is a DESKTOP headless-Chromium measurement on this machine's CPU, not
 * a mobile device — see docs/research/2026-07-14-baseline.md for why mobile
 * proving latency is marked UNMEASURED.
 *
 * Auto-stages its own prerequisites into www/ (snarkjs's browser bundle from
 * circuits/node_modules, the compiled circuit from circuits/build/, and a
 * generated witness.json) — none of this is committed (see .gitignore /
 * git-ignored www/*.wasm etc.); see circuit-baseline.mjs's header for how to
 * produce circuits/build/ if it doesn't exist yet.
 *
 * Run: node scripts/bench/browser-proving-bench.mjs
 */
import { createServer } from "http";
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import { loadCircuitsDeps, buildTransferWitness } from "./witness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");
const WWW_DIR = join(__dirname, "www");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zkey": "application/octet-stream",
};

function startServer() {
  const server = createServer((req, res) => {
    const filePath = join(WWW_DIR, req.url === "/" ? "index.html" : req.url);
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(readFileSync(filePath));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function stagePrerequisites() {
  const wasmSrc = join(BUILD_DIR, "transfer_js", "transfer.wasm");
  const zkeySrc = join(BUILD_DIR, "transfer_final.zkey");
  const vkSrc = join(BUILD_DIR, "transfer_vk.json");
  const snarkjsBrowserSrc = join(CIRCUITS_DIR, "node_modules", "snarkjs", "build", "snarkjs.min.js");

  for (const [label, src] of [["compiled circuit (transfer.wasm)", wasmSrc], ["zkey", zkeySrc], ["vk", vkSrc], ["snarkjs browser bundle", snarkjsBrowserSrc]]) {
    if (!existsSync(src)) {
      console.log(`[BLOCKED] missing ${label} at ${src}.`);
      console.log("          See circuit-baseline.mjs's header comment for how to produce circuits/build/.");
      process.exit(1);
    }
  }

  copyFileSync(wasmSrc, join(WWW_DIR, "transfer.wasm"));
  copyFileSync(zkeySrc, join(WWW_DIR, "transfer_final.zkey"));
  copyFileSync(vkSrc, join(WWW_DIR, "transfer_vk.json"));
  copyFileSync(snarkjsBrowserSrc, join(WWW_DIR, "snarkjs.min.js"));

  const { buildPoseidon } = await loadCircuitsDeps(CIRCUITS_DIR);
  const witness = await buildTransferWitness(buildPoseidon);
  writeFileSync(join(WWW_DIR, "witness.json"), JSON.stringify(witness));
}

async function main() {
  await stagePrerequisites();

  const globalRequire = createRequire("/opt/node22/lib/node_modules/playwright/package.json");
  const playwrightModule = await import(pathToFileURL(globalRequire.resolve("playwright")).href);
  const chromium = playwrightModule.default?.chromium ?? playwrightModule.chromium;

  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => document.title === "DONE" || document.title === "ERROR", { timeout: 120000 });
    const title = await page.title();
    if (title === "ERROR") {
      console.log("[ERROR]", await page.textContent("#out"));
      process.exit(1);
    }
    const results = await page.evaluate(() => window.__RESULTS__);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
