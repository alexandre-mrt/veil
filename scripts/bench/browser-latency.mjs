#!/usr/bin/env node
/**
 * browser-latency.mjs — Real in-browser Groth16 proving-time benchmark using Playwright + Chromium.
 *
 * Serves circuit wasm/zkey straight out of circuits/build{,-withdraw,-compliance}/ (no copies
 * committed to the repo — these are gitignored build outputs) plus the same snarkjs.min.js UMD
 * bundle the frontend ships, over a local static HTTP server (WASM must be fetched over http(s),
 * not file://). Witnesses are computed server-side (Node + circomlibjs) and handed to the page
 * as JSON so the browser only runs snarkjs.groth16.fullProve — the same call the frontend's
 * useProofGeneration hook makes (see frontend/src/hooks/useProofGeneration.ts).
 *
 * Usage:
 *   node scripts/bench/browser-latency.mjs [--runs N]
 *
 * Requires: `playwright` package (see scripts/bench/package.json) with a Chromium build
 * available. Set PLAYWRIGHT_CHROMIUM_PATH to override the default executable path.
 *
 * Prerequisite: run the circuit compile + Groth16 setup steps documented at the top of
 * prove-latency.mjs first, so the circuits/build directories contain the wasm + zkey artifacts.
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { buildPoseidon } from "circomlibjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const PORT = 8934;

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUIT_DIRS = { transfer: "build", withdraw: "build-withdraw", compliance: "build-compliance" };
const MIME = { ".html": "text/html", ".js": "application/javascript", ".wasm": "application/wasm", ".zkey": "application/octet-stream", ".json": "application/json" };

async function startServer(poseidon) {
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/witness/")) {
        const circuit = req.url.split("/witness/")[1];
        const builder = WITNESS_BUILDERS[circuit];
        if (!builder) throw new Error("unknown circuit");
        const witness = stringifyInputs(builder(poseidon));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(witness));
        return;
      }
      if (req.url === "/snarkjs.min.js") {
        const data = await readFile(join(CIRCUITS_DIR, "node_modules", "snarkjs", "build", "snarkjs.min.js"));
        res.writeHead(200, { "Content-Type": MIME[".js"] });
        res.end(data);
        return;
      }
      const circuitMatch = req.url.match(/^\/circuit\/(\w+)\/(.+)$/);
      if (circuitMatch) {
        const [, circuit, file] = circuitMatch;
        const dir = CIRCUIT_DIRS[circuit];
        const candidates = [
          join(CIRCUITS_DIR, dir, file),
          join(CIRCUITS_DIR, dir, `${circuit}_js`, file),
        ];
        const filePath = candidates.find(existsSync);
        if (!filePath) throw new Error("not found");
        const data = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
        res.end(data);
        return;
      }
      const path = req.url === "/" ? "/index.html" : req.url;
      const filePath = join(__dirname, "browser-harness", path);
      const data = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  for (const circuit of Object.keys(CIRCUIT_DIRS)) {
    const dir = CIRCUIT_DIRS[circuit];
    const wasmPath = join(CIRCUITS_DIR, dir, `${circuit}_js`, `${circuit}.wasm`);
    const zkeyPath = join(CIRCUITS_DIR, dir, `${circuit}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.error(`Missing artifacts for ${circuit}: ${wasmPath}. Run the compile steps first.`);
      process.exit(1);
    }
  }

  const server = await startServer(poseidon);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/index.html`);

  console.log(`=== Veil browser (Chromium) proving-time benchmark (${RUNS} runs per circuit) ===`);
  const ua = await page.evaluate(() => navigator.userAgent);
  console.log(ua, "\n");

  const results = [];
  for (const circuit of Object.keys(CIRCUIT_DIRS)) {
    const result = await page.evaluate(
      ([c, r]) => window.runBenchmark(c, r),
      [circuit, RUNS],
    );
    results.push(result);
    console.log(`--- ${circuit} ---`);
    console.log(`  runs: ${result.runs}`);
    console.log(`  mean: ${result.meanMs.toFixed(2)} ms   stddev: ${result.stddevMs.toFixed(2)} ms   min: ${result.minMs.toFixed(2)} ms   max: ${result.maxMs.toFixed(2)} ms`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));

  await browser.close();
  server.close();
}

main().catch((err) => {
  console.error("Browser benchmark failed:", err);
  process.exit(1);
});
