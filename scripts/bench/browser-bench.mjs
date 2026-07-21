/**
 * browser-bench.mjs — Veil browser (WASM) proving-latency benchmark
 *
 * Measures Groth16 proving time for transfer.circom inside a real Chromium tab
 * (not Node), using the same snarkjs UMD bundle and wasm/zkey artifacts the
 * Next.js frontend ships to the browser. This is the number a user's device
 * actually experiences when generating a transfer proof client-side.
 *
 * Requires:
 *   - circuits/build/transfer_js/transfer.wasm and circuits/build/transfer_final.zkey
 *     (produced by `cd circuits && bash scripts/compile.sh`)
 *   - the `playwright` package with a Chromium binary available
 *     (this repo's dev container preinstalls one at $PLAYWRIGHT_BROWSERS_PATH)
 *
 * Run:
 *   cd scripts && node bench/browser-bench.mjs
 *   cd scripts && node bench/browser-bench.mjs --iterations 5
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFile, copyFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_BUILD_DIR = join(__dirname, "..", "..", "circuits", "build");
const HARNESS_DIR = join(__dirname, "browser-harness");

const ITER_ARG = process.argv.indexOf("--iterations");
const ITERATIONS = ITER_ARG !== -1 ? parseInt(process.argv[ITER_ARG + 1], 10) : 5;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".zkey": "application/octet-stream" };

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const MERKLE_DEPTH = 20;

async function buildTransferWitness() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toBI = (v) => (typeof v === "bigint" ? v : F.toObject(v));

  const cumulativeOld = 100n, txAmount = 50n, randomnessOld = 55n, randomnessNew = 66n;
  const userSecret = 444n, epochId = 1n, threshold = 1_000_000_000n, salt = 9n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  let node = oldCommitment;
  for (let i = 0; i < MERKLE_DEPTH; i++) node = toBI(poseidon([node, 0n]));
  const merkleRoot = node;

  const witness = {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
  const out = {};
  for (const [k, v] of Object.entries(witness)) out[k] = Array.isArray(v) ? v.map(String) : String(v);
  return out;
}

async function stageHarness() {
  if (!existsSync(join(CIRCUITS_BUILD_DIR, "transfer_js", "transfer.wasm"))) {
    throw new Error(`missing ${CIRCUITS_BUILD_DIR}/transfer_js/transfer.wasm — run: cd circuits && bash scripts/compile.sh`);
  }
  if (!existsSync(join(CIRCUITS_BUILD_DIR, "transfer_final.zkey"))) {
    throw new Error(`missing ${CIRCUITS_BUILD_DIR}/transfer_final.zkey — run: cd circuits && bash scripts/compile.sh`);
  }
  const snarkjsBundle = join(__dirname, "..", "node_modules", "snarkjs", "build", "snarkjs.min.js");
  if (!existsSync(snarkjsBundle)) {
    throw new Error(`missing ${snarkjsBundle} — run: cd scripts && bun install`);
  }
  await mkdir(CIRCUITS_BUILD_DIR, { recursive: true });
  await copyFile(join(HARNESS_DIR, "index.html"), join(CIRCUITS_BUILD_DIR, "index.html"));
  await copyFile(snarkjsBundle, join(CIRCUITS_BUILD_DIR, "snarkjs.min.js"));
}

function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      const path = join(root, decodeURIComponent(req.url.split("?")[0]));
      const data = await readFile(path);
      res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  console.log(`=== Veil browser (Chromium/WASM) proving benchmark — transfer.circom, ${ITERATIONS} iterations ===`);

  await stageHarness();
  const witness = await buildTransferWitness();
  const server = await startServer(CIRCUITS_BUILD_DIR);
  const port = server.address().port;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => { if (msg.type() === "error") console.error("[page]", msg.text()); });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.evaluate(([w, n]) => window.__runBench(w, n), [witness, ITERATIONS]);
    await page.waitForFunction(() => window.__BENCH_RESULT__ !== undefined, { timeout: 120_000 });
    const result = await page.evaluate(() => window.__BENCH_RESULT__);
    const version = await browser.version();

    if (!result.ok) {
      console.error("Browser proving FAILED:", result.error);
      process.exit(1);
    }

    const ms = result.results.map((r) => r.ms);
    const sorted = [...ms].sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[(sorted.length - 1) / 2];

    console.log(`Chromium version: ${version}`);
    console.log(`Per-iteration proving time (ms): ${ms.map((x) => x.toFixed(1)).join(", ")}`);
    console.log(`Median: ${median.toFixed(1)} ms`);
    console.log(`Proof size: ${result.results[0].proofBytes} bytes (JSON)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
