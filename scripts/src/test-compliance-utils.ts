/**
 * test-compliance-utils.ts
 *
 * Tests for the Veil Tier 3 compliance utilities:
 * credential leaf, compliance nullifier, Merkle tree builder, and Merkle proof extractor.
 *
 * Run with: npx tsx src/test-compliance-utils.ts
 */

import { buildPoseidon } from "circomlibjs";
import type { PoseidonFunction } from "circomlibjs";

import {
  computeCredentialLeaf,
  computeCredentialNullifier,
  buildMerkleTree,
  getMerkleProof,
} from "./compliance-utils.js";

// ---------------------------------------------------------------------------
// Minimal test runner (same pattern as test-converter.ts)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (got ${actual}, expected ${expected})`);
}

function section(name: string): void {
  console.log(`\n[${name}]`);
}

// ---------------------------------------------------------------------------
// Setup — build Poseidon instance once
// ---------------------------------------------------------------------------

const poseidon: PoseidonFunction = await buildPoseidon();
const F = poseidon.F;

// Sample inputs for reuse across tests
const SECRET_A = 1234567890123456789n;
const SECRET_B = 9876543210987654321n;
const KYC_LEVEL_1 = 1n;
const KYC_LEVEL_2 = 2n;
const EXPIRY_EPOCH = 1000n;
const ISSUER_ID = 42n;
const CONTEXT_ID_A = 111n;
const CONTEXT_ID_B = 222n;

// ---------------------------------------------------------------------------
// T1: computeCredentialLeaf — determinism and domain separation
// ---------------------------------------------------------------------------

section("computeCredentialLeaf — determinism");

{
  // Same inputs → same leaf (deterministic hash)
  const leaf1 = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const leaf2 = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  assert(leaf1 === leaf2, "computeCredentialLeaf: same inputs → same leaf (deterministic)");
}

{
  // Returns a bigint
  const leaf = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  assert(typeof leaf === "bigint", "computeCredentialLeaf: returns bigint");
}

{
  // Output is a non-zero positive bigint (Poseidon output on BN254 is always in [1, p-1])
  const leaf = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  assert(leaf > 0n, "computeCredentialLeaf: output > 0");
}

section("computeCredentialLeaf — different inputs produce different leaves");

{
  // Different userSecret → different leaf
  const leafA = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const leafB = computeCredentialLeaf(poseidon, F, SECRET_B, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  assert(leafA !== leafB, "computeCredentialLeaf: different userSecret → different leaf");
}

{
  // Different kycLevel → different leaf
  const leafA = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const leafB = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_2, EXPIRY_EPOCH, ISSUER_ID);
  assert(leafA !== leafB, "computeCredentialLeaf: different kycLevel → different leaf");
}

{
  // Different expiryEpoch → different leaf
  const leafA = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const leafB = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH + 1n, ISSUER_ID);
  assert(leafA !== leafB, "computeCredentialLeaf: different expiryEpoch → different leaf");
}

{
  // Different issuerId → different leaf
  const leafA = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const leafB = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID + 1n);
  assert(leafA !== leafB, "computeCredentialLeaf: different issuerId → different leaf");
}

section("computeCredentialLeaf — domain tag 4 differs from tag 1");

{
  // Manual Poseidon with domain 1 vs. computeCredentialLeaf (domain 4) — must differ
  // even when all other inputs are identical.
  // Poseidon(1, userSecret, kycLevel, expiryEpoch, issuerId) vs Poseidon(4, ...)
  const domain1Result = poseidon([1n, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID]);
  const tagOneLeaf = F.toObject(domain1Result);
  const tagFourLeaf = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  assert(tagOneLeaf !== tagFourLeaf, "computeCredentialLeaf: domain tag 4 differs from domain tag 1");
}

{
  // Domain 4 also differs from domain 2 and 3
  const domain2Result = poseidon([2n, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID]);
  const domain3Result = poseidon([3n, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID]);
  const tagTwoLeaf = F.toObject(domain2Result);
  const tagThreeLeaf = F.toObject(domain3Result);
  const tagFourLeaf = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  assert(tagFourLeaf !== tagTwoLeaf, "computeCredentialLeaf: domain tag 4 differs from tag 2");
  assert(tagFourLeaf !== tagThreeLeaf, "computeCredentialLeaf: domain tag 4 differs from tag 3");
}

// ---------------------------------------------------------------------------
// T2: computeCredentialNullifier — determinism and domain separation
// ---------------------------------------------------------------------------

section("computeCredentialNullifier — determinism");

{
  // Same inputs → same nullifier
  const nf1 = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  const nf2 = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  assert(nf1 === nf2, "computeCredentialNullifier: same inputs → same nullifier (deterministic)");
}

{
  // Returns a bigint
  const nf = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  assert(typeof nf === "bigint", "computeCredentialNullifier: returns bigint");
}

{
  // Output is non-zero
  const nf = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  assert(nf > 0n, "computeCredentialNullifier: output > 0");
}

section("computeCredentialNullifier — different inputs produce different nullifiers");

{
  // Different userSecret → different nullifier
  const nfA = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  const nfB = computeCredentialNullifier(poseidon, F, SECRET_B, CONTEXT_ID_A);
  assert(nfA !== nfB, "computeCredentialNullifier: different userSecret → different nullifier");
}

{
  // Different contextId → different nullifier
  const nfA = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  const nfB = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_B);
  assert(nfA !== nfB, "computeCredentialNullifier: different contextId → different nullifier");
}

section("computeCredentialNullifier — domain tag 5 differs from tag 2");

{
  // Manual Poseidon with domain 2 (transfer nullifier tag) vs. domain 5 (compliance nullifier)
  const domain2Result = poseidon([2n, SECRET_A, CONTEXT_ID_A]);
  const tagTwoNullifier = F.toObject(domain2Result);
  const tagFiveNullifier = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  assert(tagTwoNullifier !== tagFiveNullifier, "computeCredentialNullifier: domain tag 5 differs from tag 2");
}

{
  // Domain 5 also differs from domain 1, 3, 4
  const domain1Result = poseidon([1n, SECRET_A, CONTEXT_ID_A]);
  const domain3Result = poseidon([3n, SECRET_A, CONTEXT_ID_A]);
  const domain4Result = poseidon([4n, SECRET_A, CONTEXT_ID_A]);
  const nf = computeCredentialNullifier(poseidon, F, SECRET_A, CONTEXT_ID_A);
  assert(nf !== F.toObject(domain1Result), "computeCredentialNullifier: domain 5 differs from 1");
  assert(nf !== F.toObject(domain3Result), "computeCredentialNullifier: domain 5 differs from 3");
  assert(nf !== F.toObject(domain4Result), "computeCredentialNullifier: domain 5 differs from 4");
}

// ---------------------------------------------------------------------------
// T3: buildMerkleTree — structure and consistency
// ---------------------------------------------------------------------------

section("buildMerkleTree — basic structure");

{
  // Single leaf, depth 1: tree has 2 layers (leaves + root)
  const tree = buildMerkleTree(poseidon, F, [100n], 1);
  assertEqual(tree.layers.length, 2, "depth=1: layers.length = 2");
  assertEqual(tree.layers[0].length, 2, "depth=1: leaf layer has 2 entries");
  assertEqual(tree.layers[1].length, 1, "depth=1: root layer has 1 entry");
  assert(typeof tree.root === "bigint", "depth=1: root is bigint");
}

{
  // depth=3: 4 layers (leaves=8, level3=4, level2=2, root=1)
  const leaves = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];
  const tree = buildMerkleTree(poseidon, F, leaves, 3);
  assertEqual(tree.layers.length, 4, "depth=3: layers.length = 4");
  assertEqual(tree.layers[0].length, 8, "depth=3: leaf layer has 8 entries");
  assertEqual(tree.layers[1].length, 4, "depth=3: level 1 has 4 entries");
  assertEqual(tree.layers[2].length, 2, "depth=3: level 2 has 2 entries");
  assertEqual(tree.layers[3].length, 1, "depth=3: root layer has 1 entry");
}

{
  // root equals tree.layers[depth][0]
  const leaves = [42n, 43n];
  const tree = buildMerkleTree(poseidon, F, leaves, 1);
  assertEqual(tree.root, tree.layers[1][0], "buildMerkleTree: root === layers[depth][0]");
}

{
  // Root is non-zero for non-trivial leaves
  const leaves = [1n, 2n, 3n, 4n];
  const tree = buildMerkleTree(poseidon, F, leaves, 2);
  assert(tree.root > 0n, "buildMerkleTree: root > 0 for non-trivial leaves");
}

section("buildMerkleTree — consistency");

{
  // Same leaves → same root (deterministic)
  const leaves = [10n, 20n, 30n, 40n];
  const tree1 = buildMerkleTree(poseidon, F, leaves, 2);
  const tree2 = buildMerkleTree(poseidon, F, leaves, 2);
  assert(tree1.root === tree2.root, "buildMerkleTree: same leaves → same root");
}

{
  // Different leaves → different root
  const leavesA = [1n, 2n, 3n, 4n];
  const leavesB = [1n, 2n, 3n, 5n];
  const treeA = buildMerkleTree(poseidon, F, leavesA, 2);
  const treeB = buildMerkleTree(poseidon, F, leavesB, 2);
  assert(treeA.root !== treeB.root, "buildMerkleTree: different leaves → different root");
}

{
  // Leaf order matters: [1,2] and [2,1] produce different roots
  const tree12 = buildMerkleTree(poseidon, F, [1n, 2n], 1);
  const tree21 = buildMerkleTree(poseidon, F, [2n, 1n], 1);
  assert(tree12.root !== tree21.root, "buildMerkleTree: [1,2] and [2,1] differ");
}

{
  // Padding: providing fewer leaves than capacity still produces same root as explicitly padding with 0n
  const explicit = buildMerkleTree(poseidon, F, [5n, 0n, 0n, 0n], 2);
  const padded = buildMerkleTree(poseidon, F, [5n], 2);
  assert(explicit.root === padded.root, "buildMerkleTree: implicit 0n padding matches explicit 0n");
}

section("buildMerkleTree — depth 20");

{
  // Depth 20 is the compliance circuit depth — must not throw and root must be bigint
  const leaf = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const tree = buildMerkleTree(poseidon, F, [leaf], 20);
  assert(typeof tree.root === "bigint", "depth=20: root is bigint");
  assert(tree.root > 0n, "depth=20: root > 0");
  assertEqual(tree.layers.length, 21, "depth=20: layers.length = 21");
  assertEqual(tree.layers[0].length, 1 << 20, "depth=20: leaf layer has 2^20 entries");
}

section("buildMerkleTree — edge case: empty tree");

{
  // Empty leaves: all padding → root is still a valid bigint (all-zero leaf tree)
  const tree = buildMerkleTree(poseidon, F, [], 3);
  assert(typeof tree.root === "bigint", "empty tree: root is bigint");
  assertEqual(tree.layers[0].length, 8, "empty tree (depth=3): 8 leaf slots");
  // All leaves are 0n
  assert(tree.layers[0].every((v) => v === 0n), "empty tree: all leaf values are 0n");
}

section("buildMerkleTree — edge case: too many leaves throws");

{
  // More leaves than capacity must throw
  let threw = false;
  try {
    buildMerkleTree(poseidon, F, [1n, 2n, 3n, 4n, 5n], 2); // capacity = 4
  } catch {
    threw = true;
  }
  assert(threw, "buildMerkleTree: more leaves than capacity → throws");
}

// ---------------------------------------------------------------------------
// T4: getMerkleProof — manual verification for depth 3
// ---------------------------------------------------------------------------

section("getMerkleProof — depth 3 structure");

const LEAVES_D3 = [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n];
const TREE_D3 = buildMerkleTree(poseidon, F, LEAVES_D3, 3);

{
  // pathElements and pathIndices have length = depth
  const proof = getMerkleProof(TREE_D3.layers, 0, 3);
  assertEqual(proof.pathElements.length, 3, "getMerkleProof depth=3: pathElements.length = 3");
  assertEqual(proof.pathIndices.length, 3, "getMerkleProof depth=3: pathIndices.length = 3");
}

{
  // pathIndices values are only 0 or 1
  const proof = getMerkleProof(TREE_D3.layers, 0, 3);
  assert(
    proof.pathIndices.every((v) => v === 0 || v === 1),
    "getMerkleProof: pathIndices are all 0 or 1",
  );
}

{
  // Leaf at index 0 is a left child at every level: pathIndices = [0, 0, 0]
  const proof = getMerkleProof(TREE_D3.layers, 0, 3);
  assertEqual(proof.pathIndices[0], 0, "index=0: pathIndices[0] = 0 (left child at level 0)");
  assertEqual(proof.pathIndices[1], 0, "index=0: pathIndices[1] = 0 (left child at level 1)");
  assertEqual(proof.pathIndices[2], 0, "index=0: pathIndices[2] = 0 (left child at level 2)");
}

{
  // Leaf at index 1 is right child at level 0: pathIndices[0] = 1
  const proof = getMerkleProof(TREE_D3.layers, 1, 3);
  assertEqual(proof.pathIndices[0], 1, "index=1: pathIndices[0] = 1 (right child at level 0)");
  assertEqual(proof.pathIndices[1], 0, "index=1: pathIndices[1] = 0 (left child at level 1)");
}

{
  // Leaf at index 7 (last) is right child at all levels: pathIndices = [1, 1, 1]
  const proof = getMerkleProof(TREE_D3.layers, 7, 3);
  assertEqual(proof.pathIndices[0], 1, "index=7: pathIndices[0] = 1");
  assertEqual(proof.pathIndices[1], 1, "index=7: pathIndices[1] = 1");
  assertEqual(proof.pathIndices[2], 1, "index=7: pathIndices[2] = 1");
}

section("getMerkleProof — manual Merkle proof verification for depth 3");

function verifyMerkleProof(
  leaf: bigint,
  proof: { pathElements: bigint[]; pathIndices: number[] },
  expectedRoot: bigint,
): boolean {
  let current = leaf;
  for (let i = 0; i < proof.pathElements.length; i++) {
    const sibling = proof.pathElements[i];
    let left: bigint;
    let right: bigint;
    if (proof.pathIndices[i] === 0) {
      // Current node is left child
      left = current;
      right = sibling;
    } else {
      // Current node is right child
      left = sibling;
      right = current;
    }
    const nodeResult = poseidon([left, right]);
    current = F.toObject(nodeResult);
  }
  return current === expectedRoot;
}

{
  // Every leaf in depth=3 tree must produce a valid proof
  for (let i = 0; i < 8; i++) {
    const proof = getMerkleProof(TREE_D3.layers, i, 3);
    const valid = verifyMerkleProof(LEAVES_D3[i], proof, TREE_D3.root);
    assert(valid, `getMerkleProof depth=3: proof valid for leaf index ${i}`);
  }
}

{
  // Wrong leaf value → proof verification must fail
  const proof = getMerkleProof(TREE_D3.layers, 0, 3);
  const invalid = verifyMerkleProof(999n, proof, TREE_D3.root);
  assert(!invalid, "getMerkleProof: wrong leaf → proof verification fails");
}

section("getMerkleProof — verification for depth 20 with credential leaf");

{
  // Build a depth-20 tree with one real credential leaf and verify its proof
  const credLeaf = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const tree20 = buildMerkleTree(poseidon, F, [credLeaf], 20);
  const proof = getMerkleProof(tree20.layers, 0, 20);
  assertEqual(proof.pathElements.length, 20, "depth=20: pathElements.length = 20");
  const valid = verifyMerkleProof(credLeaf, proof, tree20.root);
  assert(valid, "getMerkleProof depth=20: credential leaf proof verifies against root");
}

{
  // Sibling of index 0 at level 0 must be layers[0][1] (zero padded)
  const credLeaf = computeCredentialLeaf(poseidon, F, SECRET_A, KYC_LEVEL_1, EXPIRY_EPOCH, ISSUER_ID);
  const tree20 = buildMerkleTree(poseidon, F, [credLeaf], 20);
  const proof = getMerkleProof(tree20.layers, 0, 20);
  assertEqual(proof.pathElements[0], tree20.layers[0][1], "depth=20: pathElements[0] = layers[0][1] (sibling)");
}

section("getMerkleProof — error cases");

{
  // Out-of-range index must throw
  let threw = false;
  try {
    getMerkleProof(TREE_D3.layers, 100, 3);
  } catch {
    threw = true;
  }
  assert(threw, "getMerkleProof: index >= capacity → throws");
}

{
  // Mismatched depth must throw
  let threw = false;
  try {
    getMerkleProof(TREE_D3.layers, 0, 99);
  } catch {
    threw = true;
  }
  assert(threw, "getMerkleProof: depth mismatch → throws");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\nSome tests failed.`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed.`);
}
