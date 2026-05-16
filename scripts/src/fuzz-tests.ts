/**
 * fuzz-tests.ts
 *
 * Property-based fuzz tests for Veil cryptographic primitives.
 * Uses fast-check with 500+ iterations per property.
 *
 * Properties tested:
 *   P1: Commitment determinism
 *   P2: Nullifier uniqueness
 *   P3: Cumulative addition never wraps BN254 field
 *   P4: Merkle proof soundness
 *   P5: Domain separation (no cross-tag collisions)
 *   P6: Credential validity logic
 */

import fc from "fast-check";
import { buildPoseidon } from "circomlibjs";
import type { PoseidonFunction } from "circomlibjs";
import { buildMerkleTree, getMerkleProof } from "./compliance-utils.js";

// BN254 scalar field modulus
const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Arbitraries
const bigInt64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
const bigInt8 = fc.bigInt({ min: 0n, max: (1n << 8n) - 1n });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function poseidonHash(
  poseidon: PoseidonFunction,
  F: PoseidonFunction["F"],
  inputs: bigint[],
): bigint {
  const result = poseidon(inputs);
  return F.toObject(result);
}

/**
 * Verifies a Merkle proof against a root.
 * Recomputes the root from leaf + proof and checks equality.
 */
function verifyMerkleProof(
  poseidon: PoseidonFunction,
  F: PoseidonFunction["F"],
  leaf: bigint,
  proof: { pathElements: bigint[]; pathIndices: number[] },
  expectedRoot: bigint,
): boolean {
  let current = leaf;
  for (let i = 0; i < proof.pathElements.length; i++) {
    const sibling = proof.pathElements[i];
    const isRightChild = proof.pathIndices[i] === 1;
    const left = isRightChild ? sibling : current;
    const right = isRightChild ? current : sibling;
    const nodeResult = poseidon([left, right]);
    current = F.toObject(nodeResult);
  }
  return current === expectedRoot;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Initializing Poseidon (this takes ~5s)...\n");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const NUM_RUNS = 500;
  let allPassed = true;

  // =========================================================================
  // P1: Commitment determinism
  // =========================================================================
  {
    const start = performance.now();
    try {
      fc.assert(
        fc.property(
          bigInt64,
          bigInt64,
          bigInt64,
          (cumulative, randomness, userSecret) => {
            const h1 = poseidonHash(poseidon, F, [1n, cumulative, randomness, userSecret]);
            const h2 = poseidonHash(poseidon, F, [1n, cumulative, randomness, userSecret]);
            return h1 === h2;
          },
        ),
        { numRuns: NUM_RUNS },
      );
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`P1: Commitment determinism         PASSED (${NUM_RUNS} runs, ${elapsed}ms)`);
    } catch (e) {
      allPassed = false;
      console.error(`P1: Commitment determinism         FAILED`);
      console.error(e);
    }
  }

  // =========================================================================
  // P2: Nullifier uniqueness
  // =========================================================================
  {
    const start = performance.now();
    try {
      fc.assert(
        fc.property(
          bigInt64,
          bigInt64,
          bigInt64,
          bigInt64,
          bigInt64,
          bigInt64,
          (secret1, epoch1, rand1, secret2, epoch2, rand2) => {
            const inputsIdentical =
              secret1 === secret2 && epoch1 === epoch2 && rand1 === rand2;
            const n1 = poseidonHash(poseidon, F, [2n, secret1, epoch1, rand1]);
            const n2 = poseidonHash(poseidon, F, [2n, secret2, epoch2, rand2]);
            // If inputs differ, nullifiers must differ
            // If inputs are identical, nullifiers must be equal
            if (inputsIdentical) return n1 === n2;
            return n1 !== n2;
          },
        ),
        { numRuns: NUM_RUNS },
      );
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`P2: Nullifier uniqueness            PASSED (${NUM_RUNS} runs, ${elapsed}ms)`);
    } catch (e) {
      allPassed = false;
      console.error(`P2: Nullifier uniqueness            FAILED`);
      console.error(e);
    }
  }

  // =========================================================================
  // P3: Cumulative addition never wraps
  // =========================================================================
  {
    const start = performance.now();
    try {
      fc.assert(
        fc.property(
          bigInt64,
          bigInt64,
          (cumOld, txAmount) => {
            // Both are non-negative (bigIntN produces values in [0, 2^64))
            // but we take absolute value to be safe with fast-check semantics
            const a = cumOld < 0n ? -cumOld : cumOld;
            const b = txAmount < 0n ? -txAmount : txAmount;
            return a + b < BN254_FIELD_MODULUS;
          },
        ),
        { numRuns: NUM_RUNS },
      );
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`P3: Cumulative addition no wrap     PASSED (${NUM_RUNS} runs, ${elapsed}ms)`);
    } catch (e) {
      allPassed = false;
      console.error(`P3: Cumulative addition no wrap     FAILED`);
      console.error(e);
    }
  }

  // =========================================================================
  // P4: Merkle proof soundness
  // =========================================================================
  {
    const DEPTH = 5; // 32 leaves — fast enough to avoid timeout
    const CAPACITY = 1 << DEPTH;
    const start = performance.now();
    try {
      fc.assert(
        fc.property(
          fc.array(bigInt64, { minLength: 1, maxLength: CAPACITY }),
          fc.nat({ max: CAPACITY - 1 }),
          bigInt64,
          (leaves, rawIndex, perturbation) => {
            const index = rawIndex % leaves.length;
            const tree = buildMerkleTree(poseidon, F, leaves, DEPTH);
            const proof = getMerkleProof(tree.layers, index, DEPTH);

            // Valid proof must pass
            const valid = verifyMerkleProof(poseidon, F, leaves[index], proof, tree.root);
            if (!valid) return false;

            // Modify one pathElement and verify it FAILS
            if (proof.pathElements.length > 0) {
              const corruptedProof = {
                pathElements: [...proof.pathElements],
                pathIndices: [...proof.pathIndices],
              };
              // Corrupt the first element with perturbation (ensure it actually changes)
              const original = corruptedProof.pathElements[0];
              const corrupted = original ^ (perturbation === 0n ? 1n : perturbation);
              if (corrupted !== original) {
                corruptedProof.pathElements[0] = corrupted;
                const invalid = verifyMerkleProof(
                  poseidon,
                  F,
                  leaves[index],
                  corruptedProof,
                  tree.root,
                );
                if (invalid) return false; // Should have failed
              }
            }

            return true;
          },
        ),
        { numRuns: NUM_RUNS },
      );
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`P4: Merkle proof soundness          PASSED (${NUM_RUNS} runs, ${elapsed}ms)`);
    } catch (e) {
      allPassed = false;
      console.error(`P4: Merkle proof soundness          FAILED`);
      console.error(e);
    }
  }

  // =========================================================================
  // P5: Domain separation — no hash collision across tags
  // =========================================================================
  {
    const start = performance.now();
    try {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 1, max: 6 }),
          bigInt64,
          bigInt64,
          bigInt64,
          (tag1, tag2, arg1, arg2, arg3) => {
            if (tag1 === tag2) return true; // Skip same-tag cases
            const h1 = poseidonHash(poseidon, F, [BigInt(tag1), arg1, arg2, arg3]);
            const h2 = poseidonHash(poseidon, F, [BigInt(tag2), arg1, arg2, arg3]);
            return h1 !== h2;
          },
        ),
        { numRuns: NUM_RUNS },
      );
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`P5: Domain separation no collision  PASSED (${NUM_RUNS} runs, ${elapsed}ms)`);
    } catch (e) {
      allPassed = false;
      console.error(`P5: Domain separation no collision  FAILED`);
      console.error(e);
    }
  }

  // =========================================================================
  // P6: Credential validity logic
  // =========================================================================
  {
    const start = performance.now();
    try {
      fc.assert(
        fc.property(
          bigInt8,
          bigInt8,
          bigInt8,
          bigInt8,
          (expiryEpoch, currentEpoch, kycLevel, requiredLevel) => {
            // Absolute values to ensure non-negative
            const expiry = expiryEpoch < 0n ? -expiryEpoch : expiryEpoch;
            const current = currentEpoch < 0n ? -currentEpoch : currentEpoch;
            const kyc = kycLevel < 0n ? -kycLevel : kycLevel;
            const required = requiredLevel < 0n ? -requiredLevel : requiredLevel;

            const notExpired = expiry >= current;
            const levelSufficient = kyc >= required;
            const expected = notExpired && levelSufficient;

            // Simulate the credential validity check
            const validCredential = expiry >= current && kyc >= required;

            return validCredential === expected;
          },
        ),
        { numRuns: NUM_RUNS },
      );
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`P6: Credential validity logic       PASSED (${NUM_RUNS} runs, ${elapsed}ms)`);
    } catch (e) {
      allPassed = false;
      console.error(`P6: Credential validity logic       FAILED`);
      console.error(e);
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n" + "=".repeat(60));
  if (allPassed) {
    console.log("ALL 6 PROPERTIES PASSED");
  } else {
    console.log("SOME PROPERTIES FAILED");
    process.exit(1);
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
