#!/usr/bin/env node
/**
 * gadget-attribution.mjs — measures the R1CS constraint cost of each individual
 * circomlib gadget Veil's circuits are built from (Poseidon at each arity, the
 * depth-20 Merkle tree level, Num2Bits, the comparators), then reconstructs
 * transfer.circom / compliance.circom / withdraw.circom's real constraint totals
 * as a sum of (gadget cost x call count) and diffs that reconstruction against
 * the actual measured totals in docs/research/BASELINE.md.
 *
 * This answers "where do the constraints actually come from" with real numbers
 * instead of guessing — the natural prerequisite for judging whether a Poseidon2
 * swap (or a shallower Merkle tree, or fewer range checks) is the higher-leverage
 * optimization for prover time.
 *
 * Prerequisite: circom2 (WASM build of the circom compiler, works without a
 * system circom install or network access beyond the npm registry):
 *   cd circuits && npm install --no-save circom2
 *
 * Usage:
 *   node scripts/bench/gadget-attribution.mjs             # constraint counts only
 *   node scripts/bench/gadget-attribution.mjs --prove     # + real Groth16 proving time
 *                                                            for a representative subset
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const GADGETS_DIR = join(CIRCUITS_DIR, "bench-gadgets");
const BUILD_DIR = join(GADGETS_DIR, "build");
const CIRCOM2 = join(CIRCUITS_DIR, "node_modules", ".bin", "circom2");

const DO_PROVE = process.argv.includes("--prove");

// Gadget call-count inventory, read directly off transfer.circom, compliance.circom
// and withdraw.circom (see each file's Poseidon/Num2Bits/comparator component
// declarations). "merkle_level" = one loop iteration of templates/merkle_proof.circom
// (MultiMux1(2) selector + boolean check on pathIndices + Poseidon(2)), depth 20.
const CIRCUIT_INVENTORY = {
  transfer: {
    merkle_level: 20,
    poseidon4: 3, // oldHash (C1), newHash (C2), nfHash (C10)
    poseidon3: 1, // txHash (C11)
    num2bits64: 4, // oldBits, txBits, newBits, threshBits
    greaterthan64: 1, // gtZero (C4)
    lesseqthan64: 1, // ltThreshold (C9)
  },
  compliance: {
    poseidon5: 1, // leafHash (C1)
    merkle_level: 20, // merkleProof (C2)
    poseidon3: 2, // nfHash (C3), ctxHash (C_BIND)
    num2bits64: 3, // epochBits, expiryBits, issuerBits
    num2bits8: 2, // kycBits, reqKycBits
    greaterequalthan64: 1, // expiryCheck (C4)
    greaterequalthan8: 1, // kycCheck (C5)
  },
  withdraw: {
    poseidon4: 3, // commHash (C1), changeHash (C6), nfHash (C8)
    poseidon2: 1, // recipHash (C9)
    num2bits64: 3, // amountBits, cumBits, remBits
    greaterthan64: 1, // gtZero (C3)
    lesseqthan64: 1, // amountCheck (C5)
  },
};

// Real, measured totals from docs/research/BASELINE.md (2026-07-22 baseline run),
// reconfirmed by a fresh `circom2 transfer.circom --r1cs` in this same session.
const MEASURED_TOTALS = {
  transfer: { nonLinear: 6470, linear: 7141 },
  compliance: { nonLinear: 6057, linear: 6686 },
  withdraw: { nonLinear: 1465, linear: 1593 },
};

function compileGadget(file) {
  const name = basename(file, ".circom");
  const out = join(BUILD_DIR, name);
  mkdirSync(out, { recursive: true });
  execFileSync(CIRCOM2, [join(GADGETS_DIR, file), "--r1cs", "--wasm", "-o", out, "-l", join(CIRCUITS_DIR, "node_modules")], {
    stdio: "pipe",
  });
  const infoRaw = execFileSync("npx", ["--prefix", CIRCUITS_DIR, "snarkjs", "r1cs", "info", join(out, `${name}.r1cs`)], {
    encoding: "utf8",
  });
  const nonLinear = parseInt(infoRaw.match(/# of Constraints:\s*(\d+)/)[1], 10);
  // snarkjs r1cs info reports total constraints only; circom2's own stdout during
  // compile prints the non-linear/linear split, so we re-run with --verbose off and
  // capture that instead for the authoritative split.
  const compileOut = execFileSync(
    CIRCOM2,
    [join(GADGETS_DIR, file), "--r1cs", "-o", out, "-l", join(CIRCUITS_DIR, "node_modules")],
    { encoding: "utf8" }
  );
  const nl = parseInt(compileOut.match(/non-linear constraints:\s*(\d+)/)[1], 10);
  const lin = parseInt(compileOut.match(/(?<!non-)linear constraints:\s*(\d+)/)[1], 10);
  if (nl + lin !== nonLinear) {
    throw new Error(`${name}: r1cs info total ${nonLinear} != non-linear+linear ${nl + lin}`);
  }
  return { name, nonLinear: nl, linear: lin, wasm: join(out, `${name}_js`, `${name}.wasm`), r1cs: join(out, `${name}.r1cs`) };
}

console.log("=== Veil gadget constraint attribution ===");
console.log(`circom: ${execFileSync(CIRCOM2, ["--version"], { encoding: "utf8" }).trim()}\n`);

const files = readdirSync(GADGETS_DIR).filter((f) => f.endsWith(".circom"));
const gadgets = {};
for (const f of files) {
  const g = compileGadget(f);
  gadgets[g.name] = g;
  console.log(`${g.name.padEnd(20)} non-linear: ${String(g.nonLinear).padStart(4)}   linear: ${String(g.linear).padStart(4)}   total: ${g.nonLinear + g.linear}`);
}

console.log("\n=== Reconstruction: sum(gadget cost x call count) vs measured baseline ===\n");
for (const [circuit, inventory] of Object.entries(CIRCUIT_INVENTORY)) {
  let nl = 0,
    lin = 0;
  const rows = [];
  for (const [gadget, count] of Object.entries(inventory)) {
    const g = gadgets[gadget];
    nl += g.nonLinear * count;
    lin += g.linear * count;
    rows.push(`  ${String(count).padStart(2)} x ${gadget.padEnd(20)} = ${g.nonLinear * count} non-linear, ${g.linear * count} linear`);
  }
  const measured = MEASURED_TOTALS[circuit];
  console.log(`--- ${circuit}.circom ---`);
  rows.forEach((r) => console.log(r));
  console.log(`  predicted:  ${nl} non-linear, ${lin} linear (${nl + lin} total)`);
  console.log(`  measured:   ${measured.nonLinear} non-linear, ${measured.linear} linear (${measured.nonLinear + measured.linear} total)`);
  console.log(`  delta:      ${nl - measured.nonLinear} non-linear, ${lin - measured.linear} linear\n`);
}

if (DO_PROVE) {
  console.log("=== Real Groth16 proving time for a representative gadget subset ===\n");
  const PTAU = join(BUILD_DIR, "pot12_final.ptau");
  const snarkjsCli = (args) =>
    execFileSync("npx", ["--prefix", CIRCUITS_DIR, "snarkjs", ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (!existsSync(PTAU)) {
    console.log("Generating a local, dev-only powers-of-tau (2^12, bn128) — no network required...");
    const p0 = join(BUILD_DIR, "pot12_0000.ptau");
    const p1 = join(BUILD_DIR, "pot12_0001.ptau");
    console.log("  powersoftau new...");
    snarkjsCli(["powersoftau", "new", "bn128", "12", p0]);
    console.log("  powersoftau contribute...");
    snarkjsCli(["powersoftau", "contribute", p0, p1, "--name=gadget-bench", "-e=gadget-bench-entropy"]);
    console.log("  powersoftau prepare phase2...");
    snarkjsCli(["powersoftau", "prepare", "phase2", p1, PTAU]);
  }

  const SUBSET = ["poseidon2", "poseidon4", "merkle_level", "num2bits64"];
  const RUNS = 15;
  for (const name of SUBSET) {
    const g = gadgets[name];
    const zkey0 = join(BUILD_DIR, name, `${name}_0000.zkey`);
    const zkeyF = join(BUILD_DIR, name, `${name}_final.zkey`);
    if (!existsSync(zkeyF)) {
      console.log(`  ${name}: groth16 setup + zkey contribute...`);
      snarkjsCli(["groth16", "setup", g.r1cs, PTAU, zkey0]);
      snarkjsCli(["zkey", "contribute", zkey0, zkeyF, "--name=gadget-bench", "-e=gadget-bench-entropy"]);
    }
    // Arbitrary well-formed field-element inputs — these gadgets have no
    // semantic validity constraint on their own (that lives in the circuits
    // that embed them), so any input in range produces a satisfiable witness.
    const nInputs = { poseidon2: 2, poseidon4: 4 }[name];
    const input =
      name === "merkle_level"
        ? { node: "11", pathElement: "22", pathIndex: "0" }
        : name === "num2bits64"
          ? { in: "123456789" }
          : { inputs: Array.from({ length: nInputs }, (_, i) => String(i + 1)) };

    const times = [];
    let proof, publicSignals;
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      ({ proof, publicSignals } = await snarkjs.groth16.fullProve(input, g.wasm, zkeyF));
      const t1 = process.hrtime.bigint();
      if (i > 0) times.push(Number(t1 - t0) / 1e6); // discard first run (cold WASM instantiation)
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const msPerConstraint = mean / (g.nonLinear + g.linear);
    console.log(
      `${name.padEnd(14)} mean: ${mean.toFixed(2)} ms over ${times.length} runs   (${g.nonLinear + g.linear} constraints, ${msPerConstraint.toFixed(4)} ms/constraint)`
    );
  }
}
