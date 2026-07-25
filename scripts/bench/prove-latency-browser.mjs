#!/usr/bin/env node
/**
 * prove-latency-browser.mjs — Groth16 proving-time benchmark for the transfer
 * circuit run inside headless Chromium (via Playwright), using the same
 * snarkjs.min.js browser bundle the frontend ships in its proving Web Worker,
 * and the same wasm/zkey artifacts as prove-latency.mjs.
 *
 * This is NOT a run of the full Next.js app (no wallet, no UI) — it is a
 * minimal static HTML harness that loads snarkjs and times
 * groth16.fullProve/verify with performance.now() inside the page, so the
 * number reflects real in-browser WASM execution, not a Node proxy for it.
 *
 * Requires: circuits/build/{transfer_js/transfer.wasm, transfer_final.zkey,
 * transfer_vk.json} (see circuits/scripts/compile.sh) and
 * scripts/bench/node_modules/snarkjs (npm install in this directory).
 *
 * Usage:
 *   node scripts/bench/prove-latency-browser.mjs [iterations]   # default 5
 */

import { buildPoseidon } from "circomlibjs";
import { existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { makeToBI, buildTransferWitness, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");
const ITERATIONS = Number(process.argv[2] ?? 5);

const WASM_PATH = join(BUILD_DIR, "transfer_js", "transfer.wasm");
const ZKEY_PATH = join(BUILD_DIR, "transfer_final.zkey");
const VK_PATH = join(BUILD_DIR, "transfer_vk.json");
const SNARKJS_BUNDLE = join(__dirname, "node_modules", "snarkjs", "build", "snarkjs.min.js");

const MIME = { ".js": "text/javascript", ".wasm": "application/wasm", ".zkey": "application/octet-stream", ".json": "application/json", ".html": "text/html" };

function harnessHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><script src="/snarkjs.min.js"></script></head>
<body><script>
window.runBench = async (stringInputs, iterations) => {
  const proveMs = [];
  const verifyMs = [];
  let proof, publicSignals;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    ({ proof, publicSignals } = await snarkjs.groth16.fullProve(stringInputs, "/transfer.wasm", "/transfer_final.zkey"));
    proveMs.push(performance.now() - t0);
  }
  const vkRes = await fetch("/transfer_vk.json");
  const vk = await vkRes.json();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    verifyMs.push(performance.now() - t0);
    if (!ok) throw new Error("verify failed");
  }
  return { proveMs, verifyMs, proofBytes: JSON.stringify(proof).length };
};
</script></body></html>`;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr) { const m = mean(arr); return Math.sqrt(mean(arr.map((x) => (x - m) ** 2))); }

async function main() {
  if (![WASM_PATH, ZKEY_PATH, VK_PATH].every(existsSync)) {
    console.log("[SKIP] transfer: missing build artifacts (run circuits/scripts/compile.sh first)");
    process.exit(0);
  }
  if (!existsSync(SNARKJS_BUNDLE)) {
    console.log(`[BLOCKED] snarkjs browser bundle not found at ${SNARKJS_BUNDLE} (run: cd scripts/bench && npm install)`);
    process.exit(1);
  }

  const routes = {
    "/": harnessHtml(),
    "/snarkjs.min.js": SNARKJS_BUNDLE,
    "/transfer.wasm": WASM_PATH,
    "/transfer_final.zkey": ZKEY_PATH,
    "/transfer_vk.json": VK_PATH,
  };

  const server = createServer(async (req, res) => {
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    const ext = extname(req.url) || ".html";
    res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
    if (req.url === "/") { res.end(route); return; }
    res.end(await readFile(route));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const poseidon = await buildPoseidon();
  const toBI = makeToBI(poseidon.F);
  const witness = buildTransferWitness(poseidon, toBI);
  const stringInputs = stringifyInputs(witness);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const { proveMs, verifyMs, proofBytes } = await page.evaluate(
      ([inputs, n]) => window.runBench(inputs, n),
      [stringInputs, ITERATIONS],
    );

    const nodeResultPath = join(__dirname, "out", "prove-latency.json");
    let nodeCompare = null;
    if (existsSync(nodeResultPath)) {
      const nodeResults = JSON.parse(await readFile(nodeResultPath, "utf8"));
      const t = nodeResults.results.find((r) => r.circuit === "transfer");
      if (t) nodeCompare = t.proveMs.mean;
    }

    console.log(
      `[transfer/browser] prove: ${mean(proveMs).toFixed(1)}ms ± ${stddev(proveMs).toFixed(1)}ms (n=${ITERATIONS})  ` +
      `verify: ${mean(verifyMs).toFixed(2)}ms ± ${stddev(verifyMs).toFixed(2)}ms  proof.json: ${proofBytes}B` +
      (nodeCompare ? `  (Node fullProve mean: ${nodeCompare.toFixed(1)}ms, browser/Node ratio: ${(mean(proveMs) / nodeCompare).toFixed(2)}x)` : "")
    );

    const chromiumVersion = browser.version();
    const outDir = join(__dirname, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "prove-latency-browser.json"),
      JSON.stringify({
        runtime: "headless-chromium",
        chromiumVersion,
        circuit: "transfer",
        iterations: ITERATIONS,
        proveMs: { mean: mean(proveMs), stddev: stddev(proveMs), samples: proveMs },
        verifyMs: { mean: mean(verifyMs), stddev: stddev(verifyMs), samples: verifyMs },
        proofBytes,
        nodeProveMsMean: nodeCompare,
      }, null, 2),
    );
  } finally {
    await browser.close();
    server.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
