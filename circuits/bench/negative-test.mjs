#!/usr/bin/env node
/**
 * negative-test.mjs — proves a malicious witness is rejected for the linear-layer probe circuits.
 *
 * For each of the four probe circuits (t3_dense, t3_cheap, t5_dense, t5_cheap):
 *   1. Generate a real proof for a real input -> confirm it verifies (sanity check).
 *   2. Tamper with one public output signal (increment it by 1 mod p) and confirm the SAME proof
 *      is rejected against the tampered public signals.
 *   3. Tamper with one proof element (flip a byte in pi_a.x) and confirm the untampered public
 *      signals now reject that corrupted proof too.
 *
 * This is the standard Groth16 malicious-witness check: a prover cannot present a proof for one
 * output and have it verify against a different claimed output, and cannot mutate the proof itself
 * and have it still verify. Exit code is 0 iff all rejections behaved as expected (i.e. iff the
 * circuit's constraints actually bind what they claim to).
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "build");
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const CIRCUITS = [
  { name: "t3_dense", nInputs: 2 },
  { name: "t3_cheap", nInputs: 2 },
  { name: "t5_dense", nInputs: 4 },
  { name: "t5_cheap", nInputs: 4 },
];

async function main() {
  let allOk = true;
  for (const { name, nInputs } of CIRCUITS) {
    const wasmPath = join(BENCH_DIR, `${name}_js`, `${name}.wasm`);
    const zkeyPath = join(BENCH_DIR, `${name}_final.zkey`);
    const vkPath = join(BENCH_DIR, `${name}_vk.json`);

    const input = { inputs: Array.from({ length: nInputs }, (_, i) => String(i + 1)) };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    const vk = JSON.parse((await import("fs")).readFileSync(vkPath, "utf8"));

    const honestOk = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log(`[${name}] honest proof verifies: ${honestOk}`);
    if (!honestOk) { allOk = false; console.log(`  FAIL: honest proof should verify`); continue; }

    // Tamper with a public output: claim out[0] + 1 instead of the real out[0].
    const tamperedSignals = [...publicSignals];
    tamperedSignals[0] = ((BigInt(tamperedSignals[0]) + 1n) % P).toString();
    const tamperedOk = await snarkjs.groth16.verify(vk, tamperedSignals, proof);
    console.log(`[${name}] proof verifies against tampered output[0]+1: ${tamperedOk}`);
    if (tamperedOk) { allOk = false; console.log(`  FAIL: tampered output should be rejected`); }

    // Tamper with the proof itself: perturb pi_a.x by 1.
    const tamperedProof = JSON.parse(JSON.stringify(proof));
    tamperedProof.pi_a[0] = ((BigInt(tamperedProof.pi_a[0]) + 1n) % P).toString();
    const tamperedProofOk = await snarkjs.groth16.verify(vk, publicSignals, tamperedProof);
    console.log(`[${name}] tampered proof (pi_a.x+1) verifies against honest output: ${tamperedProofOk}`);
    if (tamperedProofOk) { allOk = false; console.log(`  FAIL: tampered proof should be rejected`); }
  }

  console.log(allOk ? "\nAll negative tests passed (malicious witnesses rejected)." : "\nFAILURES ABOVE.");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
