import { describe, test, expect } from "vitest";
// @ts-expect-error — no type declarations (same pattern as src/lib/dynamicRequire.ts)
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error — no type declarations (same pattern as src/lib/dynamicRequire.ts)
import type { PoseidonFunction } from "circomlibjs";

import { MerkleTree } from "@/lib/merkle-tree";

/**
 * Tests for the depth-20 Poseidon Merkle tree used to build the transfer
 * circuit's commitment-inclusion proof.
 *
 * MerkleTree.getRoot()/getProof() used to rebuild the full 2^20-wide tree on
 * every call — O(2^depth) Poseidon hashes regardless of how many real leaves
 * were inserted. They now only hash the real leaf prefix and fill the
 * always-zero remainder from precomputed per-level zero-subtree hashes
 * (see scripts/bench/merkle-scale.mjs for the measured before/after).
 * These tests are the correctness gate for that change: proofs must still
 * verify, and — once, since it costs ~2^20 real hashes — the root must
 * match hashing every pair for real, the way the old code did.
 */

const DEPTH = 20;

describe("MerkleTree (pruned, depth 20)", () => {
  test("proof recombines to the reported root, for a real leaf and a zero-padded index", async () => {
    const tree = new MerkleTree();
    await tree.init();
    const leaves = [10n, 20n, 30n, 40n, 50n];
    for (const leaf of leaves) tree.insert(leaf);

    const root = tree.getRoot();
    const poseidon = await buildPoseidon();

    for (const index of [0, 4]) {
      // real leaf
      const proof = tree.getProof(index);
      expect(proof.root).toBe(root);

      let node = leaves[index];
      let idx = index;
      for (let level = 0; level < DEPTH; level++) {
        const sibling = proof.pathElements[level];
        const isRight = idx % 2 === 1;
        const pair = isRight ? [sibling, node] : [node, sibling];
        node = poseidon.F.toObject(poseidon(pair));
        idx = Math.floor(idx / 2);
      }
      expect(node).toBe(root);
    }
  });

  test("getProof throws for an index beyond the inserted (real) leaves", async () => {
    const tree = new MerkleTree();
    await tree.init();
    tree.insert(1n);
    expect(() => tree.getProof(1)).toThrow();
    expect(() => tree.getProof(-1)).toThrow();
  });

  test("empty tree root equals the depth-20 all-zero-leaf root", async () => {
    const tree = new MerkleTree();
    await tree.init();
    const poseidon = await buildPoseidon();
    let zero = 0n;
    for (let level = 0; level < DEPTH; level++) {
      zero = poseidon.F.toObject(poseidon([zero, zero]));
    }
    expect(tree.getRoot()).toBe(zero);
  });

  test(
    "root matches a naive full-width (every pair really hashed) reference build",
    { timeout: 180_000 },
    async () => {
      const poseidon: PoseidonFunction = await buildPoseidon();
      const F = poseidon.F;
      const leaves = [111n, 222n, 333n];

      const tree = new MerkleTree();
      await tree.init();
      for (const leaf of leaves) tree.insert(leaf);

      // Naive reference: pad to the full 2^20 width and hash every pair for
      // real — exactly what merkle-tree.ts did before the pruning change.
      const capacity = 2 ** DEPTH;
      let current: bigint[] = new Array(capacity).fill(0n);
      for (let i = 0; i < leaves.length; i++) current[i] = leaves[i];
      for (let level = 0; level < DEPTH; level++) {
        const next = new Array(current.length / 2);
        for (let i = 0; i < current.length; i += 2) {
          next[i / 2] = F.toObject(poseidon([current[i], current[i + 1]]));
        }
        current = next;
      }

      expect(tree.getRoot()).toBe(current[0]);
    },
  );
});
