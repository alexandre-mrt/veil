/**
 * Poseidon Merkle tree (depth 20) for commitment privacy.
 *
 * Builds a local Merkle tree from commitment leaves and computes
 * inclusion proofs for the transfer circuit.
 *
 * Uses circomlibjs Poseidon hash (loaded dynamically to avoid bundling).
 */

import { dynamicRequire } from "@/lib/dynamicRequire";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPTH = 20;
const ZERO_VALUE = 0n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoseidonInstance {
  (inputs: bigint[]): unknown;
  F: { toObject: (v: unknown) => bigint };
}

export interface MerkleProof {
  readonly root: bigint;
  readonly pathElements: readonly bigint[];
  readonly pathIndices: readonly number[];
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class MerkleTree {
  private readonly leaves: bigint[] = [];
  private poseidon: PoseidonInstance | null = null;
  private zeroHashes: bigint[] = [];

  /**
   * Initialize the Poseidon hash function and precompute zero hashes.
   * Must be called before any other method.
   */
  async init(): Promise<void> {
    const circomlibjs = (await dynamicRequire("circomlibjs")) as {
      buildPoseidon: () => Promise<PoseidonInstance>;
    };
    this.poseidon = await circomlibjs.buildPoseidon();
    this.zeroHashes = this.computeZeroHashes();
  }

  /**
   * Insert a commitment leaf into the tree.
   */
  insert(leaf: bigint): void {
    if (this.leaves.length >= 2 ** DEPTH) {
      throw new Error(`Merkle tree full: max ${2 ** DEPTH} leaves`);
    }
    this.leaves.push(leaf);
  }

  /**
   * Get the current number of leaves.
   */
  get size(): number {
    return this.leaves.length;
  }

  /**
   * Compute the Merkle root.
   */
  getRoot(): bigint {
    if (this.leaves.length === 0) {
      return this.zeroHashes[DEPTH];
    }
    return this.computeRootFromLeaves();
  }

  /**
   * Compute a Merkle inclusion proof for the leaf at `index`.
   */
  getProof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Leaf index ${index} out of range [0, ${this.leaves.length})`);
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    // Build tree level by level, collecting sibling hashes
    let currentLevel = this.padToDepthLevel(this.leaves);

    for (let level = 0; level < DEPTH; level++) {
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      pathElements.push(currentLevel[siblingIndex]);
      pathIndices.push(index % 2);

      // Move up one level
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(this.hash(currentLevel[i], currentLevel[i + 1]));
      }
      currentLevel = nextLevel;
      index = Math.floor(index / 2);
    }

    return {
      root: currentLevel[0],
      pathElements,
      pathIndices,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private hash(left: bigint, right: bigint): bigint {
    if (!this.poseidon) {
      throw new Error("MerkleTree not initialized: call init() first");
    }
    return this.poseidon.F.toObject(this.poseidon([left, right]));
  }

  /**
   * Precompute zero hashes for each level.
   * zeroHashes[0] = ZERO_VALUE
   * zeroHashes[i] = hash(zeroHashes[i-1], zeroHashes[i-1])
   */
  private computeZeroHashes(): bigint[] {
    const zeros: bigint[] = [ZERO_VALUE];
    for (let i = 1; i <= DEPTH; i++) {
      zeros.push(this.hash(zeros[i - 1], zeros[i - 1]));
    }
    return zeros;
  }

  /**
   * Pad the leaves array to the full width at level 0 (2^DEPTH)
   * using precomputed zero hashes.
   */
  private padToDepthLevel(leaves: readonly bigint[]): bigint[] {
    const width = 2 ** DEPTH;
    const padded = new Array<bigint>(width);
    for (let i = 0; i < width; i++) {
      padded[i] = i < leaves.length ? leaves[i] : ZERO_VALUE;
    }
    return padded;
  }

  /**
   * Compute the root by hashing all levels bottom-up.
   */
  private computeRootFromLeaves(): bigint {
    let currentLevel = this.padToDepthLevel(this.leaves);
    for (let level = 0; level < DEPTH; level++) {
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(this.hash(currentLevel[i], currentLevel[i + 1]));
      }
      currentLevel = nextLevel;
    }
    return currentLevel[0];
  }
}
