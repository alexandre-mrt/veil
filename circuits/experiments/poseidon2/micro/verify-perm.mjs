/**
 * verify-perm.mjs — cross-checks the circom Poseidon2(t=2) permutation (compiled from
 * @taceo/circom-lib's poseidon2.circom, via rawperm2.circom in this directory) against
 * @taceo/poseidon2's JS implementation (bn254.t2.permutation), on a fixed input.
 *
 * This is the one correctness dependency the whole experiment's proving-time and witness-based
 * results rest on: scripts/bench/witnesses-poseidon2.mjs computes public inputs (oldCommitment,
 * nullifier, merkleRoot, ...) off-circuit using @taceo/poseidon2, and those values only produce a
 * valid witness if that JS implementation computes bit-for-bit the same permutation the compiled
 * circuit does. A mismatch here would make every downstream proving-time number meaningless (the
 * witness builder would simply fail to produce satisfying witnesses), so this is checked once,
 * explicitly, before relying on it anywhere else.
 *
 * Prerequisite: circom rawperm2.circom --r1cs --wasm -o build -l ../../../node_modules
 * Run: node micro/verify-perm.mjs
 */
import { WitnessCalculatorBuilder } from "circom_runtime";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { bn254 } from "@taceo/poseidon2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "build", "rawperm2_js", "rawperm2.wasm");

async function main() {
  const wasm = await fs.readFile(WASM_PATH);
  const wc = await WitnessCalculatorBuilder(wasm);
  const w = await wc.calculateWitness({ in: [111n, 222n] }, false);

  const circomOut0 = w[1].toString();
  const circomOut1 = w[2].toString();

  const jsOut = bn254.t2.permutation([111n, 222n]);
  const jsOut0 = jsOut[0].toString();
  const jsOut1 = jsOut[1].toString();

  console.log("circom out[0]:", circomOut0);
  console.log("circom out[1]:", circomOut1);
  console.log("js     out[0]:", jsOut0);
  console.log("js     out[1]:", jsOut1);

  const match = circomOut0 === jsOut0 && circomOut1 === jsOut1;
  console.log("MATCH:", match);
  if (!match) {
    console.error("FAIL: circom and JS Poseidon2 permutations disagree — do not trust witnesses-poseidon2.mjs");
    process.exit(1);
  }
}

main();
