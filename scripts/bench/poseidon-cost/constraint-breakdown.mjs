#!/usr/bin/env node
/**
 * constraint-breakdown.mjs — measures the standalone R1CS cost of every gadget
 * (Poseidon at each arity used, Num2Bits, the comparators, the depth-20 Merkle
 * membership template) that composes transfer.circom, compliance.circom and
 * withdraw.circom, then checks that those standalone costs actually add up to
 * the real circuits' measured constraint counts.
 *
 * This answers, with real numbers: how much of Veil's non-linear constraint
 * count (the thing that dominates Groth16 proving time) comes from Poseidon
 * hashing vs. everything else (range checks, comparators)? That's the number
 * a Poseidon2 migration would actually move, and by how much, *before*
 * committing to porting the hash function itself.
 *
 * Usage:
 *   node scripts/bench/poseidon-cost/constraint-breakdown.mjs
 *
 * Prerequisite: `circom` (2.1.x/2.2.x) on PATH — same requirement as
 * circuits/scripts/compile*.sh. If it isn't installed:
 *   git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom.git
 *   cd circom && cargo build --release
 *   # use target/release/circom, or copy it onto PATH
 *
 * Every number below is this script's own circom/snarkjs output — nothing is
 * estimated. The "predicted" column is an explicit, documented sum of
 * measured standalone gadget costs (see GADGET_USAGE below) plus a small
 * number of hand-counted primitive R1CS constraints (multiplications,
 * boolean-enforcement checks) that are not gadget calls — those are cited by
 * source line, not measured, because there is nothing to compile standalone.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");
const BENCH_CIRCUITS_DIR = join(__dirname, "circuits");

function findCircom() {
  const candidates = ["circom", join(REPO_ROOT, "target", "release", "circom")];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "pipe" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "circom not found on PATH. Build it: git clone --depth 1 --branch v2.2.2 " +
      "https://github.com/iden3/circom.git && cd circom && cargo build --release"
  );
}

// circom's own stdout reports the non-linear/linear split directly (snarkjs
// r1cs info only reports the combined total), so we parse that instead of
// shelling out twice.
function compileAndParse(circom, entryFile, outDir, libDirs) {
  mkdirSync(outDir, { recursive: true });
  const args = [entryFile, "--r1cs", "--output", outDir];
  for (const l of libDirs) args.push("-l", l);
  const stdout = execFileSync(circom, args, { encoding: "utf8", cwd: REPO_ROOT });
  const nonLinear = /non-linear constraints:\s*(\d+)/.exec(stdout);
  // Not just /linear constraints:/ — that also matches inside the
  // "non-linear constraints:" line above (it's a substring of it).
  const linear = /^linear constraints:\s*(\d+)/m.exec(stdout);
  if (!nonLinear || !linear) {
    throw new Error(`Could not parse circom output for ${entryFile}:\n${stdout}`);
  }
  return {
    nonLinear: parseInt(nonLinear[1], 10),
    linear: parseInt(linear[1], 10),
    raw: stdout,
  };
}

// Gadget name -> { file, label }. Every one of these is a standalone circuit
// with `component main = <gadget>(...)`, isolating exactly one instance of
// the gadget at the arity actually used somewhere in the protocol.
const GADGETS = [
  { name: "poseidon2", label: "Poseidon(2)" },
  { name: "poseidon3", label: "Poseidon(3)" },
  { name: "poseidon4", label: "Poseidon(4)" },
  { name: "poseidon5", label: "Poseidon(5)" },
  { name: "num2bits64", label: "Num2Bits(64)" },
  { name: "num2bits8", label: "Num2Bits(8)" },
  { name: "greaterthan64", label: "GreaterThan(64)" },
  { name: "lesseqthan64", label: "LessEqThan(64)" },
  { name: "greaterequalthan64", label: "GreaterEqThan(64)" },
  { name: "greaterequalthan8", label: "GreaterEqThan(8)" },
  { name: "merkleproof20", label: "MerkleProof(20)" },
];

const REAL_CIRCUITS = [
  { name: "transfer", file: join(CIRCUITS_DIR, "transfer.circom") },
  { name: "compliance", file: join(CIRCUITS_DIR, "compliance.circom") },
  { name: "withdraw", file: join(CIRCUITS_DIR, "withdraw.circom") },
];

// Instantiation inventory, read directly off each circuit's source (cited by
// component name so it can be checked against the .circom file by hand).
// "extra" is non-linear constraints from primitive R1CS ops that aren't a
// gadget call — hand-counted from source, not measured, because there is no
// standalone gadget to compile. Each is cited.
const INVENTORY = {
  transfer: {
    gadgets: { poseidon4: 3, poseidon3: 1, merkleproof20: 1, greaterthan64: 1, num2bits64: 4, lesseqthan64: 1 },
    // oldHash, newHash, nfHash (Poseidon4) + txHash (Poseidon3) + membershipProof
    // (MerkleProof20) + gtZero (GreaterThan64) + oldBits/txBits/newBits/threshBits
    // (Num2Bits64 x4) + ltThreshold (LessEqThan64). C3 (cumulativeNew === cumulativeOld
    // + txAmount) is a pure linear R1CS constraint: 0 non-linear.
    extra: 0,
    extraNote: "C3 (cumulativeNew === cumulativeOld + txAmount) is linear addition — 0 non-linear constraints.",
  },
  compliance: {
    gadgets: {
      poseidon5: 1,
      poseidon3: 2,
      merkleproof20: 1,
      greaterequalthan64: 1,
      greaterequalthan8: 1,
      num2bits64: 3,
      num2bits8: 2,
    },
    // leafHash (Poseidon5) + nfHash/ctxHash (Poseidon3 x2) + merkleProof
    // (MerkleProof20) + expiryCheck (GreaterEqThan64) + kycCheck (GreaterEqThan8)
    // + epochBits/expiryBits/issuerBits (Num2Bits64 x3) + kycBits/reqKycBits
    // (Num2Bits8 x2). Plus 3 primitive non-linear constraints not covered by any
    // gadget: expiryCheck.out*(1-expiryCheck.out)===0 (1), kycCheck.out*(1-kycCheck.out)===0
    // (1), computedValid <== expiryCheck.out * kycCheck.out (1 multiplication).
    extra: 3,
    extraNote:
      "3 hand-counted non-linear constraints from source: expiryCheck.out*(1-expiryCheck.out)===0, " +
      "kycCheck.out*(1-kycCheck.out)===0, and computedValid <== expiryCheck.out * kycCheck.out " +
      "(each is a single R1CS multiplication gate, not a gadget call).",
  },
  withdraw: {
    gadgets: { poseidon4: 3, poseidon2: 1, num2bits64: 3, greaterthan64: 1, lesseqthan64: 1 },
    // commHash/changeHash/nfHash (Poseidon4 x3) + recipHash (Poseidon2) +
    // amountBits/cumBits/remBits (Num2Bits64 x3) + gtZero (GreaterThan64) +
    // amountCheck (LessEqThan64). remainingBalance <== cumulativeOld - withdrawAmount
    // is linear subtraction: 0 non-linear constraints.
    extra: 0,
    extraNote: "remainingBalance <== cumulativeOld - withdrawAmount is linear subtraction — 0 non-linear constraints.",
  },
};

function main() {
  const circom = findCircom();
  const stdout = execFileSync(circom, ["--version"], { encoding: "utf8" }).trim();
  console.log(`=== Veil Poseidon-vs-everything-else constraint breakdown ===`);
  console.log(`${stdout}\n`);

  const tmp = mkdtempSync(join(tmpdir(), "veil-poseidon-cost-"));
  const gadgetResults = {};

  try {
    console.log("--- Standalone gadget costs ---\n");
    for (const g of GADGETS) {
      const entry = join(BENCH_CIRCUITS_DIR, `${g.name}.circom`);
      const outDir = join(tmp, g.name);
      const { nonLinear, linear, raw } = compileAndParse(circom, entry, outDir, [
        CIRCUITS_DIR,
        join(CIRCUITS_DIR, "node_modules"),
      ]);
      gadgetResults[g.name] = { nonLinear, linear };
      console.log(`$ circom ${entry.replace(REPO_ROOT + "/", "")} --r1cs -l circuits -l circuits/node_modules`);
      console.log(raw);
      console.log(`-> ${g.label}: ${nonLinear} non-linear, ${linear} linear\n`);
    }

    console.log("--- Real circuits (measured directly, same compiler, same flags) ---\n");
    const realResults = {};
    for (const c of REAL_CIRCUITS) {
      const outDir = join(tmp, c.name);
      const { nonLinear, linear, raw } = compileAndParse(circom, c.file, outDir, [
        CIRCUITS_DIR,
        join(CIRCUITS_DIR, "node_modules"),
      ]);
      realResults[c.name] = { nonLinear, linear };
      console.log(`$ circom ${c.name}.circom --r1cs -l circuits/node_modules (from circuits/)`);
      console.log(raw);
      console.log(`-> ${c.name}: ${nonLinear} non-linear, ${linear} linear\n`);
    }

    console.log("--- Predicted (sum of standalone gadget costs) vs actual ---\n");
    console.log(
      "| Circuit | Predicted non-linear | Actual non-linear | Delta | Delta % | Poseidon share of actual |"
    );
    console.log("|---|---|---|---|---|---|");
    for (const c of REAL_CIRCUITS) {
      const inv = INVENTORY[c.name];
      let predicted = inv.extra;
      let poseidonNonLinear = 0;
      for (const [gadget, count] of Object.entries(inv.gadgets)) {
        const cost = gadgetResults[gadget].nonLinear * count;
        predicted += cost;
        if (gadget.startsWith("poseidon") || gadget === "merkleproof20") {
          poseidonNonLinear += cost;
        }
      }
      const actual = realResults[c.name].nonLinear;
      const delta = predicted - actual;
      const deltaPct = ((delta / actual) * 100).toFixed(2);
      const poseidonSharePct = ((poseidonNonLinear / actual) * 100).toFixed(1);
      console.log(
        `| \`${c.name}.circom\` | ${predicted} | ${actual} | ${delta >= 0 ? "+" : ""}${delta} | ${deltaPct}% | ${poseidonNonLinear} (${poseidonSharePct}%) |`
      );
    }
    console.log(
      "\n(\"Poseidon share\" counts MerkleProof(20) as Poseidon cost — its 20 Poseidon(2) calls " +
        "are essentially all of its non-linear constraints; see the MerkleProof(20) row above.)\n"
    );
    for (const c of REAL_CIRCUITS) {
      console.log(`${c.name}: ${INVENTORY[c.name].extraNote}`);
    }

    console.log("\n--- Bonus: does Merkle depth cost scale linearly? (queue item #4) ---\n");
    const depths = [10, 20, 30];
    const depthResults = [];
    for (const d of depths) {
      const entry = join(BENCH_CIRCUITS_DIR, `merkleproof${d}.circom`);
      const outDir = join(tmp, `merkleproof${d}`);
      const { nonLinear, raw } = compileAndParse(circom, entry, outDir, [
        CIRCUITS_DIR,
        join(CIRCUITS_DIR, "node_modules"),
      ]);
      depthResults.push({ depth: d, nonLinear });
      console.log(`$ circom scripts/bench/poseidon-cost/circuits/merkleproof${d}.circom --r1cs -l circuits -l circuits/node_modules`);
      console.log(raw);
    }
    console.log("| Merkle depth | Anonymity set (2^depth) | Non-linear constraints | Per-level (this - previous) / 10 |");
    console.log("|---|---|---|---|");
    for (let i = 0; i < depthResults.length; i++) {
      const { depth, nonLinear } = depthResults[i];
      const perLevel = i === 0 ? "-" : ((nonLinear - depthResults[i - 1].nonLinear) / (depth - depthResults[i - 1].depth)).toFixed(1);
      console.log(`| ${depth} | 2^${depth} | ${nonLinear} | ${perLevel} |`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
