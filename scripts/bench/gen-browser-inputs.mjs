import { buildPoseidon } from "circomlibjs";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "browser-harness", "inputs");
mkdirSync(OUT_DIR, { recursive: true });

const poseidon = await buildPoseidon();
const F = poseidon.F;
function toBI(v) {
  if (typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return F.toObject(v);
  return BigInt(v);
}
function buildMerkleTree(leaf, depth) {
  const pathElements = [], pathIndices = [];
  let current = leaf, zero = 0n;
  for (let i = 0; i < depth; i++) {
    pathElements.push(zero);
    pathIndices.push(0n);
    current = toBI(poseidon([current, zero]));
    zero = toBI(poseidon([zero, zero]));
  }
  return { root: current, pathElements, pathIndices };
}
function stringify(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? v.map(String) : String(v);
  return out;
}

// withdraw
{
  const DOMAIN_COMMITMENT = 1n, DOMAIN_WITHDRAW_NULLIFIER = 7n, DOMAIN_RECIPIENT_HASH = 8n;
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xabcdef123456n, randomnessNew = 77777n;
  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));
  writeFileSync(join(OUT_DIR, "withdraw.json"), JSON.stringify(stringify({
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  })));
}

// compliance
{
  const DOMAIN_CREDENTIAL_LEAF = 4n, DOMAIN_COMPLIANCE_NULLIFIER = 5n, DOMAIN_CONTEXT_BINDING = 6n, MERKLE_DEPTH = 20;
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const { root: merkleRoot, pathElements, pathIndices } = buildMerkleTree(credentialLeaf, MERKLE_DEPTH);
  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  writeFileSync(join(OUT_DIR, "compliance.json"), JSON.stringify(stringify({
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  })));
}

// transfer
{
  const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n, MERKLE_DEPTH = 20;
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const { root: merkleRoot, pathElements, pathIndices } = buildMerkleTree(oldCommitment, MERKLE_DEPTH);
  writeFileSync(join(OUT_DIR, "transfer.json"), JSON.stringify(stringify({
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  })));
}

console.log("wrote browser-harness/inputs/{withdraw,compliance,transfer}.json");
