/**
 * poseidon2_merkle.test.mjs — Soundness tests for the Poseidon2 Merkle-hasher experiment
 * (circuits/experiments/transfer_poseidon2_merkle.circom,
 * circuits/experiments/compliance_poseidon2_merkle.circom).
 *
 * Same shape as circuits/test/transfer.test.mjs's T41/T42/T43 Merkle-membership tests: a
 * valid membership witness satisfies every R1CS constraint, and three classes of
 * malicious witness are rejected — (1) a merkleRoot that doesn't match the path, (2) a
 * tampered sibling with the root left unchanged, (3) a non-boolean pathIndices entry
 * (MultiMux1 selector abuse).
 *
 * These are **witness-generation-level** checks (`snarkjs.wtns.calculate`), not full
 * `groth16.fullProve`/`verify` — the local Groth16 setup for this circuit's zkey did not
 * finish within this session's time budget (see
 * docs/research/2026-09-09-poseidon2-merkle-hasher.md, "Toolchain gaps"). This is still a
 * real soundness check, not a weaker stand-in: circom's compiled wasm witness calculator
 * enforces every `===` constraint in the circuit (that's what throws on T43 in the
 * existing suite too), and it does so *before* any Groth16-specific step would run — a
 * witness that fails here would fail `fullProve` for the identical reason, just later and
 * slower. What this does NOT check: Groth16 completeness/soundness itself (that a
 * constraint-satisfying witness produces a proof that verifies) — that's a property of
 * the untouched Groth16/BN254 machinery, not of this circuit change, and is exercised by
 * the existing `circuits/test/*.test.mjs` suite against the production circuits.
 *
 * Run: node --experimental-vm-modules circuits/experiments/test/poseidon2_merkle.test.mjs
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildTransferWitness, stringifyInputs, setPoseidonField } from "../../../scripts/bench/witnesses-poseidon2-merkle.mjs";
import { makePoseidon2 } from "../../../scripts/bench/poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "..", "build", "experiments", "transfer_poseidon2_merkle_js", "transfer_poseidon2_merkle.wasm");

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name}\n    ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const WTNS_OUT_PATH = join(__dirname, "..", "..", "build", "experiments", "_negative_test.wtns");

async function calcWitness(inputs) {
  return await snarkjs.wtns.calculate(stringifyInputs(inputs), WASM_PATH, WTNS_OUT_PATH);
}

async function main() {
  if (!existsSync(WASM_PATH)) {
    console.log(`[SKIP] Poseidon2 Merkle-hasher soundness tests: wasm not built (${WASM_PATH})`);
    process.exit(0);
  }

  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const { compress } = await makePoseidon2();

  console.log("Poseidon2 Merkle-hasher witness-level soundness tests (transfer_poseidon2_merkle.circom)\n");

  // P1: a valid membership witness satisfies every R1CS constraint (positive control).
  await test("P1: valid Poseidon2 Merkle witness satisfies every R1CS constraint", async () => {
    const w = buildTransferWitness(poseidon, compress);
    await calcWitness(w);
  });

  // P2 (malicious witness, class 1): claim a merkleRoot that the real path does not
  // produce. Mirrors T41 in transfer.test.mjs.
  await test("P2: wrong merkleRoot rejected at witness generation (C0)", async () => {
    const w = buildTransferWitness(poseidon, compress);
    w.merkleRoot = w.merkleRoot + 1n;
    let threw = false;
    try { await calcWitness(w); } catch { threw = true; }
    assert(threw, "wrong merkleRoot must fail witness generation");
  });

  // P3 (malicious witness, class 2): tamper a sibling but leave the (now-inconsistent)
  // root as originally computed. Mirrors T42.
  await test("P3: tampered Merkle sibling rejected at witness generation (C0)", async () => {
    const w = buildTransferWitness(poseidon, compress);
    w.pathElements = [...w.pathElements];
    w.pathElements[0] = 999n;
    let threw = false;
    try { await calcWitness(w); } catch { threw = true; }
    assert(threw, "tampered sibling must fail witness generation");
  });

  // P4 (malicious witness, class 3): a non-boolean pathIndices entry tries to abuse
  // MultiMux1's selector. The shared `pathIndices[i] * (1 - pathIndices[i]) === 0`
  // constraint (unchanged by this experiment — it lives in MerkleProofV2 exactly as in
  // MerkleProof) must still catch it. Mirrors T43.
  await test("P4: non-boolean pathIndices rejected at witness generation", async () => {
    const w = buildTransferWitness(poseidon, compress);
    w.pathIndices = [...w.pathIndices];
    w.pathIndices[3] = 2n;
    let threw = false;
    try { await calcWitness(w); } catch { threw = true; }
    assert(threw, "non-boolean path index must fail witness generation");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
