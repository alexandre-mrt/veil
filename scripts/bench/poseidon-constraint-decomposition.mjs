#!/usr/bin/env node
/**
 * poseidon-constraint-decomposition.mjs — decomposes transfer/compliance/withdraw's
 * R1CS constraint counts into per-gadget contributions (Poseidon arity 2/3/4/5,
 * Num2Bits, comparators, MultiMux1, the depth-20 Merkle accumulator).
 *
 * Method: compile each gadget in isolation (scripts/bench/poseidon-gadgets/*.circom,
 * one component instantiation each), read circom's own "non-linear constraints" /
 * "linear constraints" report, then predict each real circuit's total as
 * sum(gadget_count[circuit][gadget] * gadget_constraints[gadget]) + a small,
 * explicitly-documented set of top-level constraints each circuit adds outside any
 * gadget (equality checks, one multiplication, boolean-enforcement checks — see
 * EXTRA_NONLINEAR / EXTRA_LINEAR below, each comment cites the exact source line).
 * Prints predicted vs. actual side by side — the gap (if any) is itself the finding.
 *
 * Usage:
 *   node scripts/bench/poseidon-constraint-decomposition.mjs
 *
 * Requires a `circom` binary on PATH or at $CIRCOM_BIN (2.1.x/2.2.x — see
 * circuits/scripts/compile.sh for how to build one from source).
 */
import { execFileSync, execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const GADGETS_DIR = join(__dirname, "poseidon-gadgets");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");

function resolveCircom() {
  if (process.env.CIRCOM_BIN && existsSync(process.env.CIRCOM_BIN)) {
    return process.env.CIRCOM_BIN;
  }
  try {
    return execFileSync("which", ["circom"]).toString().trim();
  } catch {
    console.error(
      "ERROR: circom not found on PATH and $CIRCOM_BIN not set.\n" +
        "Build it per circuits/scripts/compile.sh:\n" +
        "  git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom\n" +
        "  cd circom && cargo build --release\n" +
        "  export CIRCOM_BIN=$(pwd)/target/release/circom"
    );
    process.exit(1);
  }
}

const CIRCOM = resolveCircom();

function compileAndParse(circomFile, outDir, libDir) {
  mkdirSync(outDir, { recursive: true });
  const rawOut = execSync(
    `"${CIRCOM}" "${circomFile}" --r1cs -o "${outDir}" -l "${libDir}" 2>&1`,
    { cwd: dirname(circomFile), encoding: "utf8" }
  );
  // eslint-disable-next-line no-control-regex
  const out = rawOut.replace(/\x1b\[[0-9;]*m/g, ""); // strip circom's ANSI color codes
  const nonLinear = parseInt(out.match(/non-linear constraints:\s*(\d+)/)[1], 10);
  // anchored to line start: "linear constraints:" also appears as a substring of
  // "non-linear constraints:", so an unanchored match would pick up the wrong line.
  const linear = parseInt(out.match(/^linear constraints:\s*(\d+)/m)[1], 10);
  const templateInstances = parseInt(out.match(/template instances:\s*(\d+)/)[1], 10);
  return { nonLinear, linear, templateInstances, raw: out };
}

// ── Step 1: compile each isolated gadget, one component instantiation each ──
const GADGETS = {
  poseidon2: "poseidon2.circom",
  poseidon3: "poseidon3.circom",
  poseidon4: "poseidon4.circom",
  poseidon5: "poseidon5.circom",
  num2bits64: "num2bits64.circom",
  num2bits8: "num2bits8.circom",
  lesseqthan64: "lesseqthan64.circom",
  greaterthan64: "greaterthan64.circom",
  greaterequalthan64: "greaterequalthan64.circom",
  greaterequalthan8: "greaterequalthan8.circom",
  multimux1_2: "multimux1_2.circom",
  merkleproof20: "merkleproof20.circom", // cross-check: whole depth-20 accumulator template
};

const gadgetBuildDir = join(GADGETS_DIR, "build");
const gadgetResults = {};
console.log("=== Compiling isolated gadgets ===\n");
for (const [name, file] of Object.entries(GADGETS)) {
  const r = compileAndParse(join(GADGETS_DIR, file), gadgetBuildDir, join(CIRCUITS_DIR, "node_modules"));
  gadgetResults[name] = r;
  console.log(
    `${name.padEnd(20)} non-linear=${String(r.nonLinear).padStart(5)}  linear=${String(r.linear).padStart(5)}  templates=${r.templateInstances}`
  );
}

// Cross-check: MerkleProof(20) should equal 20x Poseidon(2) + 20x MultiMux1(2) +
// 20 boolean-enforcement constraints (pathIndices[i]*(1-pathIndices[i])===0, one
// per level — merkle_proof.circom line 19), all non-linear.
const predictedMerkleNonLinear =
  20 * gadgetResults.poseidon2.nonLinear + 20 * gadgetResults.multimux1_2.nonLinear + 20;
const predictedMerkleLinear = 20 * gadgetResults.poseidon2.linear + 20 * gadgetResults.multimux1_2.linear;
console.log(
  `\nMerkleProof(20) cross-check: predicted non-linear=${predictedMerkleNonLinear} ` +
    `actual=${gadgetResults.merkleproof20.nonLinear} ` +
    `(delta ${gadgetResults.merkleproof20.nonLinear - predictedMerkleNonLinear})`
);
console.log(
  `MerkleProof(20) cross-check: predicted linear=${predictedMerkleLinear} ` +
    `actual=${gadgetResults.merkleproof20.linear} ` +
    `(delta ${gadgetResults.merkleproof20.linear - predictedMerkleLinear})\n`
);

// ── Step 2: per-circuit gadget instantiation counts (read off the .circom source) ──
const CIRCUIT_COMPOSITION = {
  transfer: {
    file: "transfer.circom",
    counts: { merkleproof20: 1, poseidon4: 3, poseidon3: 1, greaterthan64: 1, num2bits64: 4, lesseqthan64: 1 },
    // 8x top-level `===` on a component output or a 2-term sum (transfer.circom
    // lines 61,71,80,83,89,109,120,129) — each a single linear equality constraint.
    extraNonLinear: 0,
    extraLinear: 8,
  },
  compliance: {
    file: "compliance.circom",
    counts: {
      poseidon5: 1,
      merkleproof20: 1,
      poseidon3: 2,
      greaterequalthan64: 1,
      greaterequalthan8: 1,
      num2bits64: 3,
      num2bits8: 2,
    },
    // compliance.circom: 2x boolean-enforcement (lines 100-101) + 1x
    // computedValid <== expiryCheck.out * kycCheck.out (line 105, a genuine
    // signal*signal multiplication) = 3 non-linear; plus merkleRoot===...(69),
    // nullifier===...(77), contextId===...(87), validCredential===...(106) = 4 linear.
    extraNonLinear: 3,
    extraLinear: 4,
  },
  withdraw: {
    file: "withdraw.circom",
    counts: { poseidon4: 3, poseidon2: 1, num2bits64: 3, greaterthan64: 1, lesseqthan64: 1 },
    // withdraw.circom: commitment===...(64), remainingBalance<==sub(89, linear),
    // newCommitment===...(96), nullifier===...(110), recipientHash===...(117) = 5 linear.
    extraNonLinear: 0,
    extraLinear: 5,
  },
};

// ── Step 3: fresh-compile the real circuits with the same toolchain ──
console.log("=== Compiling real circuits (fresh, same toolchain) ===\n");
const realBuildDirs = { transfer: "build", compliance: "build-compliance", withdraw: "build-withdraw" };
const realResults = {};
for (const [name, spec] of Object.entries(CIRCUIT_COMPOSITION)) {
  const r = compileAndParse(
    join(CIRCUITS_DIR, spec.file),
    join(CIRCUITS_DIR, realBuildDirs[name]),
    join(CIRCUITS_DIR, "node_modules")
  );
  realResults[name] = r;
  console.log(`${name.padEnd(12)} non-linear=${r.nonLinear}  linear=${r.linear}`);
}

// ── Step 4: predict and compare ──
console.log("\n=== Predicted (sum of isolated gadgets) vs. actual ===\n");
console.log(
  "circuit".padEnd(12) +
    "gadget".padEnd(20) +
    "count".padEnd(7) +
    "nonlin/ea".padEnd(11) +
    "nonlin-sub".padEnd(12) +
    "lin/ea".padEnd(8) +
    "lin-sub"
);
const summary = [];
for (const [name, spec] of Object.entries(CIRCUIT_COMPOSITION)) {
  let predNonLinear = spec.extraNonLinear;
  let predLinear = spec.extraLinear;
  for (const [gadget, count] of Object.entries(spec.counts)) {
    const g = gadgetResults[gadget];
    const subNL = count * g.nonLinear;
    const subL = count * g.linear;
    predNonLinear += subNL;
    predLinear += subL;
    console.log(
      name.padEnd(12) + gadget.padEnd(20) + String(count).padEnd(7) + String(g.nonLinear).padEnd(11) + String(subNL).padEnd(12) + String(g.linear).padEnd(8) + String(subL)
    );
  }
  console.log(
    name.padEnd(12) + `+extra`.padEnd(20) + "".padEnd(7) + "".padEnd(11) + String(spec.extraNonLinear).padEnd(12) + "".padEnd(8) + String(spec.extraLinear)
  );
  const actual = realResults[name];
  console.log(
    `  -> predicted: non-linear=${predNonLinear} linear=${predLinear}` +
      `   actual: non-linear=${actual.nonLinear} linear=${actual.linear}` +
      `   delta: non-linear=${actual.nonLinear - predNonLinear} linear=${actual.linear - predLinear}\n`
  );
  summary.push({ name, predNonLinear, predLinear, actualNonLinear: actual.nonLinear, actualLinear: actual.linear });
}

// ── Step 5: what fraction of each circuit's non-linear budget is Poseidon? ──
console.log("=== Poseidon share of non-linear constraints ===\n");
for (const [name, spec] of Object.entries(CIRCUIT_COMPOSITION)) {
  let poseidonNonLinear = 0;
  for (const [gadget, count] of Object.entries(spec.counts)) {
    if (gadget.startsWith("poseidon")) poseidonNonLinear += count * gadgetResults[gadget].nonLinear;
    if (gadget === "merkleproof20") poseidonNonLinear += count * 20 * gadgetResults.poseidon2.nonLinear;
  }
  const actual = realResults[name].nonLinear;
  console.log(`${name.padEnd(12)} Poseidon non-linear=${poseidonNonLinear}  of total=${actual}  (${((100 * poseidonNonLinear) / actual).toFixed(1)}%)`);
}
