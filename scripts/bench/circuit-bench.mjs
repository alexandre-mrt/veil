/**
 * circuit-bench.mjs — Groth16 proving-time / proof-size / VK-size benchmark
 * for Veil's three circuits (transfer, compliance, withdraw).
 *
 * Requires compiled artifacts in circuits/build/ (or circuits/build-withdraw/
 * for withdraw, falling back to circuits/build/):
 *   <circuit>_js/<circuit>.wasm, <circuit>_final.zkey, <circuit>_vk.json
 *
 * Produced by (from circuits/):
 *   npx circom2 <circuit>.circom --r1cs --wasm --sym -o build -l node_modules
 *   npx snarkjs groth16 setup build/<circuit>.r1cs build/pot15_final.ptau build/<circuit>_0000.zkey
 *   npx snarkjs zkey contribute build/<circuit>_0000.zkey build/<circuit>_final.zkey --name=dev -v
 *   npx snarkjs zkey export verificationkey build/<circuit>_final.zkey build/<circuit>_vk.json
 *
 * Usage: node scripts/bench/circuit-bench.mjs [--runs N]
 */

import { existsSync, statSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");

// Deps (circomlibjs, snarkjs) live in circuits/node_modules, not here — resolve
// against circuits/package.json so this script doesn't need its own copy.
const circuitsRequire = createRequire(join(CIRCUITS_DIR, "package.json"));
const { buildPoseidon } = circuitsRequire("circomlibjs");
const snarkjs = circuitsRequire("snarkjs");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 5;
})();

let poseidonF = null;
export function setPoseidonF(F) {
  poseidonF = F;
}
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

const MERKLE_DEPTH = 20;

function merkleRootFromPath(poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = toBI(poseidon([left, right]));
  }
  return node;
}

// -- Witness builders, ported 1:1 from circuits/test/*.test.mjs --------------

function buildTransferWitness(poseidon) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n;
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;

  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPath(poseidon, oldCommitment, pathElements, pathIndices);

  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function buildComplianceWitness(poseidon) {
  const DOMAIN_CREDENTIAL_LEAF = 4n, DOMAIN_COMPLIANCE_NULLIFIER = 5n, DOMAIN_CONTEXT_BINDING = 6n;
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;

  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));

  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  let zeroHash = 0n;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(zeroHash);
    pathIndices.push(0n);
    current = toBI(poseidon([current, zeroHash]));
    zeroHash = toBI(poseidon([zeroHash, zeroHash]));
  }
  const merkleRoot = current;

  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;

  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export function buildWithdrawWitness(poseidon) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_WITHDRAW_NULLIFIER = 7n, DOMAIN_RECIPIENT_HASH = 8n;
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;

  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

const CIRCUITS = [
  {
    name: "transfer",
    buildWitness: buildTransferWitness,
    wasm: join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    zkey: join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
    vk: join(CIRCUITS_DIR, "build", "transfer_vk.json"),
    r1cs: join(CIRCUITS_DIR, "build", "transfer.r1cs"),
  },
  {
    name: "compliance",
    buildWitness: buildComplianceWitness,
    wasm: join(CIRCUITS_DIR, "build", "compliance_js", "compliance.wasm"),
    zkey: join(CIRCUITS_DIR, "build", "compliance_final.zkey"),
    vk: join(CIRCUITS_DIR, "build", "compliance_vk.json"),
    r1cs: join(CIRCUITS_DIR, "build", "compliance.r1cs"),
  },
  {
    name: "withdraw",
    buildWitness: buildWithdrawWitness,
    wasm: existsSync(join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm"))
      ? join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm")
      : join(CIRCUITS_DIR, "build", "withdraw_js", "withdraw.wasm"),
    zkey: existsSync(join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey"))
      ? join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey")
      : join(CIRCUITS_DIR, "build", "withdraw_final.zkey"),
    vk: existsSync(join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json"))
      ? join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json")
      : join(CIRCUITS_DIR, "build", "withdraw_vk.json"),
    r1cs: existsSync(join(CIRCUITS_DIR, "build-withdraw", "withdraw.r1cs"))
      ? join(CIRCUITS_DIR, "build-withdraw", "withdraw.r1cs")
      : join(CIRCUITS_DIR, "build", "withdraw.r1cs"),
  },
];

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  console.log(`=== Veil circuit-bench (${RUNS} runs per circuit) ===`);
  console.log(`Node ${process.version}, platform ${process.platform} ${process.arch}`);
  console.log("");

  const results = [];

  for (const c of CIRCUITS) {
    if (!existsSync(c.wasm) || !existsSync(c.zkey) || !existsSync(c.vk)) {
      console.log(`[SKIP] ${c.name}: artifacts missing (${c.wasm})`);
      results.push({ circuit: c.name, status: "SKIPPED_MISSING_ARTIFACTS" });
      continue;
    }

    const r1csConstraints = existsSync(c.r1cs) ? statSync(c.r1cs).size : null;
    const zkeySize = statSync(c.zkey).size;
    const vkSize = statSync(c.vk).size;

    const witnessRaw = c.buildWitness(poseidon);
    const stringInputs = {};
    for (const [k, v] of Object.entries(witnessRaw)) {
      stringInputs[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
    }

    const times = [];
    let proofSize = null;
    let publicSignalsCount = null;
    let verifyOk = null;

    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringInputs, c.wasm, c.zkey);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6); // ms

      if (proofSize === null) {
        proofSize = Buffer.byteLength(JSON.stringify(proof));
        publicSignalsCount = publicSignals.length;
        const vk = JSON.parse(readFileSync(c.vk, "utf8"));
        verifyOk = await snarkjs.groth16.verify(vk, publicSignals, proof);
      }
    }

    const meanMs = times.reduce((a, b) => a + b, 0) / times.length;
    const medianMs = median(times);
    const minMs = Math.min(...times);
    const maxMs = Math.max(...times);

    console.log(`--- ${c.name} ---`);
    console.log(`  runs (ms): ${times.map((t) => t.toFixed(1)).join(", ")}`);
    console.log(`  mean=${meanMs.toFixed(1)}ms median=${medianMs.toFixed(1)}ms min=${minMs.toFixed(1)}ms max=${maxMs.toFixed(1)}ms`);
    console.log(`  proof.json size: ${proofSize} bytes, public signals: ${publicSignalsCount}`);
    console.log(`  zkey size: ${zkeySize} bytes, vk.json size: ${vkSize} bytes`);
    console.log(`  verify: ${verifyOk ? "OK" : "FAILED"}`);
    console.log("");

    results.push({
      circuit: c.name,
      status: "OK",
      runs_ms: times,
      mean_ms: meanMs,
      median_ms: medianMs,
      min_ms: minMs,
      max_ms: maxMs,
      proof_bytes: proofSize,
      public_signals: publicSignalsCount,
      zkey_bytes: zkeySize,
      vk_bytes: vkSize,
      verify_ok: verifyOk,
    });
  }

  console.log("=== JSON summary ===");
  console.log(JSON.stringify(results, null, 2));

  // snarkjs' bn128 curve keeps worker handles open after the last use, which
  // otherwise leaves this process hanging well after all work is done.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
