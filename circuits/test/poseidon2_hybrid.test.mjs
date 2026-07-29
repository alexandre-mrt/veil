/**
 * poseidon2_hybrid.test.mjs — Real Groth16 proof tests for the Poseidon2-hybrid circuits
 * (transfer_hybrid.circom, compliance_hybrid.circom — Merkle tree hashed with Poseidon2
 * compression, everything else identical to transfer.circom/compliance.circom). See
 * docs/research/2026-07-29-poseidon2-migration.md.
 *
 * Requires build-hybrid/{transfer,compliance}/ to exist (circom compile + Groth16 setup —
 * see the report's Approach section for the exact commands). Always runs real full proofs;
 * there is no hash-only fallback mode here (unlike transfer.test.mjs / compliance.test.mjs)
 * because the whole point of this circuit is the Poseidon2 witness path.
 */
import { buildPoseidon } from "circomlibjs";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { setPoseidonField, stringifyInputs, buildTransferHybridWitness, buildComplianceHybridWitness } from "../../scripts/bench/witnesses-poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..");

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name}\n    ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

async function proveAndVerify(wasmPath, zkeyPath, vk, inputs) {
  const stringInputs = stringifyInputs(inputs);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringInputs, wasmPath, zkeyPath);
  const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  return valid;
}

async function assertRejected(wasmPath, zkeyPath, vk, inputs, label) {
  let threw = false;
  try {
    const valid = await proveAndVerify(wasmPath, zkeyPath, vk, inputs);
    // Some tampers survive witness generation but must fail verification.
    if (!valid) threw = true;
  } catch {
    threw = true;
  }
  assert(threw, `${label}: malicious witness must be rejected (proof generation must fail, or the resulting proof must not verify)`);
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  const circuits = {
    transfer_hybrid: {
      dir: "build-hybrid/transfer",
      buildWitness: buildTransferHybridWitness,
    },
    compliance_hybrid: {
      dir: "build-hybrid/compliance",
      buildWitness: buildComplianceHybridWitness,
    },
  };

  for (const [name, cfg] of Object.entries(circuits)) {
    const wasmPath = join(CIRCUITS_DIR, cfg.dir, `${name}_js`, `${name}.wasm`);
    const zkeyPath = join(CIRCUITS_DIR, cfg.dir, `${name}_final.zkey`);
    const vkPath = join(CIRCUITS_DIR, cfg.dir, `${name}_vk.json`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath) || !existsSync(vkPath)) {
      console.log(`[SKIP] ${name}: artifacts not found under ${cfg.dir} — run the compile + setup steps first`);
      continue;
    }
    const vk = JSON.parse(readFileSync(vkPath, "utf8"));

    console.log(`\n--- ${name} ---`);

    await test(`${name}: happy path — valid witness produces a verifying proof`, async () => {
      const w = cfg.buildWitness(poseidon);
      const valid = await proveAndVerify(wasmPath, zkeyPath, vk, w);
      assert(valid, "valid witness must produce a verifying Groth16 proof");
    });

    await test(`${name}: C0 — wrong merkleRoot rejected (Poseidon2-hashed path doesn't match)`, async () => {
      const w = cfg.buildWitness(poseidon);
      w.merkleRoot = w.merkleRoot + 1n;
      await assertRejected(wasmPath, zkeyPath, vk, w, `${name} wrong merkleRoot`);
    });

    await test(`${name}: C0 — tampered Merkle sibling rejected (malicious prover forges a path element)`, async () => {
      const w = cfg.buildWitness(poseidon);
      w.pathElements = [...w.pathElements];
      w.pathElements[0] = 999n;
      await assertRejected(wasmPath, zkeyPath, vk, w, `${name} tampered sibling`);
    });

    await test(`${name}: C0 — non-boolean pathIndices rejected (mux selector must be 0/1)`, async () => {
      const w = cfg.buildWitness(poseidon);
      w.pathIndices = [...w.pathIndices];
      w.pathIndices[3] = 2n;
      await assertRejected(wasmPath, zkeyPath, vk, w, `${name} non-boolean pathIndices`);
    });

    await test(`${name}: C0 — swapped left/right at one level rejected (prover claims wrong side of the tree)`, async () => {
      // A malicious prover who knows the leaf and the sibling but tries to claim the
      // opposite pathIndex bit (i.e. lies about which side of the tree the leaf sits on)
      // changes the Poseidon2 compression's (left, right) order, which changes the digest
      // at that level (compression is not commutative) and so the recomputed root — this
      // is the property that makes the accumulator sound against a prover who wants to
      // claim membership under the wrong leaf position. Same check as T42, but flips a
      // pathIndex rather than a sibling value.
      const w = cfg.buildWitness(poseidon);
      w.pathIndices = [...w.pathIndices];
      w.pathIndices[5] = w.pathIndices[5] === 0n ? 1n : 0n;
      await assertRejected(wasmPath, zkeyPath, vk, w, `${name} swapped path side`);
    });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
