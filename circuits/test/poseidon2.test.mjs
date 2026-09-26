/**
 * poseidon2.test.mjs — Correctness and soundness tests for the Poseidon2
 * Merkle-path variant (docs/research/2026-09-26-poseidon2-merkle-path.md).
 *
 * Three layers, each narrower than the last:
 *
 *   1. Raw permutation (test/circuits/poseidon2_t2_raw.circom) against the
 *      @taceo/poseidon2 JS reference — same publisher as the circom template
 *      (@taceo/circom-lib), explicit "parity to the Rust taceo-poseidon2
 *      crate" claim in its README. This is the primary correctness check:
 *      if the circom template's round constants, S-box, or matrix logic
 *      were wrong, it would disagree with the JS permutation on essentially
 *      every random input.
 *   2. The 2-to-1 compression construction (test/circuits/
 *      poseidon2_compress2.circom) against a JS re-implementation of the
 *      same feed-forward formula over that same reference permutation.
 *   3. The full MerkleProofPoseidon2(20) template (bench-circuits/
 *      merkle20_poseidon2.circom) — a valid root computation, plus the
 *      three negative tests transfer.test.mjs already runs against the
 *      original MerkleProof (T41–T43), mirrored here: wrong root, tampered
 *      sibling, non-boolean path index all rejected.
 *
 * Layer 3's circuits are compiled on the fly by circom_tester (needs
 * `circom` on PATH — see docs/research/2026-09-26-poseidon2-merkle-path.md
 * for how it was built in this environment).
 *
 * Run: node --experimental-vm-modules test/poseidon2.test.mjs
 */
import { createRequire } from "module";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const wasm_tester = require("circom_tester").wasm;
const { bn254 } = require("@taceo/poseidon2");

const __dirname = dirname(fileURLToPath(import.meta.url));
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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

function randomFieldElement(rng) {
  let v = 0n;
  for (let i = 0; i < 4; i++) v = (v << 16n) | BigInt(rng() & 0xffff);
  return v % P;
}
// Deterministic PRNG so failures are reproducible without a fixed seed file.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

/** Re-implementation of the compression formula, independent of the circuit. */
function compress2Ref(left, right) {
  const state = bn254.t2.permutation([left, right]);
  return (state[0] + left) % P;
}

async function main() {
  console.log("=== Veil Poseidon2 Merkle-path — correctness & soundness tests ===\n");
  const rng = mulberry32(0xC0FFEE);

  // ═══════════════════════════════════════════════════════════════════════
  // LAYER 1: raw permutation vs @taceo/poseidon2 JS reference
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- Layer 1: Poseidon2(t=2) permutation vs JS reference ---");
  const permCircuit = await wasm_tester(path.join(__dirname, "circuits", "poseidon2_t2_raw.circom"), {
    include: [path.join(__dirname, "..", "node_modules")],
  });

  await test("P1: permutation([0,0]) matches reference", async () => {
    const w = await permCircuit.calculateWitness({ in: [0n, 0n] }, true);
    await permCircuit.checkConstraints(w);
    const expected = bn254.t2.permutation([0n, 0n]);
    await permCircuit.assertOut(w, { out: expected });
  });

  await test("P2: permutation([1,2]) matches reference", async () => {
    const w = await permCircuit.calculateWitness({ in: [1n, 2n] }, true);
    await permCircuit.checkConstraints(w);
    const expected = bn254.t2.permutation([1n, 2n]);
    await permCircuit.assertOut(w, { out: expected });
  });

  await test("P3: 25 random inputs all match reference", async () => {
    for (let i = 0; i < 25; i++) {
      const a = randomFieldElement(rng), b = randomFieldElement(rng);
      const w = await permCircuit.calculateWitness({ in: [a, b] }, true);
      await permCircuit.checkConstraints(w);
      const expected = bn254.t2.permutation([a, b]);
      await permCircuit.assertOut(w, { out: expected });
    }
  });

  await test("P4: permutation is not the identity (sanity — catches a no-op template)", async () => {
    const w = await permCircuit.calculateWitness({ in: [5n, 7n] }, true);
    const out0 = w[permCircuit.symbols["main.out[0]"].varIdx];
    assert(out0.toString() !== "5", "P4: out[0] must not equal in[0] — permutation looks like a no-op");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LAYER 2: compression construction (Miyaguchi-Preneel feed-forward)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- Layer 2: 2-to-1 compression (out = perm(in)[0] + left) ---");
  const compressCircuit = await wasm_tester(path.join(__dirname, "circuits", "poseidon2_compress2.circom"), {
    include: [path.join(__dirname, "..", "node_modules")],
  });

  await test("C1: compress2(0,0) matches reference formula", async () => {
    const w = await compressCircuit.calculateWitness({ left: 0n, right: 0n }, true);
    await compressCircuit.checkConstraints(w);
    await compressCircuit.assertOut(w, { out: compress2Ref(0n, 0n) });
  });

  await test("C2: 25 random (left,right) pairs match reference formula", async () => {
    for (let i = 0; i < 25; i++) {
      const l = randomFieldElement(rng), r = randomFieldElement(rng);
      const w = await compressCircuit.calculateWitness({ left: l, right: r }, true);
      await compressCircuit.checkConstraints(w);
      await compressCircuit.assertOut(w, { out: compress2Ref(l, r) });
    }
  });

  await test("C3: compress2(a,b) != compress2(b,a) for a != b (feed-forward breaks symmetry)", async () => {
    const a = 111n, b = 222n;
    const wab = await compressCircuit.calculateWitness({ left: a, right: b }, true);
    const wba = await compressCircuit.calculateWitness({ left: b, right: a }, true);
    const outAB = wab[compressCircuit.symbols["main.out"].varIdx].toString();
    const outBA = wba[compressCircuit.symbols["main.out"].varIdx].toString();
    assert(outAB !== outBA, "C3: left/right must not be interchangeable — MultiMux1 in the Merkle template relies on this for L/R positioning to matter");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LAYER 3: full MerkleProofPoseidon2(20) — valid proof + negative tests
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- Layer 3: MerkleProofPoseidon2(20) — root computation + negative tests ---");
  const merkleCircuit = await wasm_tester(path.join(__dirname, "..", "bench-circuits", "merkle20_poseidon2.circom"), {
    include: [path.join(__dirname, "..", "node_modules")],
  });

  function merkleRootP2(leaf, pathElements, pathIndices) {
    let node = leaf;
    for (let i = 0; i < pathElements.length; i++) {
      const [left, right] = pathIndices[i] === 0n ? [node, pathElements[i]] : [pathElements[i], node];
      node = compress2Ref(left, right);
    }
    return node;
  }

  const leaf = 424242n;
  const pathElements = Array.from({ length: 20 }, (_, i) => BigInt(1000 + i));
  const pathIndices = Array.from({ length: 20 }, (_, i) => BigInt(i % 2));
  const expectedRoot = merkleRootP2(leaf, pathElements, pathIndices);

  await test("M1: valid path computes the expected root", async () => {
    const w = await merkleCircuit.calculateWitness(
      { leaf, pathElements, pathIndices }, true,
    );
    await merkleCircuit.checkConstraints(w);
    await merkleCircuit.assertOut(w, { root: expectedRoot });
  });

  await test("M2 (negative): tampered sibling produces a different root, not a matching one", async () => {
    const tampered = [...pathElements];
    tampered[0] = tampered[0] + 1n;
    const w = await merkleCircuit.calculateWitness(
      { leaf, pathElements: tampered, pathIndices }, true,
    );
    const actualRoot = w[merkleCircuit.symbols["main.root"].varIdx];
    assert(
      actualRoot.toString() !== expectedRoot.toString(),
      "M2: a forged sibling must not reproduce the honest root — otherwise membership is not sound",
    );
  });

  await test("M3 (negative): non-boolean pathIndices is rejected at witness generation", async () => {
    const badIndices = [...pathIndices];
    badIndices[3] = 2n; // not 0 or 1 — violates idx*(1-idx) === 0
    let threw = false;
    try {
      await merkleCircuit.calculateWitness({ leaf, pathElements, pathIndices: badIndices }, true);
    } catch {
      threw = true;
    }
    assert(threw, "M3: a non-boolean path index must fail witness generation, exactly like the original MerkleProof template");
  });

  await test("M4 (negative): a witness for the wrong leaf does not match the honest root", async () => {
    const w = await merkleCircuit.calculateWitness(
      { leaf: leaf + 1n, pathElements, pathIndices }, true,
    );
    const actualRoot = w[merkleCircuit.symbols["main.root"].varIdx];
    assert(
      actualRoot.toString() !== expectedRoot.toString(),
      "M4: a different leaf must not collide onto the same root under this path",
    );
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
