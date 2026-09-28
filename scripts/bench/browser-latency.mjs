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
 *   node scripts/bench/browser-latency.mjs [--runs N] --device "Pixel 7" --cpu-throttle 4
 *
 * With --device, the page is created with that Playwright device descriptor's viewport, user
 * agent, device-scale-factor and touch/mobile flags. With --cpu-throttle, a CDP session applies
 * Emulation.setCPUThrottlingRate(rate) before benchmarking. IMPORTANT: this still runs on the
 * host machine's desktop x86_64 CPU under headless Chromium — it is a CPU-throttled emulation of
 * a mobile device's viewport/UA/CPU budget, not a measurement on real mobile hardware (real ARM
 * silicon, thermal throttling, and a real mobile browser's WASM JIT would all differ). Report
 * results as "CPU-throttled desktop Chromium approximating <device>", never as "measured on
 * <device>".
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
import { chromium, devices } from "playwright";
import { buildPoseidon } from "circomlibjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const PORT = 8934;

function argVal(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const RUNS = (() => {
  const v = argVal("--runs");
  return v !== undefined ? parseInt(v, 10) : 10;
})();

const DEVICE_NAME = argVal("--device");
const DEVICE = DEVICE_NAME ? devices[DEVICE_NAME] : undefined;
if (DEVICE_NAME && !DEVICE) {
  console.error(`Unknown Playwright device: "${DEVICE_NAME}". See playwright's devices.json for valid names.`);
  process.exit(1);
}
const CPU_THROTTLE = (() => {
  const v = argVal("--cpu-throttle");
  return v !== undefined ? parseFloat(v) : 1;
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
  const context = await browser.newContext(DEVICE ?? {});
  const page = await context.newPage();

  if (CPU_THROTTLE !== 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  }

  await page.goto(`http://localhost:${PORT}/index.html`);

  const label = DEVICE_NAME
    ? `=== Veil browser (Chromium, CPU-throttled ${CPU_THROTTLE}x, emulating "${DEVICE_NAME}") proving-time benchmark (${RUNS} runs per circuit) ===`
    : `=== Veil browser (Chromium) proving-time benchmark (${RUNS} runs per circuit) ===`;
  console.log(label);
  if (DEVICE_NAME) {
    console.log(
      `NOTE: runs on this machine's desktop x86_64 CPU under headless Chromium with CPU throttling ` +
      `(Emulation.setCPUThrottlingRate rate=${CPU_THROTTLE}) and "${DEVICE_NAME}"'s viewport/UA/DPR ` +
      `emulated. This approximates a mobile device's CPU budget; it is not a measurement on real ` +
      `mobile hardware.`
    );
  }
  const ua = await page.evaluate(() => navigator.userAgent);
  console.log(ua, "\n");

  const results = [];
  for (const circuit of Object.keys(CIRCUIT_DIRS)) {
    const result = await page.evaluate(
      ([c, r]) => window.runBenchmark(c, r),
      [circuit, RUNS],
    );
    result.device = DEVICE_NAME ?? null;
    result.cpuThrottleRate = CPU_THROTTLE;
    results.push(result);
    console.log(`--- ${circuit} ---`);
    console.log(`  runs: ${result.runs}`);
    console.log(`  mean: ${result.meanMs.toFixed(2)} ms   stddev: ${result.stddevMs.toFixed(2)} ms   min: ${result.minMs.toFixed(2)} ms   max: ${result.maxMs.toFixed(2)} ms`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));

  await context.close();
  await browser.close();
  server.close();
}

main().catch((err) => {
  console.error("Browser benchmark failed:", err);
  process.exit(1);
});
