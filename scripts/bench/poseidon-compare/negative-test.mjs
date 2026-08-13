#!/usr/bin/env node
/**
 * negative-test.mjs — sanity check that the vendored Poseidon2 Merkle circuit
 * (p2_merkle20) behaves like a real Groth16 circuit should: a valid proof
 * verifies, and a proof whose public output has been tampered with is
 * rejected. Not a claim about production Veil circuits (none were changed
 * in this experiment) — this only guards against "the benchmark circuit
 * compiles but is a tautology / accepts anything", which would have
 * silently invalidated every constraint-count and proving-time number in
 * this report.
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "build");

async function main() {
  const wasmPath = join(BUILD_DIR, "p2_merkle20_js", "p2_merkle20.wasm");
  const zkeyPath = join(BUILD_DIR, "p2_merkle20_final.zkey");
  const vkeyPath = join(BUILD_DIR, "p2_merkle20_vk.json");

  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    console.error("Artifacts missing — run the setup commands in the experiment report first.");
    process.exit(1);
  }

  if (!existsSync(vkeyPath)) {
    const vk = await snarkjs.zKey.exportVerificationKey(zkeyPath);
    await import("fs").then(fs => fs.promises.writeFile(vkeyPath, JSON.stringify(vk)));
  }
  const vkey = JSON.parse(await import("fs").then(fs => fs.promises.readFile(vkeyPath, "utf8")));

  const input = {
    leaf: 12345,
    pathElements: Array.from({ length: 20 }, (_, i) => (i + 1) * 7 + 1),
    pathIndices: Array.from({ length: 20 }, (_, i) => i % 2),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

  const validOk = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(`Valid proof, correct public signal (root): verify() = ${validOk}`);
  if (!validOk) {
    console.error("FAIL: a genuinely valid proof was rejected. Something is broken.");
    process.exit(1);
  }

  // Tamper with the public output (the computed Merkle root) and confirm rejection.
  const forgedSignals = [...publicSignals];
  forgedSignals[0] = (BigInt(forgedSignals[0]) + 1n).toString();
  const forgedOk = await snarkjs.groth16.verify(vkey, forgedSignals, proof);
  console.log(`Same proof, tampered public signal (root+1): verify() = ${forgedOk}`);
  if (forgedOk) {
    console.error("FAIL: a tampered public signal was accepted. Something is broken.");
    process.exit(1);
  }

  console.log("\nPASS: valid witness verifies, tampered public output is rejected.");
  // snarkjs' bn128 curve keeps worker handles open after the last proof (PR #17).
  process.exit(0);
}

main().catch((err) => {
  console.error("negative-test failed:", err);
  process.exit(1);
});
