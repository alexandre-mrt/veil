#!/usr/bin/env node
/**
 * circuit-baseline.mjs — Veil transfer.circom baseline benchmark (Node.js).
 *
 * Measures witness generation + Groth16 proving time, verify time, and
 * proof/VK/zkey/wasm sizes against a REAL, constraint-satisfying witness
 * (including a valid depth-20 Merkle membership proof — see witness.mjs).
 *
 * Prerequisite (not committed — see .gitignore): a compiled circuit at
 * circuits/build/transfer_{js/transfer.wasm,final.zkey,vk.json}. Native
 * circom is required per CLAUDE.md; if unavailable (e.g. this sandbox's
 * egress policy blocks the GitHub release binary — see
 * docs/research/2026-07-14-baseline.md), the WASM build works as a
 * documented fallback:
 *
 *   cd circuits && npm install && npm install --no-save circom2
 *   npx circom2 transfer.circom --r1cs --wasm --sym --output build
 *   curl -o build/pot15_final.ptau \
 *     https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
 *   npx snarkjs groth16 setup build/transfer.r1cs build/pot15_final.ptau build/transfer_0000.zkey
 *   echo "dev-entropy" | npx snarkjs zkey contribute build/transfer_0000.zkey build/transfer_final.zkey -v
 *   npx snarkjs zkey export verificationkey build/transfer_final.zkey build/transfer_vk.json
 *
 * Run: node scripts/bench/circuit-baseline.mjs
 */
import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadCircuitsDeps, buildTransferWitness } from "./witness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");

async function main() {
  const wasmPath = join(BUILD_DIR, "transfer_js", "transfer.wasm");
  const zkeyPath = join(BUILD_DIR, "transfer_final.zkey");
  const vkPath = join(BUILD_DIR, "transfer_vk.json");

  if (!existsSync(wasmPath) || !existsSync(zkeyPath) || !existsSync(vkPath)) {
    console.log("[BLOCKED] missing circuits/build/transfer_{js/transfer.wasm,final.zkey,vk.json}.");
    console.log("          See the prerequisite steps in this script's header comment.");
    process.exit(1);
  }

  const { buildPoseidon, groth16 } = await loadCircuitsDeps(CIRCUITS_DIR);
  const input = await buildTransferWitness(buildPoseidon);
  const vk = JSON.parse(readFileSync(vkPath, "utf8"));

  const t0 = performance.now();
  const { proof, publicSignals } = await groth16.fullProve(input, wasmPath, zkeyPath);
  const t1 = performance.now();
  const valid = await groth16.verify(vk, publicSignals, proof);
  const t2 = performance.now();

  const result = {
    circuit: "transfer",
    valid,
    provingMs: +(t1 - t0).toFixed(1),
    verifyMs: +(t2 - t1).toFixed(1),
    proofBytesJson: Buffer.byteLength(JSON.stringify(proof)),
    vkBytes: statSync(vkPath).size,
    zkeyBytes: statSync(zkeyPath).size,
    wasmBytes: statSync(wasmPath).size,
    publicSignalsCount: publicSignals.length,
  };
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
