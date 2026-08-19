// Negative test: a tampered witness for the vendored Poseidon2Hash circuit must be REJECTED by
// the R1CS constraints. This isn't a claim about the whole protocol (this circuit isn't wired
// into transfer/compliance/withdraw) -- it's the baseline soundness sanity check for new circuit
// code being added to the repo at all: confirms circom's `<==` constraints on the vendored
// Poseidon2 permutation actually bind the claimed output to the real permutation of the inputs,
// not merely computing it in the witness-generation phase without constraining it.
//
// Run: node negative_test.cjs   (from this directory)
const path = require("path");
const wasm_tester = require("circom_tester").wasm;

async function main() {
  const circuit = await wasm_tester(
    path.join(__dirname, "..", "bench", "poseidon2_n2.circom"),
    { output: path.join(__dirname, "build_negtest") }
  );

  // 1. A genuine witness must satisfy the constraints.
  const w = await circuit.calculateWitness({ inputs: ["1", "2"] });
  await circuit.checkConstraints(w);
  console.log("[PASS] genuine witness satisfies constraints");

  // 2. A witness with the claimed output tampered (attacker claims out = real_out + 1, i.e.
  //    "I know a preimage of Poseidon2Hash(1,2)+1" without knowing one) must be rejected.
  const tampered = w.slice();
  tampered[1] = (BigInt(tampered[1].toString()) + 1n) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  let rejected = false;
  try {
    await circuit.checkConstraints(tampered);
  } catch (err) {
    rejected = true;
    console.log(`[PASS] tampered-output witness rejected: ${err.message}`);
  }
  if (!rejected) {
    console.error("[FAIL] tampered-output witness was NOT rejected -- constraints are under-constrained");
    process.exit(1);
  }

  // 3. Same check, tampering an internal signal instead of the public output (state after the
  //    first full round, signal index further into the witness) -- confirms intermediate wires
  //    are constrained too, not just the final output.
  const tamperedInternal = w.slice();
  const internalIdx = Math.floor(w.length / 2);
  tamperedInternal[internalIdx] = (BigInt(tamperedInternal[internalIdx].toString()) + 1n) %
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  let internalRejected = false;
  try {
    await circuit.checkConstraints(tamperedInternal);
  } catch (err) {
    internalRejected = true;
    console.log(`[PASS] tampered-internal-wire witness rejected: ${err.message}`);
  }
  if (!internalRejected) {
    console.error(`[FAIL] tampered internal wire (index ${internalIdx}) was NOT rejected`);
    process.exit(1);
  }

  console.log("\nAll negative-test checks passed.");
}

main().catch((err) => {
  console.error("Negative test crashed:", err);
  process.exit(1);
});
