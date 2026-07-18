/**
 * browser-prove-bench.mjs — Real in-browser Groth16 proving latency for transfer.circom.
 *
 * Serves circuits/build/ + the snarkjs browser bundle over a local HTTP server, drives the
 * pre-installed Chromium via Playwright, and times snarkjs.groth16.fullProve() inside the
 * page (not in Node) so the number reflects what a user's browser actually pays — WASM
 * instantiation + witness calculation + proving, on the main thread, no native bindings.
 *
 * Requires circuits/build/{transfer.wasm,transfer_final.zkey} to exist (run prove-bench.mjs's
 * compile steps first) and playwright-core (scripts/bench/package.json).
 *
 * Usage: node scripts/bench/browser-prove-bench.mjs [--runs N]
 */

import { createServer } from "http";
import { readFile, stat } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCUITS_BUILD = join(REPO_ROOT, "circuits", "build");
const SNARKJS_BUNDLE = join(REPO_ROOT, "circuits", "node_modules", "snarkjs", "build", "snarkjs.min.js");

function findChromium() {
  const base = "/opt/pw-browsers";
  if (!existsSync(base)) return null;
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-"));
  if (!dir) return null;
  const candidate = join(base, dir, "chrome-linux", "chrome");
  return existsSync(candidate) ? candidate : null;
}
const CHROMIUM_PATH = findChromium();

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 3;
})();

const MIME = { ".wasm": "application/wasm", ".zkey": "application/octet-stream", ".js": "text/javascript", ".html": "text/html", ".json": "application/json" };

const HARNESS_HTML = `<!doctype html><html><body><script src="/snarkjs.min.js"></script></body></html>`;

async function serveFile(res, filePath) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream", "Content-Length": data.length });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function startServer() {
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HARNESS_HTML);
      return;
    }
    if (req.url === "/snarkjs.min.js") return serveFile(res, SNARKJS_BUNDLE);
    if (req.url === "/transfer.wasm") return serveFile(res, join(CIRCUITS_BUILD, "transfer_js", "transfer.wasm"));
    if (req.url === "/transfer_final.zkey") return serveFile(res, join(CIRCUITS_BUILD, "transfer_final.zkey"));
    if (req.url === "/transfer_vk.json") return serveFile(res, join(CIRCUITS_BUILD, "transfer_vk.json"));
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const wasmPath = join(CIRCUITS_BUILD, "transfer_js", "transfer.wasm");
  const zkeyPath = join(CIRCUITS_BUILD, "transfer_final.zkey");
  try {
    await stat(wasmPath);
    await stat(zkeyPath);
  } catch {
    console.log(JSON.stringify({ error: `missing ${wasmPath} or ${zkeyPath} — compile transfer.circom and run groth16 setup first` }));
    process.exit(1);
  }

  if (!CHROMIUM_PATH) {
    console.log(JSON.stringify({ error: "no chromium-* build found under /opt/pw-browsers" }));
    process.exit(1);
  }

  const server = await startServer();
  const port = server.address().port;

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => process.stderr.write(`[browser] ${msg.text()}\n`));
    page.on("pageerror", (err) => process.stderr.write(`[browser error] ${err}\n`));

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof window.snarkjs !== "undefined");

    const result = await page.evaluate(async ({ runs }) => {
      // Same witness as circuits/test/transfer.test.mjs buildValidWitness() defaults,
      // precomputed in Node (poseidon not available in this minimal harness) and inlined
      // as decimal strings — see prove-bench.mjs for the derivation.
      const input = {
        oldCommitment: "413687954456226285006769170318412110166829765271532172910717977471729010125",
        newCommitment: "2046095552086145732774094747582126972825505517276238725402256179364355583950",
        threshold: "1000000000",
        epochId: "1",
        nullifier: "3967160587919863969322438820888899155283021227814388596766340006015061956966",
        txAmountHash: "13877927720485478492282793055724598988144286885818278984005830714945591630409",
        merkleRoot: "3913250323435455793499490673507062835928385577594149380971783896990664721867",
        cumulativeOld: "0",
        cumulativeNew: "100",
        txAmount: "100",
        randomnessOld: "0",
        randomnessNew: "12345",
        userSecret: "987654321",
        salt: "99",
        pathElements: new Array(20).fill("0"),
        pathIndices: new Array(20).fill("0"),
      };

      const times = [];
      let proof, publicSignals;
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        ({ proof, publicSignals } = await window.snarkjs.groth16.fullProve(input, "/transfer.wasm", "/transfer_final.zkey"));
        const t1 = performance.now();
        times.push(t1 - t0);
      }
      const vk = await (await fetch("/transfer_vk.json")).json();
      const verifyOk = await window.snarkjs.groth16.verify(vk, publicSignals, proof);
      return { times, verifyOk, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency };
    }, { runs: RUNS });

    console.log(JSON.stringify({ circuit: "transfer", runs: RUNS, ...result }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
