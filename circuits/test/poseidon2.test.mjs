/**
 * poseidon2.test.mjs -- Correctness and negative tests for the Poseidon2
 * (t=3, BN254) research circuit at circuits/templates/poseidon2_t3.circom.
 *
 * This is NOT one of Veil's production circuits. It exists to validate the
 * research artifact used in docs/research/2026-08-04-poseidon2-vs-poseidon.md:
 *   1. The circom translation computes the same permutation as the official
 *      reference implementation (HorizenLabs/poseidon2), checked against that
 *      repo's own published known-answer test.
 *   2. A witness that claims a false hash output is rejected by the R1CS
 *      constraint system (the negative test the research report requires for
 *      any circuit change).
 *
 * Prerequisite (produces the artifacts this reads):
 *   see scripts/bench/poseidon2-vs-poseidon/build-circuits.sh
 *
 * Run: node --experimental-vm-modules test/poseidon2.test.mjs
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "..", "..", "scripts", "bench", "poseidon2-vs-poseidon", "build");

const PERM_WASM = join(BENCH_DIR, "main_poseidon2_t3_js", "main_poseidon2_t3.wasm");
const COMMIT_WASM = join(BENCH_DIR, "main_poseidon2_commit_js", "main_poseidon2_commit.wasm");
const COMMIT_ZKEY = join(BENCH_DIR, "main_poseidon2_commit_final.zkey");
const COMMIT_VK = join(BENCH_DIR, "main_poseidon2_commit_vk.json");

const ARTIFACTS_AVAILABLE = existsSync(PERM_WASM) && existsSync(COMMIT_WASM) && existsSync(COMMIT_ZKEY);

let passed = 0;
let failed = 0;

console.log("=== Poseidon2 (t=3) research circuit tests ===");
if (!ARTIFACTS_AVAILABLE) {
  console.log("[SKIP] artifacts not found — run scripts/bench/poseidon2-vs-poseidon/build-circuits.sh first");
  process.exit(0);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

async function calculateWitness(wasmPath, input) {
  const wasm = readFileSync(wasmPath);
  const wc = await WitnessCalculatorBuilder(wasm);
  return wc.calculateWitness(input, false);
}

// Known-answer test from the reference implementation itself:
// https://github.com/HorizenLabs/poseidon2 plain_implementations/src/poseidon2/poseidon2.rs
// mod poseidon2_tests_bn256::kats() — permutation([0,1,2]).
const KAT_INPUT = ["0", "1", "2"];
const KAT_EXPECTED = [
  "5297208644449048816064511434384511824916970985131888684874823260532015509555",
  "21816030159894113985964609355246484851575571273661473159848781012394295965040",
  "13940986381491601233448981668101586453321811870310341844570924906201623195336",
];

async function main() {
  await test("KAT: Poseidon2Permutation3([0,1,2]) matches HorizenLabs reference vector", async () => {
    const w = await calculateWitness(PERM_WASM, { in: KAT_INPUT });
    // w[0] = constant 1, w[1..3] = out[0..2] (circom emits component-main outputs immediately
    // after the constant signal, ahead of declared-public inputs).
    const out = [w[1].toString(), w[2].toString(), w[3].toString()];
    assert(
      out[0] === KAT_EXPECTED[0] && out[1] === KAT_EXPECTED[1] && out[2] === KAT_EXPECTED[2],
      `permutation output mismatch: got ${JSON.stringify(out)}, expected ${JSON.stringify(KAT_EXPECTED)}`,
    );
  });

  await test("Negative: Poseidon2Commit accepts a witness with the correct hash", async () => {
    const vk = JSON.parse(readFileSync(COMMIT_VK, "utf8"));
    // Compute the real hash via the permutation circuit's own wasm (capacity = 0), then feed it
    // as `expected` to the commitment circuit — this is the "honest prover" path.
    const permW = await calculateWitness(PERM_WASM, { in: ["7", "9", "0"] });
    const realHash = permW[1].toString();

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      { in: ["7", "9"], expected: realHash },
      COMMIT_WASM,
      COMMIT_ZKEY,
    );
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    assert(valid, "honest proof must verify");
  });

  await test("Negative: Poseidon2Commit rejects a witness claiming a false hash", async () => {
    const permW = await calculateWitness(PERM_WASM, { in: ["7", "9", "0"] });
    const realHash = permW[1].toString();
    const falseHash = (BigInt(realHash) + 1n).toString();

    let threw = false;
    try {
      await snarkjs.groth16.fullProve({ in: ["7", "9"], expected: falseHash }, COMMIT_WASM, COMMIT_ZKEY);
    } catch {
      threw = true;
    }
    assert(threw, "witness with a false claimed hash must fail constraint satisfaction (`expected === h.out`)");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
