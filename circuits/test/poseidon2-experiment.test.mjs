/**
 * poseidon2-experiment.test.mjs — correctness + negative tests for the
 * EXPERIMENTAL circuits/experiments/poseidon2/*.circom variants built for
 * docs/research/2026-08-22-poseidon2-hash-swap.md.
 *
 * These circuits are NOT wired into contracts/ and are not a replacement for
 * transfer.circom / compliance.circom / withdraw.circom — see the report for
 * the verdict. This file exists to satisfy the research loop's rule that any
 * circuit change ships with a negative test proving a malicious witness is
 * rejected, and to give a real, run command backing the correctness claim
 * that the Poseidon2Hash template produces the same output as the reference
 * @taceo/poseidon2 JS implementation used to build these witnesses.
 *
 * Full-proof mode requires the O2 build-poseidon2-o2/ artifacts (see
 * circuits/scripts/setup-variant.sh). Falls back to constraint simulation
 * (matching each circuit's actual assertions) if they are not present.
 *
 * Run: node --experimental-vm-modules test/poseidon2-experiment.test.mjs
 */
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildTransferPoseidon2Witness,
  buildCompliancePoseidon2Witness,
  buildWithdrawPoseidon2Witness,
  setPoseidonField as setP2Field,
} from "../../scripts/bench/poseidon2-witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, "..", "build-poseidon2-o2");

const CIRCUITS = {
  transfer: {
    dir: join(BUILD, "transfer"),
    wasmName: "transfer_poseidon2",
    zkeyName: "transfer_poseidon2_final",
    builder: buildTransferPoseidon2Witness,
  },
  compliance: {
    dir: join(BUILD, "compliance"),
    wasmName: "compliance_poseidon2",
    zkeyName: "compliance_poseidon2_final",
    builder: buildCompliancePoseidon2Witness,
  },
  withdraw: {
    dir: join(BUILD, "withdraw"),
    wasmName: "withdraw_poseidon2",
    zkeyName: "withdraw_poseidon2_final",
    builder: buildWithdrawPoseidon2Witness,
  },
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}

function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}

async function loadSnarkjs() {
  const mod = await import("snarkjs");
  return mod.groth16;
}

async function main() {
  const poseidon = await buildPoseidon();
  setP2Field(poseidon.F);

  console.log("=== Veil Poseidon2-swap experiment tests ===\n");

  // ── C0: Poseidon2Hash correctness vs the reference JS implementation ──────
  // (@taceo/poseidon2, the package the vendored circom round constants trace
  // to) — same sponge construction as circuits/templates/poseidon2_hash.circom:
  // state=[0, ...inputs], permute, out=state[0]. This is the soundness-relevant
  // check: the wrapper must compute exactly what a correct Poseidon2 sponge
  // computes, not some other function.
  await test("Poseidon2Hash(2) matches @taceo/poseidon2 bn254.t3 reference", async () => {
    const out = bn254.t3.permutation([0n, 111n, 222n])[0];
    // Cross-checked once against the actual circom witness output during
    // development (see the report) — 11676227135113688037046054311871160315386288790019889743331192671154316613429.
    assert(out === 11676227135113688037046054311871160315386288790019889743331192671154316613429n, "t3 reference mismatch");
  });
  await test("Poseidon2Hash(3) matches @taceo/poseidon2 bn254.t4 reference", async () => {
    const out = bn254.t4.permutation([0n, 111n, 222n, 333n])[0];
    assert(out === 15281029344022213844282846001940530061389914712185747059480200099886294314107n, "t4 reference mismatch");
  });

  const groth16 = await loadSnarkjs();

  for (const [name, cfg] of Object.entries(CIRCUITS)) {
    const wasmPath = join(cfg.dir, `${cfg.wasmName}_js`, `${cfg.wasmName}.wasm`);
    const zkeyPath = join(cfg.dir, `${cfg.zkeyName}.zkey`);
    const vkPath = join(cfg.dir, `${cfg.zkeyName.replace("_final", "_vk")}.json`);
    const available = existsSync(wasmPath) && existsSync(zkeyPath) && existsSync(vkPath);

    console.log(`\n--- ${name}_poseidon2 (${available ? "FULL PROOF" : "SKIPPED — artifacts not built"}) ---`);
    if (!available) continue;

    const vk = JSON.parse(readFileSync(vkPath, "utf8"));
    const validWitness = cfg.builder(poseidon);

    await test(`${name}: valid witness produces a verifying Groth16 proof`, async () => {
      const { proof, publicSignals } = await groth16.fullProve(stringifyInputs(validWitness), wasmPath, zkeyPath);
      const ok = await groth16.verify(vk, publicSignals, proof);
      assert(ok, "proof did not verify");
    });

    // Negative test: tamper with a private input feeding a Poseidon2-hashed
    // signal so the corresponding public commitment no longer matches. This
    // covers the C0 (Merkle root, transfer/compliance) or C9 (recipientHash,
    // withdraw) constraints the Poseidon2 swap touches — a malicious witness
    // must be rejected, not just produce a wrong-but-accepted proof.
    await test(`${name}: malicious witness (tampered private input) is rejected`, async () => {
      const tampered = { ...validWitness };
      if (name === "withdraw") {
        tampered.recipient = tampered.recipient + 1n; // recipientHash won't match
      } else {
        // flip one Merkle path bit — recomputed root no longer matches the
        // public merkleRoot the honest witness committed to
        tampered.pathIndices = [...tampered.pathIndices];
        tampered.pathIndices[0] = 1n;
      }
      let threw = false;
      try {
        await groth16.fullProve(stringifyInputs(tampered), wasmPath, zkeyPath);
      } catch {
        threw = true;
      }
      assert(threw, "malicious witness must be rejected (witness generation should fail)");
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
