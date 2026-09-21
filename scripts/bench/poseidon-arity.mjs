#!/usr/bin/env node
/**
 * poseidon-arity.mjs — per-instance Poseidon constraint breakdown, and a measured
 * Poseidon-vs-Poseidon2 R1CS constraint-count comparison, for Veil's circuits.
 *
 * Answers two questions with real `circom`/`snarkjs r1cs info` output, not estimates:
 *
 *   1. Which Poseidon call actually dominates transfer.circom / compliance.circom's
 *      non-linear constraint count? (EXPERIMENTS.md queue item #2 assumed "four Poseidon
 *      instances" — this measures each instance in isolation to check that.)
 *   2. Does swapping the dominant instance (the Merkle-path Poseidon(2), called 20x per
 *      proof via templates/merkle_proof.circom) for a structurally faithful Poseidon2
 *      permutation (same round schedule, alpha=5 S-box) change R1CS constraint count?
 *
 * All circuits measured are isolated benchmark-only wrappers under
 * circuits/research/poseidon-bench/ — nothing here is included by, or changes, any
 * production circuit.
 *
 * Usage:
 *   node scripts/bench/poseidon-arity.mjs [--circom /path/to/circom]
 *
 * Prerequisite: a circom 2.1.x/2.2.x binary. If not on PATH, pass --circom or set
 * CIRCOM=/path/to/circom. Building one from source (no prebuilt Linux binary was
 * reachable in this environment — see the 2026-09-21 report):
 *   git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom.git /tmp/circom_src
 *   cd /tmp/circom_src && cargo build --release
 *   # binary at /tmp/circom_src/target/release/circom
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "..", "..", "circuits", "research", "poseidon-bench");
const NODE_MODULES = join(__dirname, "..", "..", "circuits", "node_modules");
const BUILD_DIR = join(BENCH_DIR, "build");

const CIRCOM = (() => {
  const idx = process.argv.indexOf("--circom");
  if (idx !== -1) return process.argv[idx + 1];
  return process.env.CIRCOM || "circom";
})();

const CIRCUITS = [
  { file: "poseidon_t3", label: "Poseidon(2)  (t=3) — Merkle-path hasher, 1 instance × 20/proof" },
  { file: "poseidon_t4", label: "Poseidon(3)  (t=4) — txAmountHash, 1 instance/proof" },
  { file: "poseidon_t5", label: "Poseidon(4)  (t=5) — commitment/nullifier hashes, 3 instances/proof" },
  { file: "merkle20", label: "MerkleProof(20) — production template, 20x Poseidon(2) chained" },
  { file: "poseidon2_t3", label: "Poseidon2T3 (t=3) — benchmark-only, same round schedule as Poseidon(2)" },
  { file: "merkle20_poseidon2", label: "MerkleProof(20) rebuilt with Poseidon2T3 as the per-level hasher" },
];

function compile(file) {
  const src = join(BENCH_DIR, `${file}.circom`);
  execFileSync(CIRCOM, [src, "--r1cs", "-o", BUILD_DIR, "-l", NODE_MODULES], { stdio: "pipe" });
}

function r1csInfo(file) {
  const r1cs = join(BUILD_DIR, `${file}.r1cs`);
  const out = execFileSync("npx", ["snarkjs", "r1cs", "info", r1cs], { cwd: BENCH_DIR, encoding: "utf8" });
  const constraints = parseInt(out.match(/# of Constraints:\s*(\d+)/)[1], 10);
  const wires = parseInt(out.match(/# of Wires:\s*(\d+)/)[1], 10);
  return { constraints, wires, raw: out };
}

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true });
  console.log("=== Veil Poseidon per-instance / Poseidon2 constraint-count benchmark ===");
  console.log(`circom: ${execFileSync(CIRCOM, ["--version"], { encoding: "utf8" }).trim()}`);
  console.log(`snarkjs: 0.7.6 (pinned in circuits/package.json)\n`);

  const results = {};
  for (const c of CIRCUITS) {
    compile(c.file);
    const info = r1csInfo(c.file);
    results[c.file] = info;
    console.log(`--- ${c.file} ---  ${c.label}`);
    console.log(`  # of Wires: ${info.wires}`);
    console.log(`  # of Constraints: ${info.constraints}`);
    console.log("");
  }

  console.log("=== Headline comparisons ===");
  const single = results.poseidon2_t3.constraints - results.poseidon_t3.constraints;
  console.log(
    `Single hash, same round schedule: Poseidon(2)=${results.poseidon_t3.constraints} vs ` +
    `Poseidon2T3=${results.poseidon2_t3.constraints}  (delta ${single >= 0 ? "+" : ""}${single}, ` +
    `${((single / results.poseidon_t3.constraints) * 100).toFixed(2)}%)`,
  );
  const merkle = results.merkle20_poseidon2.constraints - results.merkle20.constraints;
  console.log(
    `Full depth-20 Merkle proof: Poseidon=${results.merkle20.constraints} vs ` +
    `Poseidon2=${results.merkle20_poseidon2.constraints}  (delta ${merkle >= 0 ? "+" : ""}${merkle}, ` +
    `${((merkle / results.merkle20.constraints) * 100).toFixed(2)}%)`,
  );

  console.log("\n=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
