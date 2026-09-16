/**
 * poseidon2-microbench.test.mjs -- correctness + negative test for the
 * Poseidon2 benchmark circuits under circuits/bench/ (docs/research/
 * 2026-09-16-poseidon2-microbench.md).
 *
 * This does NOT test any production circuit — circuits/bench/poseidon2.circom
 * is an isolated, non-shipped scaffold used only to measure a constraint-count
 * and proving-time delta against the current Poseidon. Two checks:
 *
 *   1. Correctness: the circuit's output for a known input matches
 *      @taceo/poseidon2's native (non-circuit) reference permutation.
 *   2. Negative test: circuits/bench/mains/hash{2,3}_poseidon2_checked.circom
 *      constrain a public `claimedOut` against the real permutation output
 *      (`claimedOut === h.out`, the same pattern as `oldCommitment ===
 *      oldHash.out` in transfer.circom). A witness whose claimedOut is wrong
 *      must fail witness generation.
 *
 * Requires: bash circuits/bench/compile-bench.sh (produces the wasm/zkey
 * artifacts this test reads). Skips with a clear message if not compiled.
 *
 * Run: node --experimental-vm-modules test/poseidon2-microbench.test.mjs
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_BUILD = join(__dirname, "..", "bench", "build");

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

function artifactsFor(name) {
  return {
    wasm: join(BENCH_BUILD, name, `${name}_js`, `${name}.wasm`),
    zkey: join(BENCH_BUILD, name, `${name}_final.zkey`),
  };
}

async function main() {
  const hash2 = artifactsFor("hash2_poseidon2");
  const hash3 = artifactsFor("hash3_poseidon2");
  const hash2Checked = artifactsFor("hash2_poseidon2_checked");

  if (!existsSync(hash2.wasm) || !existsSync(hash3.wasm) || !existsSync(hash2Checked.wasm)) {
    console.log(
      "[SKIP] bench artifacts not found — run: bash circuits/bench/compile-bench.sh"
    );
    process.exit(0);
  }

  console.log("--- Correctness (vs. @taceo/poseidon2 native reference) ---");

  // Reference values: bn254.t3.permutation([0n,1n,2n])[0] and
  // bn254.t4.permutation([0n,1n,2n,3n])[0], computed independently via
  // `import { bn254 } from "@taceo/poseidon2"` (see docs/research/
  // 2026-09-16-poseidon2-microbench.md, "Correctness check" section, for the
  // exact command). Hardcoded here so this test has no dependency on the
  // npm package at test time — only the generated circuit needs to agree.
  const REF_HASH2 =
    "5297208644449048816064511434384511824916970985131888684874823260532015509555";
  const REF_HASH3 =
    "786823568102245344938517132468097745676732687098822989626730198331658606391";

  const r1 = await snarkjs.groth16.fullProve({ inputs: ["1", "2"] }, hash2.wasm, hash2.zkey);
  report("hash2_poseidon2(1,2) matches native Poseidon2 reference", r1.publicSignals[0] === REF_HASH2, `got ${r1.publicSignals[0]}`);

  const r2 = await snarkjs.groth16.fullProve({ inputs: ["1", "2", "3"] }, hash3.wasm, hash3.zkey);
  report("hash3_poseidon2(1,2,3) matches native Poseidon2 reference", r2.publicSignals[0] === REF_HASH3, `got ${r2.publicSignals[0]}`);

  console.log("\n--- Negative test (malicious witness rejected) ---");

  let positiveOk = false;
  try {
    await snarkjs.groth16.fullProve(
      { inputs: ["1", "2"], claimedOut: REF_HASH2 },
      hash2Checked.wasm,
      hash2Checked.zkey
    );
    positiveOk = true;
  } catch (e) {
    positiveOk = false;
  }
  report("correct claimedOut: witness generation succeeds", positiveOk);

  let negativeRejected = false;
  try {
    await snarkjs.groth16.fullProve(
      { inputs: ["1", "2"], claimedOut: (BigInt(REF_HASH2) + 1n).toString() },
      hash2Checked.wasm,
      hash2Checked.zkey
    );
    negativeRejected = false; // should never reach here
  } catch (e) {
    negativeRejected = /Assert Failed/.test(e.message);
  }
  report("claimedOut off by one: witness generation fails (Assert Failed)", negativeRejected);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
