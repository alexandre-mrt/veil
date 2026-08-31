#!/usr/bin/env node
/**
 * merkle-scale.mjs — off-chain Merkle-tree build cost, old (naive) vs new (pruned).
 *
 * Veil's credential and commitment trees are depth-20 binary Poseidon trees, built
 * off-chain and reconciled against an on-chain root (`scripts/src/compliance-utils.ts`,
 * `frontend/src/lib/merkle-tree.ts`). Both previously rebuilt the *entire* 2^depth-wide
 * tree on every call, hashing every zero-padding pair for real — O(2^depth) Poseidon
 * calls regardless of how many real leaves exist. `scripts/src/seed-credential-tree.ts`
 * even warns "this may take ~60s" for a tree with exactly one real leaf.
 *
 * This script measures that cost directly:
 *   1. OLD  — the naive full-width rebuild (reference implementation below, matching
 *             what compliance-utils.ts / merkle-tree.ts did before this change).
 *   2. NEW  — the pruned rebuild now in scripts/src/compliance-utils.ts: only the real
 *             leaf prefix is ever hashed; the always-zero remainder is filled from
 *             precomputed per-level zero-subtree hashes instead of being re-hashed.
 * OLD is O(2^depth) by construction, so it is only run once (it does not depend on n).
 * NEW is run across a range of n to show the O(n + depth) scaling directly, including
 * at depth 24 (~16.8M capacity, inside the 10^5-10^7 anonymity-set range in
 * docs/research/EXPERIMENTS.md item 4) where OLD is impractical to even attempt here.
 *
 * Usage (run with bun — this script imports scripts/src/compliance-utils.ts directly,
 * same as the rest of the scripts/ package; plain `node` cannot resolve the .ts import):
 *   bun run scripts/bench/merkle-scale.mjs
 */
import { buildPoseidon } from "circomlibjs";
import { buildMerkleTree as buildMerkleTreePruned } from "../src/compliance-utils.ts";

const ZERO_LEAF = 0n;

// Reference implementation: the *old* algorithm, byte-for-byte what
// compliance-utils.ts's buildMerkleTree did before this experiment. Kept here only
// as a naive baseline for comparison, not exported for use elsewhere.
function buildMerkleTreeNaive(poseidon, F, leaves, depth) {
  const capacity = 1 << depth;
  if (leaves.length > capacity) {
    throw new Error(`Too many leaves: ${leaves.length} > 2^${depth} = ${capacity}`);
  }
  const leafLayer = Array.from({ length: capacity }, (_, i) => (i < leaves.length ? leaves[i] : ZERO_LEAF));
  const layers = [leafLayer];
  let current = leafLayer;
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(F.toObject(poseidon([current[i], current[i + 1]])));
    }
    layers.push(next);
    current = next;
  }
  return { root: layers[depth][0], layers };
}

function randomLeaves(n, seed = 1n) {
  // Deterministic pseudo-random bigints, not cryptographically meaningful —
  // only used to avoid an all-identical-leaf tree, which could hide indexing bugs.
  const leaves = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    leaves.push(x);
  }
  return leaves;
}

function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  const result = fn();
  const t1 = process.hrtime.bigint();
  return { result, ms: Number(t1 - t0) / 1e6 };
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  console.log("=== Veil Merkle-tree build-cost benchmark: naive (old) vs pruned (new) ===");
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  // --- Correctness gate: pruned must match naive bit-for-bit before any number counts. ---
  console.log("--- Correctness: pruned vs naive root/layers, depth=10 (capacity=1024) ---");
  let mismatches = 0;
  for (const n of [0, 1, 2, 3, 7, 8, 100, 511, 512, 513, 1000, 1024]) {
    const leaves = randomLeaves(n, BigInt(n) + 1n);
    const naive = buildMerkleTreeNaive(poseidon, F, leaves, 10);
    const pruned = buildMerkleTreePruned(poseidon, F, leaves, 10);
    const rootMatch = naive.root === pruned.root;
    const layersMatch =
      naive.layers.length === pruned.layers.length &&
      naive.layers.every((layer, d) => layer.length === pruned.layers[d].length && layer.every((v, i) => v === pruned.layers[d][i]));
    if (!rootMatch || !layersMatch) {
      mismatches++;
      console.log(`  MISMATCH at n=${n}: rootMatch=${rootMatch} layersMatch=${layersMatch}`);
    } else {
      console.log(`  OK n=${n.toString().padStart(4)}: root and all ${naive.layers.length} layers identical`);
    }
  }
  if (mismatches > 0) {
    console.error(`\n${mismatches} correctness mismatch(es) — refusing to report timing numbers.`);
    process.exit(1);
  }
  console.log("\nAll pruned-vs-naive outputs identical. Proceeding to timing.\n");

  const results = { depth20: {}, depth24: {} };

  // --- OLD, depth 20: run once. O(2^depth), independent of n by construction. ---
  console.log("--- OLD (naive), depth=20, n=1 leaf ---");
  const oldLeaves = randomLeaves(1, 42n);
  const oldRun = timeMs(() => buildMerkleTreeNaive(poseidon, F, oldLeaves, 20));
  console.log(`  ${oldRun.ms.toFixed(1)} ms  (2^20 - 1 = 1,048,575 Poseidon(2) calls)`);
  results.depth20.old_n1_ms = oldRun.ms;

  // --- NEW, depth 20: across n. ---
  console.log("\n--- NEW (pruned), depth=20, across n ---");
  results.depth20.new = [];
  for (const n of [1, 10, 100, 1_000, 10_000, 100_000, 1_048_576]) {
    const leaves = randomLeaves(n, BigInt(n) + 7n);
    const run = timeMs(() => buildMerkleTreePruned(poseidon, F, leaves, 20));
    console.log(`  n=${n.toString().padStart(9)}: ${run.ms.toFixed(2)} ms`);
    results.depth20.new.push({ n, ms: run.ms });
  }

  // --- NEW, depth 24 (~16.8M capacity — inside the 10^5-10^7 range EXPERIMENTS.md item 4
  //     asks about). OLD is not attempted at this depth: extrapolating from the measured
  //     depth-20 rate above (~57us/hash) puts a naive depth-24 build at ~16x the depth-20
  //     figure, i.e. minutes — this is an extrapolation, not a measurement, and is reported
  //     as such below, never as a real number. ---
  console.log("\n--- NEW (pruned), depth=24 (capacity 16,777,216), across n ---");
  results.depth24.new = [];
  for (const n of [1, 1_000, 100_000]) {
    const leaves = randomLeaves(n, BigInt(n) + 99n);
    const run = timeMs(() => buildMerkleTreePruned(poseidon, F, leaves, 24));
    console.log(`  n=${n.toString().padStart(9)}: ${run.ms.toFixed(2)} ms`);
    results.depth24.new.push({ n, ms: run.ms });
  }
  const perHashMs = oldRun.ms / (2 ** 20 - 1);
  const extrapolatedOldDepth24Ms = perHashMs * (2 ** 24 - 1);
  console.log(
    `\n  [EXTRAPOLATED, not measured] naive depth=24 build ≈ ${(extrapolatedOldDepth24Ms / 1000).toFixed(1)} s ` +
      `(${perHashMs.toFixed(4)} ms/hash x (2^24 - 1) hashes, rate taken from the depth=20 OLD run above)`,
  );

  console.log("\n=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
