#!/usr/bin/env node
/**
 * prove-latency.mjs — Groth16 proving-time / proof-size / VK-size benchmark
 * for all three Veil circuits, run in plain Node (V8, not a browser).
 *
 * Witness construction mirrors circuits/test/{transfer,compliance,withdraw}.test.mjs
 * exactly (same domain tags, same Merkle-path construction) so the timed proof is a
 * real accepted witness, not a synthetic one.
 *
 * Requires compiled artifacts (see circuits/scripts/compile*.sh or the README):
 *   circuits/build/{transfer_js/transfer.wasm, transfer_final.zkey, transfer_vk.json}
 *   circuits/build-compliance/{compliance_js/compliance.wasm, compliance_final.zkey, compliance_vk.json}
 *   circuits/build-withdraw/{withdraw_js/withdraw.wasm, withdraw_final.zkey, withdraw_vk.json}
 *
 * Usage:
 *   node scripts/bench/prove-latency.mjs [iterations]   # default 5 iterations/circuit
 *
 * Output: human-readable table to stdout, machine-readable JSON to stdout on stderr-free
 * exit, written to scripts/bench/out/prove-latency.json.
 */

import { buildPoseidon } from "circomlibjs";
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  makeToBI, buildTransferWitness, buildComplianceWitness, buildWithdrawWitness, stringifyInputs,
} from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const ITERATIONS = Number(process.argv[2] ?? 5);

const CIRCUITS = [
  {
    name: "transfer",
    wasm: join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    zkey: join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
    vk: join(CIRCUITS_DIR, "build", "transfer_vk.json"),
    build: buildTransferWitness,
  },
  {
    name: "compliance",
    wasm: join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm"),
    zkey: join(CIRCUITS_DIR, "build-compliance", "compliance_final.zkey"),
    vk: join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json"),
    build: buildComplianceWitness,
  },
  {
    name: "withdraw",
    wasm: join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm"),
    zkey: join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey"),
    vk: join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json"),
    build: buildWithdrawWitness,
  },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

async function main() {
  const poseidon = await buildPoseidon();
  const toBI = makeToBI(poseidon.F);
  const { groth16 } = await import("snarkjs");

  const results = [];

  for (const circuit of CIRCUITS) {
    if (![circuit.wasm, circuit.zkey, circuit.vk].every(existsSync)) {
      console.log(`[SKIP] ${circuit.name}: missing build artifacts (run circuits/scripts/compile*.sh first)`);
      results.push({ circuit: circuit.name, status: "MISSING_ARTIFACTS" });
      continue;
    }

    const witness = circuit.build(poseidon, toBI);
    const stringInputs = stringifyInputs(witness);

    const proveTimesMs = [];
    let lastProof = null;
    let lastPublicSignals = null;

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const { proof, publicSignals } = await groth16.fullProve(stringInputs, circuit.wasm, circuit.zkey);
      const t1 = performance.now();
      proveTimesMs.push(t1 - t0);
      lastProof = proof;
      lastPublicSignals = publicSignals;
    }

    const vk = JSON.parse(readFileSync(circuit.vk, "utf8"));
    const verifyTimesMs = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const valid = await groth16.verify(vk, lastPublicSignals, lastProof);
      const t1 = performance.now();
      if (!valid) throw new Error(`${circuit.name}: proof failed to verify during benchmark`);
      verifyTimesMs.push(t1 - t0);
    }

    const proofBytes = Buffer.byteLength(JSON.stringify(lastProof));
    const vkBytes = statSync(circuit.vk).size;
    const zkeyBytes = statSync(circuit.zkey).size;

    results.push({
      circuit: circuit.name,
      status: "OK",
      iterations: ITERATIONS,
      proveMs: { mean: mean(proveTimesMs), stddev: stddev(proveTimesMs), samples: proveTimesMs },
      verifyMs: { mean: mean(verifyTimesMs), stddev: stddev(verifyTimesMs), samples: verifyTimesMs },
      proofJsonBytes: proofBytes,
      vkJsonBytes: vkBytes,
      zkeyBytes,
      publicInputCount: lastPublicSignals.length,
    });

    console.log(
      `[${circuit.name}] prove: ${mean(proveTimesMs).toFixed(1)}ms ± ${stddev(proveTimesMs).toFixed(1)}ms ` +
      `(n=${ITERATIONS})  verify: ${mean(verifyTimesMs).toFixed(2)}ms ± ${stddev(verifyTimesMs).toFixed(2)}ms  ` +
      `proof.json: ${proofBytes}B  vk.json: ${vkBytes}B  zkey: ${(zkeyBytes / 1024).toFixed(0)}KB`
    );
  }

  const outDir = join(__dirname, "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "prove-latency.json");
  writeFileSync(outPath, JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, results }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
