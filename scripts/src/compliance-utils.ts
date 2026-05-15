/**
 * compliance-utils.ts
 *
 * Utilities for the Veil Tier 3 compliance circuit.
 *
 * Domain separation tags (must match compliance.circom):
 *   4 — credential leaf:  Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)
 *   5 — compliance nullifier: Poseidon(5, userSecret, contextId)
 *
 * Merkle tree: binary Poseidon(2) tree, matching templates/merkle_proof.circom.
 * Each internal node = Poseidon(left, right) with no domain tag (Poseidon(2) of 2 inputs).
 * Zero value for padding: 0n.
 */

import { readFileSync } from "fs";
import { buildPoseidon } from "circomlibjs";
import type { PoseidonFunction } from "circomlibjs";

import { vkToSuiBytes, toHex } from "./proof-converter.js";
import type { SnarkjsVK } from "./proof-converter.js";

// Domain separation tags (must stay in sync with compliance.circom)
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;

// Zero padding value for empty Merkle leaves
const ZERO_LEAF = 0n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MerkleTree {
  /** Root of the tree (bigint field element). */
  root: bigint;
  /**
   * All layers from bottom to top.
   * layers[0] = leaf layer (length = 2^depth).
   * layers[depth] = [root].
   */
  layers: bigint[][];
}

export interface MerkleProof {
  /** Sibling elements along the path from leaf to root. */
  pathElements: bigint[];
  /**
   * 0 = current node is left child, 1 = current node is right child.
   * Matches pathIndices in compliance.circom.
   */
  pathIndices: number[];
}

// ---------------------------------------------------------------------------
// VK conversion
// ---------------------------------------------------------------------------

/**
 * Reads a compliance VK JSON file and converts it to Sui-compatible hex bytes.
 * The result can be submitted to the compliance verifier on-chain.
 *
 * @param vkJsonPath Absolute path to the VK JSON produced by snarkjs.
 * @returns Hex string of the serialized VK (no 0x prefix).
 */
export function convertComplianceVK(vkJsonPath: string): string {
  const raw = readFileSync(vkJsonPath, "utf-8");
  const vk = JSON.parse(raw) as SnarkjsVK;
  const bytes = vkToSuiBytes(vk);
  return toHex(bytes);
}

// ---------------------------------------------------------------------------
// Credential leaf
// ---------------------------------------------------------------------------

/**
 * Computes the credential leaf hash for the compliance circuit.
 *
 * leaf = Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)
 *
 * The domain tag 4 ensures this value is distinct from all transfer-circuit
 * commitments (tags 1-3) even if inputs coincide.
 *
 * @param poseidon  Built circomlibjs Poseidon instance.
 * @param F         poseidon.F (the BN254 scalar field).
 * @param userSecret  User's private secret (bigint field element).
 * @param kycLevel    KYC tier level (e.g. 1n, 2n, 3n).
 * @param expiryEpoch Epoch at which the credential expires (bigint).
 * @param issuerId    Identifier of the credential issuer (bigint field element).
 * @returns Leaf hash as bigint.
 */
export function computeCredentialLeaf(
  poseidon: PoseidonFunction,
  F: PoseidonFunction["F"],
  userSecret: bigint,
  kycLevel: bigint,
  expiryEpoch: bigint,
  issuerId: bigint,
): bigint {
  const result = poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]);
  return F.toObject(result);
}

// ---------------------------------------------------------------------------
// Compliance nullifier
// ---------------------------------------------------------------------------

/**
 * Computes the compliance nullifier for the compliance circuit.
 *
 * nullifier = Poseidon(5, userSecret, contextId)
 *
 * The domain tag 5 ensures this nullifier is distinct from transfer nullifiers
 * (tag 2) even when (userSecret, contextId) share values with transfer inputs.
 *
 * @param poseidon  Built circomlibjs Poseidon instance.
 * @param F         poseidon.F.
 * @param userSecret  User's private secret (bigint field element).
 * @param contextId   Context identifier binding the nullifier to a specific use (bigint).
 * @returns Nullifier as bigint.
 */
export function computeCredentialNullifier(
  poseidon: PoseidonFunction,
  F: PoseidonFunction["F"],
  userSecret: bigint,
  contextId: bigint,
): bigint {
  const result = poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]);
  return F.toObject(result);
}

// ---------------------------------------------------------------------------
// Merkle tree builder
// ---------------------------------------------------------------------------

/**
 * Builds a complete binary Poseidon Merkle tree of the given depth.
 *
 * The tree uses Poseidon(2) for each internal node:
 *   node = Poseidon(left, right)
 * This matches the MerkleProof template in templates/merkle_proof.circom.
 *
 * If `leaves` is shorter than 2^depth, missing positions are padded with ZERO_LEAF (0n).
 *
 * @param poseidon  Built circomlibjs Poseidon instance.
 * @param F         poseidon.F.
 * @param leaves    Array of leaf values (bigint). Length must be <= 2^depth.
 * @param depth     Tree depth (e.g. 20 for the compliance circuit).
 * @returns MerkleTree with root and all layers.
 * @throws Error if leaves.length > 2^depth.
 */
export function buildMerkleTree(
  poseidon: PoseidonFunction,
  F: PoseidonFunction["F"],
  leaves: bigint[],
  depth: number,
): MerkleTree {
  const capacity = 1 << depth;
  if (leaves.length > capacity) {
    throw new Error(
      `Too many leaves: ${leaves.length} > 2^${depth} = ${capacity}`,
    );
  }

  // Build leaf layer padded to 2^depth
  const leafLayer: bigint[] = Array.from({ length: capacity }, (_, i) =>
    i < leaves.length ? leaves[i] : ZERO_LEAF,
  );

  const layers: bigint[][] = [leafLayer];
  let current = leafLayer;

  for (let d = 0; d < depth; d++) {
    const next: bigint[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1];
      const nodeResult = poseidon([left, right]);
      next.push(F.toObject(nodeResult));
    }
    layers.push(next);
    current = next;
  }

  const root = layers[depth][0];
  return { root, layers };
}

// ---------------------------------------------------------------------------
// Merkle proof extractor
// ---------------------------------------------------------------------------

/**
 * Extracts the Merkle proof for a leaf at the given index.
 *
 * Returns pathElements and pathIndices compatible with the MerkleProof
 * circom template and the compliance circuit's private inputs.
 *
 * pathIndices[i] = 0 means the current node is the LEFT child (sibling is on the right).
 * pathIndices[i] = 1 means the current node is the RIGHT child (sibling is on the left).
 *
 * @param layers  The layers array from a MerkleTree (layers[0] = leaves, layers[depth] = [root]).
 * @param index   Leaf index (0-based, must be < layers[0].length).
 * @param depth   Tree depth (must equal layers.length - 1).
 * @returns MerkleProof with pathElements and pathIndices arrays of length `depth`.
 * @throws Error if index is out of range or depth mismatches.
 */
export function getMerkleProof(
  layers: bigint[][],
  index: number,
  depth: number,
): MerkleProof {
  if (layers.length !== depth + 1) {
    throw new Error(
      `layers.length (${layers.length}) must equal depth + 1 (${depth + 1})`,
    );
  }
  const capacity = layers[0].length;
  if (index < 0 || index >= capacity) {
    throw new Error(`index ${index} out of range [0, ${capacity})`);
  }

  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  let currentIndex = index;
  for (let d = 0; d < depth; d++) {
    const isRightChild = currentIndex % 2 === 1;
    const siblingIndex = isRightChild ? currentIndex - 1 : currentIndex + 1;

    pathElements.push(layers[d][siblingIndex]);
    pathIndices.push(isRightChild ? 1 : 0);

    currentIndex = Math.floor(currentIndex / 2);
  }

  return { pathElements, pathIndices };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));

if (isMain) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("Usage: npx tsx src/compliance-utils.ts <path/to/compliance_vk.json>");
    process.exit(1);
  }
  const vkPath = args[0];
  try {
    const hex = convertComplianceVK(vkPath);
    console.log(hex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

// Re-export for external use
export { buildPoseidon };
