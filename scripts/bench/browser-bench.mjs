/**
 * browser-bench.mjs — real in-browser Groth16 proving latency for the
 * withdraw circuit, driven headlessly via Playwright/Chromium.
 *
 * Why withdraw only: it is the smallest circuit (3,058 constraints) and the
 * only one currently wired into the frontend's proving flow. transfer/
 * compliance can be added the same way once they ship client-side.
 *
 * Requires:
 *   - circuits/build-withdraw/{withdraw_js/withdraw.wasm,withdraw_final.zkey,withdraw_vk.json}
 *     (see circuits/scripts/compile-withdraw.sh, or scripts/bench/circuit-bench.mjs header)
 *   - playwright + a Chromium build reachable via PW_CHROMIUM_PATH or the
 *     default Playwright browsers cache
 *
 * Usage: node scripts/bench/browser-bench.mjs [--runs N] [--port P]
 */

import { createRequire } from "module";
import { existsSync, mkdtempSync, writeFileSync, copyFileSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { createServer } from "http";
import { extname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");
const WITHDRAW_BUILD = join(CIRCUITS_DIR, "build-withdraw");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 5;
})();
const PORT = (() => {
  const idx = process.argv.indexOf("--port");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 8931;
})();

const circuitsRequire = createRequire(join(CIRCUITS_DIR, "package.json"));
const { buildPoseidon } = circuitsRequire("circomlibjs");

const CHROMIUM_PATH =
  process.env.PW_CHROMIUM_PATH ||
  (() => {
    // Playwright's default cache layout: <browsersPath>/chromium-<rev>/chrome-linux/chrome
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME || "", ".cache", "ms-playwright");
    if (!existsSync(base)) return null;
    const dir = readdirSync(base).find((d) => d.startsWith("chromium-") && !d.startsWith("chromium_headless_shell"));
    return dir ? join(base, dir, "chrome-linux", "chrome") : null;
  })();

async function buildWithdrawWitnessJSON() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toBI = (v) => (typeof v === "bigint" ? v : F.toObject(v));
  const DOMAIN_COMMITMENT = 1n, DOMAIN_WITHDRAW_NULLIFIER = 7n, DOMAIN_RECIPIENT_HASH = 8n;
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xabcdef123456n, randomnessNew = 77777n;

  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

  const w = { commitment, withdrawAmount, nullifier, recipientHash, newCommitment, cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew };
  const out = {};
  for (const [k, v] of Object.entries(w)) out[k] = v.toString();
  return out;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".zkey": "application/octet-stream" };

function serveDir(dir, port) {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function main() {
  if (!existsSync(join(WITHDRAW_BUILD, "withdraw_js", "withdraw.wasm"))) {
    console.log("[BLOCKED] withdraw circuit not compiled — run circuits/scripts/compile-withdraw.sh first.");
    process.exit(1);
  }
  if (!CHROMIUM_PATH || !existsSync(CHROMIUM_PATH)) {
    console.log("[BLOCKED] no Chromium binary found. Set PW_CHROMIUM_PATH or install via `npx playwright install chromium`.");
    process.exit(1);
  }

  let chromium;
  const pwCandidates = [
    import.meta.url,
    ...(process.env.PW_REQUIRE_FROM ? [process.env.PW_REQUIRE_FROM] : []),
    "/opt/node22/lib/node_modules/playwright/package.json",
  ];
  for (const from of pwCandidates) {
    try {
      const pwRequire = createRequire(from);
      ({ chromium } = pwRequire("playwright"));
      break;
    } catch {}
  }
  if (!chromium) {
    console.log("[BLOCKED] `playwright` package not resolvable. Install it (npm i -D playwright),");
    console.log("          or set PW_REQUIRE_FROM to a path whose node_modules contains it.");
    process.exit(1);
  }

  const stage = mkdtempSync(join(tmpdir(), "veil-browser-bench-"));
  copyFileSync(join(CIRCUITS_DIR, "node_modules", "snarkjs", "build", "snarkjs.min.js"), join(stage, "snarkjs.min.js"));
  copyFileSync(join(WITHDRAW_BUILD, "withdraw_js", "withdraw.wasm"), join(stage, "withdraw.wasm"));
  copyFileSync(join(WITHDRAW_BUILD, "withdraw_final.zkey"), join(stage, "withdraw_final.zkey"));
  copyFileSync(join(WITHDRAW_BUILD, "withdraw_vk.json"), join(stage, "withdraw_vk.json"));
  writeFileSync(join(stage, "witness.json"), JSON.stringify(await buildWithdrawWitnessJSON()));
  writeFileSync(
    join(stage, "bench.html"),
    `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="snarkjs.min.js"></script>
<script>
window.runBench = async function(runs) {
  const witness = await fetch("witness.json").then(r => r.json());
  const times = [];
  let proofBytes = null, verifyOk = null;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, "withdraw.wasm", "withdraw_final.zkey");
    const t1 = performance.now();
    times.push(t1 - t0);
    if (proofBytes === null) {
      proofBytes = JSON.stringify(proof).length;
      const vk = await fetch("withdraw_vk.json").then(r => r.json());
      verifyOk = await snarkjs.groth16.verify(vk, publicSignals, proof);
    }
  }
  return { times, proofBytes, verifyOk };
};
</script></body></html>`
  );

  const server = await serveDir(stage, PORT);
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/bench.html`);
  const result = await page.evaluate((runs) => window.runBench(runs), RUNS);
  const ua = await page.evaluate(() => navigator.userAgent);
  await browser.close();
  server.close();

  const mean = result.times.reduce((a, b) => a + b, 0) / result.times.length;
  console.log(`=== Veil browser-bench (withdraw, ${RUNS} runs, headless Chromium) ===`);
  console.log(`UA: ${ua}`);
  console.log(`runs (ms): ${result.times.map((t) => t.toFixed(1)).join(", ")}`);
  console.log(`mean=${mean.toFixed(1)}ms proof_bytes=${result.proofBytes} verify=${result.verifyOk ? "OK" : "FAILED"}`);
  console.log("");
  console.log(JSON.stringify({ circuit: "withdraw", env: "browser-headless-chromium", ua, ...result, mean_ms: mean }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
