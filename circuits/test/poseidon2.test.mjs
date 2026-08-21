/**
 * poseidon2.test.mjs — Negative-witness tests for the Poseidon2 shadow circuits
 * (transfer2/withdraw2/compliance2.circom), part of the 2026-08-21
 * Poseidon2-vs-Poseidon research experiment.
 *
 * These circuits are NOT wired into the deployed protocol — see
 * docs/research/2026-08-21-poseidon2-hash.md. This file exists to back the
 * experiment's soundness argument with real evidence: every malicious
 * witness below must be REJECTED (witness generation must throw, because
 * circom's `===` constraints have no satisfying assignment), not merely
 * "produce a different but still-verifying proof."
 *
 * Run: node --experimental-vm-modules test/poseidon2.test.mjs
 * Requires: circuits/build2/{transfer2,withdraw2,compliance2}_js/*.wasm
 *           (produced by node node_modules/circom2/cli.js <name>.circom
 *            --r1cs --wasm --sym -o build2 -l node_modules)
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { bn254 } from "@taceo/poseidon2";
import {
  buildTransfer2Witness,
  buildWithdraw2Witness,
  buildCompliance2Witness,
  stringifyInputs,
} from "../../scripts/bench/witnesses2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build2");
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let passed = 0;
let failed = 0;

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

/** Compute a witness for `inputs` against `wasmPath`; throws if unsatisfiable. */
async function calculateWitness(inputs, wasmPath) {
  const wtnsPath = join(BUILD_DIR, `_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.wtns`);
  await snarkjs.wtns.calculate(stringifyInputs(inputs), wasmPath, wtnsPath);
  return wtnsPath;
}

async function assertWitnessRejected(name, inputs, wasmPath) {
  let threw = false;
  try {
    await calculateWitness(inputs, wasmPath);
  } catch {
    threw = true;
  }
  assert(threw, `${name}: witness generation must fail for a malicious/inconsistent input, but it succeeded`);
}

function spongeWithDs(data, t, ds) {
  const PERM = { 2: bn254.t2, 3: bn254.t3, 4: bn254.t4, 8: bn254.t8 };
  const rate = t - 1;
  let state = new Array(t).fill(0n);
  state[t - 1] = ds;
  for (let offset = 0; offset < data.length; offset += rate) {
    const chunk = data.slice(offset, offset + rate);
    for (let i = 0; i < chunk.length; i++) state[i] = (state[i] + chunk[i]) % FIELD_MODULUS;
    state = PERM[t].permutation(state);
  }
  return state[0];
}

async function main() {
  const T2_WASM = join(BUILD_DIR, "transfer2_js", "transfer2.wasm");
  const W2_WASM = join(BUILD_DIR, "withdraw2_js", "withdraw2.wasm");
  const C2_WASM = join(BUILD_DIR, "compliance2_js", "compliance2.wasm");
  const AVAILABLE = existsSync(T2_WASM) && existsSync(W2_WASM) && existsSync(C2_WASM);

  console.log("=== Veil Poseidon2 shadow-circuit negative tests ===");
  if (!AVAILABLE) {
    console.log("[SKIP] build2/ wasm artifacts not found — compile transfer2/withdraw2/compliance2.circom first.");
    process.exit(0);
  }

  console.log("\n--- Positive control: valid witnesses are accepted ---");

  await test("PC1: transfer2 valid witness generates a witness", async () => {
    const w = buildTransfer2Witness();
    await calculateWitness(w, T2_WASM);
  });

  await test("PC2: withdraw2 valid witness generates a witness", async () => {
    const w = buildWithdraw2Witness();
    await calculateWitness(w, W2_WASM);
  });

  await test("PC3: compliance2 valid witness generates a witness", async () => {
    const w = buildCompliance2Witness();
    await calculateWitness(w, C2_WASM);
  });

  console.log("\n--- Negative: malicious/inconsistent witnesses are rejected ---");

  // N1: Domain-separation confusion — claim a commitment (DS=1) is actually
  // a nullifier (DS=2) computed over the same data. Mirrors the original
  // transfer.circom's T31 (tag-1-vs-tag-2 confusion), now against the
  // sponge's capacity element instead of the first rate element.
  await test("N1: transfer2 — nullifier (DS=2) submitted as oldCommitment (DS=1) is rejected", async () => {
    const w = buildTransfer2Witness();
    const forgedOldCommitment = spongeWithDs(
      [w.cumulativeOld, w.randomnessOld, w.userSecret],
      4,
      2n, // wrong domain tag: nullifier's DS instead of commitment's DS=1
    );
    assert(forgedOldCommitment !== w.oldCommitment, "sanity: forged value must actually differ");
    const malicious = { ...w, oldCommitment: forgedOldCommitment };
    await assertWitnessRejected("N1", malicious, T2_WASM);
  });

  // N2: Forged nullifier — a prover claims an arbitrary nullifier instead of
  // the one correctly derived from (userSecret, epochId, randomnessOld).
  // This is the double-spend-prevention property: without this constraint a
  // malicious prover could pick nullifiers that never collide, defeating the
  // whole point of nullifiers.
  await test("N2: transfer2 — arbitrary nullifier not matching the DS=2 sponge is rejected", async () => {
    const w = buildTransfer2Witness();
    const malicious = { ...w, nullifier: (w.nullifier + 1n) % FIELD_MODULUS };
    await assertWitnessRejected("N2", malicious, T2_WASM);
  });

  // N3: Tampered Merkle path — flip one sibling so the recomputed root no
  // longer matches merkleRoot. Proves membership is actually enforced, not
  // vacuously true.
  await test("N3: transfer2 — tampered Merkle sibling breaks root recomputation", async () => {
    const w = buildTransfer2Witness();
    const tamperedPath = [...w.pathElements];
    tamperedPath[0] = tamperedPath[0] + 1n;
    const malicious = { ...w, pathElements: tamperedPath };
    await assertWitnessRejected("N3", malicious, T2_WASM);
  });

  // N4: Cross-circuit domain confusion — withdraw2's nullifier (DS=7) value
  // submitted as its commitment (DS=1). Same value, wrong slot: proves the
  // circuit binds each public signal to its OWN sponge call, not just to
  // "some" Poseidon2 output.
  await test("N4: withdraw2 — recipientHash (DS=8) submitted as commitment (DS=1) is rejected", async () => {
    const w = buildWithdraw2Witness();
    const malicious = { ...w, commitment: w.recipientHash };
    await assertWitnessRejected("N4", malicious, W2_WASM);
  });

  // N5: compliance2 — forged credential leaf (wrong kycLevel folded into the
  // DS=4 sponge) must fail Merkle membership against the honest root.
  await test("N5: compliance2 — forged leaf (tampered kycLevel) breaks Merkle membership", async () => {
    const w = buildCompliance2Witness();
    const malicious = { ...w, kycLevel: w.kycLevel + 1n };
    await assertWitnessRejected("N5", malicious, C2_WASM);
  });

  // N6: compliance2 — forged context binding (contextId not actually derived
  // from transferNullifier+userSecret via DS=6) must be rejected. This is
  // the constraint that ties a compliance proof to one specific transfer
  // without revealing transferNullifier as a public input.
  await test("N6: compliance2 — contextId not matching the DS=6 sponge is rejected", async () => {
    const w = buildCompliance2Witness();
    const malicious = { ...w, contextId: (w.contextId + 1n) % FIELD_MODULUS };
    await assertWitnessRejected("N6", malicious, C2_WASM);
  });

  // N7: Non-boolean pathIndices — mirrors T43 in the original transfer.test.mjs.
  // Confirms merkle_proof2.circom's `pathIndices[i]*(1-pathIndices[i])===0`
  // check (added after an earlier draft omitted it — see the research report)
  // actually rejects an out-of-{0,1} selector.
  await test("N7: transfer2 — non-boolean pathIndices[0] is rejected", async () => {
    const w = buildTransfer2Witness();
    const tamperedIndices = [...w.pathIndices];
    tamperedIndices[0] = 2n;
    const malicious = { ...w, pathIndices: tamperedIndices };
    await assertWitnessRejected("N7", malicious, T2_WASM);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
