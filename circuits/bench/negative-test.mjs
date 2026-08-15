#!/usr/bin/env node
/**
 * negative-test.mjs — proves a malicious witness against Poseidon2Hash is rejected.
 *
 * Poseidon2Hash(nInputs) (circuits/bench/circuits/poseidon2_hash.circom) constrains the
 * sponge's capacity element and every padding slot to 0 via `<==` (not `<--`), exactly
 * mirroring circomlib's Poseidon(nInputs), which sets `initialState <== 0`. The claim under
 * test: a prover cannot claim a hash output that doesn't match the real Poseidon2 permutation
 * of the declared inputs and still pass `wtns check` — i.e. the output is fully bound to the
 * input by the R1CS, the way a nullifier/commitment forgery attempt would need to break.
 *
 * Method: compute an honest witness for poseidon2_n2, tamper the witness vector entry for
 * `main.out` (found via the .sym file) to a different field element, write a raw .wtns file,
 * and run snarkjs's own R1CS witness checker against it. A sound circuit must reject it.
 *
 * Usage: node circuits/bench/negative-test.mjs
 * Prerequisite: bash circuits/bench/compile.sh
 */
import { readFileSync, existsSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import * as binFileUtils from "@iden3/binfileutils";
import { Scalar } from "ffjavascript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "build");
const NAME = "poseidon2_n2";
const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

async function writeWtns(path, witness) {
  const fd = await binFileUtils.createBinFile(path, "wtns", 2, 2);
  const n8 = (Math.floor((Scalar.bitLength(BN254_PRIME) - 1) / 64) + 1) * 8;
  await binFileUtils.startWriteSection(fd, 1);
  await fd.writeULE32(n8);
  await binFileUtils.writeBigInt(fd, BN254_PRIME, n8);
  await fd.writeULE32(witness.length);
  await binFileUtils.endWriteSection(fd);
  await binFileUtils.startWriteSection(fd, 2);
  for (const w of witness) await binFileUtils.writeBigInt(fd, w, n8);
  await binFileUtils.endWriteSection(fd, 2);
  await fd.close();
}

async function main() {
  const r1csPath = join(BUILD_DIR, `${NAME}.r1cs`);
  const wasmPath = join(BUILD_DIR, `${NAME}_js`, `${NAME}.wasm`);
  const symPath = join(BUILD_DIR, `${NAME}.sym`);
  if (!existsSync(r1csPath) || !existsSync(wasmPath)) {
    console.log("[SKIP] artifacts not found — run: bash circuits/bench/compile.sh");
    process.exit(1);
  }

  // witness_calculator.js is CommonJS but sits under circuits/, whose package.json says
  // "type": "module" — copy it to a .cjs sibling so Node's loader treats it correctly.
  const wcSrc = join(BUILD_DIR, `${NAME}_js`, "witness_calculator.js");
  const wcCjs = join(BUILD_DIR, `${NAME}_js`, "witness_calculator.cjs");
  copyFileSync(wcSrc, wcCjs);
  const { default: WitnessCalculatorBuilder } = await import(wcCjs);
  const wasmBuffer = readFileSync(wasmPath);
  const wc = await WitnessCalculatorBuilder(wasmBuffer);

  const input = { inputs: ["7", "11"] };
  const honestWitness = await wc.calculateWitness(input, true);

  // --- positive control: the honest witness must satisfy the R1CS ---
  const honestPath = join(BUILD_DIR, `${NAME}_honest.wtns`);
  await writeWtns(honestPath, honestWitness);
  const honestOk = await snarkjs.wtns.check(r1csPath, honestPath, console);
  console.log(`Honest witness satisfies R1CS: ${honestOk}`);
  if (!honestOk) {
    console.error("FAIL: honest witness should satisfy the circuit — test harness is broken, not the circuit.");
    process.exit(1);
  }

  // --- find witness index for main.state[0] (the sponge capacity element) ---
  // Circom's optimizer folds `state[0] <== 0` into the downstream constraints at compile
  // time (no separate witness wire survives for it — .sym reports wireId -1), which is
  // itself a soundness data point: the capacity element isn't just algebraically pinned to
  // zero by one checkable constraint, it's structurally eliminated and can never be anything
  // else in the compiled circuit. So the meaningful "malicious witness" target is the thing
  // an attacker actually controls at proof time: the claimed hash output for known inputs.
  const sym = readFileSync(symPath, "utf8").trim().split("\n");
  const line = sym.find((l) => l.endsWith(",main.out"));
  if (!line) throw new Error("could not find main.out in .sym file");
  const wireId = parseInt(line.split(",")[1], 10);
  console.log(`main.out is witness index ${wireId}, honest value = ${honestWitness[wireId]}`);

  // --- malicious witness: claim a different hash output for the same inputs ---
  const maliciousWitness = [...honestWitness];
  maliciousWitness[wireId] = (maliciousWitness[wireId] + 1n) % BN254_PRIME;
  const maliciousPath = join(BUILD_DIR, `${NAME}_malicious.wtns`);
  await writeWtns(maliciousPath, maliciousWitness);

  const maliciousOk = await snarkjs.wtns.check(r1csPath, maliciousPath, console);
  console.log(`Malicious witness (out=${maliciousWitness[wireId]}) satisfies R1CS: ${maliciousOk}`);

  if (maliciousOk) {
    console.error("FAIL: the circuit accepted a forged hash output for the same inputs — under-constrained!");
    process.exit(1);
  } else {
    console.log("PASS: malicious witness correctly rejected (R1CS constraint violated).");
    process.exit(0);
  }
}

main();
