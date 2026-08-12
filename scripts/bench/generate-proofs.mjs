#!/usr/bin/env node
/**
 * generate-proofs.mjs — Generates the real Groth16 proofs gas-bench.ts needs, as plain Node.
 *
 * Why a separate Node process instead of doing this inline in gas-bench.ts (which otherwise runs
 * under Bun for the @mysten/sui SDK calls): snarkjs's Node worker-thread path goes through the
 * `web-worker` npm package, which calls `self.dispatchEvent(plainObject)`. Bun's EventTarget is
 * spec-strict and throws `TypeError: Argument 1 ('event') ... must be an instance of Event` —
 * confirmed reproducible on Bun 1.3.11 with and without --smol, a real Bun/snarkjs incompatibility,
 * not a bug in this code. Plain Node's EventTarget accepts it (same call path already exercised by
 * scripts/bench/prove-latency.mjs and circuits/test/*.test.mjs). Isolating proof generation to a
 * Node subprocess sidesteps the incompatibility entirely rather than working around Bun internals.
 *
 * pool.move's epoch check accepts `proof_epoch == on_chain_epoch || proof_epoch == on_chain_epoch - 1`
 * (a one-epoch grace window), where on-chain epoch is real wall-clock time (timestamp_ms /
 * epoch_duration_ms), not a small counter starting at 0 like witnesses.mjs's own test defaults
 * assume. The caller passes the wall-clock epoch E observed just before this script runs (argv[2]);
 * every epoch-bearing witness field here is built against E so the proof is still valid once the
 * caller waits for the on-chain epoch to advance to E+1 (satisfying both the epoch grace check and
 * commitment maturity in the same wait).
 *
 * Usage: node scripts/bench/generate-proofs.mjs <epoch> > proofs.json
 */
import { buildPoseidon } from "circomlibjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const EPOCH = process.argv[2] !== undefined ? BigInt(process.argv[2]) : 1n;

const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n, DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n, DOMAIN_CONTEXT_BINDING = 6n;
const TRANSFER_THRESHOLD = 1_000_000_000n; // must match gas-bench.ts's pool.move create_pool threshold
const MERKLE_DEPTH = 20;
// Fixed (not epoch-relative) so the credential leaf/root are identical across an early
// commitments-only call and the later proof-generation call — see buildComplianceWitnessAtEpoch.
const CREDENTIAL_EXPIRY_EPOCH = 10_000_000_000n;

function poseidonHash(poseidon, inputs) {
  return poseidon.F.toObject(poseidon(inputs));
}

function zeroPathRoot(poseidon, leaf) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) node = poseidonHash(poseidon, [node, 0n]);
  return node;
}

async function proveCircuit(name, dir, inputs) {
  const wasmPath = join(CIRCUITS_DIR, dir, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(CIRCUITS_DIR, dir, `${name}_final.zkey`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  return { proof, publicSignals };
}

/** Mirrors witnesses.mjs's buildTransferWitness, but with epochId pinned to the real wall-clock
 * epoch E (its default hardcodes epochId=1n, which fails pool.move's real-epoch check). */
function buildTransferWitnessAtEpoch(poseidon, userSecret, randomnessNew) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]);
  const newCommitment = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]);
  const nullifier = poseidonHash(poseidon, [DOMAIN_NULLIFIER, userSecret, EPOCH, randomnessOld]);
  const txAmountHash = poseidonHash(poseidon, [DOMAIN_TX_AMOUNT, txAmount, salt]);
  const merkleRoot = zeroPathRoot(poseidon, oldCommitment);
  return {
    oldCommitment, newCommitment, threshold: TRANSFER_THRESHOLD, epochId: EPOCH, nullifier,
    txAmountHash, merkleRoot, cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew,
    userSecret, salt,
    pathElements: Array.from({ length: MERKLE_DEPTH }, () => 0n),
    pathIndices: Array.from({ length: MERKLE_DEPTH }, () => 0n),
  };
}

/** Mirrors witnesses.mjs's buildComplianceWitness, but with currentEpoch pinned to E (default
 * hardcodes currentEpoch=500n / expiryEpoch=1000n, both far below a real wall-clock epoch number). */
function buildComplianceWitnessAtEpoch(poseidon) {
  const userSecret = 987654321n, kycLevel = 2n, issuerId = 42n;
  const requiredKycLevel = 1n, transferNullifier = 111222333n;
  const currentEpoch = EPOCH;
  const expiryEpoch = CREDENTIAL_EXPIRY_EPOCH;
  const credentialLeaf = poseidonHash(poseidon, [DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]);
  const merkleRoot = zeroPathRoot(poseidon, credentialLeaf);
  const contextId = poseidonHash(poseidon, [DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]);
  const nullifier = poseidonHash(poseidon, [DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]);
  const validCredential = (expiryEpoch >= currentEpoch ? 1n : 0n) * (kycLevel >= requiredKycLevel ? 1n : 0n);
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, transferNullifier,
    pathElements: Array.from({ length: MERKLE_DEPTH }, () => 0n),
    pathIndices: Array.from({ length: MERKLE_DEPTH }, () => 0n),
  };
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  const transferWitness = buildTransferWitnessAtEpoch(poseidon, 987654321n, 12345n);
  const withdrawWitness = (await import("./witnesses.mjs")).WITNESS_BUILDERS.withdraw(poseidon); // no epoch in withdraw's public inputs
  const complianceWitness = buildComplianceWitnessAtEpoch(poseidon);
  // A second, distinct transfer witness (different userSecret) so compliant_transfer consumes its
  // own genesis commitment rather than replaying the one shielded_transfer already spent.
  const transferWitness2 = buildTransferWitnessAtEpoch(poseidon, 555444333n, 67890n);

  const transferProof = await proveCircuit("transfer", "build", stringifyInputs(transferWitness));
  const withdrawProof = await proveCircuit("withdraw", "build-withdraw", stringifyInputs(withdrawWitness));
  const complianceProof = await proveCircuit("compliance", "build-compliance", stringifyInputs(complianceWitness));
  const transferProof2 = await proveCircuit("transfer", "build", stringifyInputs(transferWitness2));

  const out = {
    genesisCommitments: {
      transfer: transferWitness.oldCommitment.toString(),
      withdraw: withdrawWitness.commitment.toString(),
      compliant_transfer: transferWitness2.oldCommitment.toString(),
    },
    // pool.commitment_root must be updated (via the timelocked pool::update_commitment_root) to
    // match whichever transfer witness is about to be submitted -- each genesis commitment here is
    // treated as the sole leaf (index 0, all-zero siblings) of its own depth-20 tree, so the two
    // transfer witnesses below need the on-chain root switched between them, not one shared root.
    transferMerkleRoot: transferWitness.merkleRoot.toString(),
    transfer2MerkleRoot: transferWitness2.merkleRoot.toString(),
    complianceCredentialRoot: complianceWitness.merkleRoot.toString(),
    proofs: {
      transfer: transferProof,
      withdraw: withdrawProof,
      compliance: complianceProof,
      transfer2: transferProof2,
    },
  };
  console.log(JSON.stringify(out));
  // A real (non-hash-only) snarkjs.groth16 run leaves the Node process alive after this point —
  // a lingering handle inside snarkjs/ffjavascript's curve workers, not a bug here (same symptom
  // documented in docs/research/2026-07-22-baseline-measurement.md and fixed the same way in
  // circuits/test/*.test.mjs). Exit explicitly once the JSON is flushed.
  process.exit(0);
}

main().catch((err) => {
  console.error("generate-proofs failed:", err);
  process.exit(1);
});
