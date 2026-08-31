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

    const layers = this.buildPrunedLayers();
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentIndex = index;
    for (let level = 0; level < DEPTH; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const layer = layers[level];
      const sibling = siblingIndex < layer.length ? layer[siblingIndex] : this.zeroHashes[level];
      pathElements.push(sibling);
      pathIndices.push(isRight ? 1 : 0);
      currentIndex = Math.floor(currentIndex / 2);
    }

    const last = layers[DEPTH];
    const root = last.length > 0 ? last[0] : this.zeroHashes[DEPTH];

    return { root, pathElements, pathIndices };
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
   * Build the tree layer by layer, keeping only the real (non-padding)
   * prefix at each level instead of materializing the full 2^DEPTH width.
   *
   * Leaves occupy a contiguous prefix [0, leaves.length), so every position
   * at or beyond a level's real width is provably the cached zero-subtree
   * hash for that level (`zeroHashes[level]`) — it never needs to be
   * recomputed. This turns root/proof computation from O(2^DEPTH) Poseidon
   * calls into O(leaves.length + DEPTH), while producing the exact same
   * root and proofs the old full-width computation did.
   */
  private buildPrunedLayers(): bigint[][] {
    const layers: bigint[][] = [this.leaves.slice()];
    let realWidth = this.leaves.length;

    for (let level = 0; level < DEPTH; level++) {
      const current = layers[level];
      const activePairs = realWidth === 0 ? 0 : Math.ceil(realWidth / 2);
      const next: bigint[] = new Array(activePairs);
      for (let i = 0; i < activePairs; i++) {
        const left = current[2 * i];
        const right = 2 * i + 1 < realWidth ? current[2 * i + 1] : this.zeroHashes[level];
        next[i] = this.hash(left, right);
      }
      layers.push(next);
      realWidth = activePairs;
    }

    return layers;
  }

  /**
   * Compute the root by hashing only the real leaves bottom-up.
   */
  private computeRootFromLeaves(): bigint {
    const layers = this.buildPrunedLayers();
    const last = layers[DEPTH];
    return last.length > 0 ? last[0] : this.zeroHashes[DEPTH];
  }
}
