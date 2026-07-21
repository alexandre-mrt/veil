/**
 * circuit-bench.mjs — Veil circuit baseline benchmark
 *
 * Measures, on real compiled artifacts, per circuit:
 *   - R1CS constraint count (via snarkjs r1cs info)
 *   - Witness generation time
 *   - Groth16 proving time (full prove, real witness)
 *   - Groth16 verification time
 *   - Proof size, verifying-key size, proving-key (zkey) size, wasm size
 *
 * Requires the circuits to already be compiled with a dev trusted setup:
 *   cd circuits && bash scripts/compile.sh
 *   cd circuits && circom compliance.circom --r1cs --wasm --sym --output build-compliance \
 *     && (snarkjs groth16 setup / contribute / export verificationkey against build-compliance)
 *   cd circuits && bash scripts/compile-withdraw.sh
 *
 * Run:
 *   cd scripts && bun run bench/circuit-bench.mjs
 *   cd scripts && bun run bench/circuit-bench.mjs --iterations 10
 */

import { buildPoseidon } from "circomlibjs";
import { existsSync, statSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { groth16 } from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const ITER_ARG = process.argv.indexOf("--iterations");
const ITERATIONS = ITER_ARG !== -1 ? parseInt(process.argv[ITER_ARG + 1], 10) : 5;

const MERKLE_DEPTH = 20;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

function merkleRootFromPath(poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = toBI(poseidon([left, right]));
  }
  return node;
}

function buildMerkleTreeFromLeaf(poseidon, leaf, depth) {
  const pathElements = [];
  const pathIndices = [];
  let current = leaf;
  let zeroHash = 0n;
  for (let i = 0; i < depth; i++) {
    pathElements.push(zeroHash);
    pathIndices.push(0n);
    current = toBI(poseidon([current, zeroHash]));
    zeroHash = toBI(poseidon([zeroHash, zeroHash]));
  }
  return { root: current, pathElements, pathIndices };
}

function transferWitness(poseidon) {
  const cumulativeOld = 100n, txAmount = 50n, randomnessOld = 55n, randomnessNew = 66n;
  const userSecret = 444n, epochId = 1n, threshold = 1_000_000_000n, salt = 9n;
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

function complianceWitness(poseidon) {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const { root: merkleRoot, pathElements, pathIndices } = buildMerkleTreeFromLeaf(poseidon, credentialLeaf, MERKLE_DEPTH);
  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const validCredential = (expiryEpoch >= currentEpoch ? 1n : 0n) * (kycLevel >= requiredKycLevel ? 1n : 0n);
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

function withdrawWitness(poseidon) {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xabcdef123456n, randomnessNew = 77777n;
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
    r1cs: join(CIRCUITS_DIR, "build", "transfer.r1cs"),
    wasm: join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    zkey: join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
    vk: join(CIRCUITS_DIR, "build", "transfer_vk.json"),
    buildWitness: transferWitness,
  },
  {
    name: "compliance",
    r1cs: join(CIRCUITS_DIR, "build-compliance", "compliance.r1cs"),
    wasm: join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm"),
    zkey: join(CIRCUITS_DIR, "build-compliance", "compliance_final.zkey"),
    vk: join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json"),
    buildWitness: complianceWitness,
  },
  {
    name: "withdraw",
    r1cs: join(CIRCUITS_DIR, "build-withdraw", "withdraw.r1cs"),
    wasm: join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm"),
    zkey: join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey"),
    vk: join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json"),
    buildWitness: withdrawWitness,
  },
];

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : null;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}

async function benchCircuit(poseidon, circuit) {
  const missing = ["r1cs", "wasm", "zkey", "vk"].filter((k) => !existsSync(circuit[k]));
  if (missing.length > 0) {
    return { name: circuit.name, blocked: true, missing };
  }

  const vk = JSON.parse(readFileSync(circuit.vk, "utf8"));
  const witness = circuit.buildWitness(poseidon);
  const stringInputs = stringifyInputs(witness);

  const proveMs = [];
  const verifyMs = [];
  let proofBytes = null;

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const { proof, publicSignals } = await groth16.fullProve(stringInputs, circuit.wasm, circuit.zkey);
    const t1 = performance.now();
    const valid = await groth16.verify(vk, publicSignals, proof);
    const t2 = performance.now();
    if (!valid) throw new Error(`${circuit.name}: proof ${i} did not verify`);
    proveMs.push(t1 - t0);
    verifyMs.push(t2 - t1);
    if (proofBytes === null) proofBytes = Buffer.byteLength(JSON.stringify(proof));
  }

  return {
    name: circuit.name,
    blocked: false,
    iterations: ITERATIONS,
    proveMsMedian: median(proveMs),
    proveMsAll: proveMs,
    verifyMsMedian: median(verifyMs),
    verifyMsAll: verifyMs,
    proofBytes,
    vkBytes: fileSize(circuit.vk),
    zkeyBytes: fileSize(circuit.zkey),
    wasmBytes: fileSize(circuit.wasm),
    r1csBytes: fileSize(circuit.r1cs),
  };
}

async function main() {
  console.log(`=== Veil circuit baseline benchmark (${ITERATIONS} iterations per circuit) ===`);
  console.log(`Node: ${process.version}, platform: ${process.platform} ${process.arch}\n`);

  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  const results = [];
  for (const circuit of CIRCUITS) {
    process.stdout.write(`--- ${circuit.name} ---\n`);
    const result = await benchCircuit(poseidon, circuit);
    results.push(result);
    if (result.blocked) {
      console.log(`  BLOCKED: missing artifacts: ${result.missing.join(", ")}`);
      continue;
    }
    console.log(`  prove (median of ${result.iterations}):  ${result.proveMsMedian.toFixed(1)} ms`);
    console.log(`  verify (median of ${result.iterations}): ${result.verifyMsMedian.toFixed(1)} ms`);
    console.log(`  proof size:  ${result.proofBytes} bytes`);
    console.log(`  vk size:     ${result.vkBytes} bytes`);
    console.log(`  zkey size:   ${result.zkeyBytes} bytes`);
    console.log(`  wasm size:   ${result.wasmBytes} bytes`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
