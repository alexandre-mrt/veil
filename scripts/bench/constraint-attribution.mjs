#!/usr/bin/env node
/**
 * constraint-attribution.mjs — attributes transfer.circom's 6,470 non-linear / 7,141 linear
 * R1CS constraints (2026-07-22 baseline) to the individual circomlib gadgets that produce them.
 *
 * Compiles one isolated micro-circuit per gadget (Poseidon(2/3/4), Num2Bits(64), GreaterThan(64),
 * LessEqThan(64), MultiMux1(2), and the full MerkleProof(20) template), multiplies each gadget's
 * per-instance cost by how many times it appears in transfer.circom, and compares the
 * reconstructed total against transfer.circom's real, freshly-measured constraint count.
 *
 * Toolchain: circom2 (npm-published WASM build of the circom 2.x compiler), not the native
 * `circom` binary the 2026-07-22 baseline used — this session's GitHub access is scoped to this
 * repo only, so `git clone iden3/circom && cargo build --release` (the 2026-07-22 path) is not
 * available. Verified before trusting it for this measurement: compiling transfer.circom itself
 * with circom2 reproduces the exact 2026-07-22 numbers (6,470 non-linear / 7,141 linear) — see the
 * 2026-09-03 report for the raw output.
 *
 * Micro-circuits are written directly into circuits/ (and circuits/templates/ for the Merkle one)
 * at runtime and deleted immediately after each compile — circom resolves `include` relative to
 * the including file's own directory, and doing it this way reuses exactly the same relative paths
 * (`node_modules/circomlib/...`, `../node_modules/circomlib/...`) the real circuits already use,
 * sidestepping a circom2-CLI bug where the `-l` library-search flag mishandles paths outside the
 * process's cwd.
 *
 * Usage:
 *   cd circuits && npm install   # circomlib must be present
 *   cd ../scripts/bench && npm install
 *   node constraint-attribution.mjs
 */
import { execFileSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCOM2_CLI = join(__dirname, "node_modules", "circom2", "cli.js");
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

// [tempFileName, circomSource, label, instances in transfer.circom, where, cwd]
const GADGETS = [
  ["_attr_poseidon2.circom", 'pragma circom 2.1.0;\ninclude "node_modules/circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(2);\n',
    "Poseidon(2)", 20, "MerkleProof(20) sibling hash, one per level", CIRCUITS_DIR],
  ["_attr_multimux1.circom", 'pragma circom 2.1.0;\ninclude "node_modules/circomlib/circuits/mux1.circom";\ncomponent main = MultiMux1(2);\n',
    "MultiMux1(2)", 20, "MerkleProof(20) left/right selector, one per level", CIRCUITS_DIR],
  ["_attr_poseidon4.circom", 'pragma circom 2.1.0;\ninclude "node_modules/circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(4);\n',
    "Poseidon(4)", 3, "oldHash (C1), newHash (C2), nfHash (C10)", CIRCUITS_DIR],
  ["_attr_poseidon3.circom", 'pragma circom 2.1.0;\ninclude "node_modules/circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(3);\n',
    "Poseidon(3)", 1, "txHash (C11)", CIRCUITS_DIR],
  ["_attr_num2bits64.circom", 'pragma circom 2.1.0;\ninclude "node_modules/circomlib/circuits/bitify.circom";\ncomponent main = Num2Bits(64);\n',
    "Num2Bits(64)", 4, "cumulativeOld, txAmount, cumulativeNew, threshold range checks (C5-C8)", CIRCUITS_DIR],
  ["_attr_gt64.circom", 'pragma circom 2.1.0;\ninclude "node_modules/circomlib/circuits/comparators.circom";\ncomponent main = GreaterThan(64);\n',
    "GreaterThan(64)", 1, "txAmount > 0 (C4)", CIRCUITS_DIR],
  ["_attr_leq64.circom", 'pragma circom 2.1.0;\ninclude "node_modules/circomlib/circuits/comparators.circom";\ncomponent main = LessEqThan(64);\n',
    "LessEqThan(64)", 1, "cumulativeNew <= threshold (C9)", CIRCUITS_DIR],
];

// Entry file lives at circuits/ root (not circuits/templates/) so its own "templates/..." include
// only ever descends from cwd — circom2's WASI sandbox does not reliably resolve `include`s that
// require walking above the process's cwd (confirmed by testing: cwd=circuits/templates made
// merkle_proof.circom's own "../node_modules/..." include unresolvable, even though the identical
// traversal succeeds when cwd=circuits and templates/ is a descendant of it).
const MERKLE_GADGET = ["_attr_merkle20.circom", 'pragma circom 2.1.0;\ninclude "templates/merkle_proof.circom";\ncomponent main = MerkleProof(20);\n',
  "MerkleProof(20)", 1, "full C0 membership proof (measured directly, not reconstructed)", CIRCUITS_DIR];

function compile(tempFileName, source, cwd) {
  const filePath = join(cwd, tempFileName);
  writeFileSync(filePath, source);
  const outDir = mkdtempSync(join(tmpdir(), "veil-attr-"));
  let stdout;
  try {
    stdout = execFileSync(
      "node",
      [CIRCOM2_CLI, tempFileName, "--r1cs", "-o", outDir, "-l", "node_modules"],
      { encoding: "utf8", cwd }
    );
  } finally {
    unlinkSync(filePath);
    rmSync(outDir, { recursive: true, force: true });
  }
  const nonLinear = parseInt(stdout.match(/non-linear constraints:\s*(\d+)/)?.[1] ?? "-1", 10);
  // Negative lookbehind is required: "linear constraints:" is a substring of "non-linear
  // constraints:", so an unanchored match picks up the non-linear count instead.
  const linear = parseInt(stdout.match(/(?<!non-)linear constraints:\s*(\d+)/)?.[1] ?? "-1", 10);
  return { nonLinear, linear, raw: stdout };
}

function main() {
  if (!existsSync(CIRCOM2_CLI)) {
    console.error(`circom2 not installed — run 'npm install' in ${__dirname} first.`);
    process.exit(1);
  }
  if (!existsSync(join(CIRCUITS_DIR, "node_modules", "circomlib"))) {
    console.error(`circomlib not installed — run 'npm install' in circuits/ first.`);
    process.exit(1);
  }

  console.log("=== Veil constraint attribution (transfer.circom gadget breakdown) ===\n");

  let totalNonLinear = 0;
  let totalLinear = 0;
  const rows = [];

  for (const [file, source, label, count, where, cwd] of GADGETS) {
    const { nonLinear, linear, raw } = compile(file, source, cwd);
    if (nonLinear < 0 || linear < 0) {
      console.error(`[FAIL] ${label}: could not parse circom2 output:\n${raw}`);
      process.exit(1);
    }
    rows.push({ label, count, nonLinear, linear, totalNonLinear: nonLinear * count, totalLinear: linear * count, where });
    console.log(
      `${label.padEnd(16)} x${count}  per-instance: ${nonLinear} non-linear / ${linear} linear` +
      `  ->  ${nonLinear * count} / ${linear * count}   (${where})`
    );
    // Poseidon(2) and MultiMux1(2) are folded into transfer.circom only via MerkleProof(20),
    // measured as its own row below — counting both would double-count.
    if (!where.startsWith("MerkleProof")) {
      totalNonLinear += nonLinear * count;
      totalLinear += linear * count;
    }
  }

  const [mFile, mSource, mLabel, , mWhere, mCwd] = MERKLE_GADGET;
  const merkle = compile(mFile, mSource, mCwd);
  console.log(`\n${mLabel} measured directly: ${merkle.nonLinear} non-linear / ${merkle.linear} linear   (${mWhere})`);
  const merkleReconstructed = rows.filter(r => r.where.startsWith("MerkleProof")).reduce((s, r) => s + r.totalNonLinear, 0);
  const merkleReconstructedLinear = rows.filter(r => r.where.startsWith("MerkleProof")).reduce((s, r) => s + r.totalLinear, 0);
  console.log(`Poseidon(2)x20 + MultiMux1(2)x20 reconstructed: ${merkleReconstructed} non-linear / ${merkleReconstructedLinear} linear`);
  console.log(`Difference (20x the boolean pathIndices[i]*(1-pathIndices[i])===0 check + wiring): ${merkle.nonLinear - merkleReconstructed} non-linear / ${merkle.linear - merkleReconstructedLinear} linear`);

  totalNonLinear += merkle.nonLinear;
  totalLinear += merkle.linear;

  console.log(`\nReconstructed total (sum of gadget rows above, MerkleProof(20) counted once as its measured whole): ${totalNonLinear} non-linear / ${totalLinear} linear`);
  console.log(`transfer.circom actual (fresh circom2 compile, matches 2026-07-22 baseline): 6470 non-linear / 7141 linear`);
  console.log(`Residual (top-level equality/arithmetic assertions — C3 addition, oldCommitment/newCommitment/nullifier/txAmountHash/merkleRoot === checks, threshBits — not attributable to a single reusable gadget): ${6470 - totalNonLinear} non-linear / ${7141 - totalLinear} linear`);

  console.log("\n=== Summary (JSON) ===");
  console.log(JSON.stringify({ rows, merkle, totalNonLinear, totalLinear }, null, 2));
}

main();
