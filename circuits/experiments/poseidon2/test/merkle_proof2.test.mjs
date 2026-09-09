/**
 * merkle_proof2.test.mjs — soundness checks for the Poseidon2-compression Merkle hasher
 * (templates/merkle_proof2.circom), the one piece of this experiment with a real, measured
 * constraint-count win (see the experiment report). Two properties, both required for it to be
 * a safe Merkle accumulator hasher, neither assumed:
 *
 *   1. BINDING — swapping the leaf (with the same sibling path) must not silently produce the
 *      same root. If it did, the accumulator would not actually bind a leaf to its position: an
 *      observer could not tell two different commitments apart from their Merkle proof alone,
 *      and — worse — a malicious prover could potentially open one root to two different leaves.
 *      This is exactly the failure mode a naive (non-feed-forward) "hash = permutation output"
 *      compression function would have: Poseidon2's permutation is a public bijection, so without
 *      the Miyaguchi-Preneel feed-forward (`out = permutation(left,right)[0] + left`) in
 *      merkle_proof2.circom, two different (left,right) pairs could not collide by luck, but nothing
 *      would stop an attacker who can compute the inverse permutation from finding one that does —
 *      the feed-forward removes that route. This test doesn't try to break the feed-forward
 *      cryptographically (that reduces to Poseidon2's assumed pseudorandomness, the same assumption
 *      the whole construction relies on) — it checks the wiring: that the circuit's *output signal*
 *      actually depends on the leaf, i.e. no under-constrained signal silently drops the leaf from
 *      the computation (the exact bug class `docs/zk-vulnerability-research.md` flags for Poseidon
 *      circuits generally).
 *
 *   2. PATH-INDEX BOOLEAN CONSTRAINT — `pathIndices[i] * (1 - pathIndices[i]) === 0` (copied
 *      verbatim from the original templates/merkle_proof.circom) must still reject a non-boolean
 *      index. Without it, `pathIndices[i] = 2` would make `MultiMux1`'s linear interpolation
 *      produce values that are neither `(nodes[i], pathElements[i])` nor `(pathElements[i],
 *      nodes[i])` — an out-of-domain "third" opening a malicious prover could exploit to satisfy a
 *      root the honest tree never produced. This is the one soundness-critical constraint carried
 *      over unchanged from the original template; this test exists so a future edit to
 *      merkle_proof2.circom that accidentally drops it fails loudly.
 *
 * Both checks run at the witness-generation layer (`snarkjs.wtns.calculate` against the compiled
 * wasm) rather than a full Groth16 prove — witness calculation already evaluates every `===`
 * constraint and throws on the first violation, which is the exact property both checks need, and
 * it needs no Powers of Tau / zkey (this experiment's ptau context is a from-scratch local
 * ceremony, see the report; that path is orthogonal to this test).
 *
 * Run: node --experimental-vm-modules test/merkle_proof2.test.mjs
 * Prerequisite: circom .../micro/newmerkle.circom --r1cs --wasm -o build (see report for exact command)
 */

import { existsSync, promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WitnessCalculatorBuilder } from "circom_runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "micro", "build", "newmerkle_js", "newmerkle.wasm");
const DEPTH = 20;

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

let wc = null;
async function calculateWitness(input) {
  if (!wc) {
    const wasm = await fs.readFile(WASM_PATH);
    wc = await WitnessCalculatorBuilder(wasm);
  }
  return wc.calculateWitness(input, false);
}

// witness[0] = 1 (constant), witness[1] = root output (first, and only, public/output signal —
// circom orders outputs before inputs after the constant wire for a template with one output).
function rootFromWitness(w) {
  return BigInt(w[1]);
}

async function main() {
  if (!existsSync(WASM_PATH)) {
    console.log(`[SKIP] wasm not found at ${WASM_PATH} — compile micro/newmerkle.circom first (see report).`);
    return;
  }

  let passed = 0;

  // Deterministic, arbitrary path — any fixed depth-20 path works; this test only cares about the
  // *relationship* between leaf and root, not any specific tree.
  const pathElements = Array.from({ length: DEPTH }, (_, i) => BigInt(1000 + i));
  const pathIndices = Array.from({ length: DEPTH }, (_, i) => i % 2);

  // ── 1. BINDING: changing the leaf must change the root ─────────────────────
  const leafA = 12345n;
  const leafB = 67890n;

  const wA = await calculateWitness({ leaf: leafA, pathElements, pathIndices });
  const wB = await calculateWitness({ leaf: leafB, pathElements, pathIndices });

  const rootA = rootFromWitness(wA);
  const rootB = rootFromWitness(wB);

  assert(rootA !== rootB, "binding: two different leaves on the same path must not produce the same root");
  assert(rootA !== 0n && rootB !== 0n, "binding: root must not degenerate to zero");
  console.log(`[PASS] binding: leaf ${leafA} -> root ${rootA}, leaf ${leafB} -> root ${rootB} (distinct)`);
  passed++;

  // Same leaf, same path, twice — determinism sanity check (not a security property, but a bug in
  // the witness calculator itself would invalidate the two checks above).
  const wA2 = await calculateWitness({ leaf: leafA, pathElements, pathIndices });
  assert(rootFromWitness(wA2) === rootA, "determinism: same inputs must produce the same root");
  console.log("[PASS] determinism: repeated witness calculation is stable");
  passed++;

  // ── 2. PATH-INDEX BOOLEAN CONSTRAINT: a malicious non-boolean index is rejected ─────────────
  const maliciousIndices = [...pathIndices];
  maliciousIndices[0] = 2; // out of {0,1}

  let rejected = false;
  try {
    await calculateWitness({ leaf: leafA, pathElements, pathIndices: maliciousIndices });
  } catch (err) {
    rejected = true;
    assert(
      /Assert Failed|assert/i.test(String(err.message ?? err)),
      `expected an assertion failure, got: ${err}`,
    );
  }
  assert(rejected, "malicious witness: pathIndices[0] = 2 must be rejected, not silently accepted");
  console.log("[PASS] malicious witness: non-boolean pathIndices[0] = 2 is rejected at witness generation");
  passed++;

  console.log(`\n${passed}/3 checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
