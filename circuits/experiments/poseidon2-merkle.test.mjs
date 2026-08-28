/**
 * poseidon2-merkle.test.mjs — correctness + negative tests for the
 * Poseidon2-compression Merkle template (templates/merkle_proof_poseidon2.circom).
 *
 * This is NOT a production circuit test — it validates the experimental
 * Poseidon2 Merkle-node hash evaluated in
 * docs/research/2026-08-28-poseidon2-merkle-hash.md, kept alongside the
 * benchmark circuits under circuits/experiments/ rather than circuits/test/
 * to keep it clearly separated from the production suite it does not touch.
 *
 * 1. Cross-checks the compiled circuit's root against an independent JS
 *    reimplementation of the same compression construction, built on the
 *    @taceo/poseidon2 reference permutation (not circomlibjs — there is no
 *    Poseidon2 support there).
 * 2. Negative tests: a tampered sibling, a tampered leaf, and an
 *    out-of-range path-index bit must all be rejected (witness generation
 *    throws — the equality/boolean constraints are unsatisfiable).
 *
 * Run: node experiments/poseidon2-merkle.test.mjs
 */
import { existsSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { bn254 } from "@taceo/poseidon2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "build-experiments", "membership-p2", "merkle_membership_poseidon2_js", "merkle_membership_poseidon2.wasm");
const DEPTH = 20;
const TMP_DIR = mkdtempSync(join(tmpdir(), "veil-poseidon2-"));
let wtnsCounter = 0;

let passed = 0, failed = 0;

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}

// Same construction as templates/merkle_proof_poseidon2.circom:
//   node = Poseidon2Perm(t=2)([left, right])[0] + left
function poseidon2Compress(left, right) {
  const [out0] = bn254.t2.permutation([left, right]);
  return (out0 + left) % FIELD;
}

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function merkleRootFromPath(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < DEPTH; i++) {
    const [left, right] = pathIndices[i] === 0n
      ? [node, pathElements[i]]
      : [pathElements[i], node];
    node = poseidon2Compress(left, right);
  }
  return node;
}

function randomField() {
  let x = 0n;
  for (let i = 0; i < 8; i++) x = (x << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32));
  return x % FIELD;
}

async function calculateWitness(inputs) {
  const stringInputs = {};
  for (const [k, v] of Object.entries(inputs)) {
    stringInputs[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  const wtnsPath = join(TMP_DIR, `w${wtnsCounter++}.wtns`);
  return snarkjs.wtns.calculate(stringInputs, WASM_PATH, wtnsPath);
}

async function main() {
  console.log("=== Poseidon2 Merkle-hash correctness + negative tests ===\n");

  if (!existsSync(WASM_PATH)) {
    console.log(`WASM not found at ${WASM_PATH} — compile experiments/merkle_membership_poseidon2.circom first.`);
    process.exit(1);
  }

  const leaf = randomField();
  const pathElements = Array.from({ length: DEPTH }, randomField);
  const pathIndices = Array.from({ length: DEPTH }, () => BigInt(Math.random() < 0.5 ? 0 : 1));
  const expectedRoot = merkleRootFromPath(leaf, pathElements, pathIndices);

  await test("P1: valid witness accepted, root matches independent JS re-implementation", async () => {
    await calculateWitness({ leaf, pathElements, pathIndices, expectedRoot });
  });

  await test("P2: known-answer vector matches @taceo/poseidon2 reference permutation directly", async () => {
    // perm([1,2]) under bn254 t=2 — same value independently cross-checked
    // against the compiled circuit's own witness output for Poseidon2(2)
    // in poseidon2_perm_t2.circom (see the experiment report's raw output).
    const [out0, out1] = bn254.t2.permutation([1n, 2n]);
    assert(
      out0 === 6588139247708940112588203339651261153905233202198520634825199962343944922546n,
      `perm([1,2])[0] mismatch: ${out0}`,
    );
    assert(
      out1 === 21813839764150077922933522808865392160783296505566234246065032573361889065726n,
      `perm([1,2])[1] mismatch: ${out1}`,
    );
  });

  await test("N1: tampered sibling (wrong pathElements[5]) is rejected", async () => {
    const badPath = [...pathElements];
    badPath[5] = (badPath[5] + 1n) % FIELD;
    let threw = false;
    try {
      await calculateWitness({ leaf, pathElements: badPath, pathIndices, expectedRoot });
    } catch {
      threw = true;
    }
    assert(threw, "Witness generation must fail for a tampered sibling");
  });

  await test("N2: tampered leaf (different leaf, same path/root) is rejected", async () => {
    let threw = false;
    try {
      await calculateWitness({ leaf: (leaf + 1n) % FIELD, pathElements, pathIndices, expectedRoot });
    } catch {
      threw = true;
    }
    assert(threw, "Witness generation must fail for a tampered leaf");
  });

  await test("N3: out-of-range pathIndices bit (2 instead of 0/1) is rejected", async () => {
    const badIndices = [...pathIndices];
    badIndices[3] = 2n;
    let threw = false;
    try {
      await calculateWitness({ leaf, pathElements, pathIndices: badIndices, expectedRoot });
    } catch {
      threw = true;
    }
    assert(threw, "Witness generation must fail for a non-boolean path index");
  });

  await test("N4: forged root without a valid path (random expectedRoot) is rejected", async () => {
    let threw = false;
    try {
      await calculateWitness({ leaf, pathElements, pathIndices, expectedRoot: randomField() });
    } catch {
      threw = true;
    }
    assert(threw, "Witness generation must fail for a forged root");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
