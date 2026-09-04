#!/usr/bin/env node
/**
 * poseidon2-negative-tests.mjs — Malicious-witness rejection tests for the three
 * *_poseidon2.circom bench circuits, mirroring the style of circuits/test/*.test.mjs
 * (assertRejected/assertAccepted around a real snarkjs.groth16.fullProve call — a
 * failing `===` constraint makes witness calculation throw, so "rejected" here means
 * proof generation itself fails, the same signal the production test suite checks).
 *
 * Covers, per circuit where applicable:
 *   - positive control: an honestly-built witness proves and verifies
 *   - tampered Merkle sibling is rejected (root no longer matches the path)
 *   - non-boolean pathIndices is rejected (the `x * (1-x) === 0` boolean constraint)
 *   - a public hash output that doesn't match its private preimage is rejected
 *     (proves the Poseidon2Sponge circuit actually enforces the hash, not just
 *     computes and ignores it)
 *
 * Usage: node scripts/bench/poseidon2-negative-tests.mjs
 * Prerequisite: cd circuits && bash scripts/compile-poseidon2-bench.sh
 */
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import assert from "assert";
import * as snarkjs from "snarkjs";
import {
  buildTransferHashPoseidon2Witness,
  buildComplianceHashPoseidon2Witness,
  buildWithdrawHashPoseidon2Witness,
  stringifyInputs,
} from "./poseidon2-bench-witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "..", "..", "circuits", "build-bench");

let pass = 0, fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
    fail++;
  }
}

function artifacts(name) {
  return {
    wasm: join(BENCH_DIR, name, `${name}_js`, `${name}.wasm`),
    zkey: join(BENCH_DIR, name, `${name}_final.zkey`),
    vk: join(BENCH_DIR, name, `${name}_vk.json`),
  };
}

async function proveAndVerify(name, inputs) {
  const { wasm, zkey, vk } = artifacts(name);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(inputs), wasm, zkey);
  const valid = await snarkjs.groth16.verify(JSON.parse(readFileSync(vk, "utf8")), publicSignals, proof);
  return valid;
}

async function assertAccepted(name, inputs, label) {
  const valid = await proveAndVerify(name, inputs);
  assert(valid, `${label}: Groth16 proof must verify`);
}

async function assertRejected(name, inputs, label) {
  let threw = false;
  try {
    await proveAndVerify(name, inputs);
  } catch {
    threw = true;
  }
  assert(threw, `${label}: proof generation must fail for a malicious/inconsistent witness`);
}

async function main() {
  console.log("=== Poseidon2 bench: malicious-witness rejection tests ===\n");

  for (const name of ["transfer_hash_poseidon2", "compliance_hash_poseidon2", "withdraw_hash_poseidon2"]) {
    const { wasm, zkey, vk } = artifacts(name);
    if (!existsSync(wasm) || !existsSync(zkey) || !existsSync(vk)) {
      console.log(`[SKIP] ${name}: artifacts not found — run scripts/compile-poseidon2-bench.sh first\n`);
      continue;
    }
    console.log(`--- ${name} ---`);

    if (name === "transfer_hash_poseidon2") {
      const w = buildTransferHashPoseidon2Witness();
      await test("honest witness accepted", () => assertAccepted(name, w, "positive control"));

      await test("tampered Merkle sibling rejected", () => {
        const bad = { ...w, pathElements: [...w.pathElements] };
        bad.pathElements[3] = bad.pathElements[3] + 1n;
        return assertRejected(name, bad, "T-P2-1");
      });

      await test("non-boolean pathIndices rejected", () => {
        const bad = { ...w, pathIndices: [...w.pathIndices] };
        bad.pathIndices[0] = 2n;
        return assertRejected(name, bad, "T-P2-2");
      });

      await test("public nullifier not matching private preimage rejected", () => {
        const bad = { ...w, nullifier: w.nullifier + 1n };
        return assertRejected(name, bad, "T-P2-3");
      });
    }

    if (name === "compliance_hash_poseidon2") {
      const w = buildComplianceHashPoseidon2Witness();
      await test("honest witness accepted", () => assertAccepted(name, w, "positive control"));

      await test("tampered Merkle sibling rejected", () => {
        const bad = { ...w, pathElements: [...w.pathElements] };
        bad.pathElements[7] = bad.pathElements[7] + 1n;
        return assertRejected(name, bad, "C-P2-1");
      });

      await test("non-boolean pathIndices rejected", () => {
        const bad = { ...w, pathIndices: [...w.pathIndices] };
        bad.pathIndices[5] = 5n;
        return assertRejected(name, bad, "C-P2-2");
      });

      await test("public contextId not matching private preimage rejected", () => {
        const bad = { ...w, contextId: w.contextId + 1n };
        return assertRejected(name, bad, "C-P2-3");
      });
    }

    if (name === "withdraw_hash_poseidon2") {
      const w = buildWithdrawHashPoseidon2Witness();
      await test("honest witness accepted", () => assertAccepted(name, w, "positive control"));

      await test("public commitment not matching private preimage rejected", () => {
        const bad = { ...w, commitment: w.commitment + 1n };
        return assertRejected(name, bad, "W-P2-1");
      });

      await test("public recipientHash not matching private recipient rejected", () => {
        const bad = { ...w, recipientHash: w.recipientHash + 1n };
        return assertRejected(name, bad, "W-P2-2");
      });
    }

    console.log("");
  }

  console.log(`=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
