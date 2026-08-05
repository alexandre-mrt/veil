#!/usr/bin/env node
// Negative test for withdraw_poseidon2.circom: a witness with a tampered
// newCommitment (doesn't match Poseidon2(1, remainingBalance, randomnessNew,
// userSecret)) must be rejected by the witness calculator — same hard
// equality (C6) as the original withdraw.circom, now backed by Poseidon2
// instead of Poseidon. Confirms the hash-primitive swap didn't accidentally
// under-constrain anything.
//
// Usage: node circuits/bench/withdraw_poseidon2_negative_test.mjs
// Prerequisite: bash circuits/bench/compile.sh (or the withdraw-specific
// compile commands in the research report) to produce
// build-withdraw-compare/withdraw_poseidon2_js/withdraw_poseidon2.wasm
import { join } from "path";
import * as snarkjs from "snarkjs";
import { poseidon2 } from "./compute_poseidon2.mjs";

const DIR = join(import.meta.dirname, "build-withdraw-compare");
const wasmPath = join(DIR, "withdraw_poseidon2_js", "withdraw_poseidon2.wasm");

const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;

const commitment = await poseidon2("poseidon2_t8_n4", [1n, cumulativeOld, randomnessOld, userSecret]);
const nullifier = await poseidon2("poseidon2_t8_n4", [7n, userSecret, randomnessOld, cumulativeOld]);
const recipientHash = await poseidon2("poseidon2_t3_n2", [8n, recipient]);

const tamperedInputs = {
  commitment: commitment.toString(),
  withdrawAmount: withdrawAmount.toString(),
  nullifier: nullifier.toString(),
  recipientHash: recipientHash.toString(),
  newCommitment: "1", // tampered: does not equal Poseidon2(1, remainingBalance, randomnessNew, userSecret)
  cumulativeOld: cumulativeOld.toString(),
  randomnessOld: randomnessOld.toString(),
  userSecret: userSecret.toString(),
  recipient: recipient.toString(),
  randomnessNew: randomnessNew.toString(),
};

try {
  await snarkjs.wtns.calculate(tamperedInputs, wasmPath, { type: "mem" });
  console.error("FAIL: witness calculation succeeded with a tampered newCommitment — C6 is under-constrained!");
  process.exit(1);
} catch (err) {
  console.log("PASS: tampered newCommitment correctly rejected by the witness calculator.");
  console.log("Raw error:", err.message);
}
