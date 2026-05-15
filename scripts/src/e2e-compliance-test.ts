/**
 * e2e-compliance-test.ts — End-to-end Tier 3 compliance test for Veil.
 *
 * Tests the FULL compliance pipeline with REAL Groth16 proofs (no mocks):
 *   1. Domain separation verification (tags 1-6)
 *   2. Credential Merkle tree (depth 20, real Poseidon)
 *   3. Transfer proof (real Groth16 circuit)
 *   4. Compliance proof (real Groth16 circuit)
 *   5. Expired credential → validCredential = 0
 *   6. Insufficient KYC level → validCredential = 0
 *   7. Auditor encryption (real ECDH P-256 + AES-GCM)
 *   8. Nullifier determinism
 *
 * Usage: npx tsx src/e2e-compliance-test.ts
 * Requires: circuit build artifacts (transfer + compliance)
 */

import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "./proof-converter.js";
import {
  computeCredentialLeaf,
  computeCredentialNullifier,
  buildMerkleTree,
  getMerkleProof,
} from "./compliance-utils.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");

const TRANSFER_WASM = join(BUILD_DIR, "transfer_js", "transfer.wasm");
const TRANSFER_ZKEY = join(BUILD_DIR, "transfer_final.zkey");
const TRANSFER_VK = join(BUILD_DIR, "transfer_vk.json");
const PTAU_PATH = join(BUILD_DIR, "pot15_final.ptau");

const COMPLIANCE_OUT = "/tmp/compliance-verify";
const COMPLIANCE_WASM = join(COMPLIANCE_OUT, "compliance_js", "compliance.wasm");
const COMPLIANCE_R1CS = join(COMPLIANCE_OUT, "compliance.r1cs");
const COMPLIANCE_ZKEY = join(COMPLIANCE_OUT, "compliance_final.zkey");
const COMPLIANCE_VK_PATH = join(COMPLIANCE_OUT, "compliance_vk.json");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function ensureComplianceCompiled(): void {
  if (existsSync(COMPLIANCE_WASM) && existsSync(COMPLIANCE_R1CS)) return;

  console.log("  Compiling compliance circuit...");
  execSync(
    `mkdir -p ${COMPLIANCE_OUT} && cd ${CIRCUITS_DIR} && circom compliance.circom --r1cs --wasm --sym -o ${COMPLIANCE_OUT} -l node_modules`,
    { stdio: "pipe" },
  );
}

async function ensureComplianceTrustedSetup(): Promise<void> {
  if (existsSync(COMPLIANCE_ZKEY)) return;

  console.log("  Running compliance trusted setup (zKey phase 1 + contribute)...");

  if (!existsSync(PTAU_PATH)) {
    console.error("Missing pot15_final.ptau — run circuits/scripts/compile.sh first");
    process.exit(1);
  }

  const zkey0 = join(COMPLIANCE_OUT, "compliance_0.zkey");
  await (snarkjs as any).zKey.newZKey(COMPLIANCE_R1CS, PTAU_PATH, zkey0);
  await (snarkjs as any).zKey.contribute(
    zkey0,
    COMPLIANCE_ZKEY,
    "test-contributor",
    "veil-compliance-test",
  );
}

async function ensureComplianceVK(): Promise<any> {
  if (!existsSync(COMPLIANCE_VK_PATH)) {
    const vk = await (snarkjs as any).zKey.exportVerificationKey(COMPLIANCE_ZKEY);
    const { writeFileSync } = await import("fs");
    writeFileSync(COMPLIANCE_VK_PATH, JSON.stringify(vk, null, 2));
  }
  return JSON.parse(readFileSync(COMPLIANCE_VK_PATH, "utf-8"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Veil Tier 3 E2E Compliance Test ===\n");

  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  function hash(...inputs: bigint[]): bigint {
    return F.toObject(poseidon(inputs));
  }

  function randomField(): bigint {
    return BigInt("0x" + crypto.randomBytes(31).toString("hex"));
  }

  // =========================================================================
  // 1. Domain separation (tags 1-6)
  // =========================================================================
  console.log("--- 1. Domain Separation (tags 1-6) ---");

  const testA = randomField();
  const testB = randomField();
  const domainHashes = new Set<string>();
  for (let tag = 1n; tag <= 6n; tag++) {
    const h = hash(tag, testA, testB);
    domainHashes.add(h.toString());
  }
  assert(domainHashes.size === 6, "All 6 domain tags produce unique hashes");

  // Cross-circuit domain separation: tag 4 (credential) vs tag 1 (commitment)
  const sharedInputs = [randomField(), randomField(), randomField(), randomField()];
  const tag1Hash = hash(1n, ...sharedInputs);
  const tag4Hash = hash(4n, ...sharedInputs);
  assert(tag1Hash !== tag4Hash, "Tag 1 (commitment) != tag 4 (credential) for same inputs");

  // =========================================================================
  // 2. Build credential Merkle tree (depth 20)
  // =========================================================================
  console.log("\n--- 2. Credential Merkle Tree (depth 20) ---");

  const userSecret = randomField();
  const kycLevel = 2n;
  const expiryEpoch = 1000n;
  const issuerId = 42n;
  const currentEpoch = 500n;

  const leaf0 = computeCredentialLeaf(poseidon, F, userSecret, kycLevel, expiryEpoch, issuerId);
  const leaf1 = computeCredentialLeaf(poseidon, F, randomField(), 1n, 2000n, 43n);
  const leaf2 = computeCredentialLeaf(poseidon, F, randomField(), 3n, 3000n, 44n);
  const leaf3 = computeCredentialLeaf(poseidon, F, randomField(), 1n, 1500n, 45n);

  const { root, layers } = buildMerkleTree(poseidon, F, [leaf0, leaf1, leaf2, leaf3], 20);
  const { pathElements, pathIndices } = getMerkleProof(layers, 0, 20);

  assert(root > 0n, "Merkle root is valid (> 0)");
  assert(pathElements.length === 20, "Merkle proof has depth 20");
  assert(pathIndices.length === 20, "Path indices has depth 20");

  // Manual verification
  let current = leaf0;
  for (let i = 0; i < 20; i++) {
    const left = pathIndices[i] === 0 ? current : pathElements[i];
    const right = pathIndices[i] === 0 ? pathElements[i] : current;
    current = hash(left, right);
  }
  assert(current === root, "Manual Merkle proof verification matches root");

  // =========================================================================
  // 3. Transfer proof (real Groth16)
  // =========================================================================
  console.log("\n--- 3. Transfer Proof (real Groth16) ---");

  const hasTransferArtifacts = existsSync(TRANSFER_WASM) && existsSync(TRANSFER_ZKEY);

  if (!hasTransferArtifacts) {
    console.log("  SKIP: Transfer circuit artifacts not found. Run circuits/scripts/compile.sh first.");
    console.log("  Continuing with compliance tests only...\n");
  }

  let transferNullifier = randomField();
  let transferProofVerified = false;

  if (hasTransferArtifacts) {
    const cumulativeOld = 0n;
    const txAmount = 100_000_000n;
    const cumulativeNew = cumulativeOld + txAmount;
    const threshold = 1_000_000_000n;
    const randomnessOld = 0n; // Genesis
    const randomnessNew = randomField();
    const salt = randomField();
    const epochId = currentEpoch;

    const oldCommitment = hash(1n, cumulativeOld, randomnessOld, userSecret);
    const newCommitment = hash(1n, cumulativeNew, randomnessNew, userSecret);
    transferNullifier = hash(2n, userSecret, epochId, randomnessOld);
    const txAmountHash = hash(3n, txAmount, salt);

    const transferInput = {
      oldCommitment: oldCommitment.toString(),
      newCommitment: newCommitment.toString(),
      threshold: threshold.toString(),
      epochId: epochId.toString(),
      nullifier: transferNullifier.toString(),
      txAmountHash: txAmountHash.toString(),
      cumulativeOld: cumulativeOld.toString(),
      cumulativeNew: cumulativeNew.toString(),
      txAmount: txAmount.toString(),
      randomnessOld: randomnessOld.toString(),
      randomnessNew: randomnessNew.toString(),
      userSecret: userSecret.toString(),
      salt: salt.toString(),
    };

    try {
      const { proof: tProof, publicSignals: tSignals } = await snarkjs.groth16.fullProve(
        transferInput,
        TRANSFER_WASM,
        TRANSFER_ZKEY,
      );

      const tVk = JSON.parse(readFileSync(TRANSFER_VK, "utf-8"));
      const tValid = await snarkjs.groth16.verify(tVk, tSignals, tProof);
      assert(tValid, "Transfer proof verifies locally (Groth16)");
      transferProofVerified = true;

      // Sui byte conversion
      const proofBytes = proofToSuiBytes(tProof);
      const inputBytes = publicInputsToSuiBytes(tSignals);
      assert(proofBytes.length === 128, "Transfer proof is 128 bytes (Sui format)");
      assert(inputBytes.length === 192, `Transfer public inputs are ${inputBytes.length} bytes (6 * 32 = 192)`);
    } catch (e) {
      failed++;
      console.error(`  FAIL: Transfer proof generation: ${e}`);
    }
  }

  // =========================================================================
  // 4. Compliance proof (real Groth16)
  // =========================================================================
  console.log("\n--- 4. Compliance Proof (real Groth16) ---");

  ensureComplianceCompiled();
  assert(existsSync(COMPLIANCE_WASM), "Compliance WASM exists");
  assert(existsSync(COMPLIANCE_R1CS), "Compliance R1CS exists");

  await ensureComplianceTrustedSetup();
  assert(existsSync(COMPLIANCE_ZKEY), "Compliance zkey exists");

  const complianceVk = await ensureComplianceVK();

  // Compute derived values
  const contextId = hash(6n, transferNullifier, userSecret);
  const credNullifier = hash(5n, userSecret, contextId);
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= 1n ? 1n : 0n;
  const validCredential = expiryValid * kycValid;

  const complianceInput = {
    // Public (6 signals)
    merkleRoot: root.toString(),
    currentEpoch: currentEpoch.toString(),
    contextId: contextId.toString(),
    requiredKycLevel: "1",
    nullifier: credNullifier.toString(),
    validCredential: validCredential.toString(),
    // Private
    userSecret: userSecret.toString(),
    kycLevel: kycLevel.toString(),
    expiryEpoch: expiryEpoch.toString(),
    issuerId: issuerId.toString(),
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices: pathIndices.map((i) => i.toString()),
    transferNullifier: transferNullifier.toString(),
  };

  try {
    const { proof: cProof, publicSignals: cSignals } = await snarkjs.groth16.fullProve(
      complianceInput,
      COMPLIANCE_WASM,
      COMPLIANCE_ZKEY,
    );

    const cValid = await snarkjs.groth16.verify(complianceVk, cSignals, cProof);
    assert(cValid, "Compliance proof verifies locally (Groth16)");

    // Verify public signals count
    assert(cSignals.length === 6, `Compliance public signals count = ${cSignals.length} (expected 6)`);

    // Verify validCredential = 1 (valid credential)
    assert(cSignals[5] === "1", `validCredential signal = ${cSignals[5]} (expected 1)`);

    // Sui byte conversion
    const cProofBytes = proofToSuiBytes(cProof);
    const cInputBytes = publicInputsToSuiBytes(cSignals);
    assert(cProofBytes.length === 128, "Compliance proof is 128 bytes (Sui format)");
    assert(cInputBytes.length === 192, `Compliance public inputs are ${cInputBytes.length} bytes (6 * 32 = 192)`);

    // VK conversion
    const vkBytes = vkToSuiBytes(complianceVk);
    assert(vkBytes.length > 200, `Compliance VK is ${vkBytes.length} bytes`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: Compliance proof generation: ${e}`);
  }

  // =========================================================================
  // 5. Expired credential → validCredential = 0
  // =========================================================================
  console.log("\n--- 5. Expired Credential ---");

  const expiredExpiryEpoch = 100n; // < currentEpoch (500)
  const expiredLeaf = computeCredentialLeaf(poseidon, F, userSecret, kycLevel, expiredExpiryEpoch, issuerId);
  const { root: expRoot, layers: expLayers } = buildMerkleTree(poseidon, F, [expiredLeaf], 20);
  const { pathElements: expPath, pathIndices: expIdx } = getMerkleProof(expLayers, 0, 20);

  const expContextId = hash(6n, transferNullifier, userSecret);
  const expNullifier = hash(5n, userSecret, expContextId);

  const expiredInput = {
    merkleRoot: expRoot.toString(),
    currentEpoch: currentEpoch.toString(),
    contextId: expContextId.toString(),
    requiredKycLevel: "1",
    nullifier: expNullifier.toString(),
    validCredential: "0", // Expired = invalid
    userSecret: userSecret.toString(),
    kycLevel: kycLevel.toString(),
    expiryEpoch: expiredExpiryEpoch.toString(),
    issuerId: issuerId.toString(),
    pathElements: expPath.map((e) => e.toString()),
    pathIndices: expIdx.map((i) => i.toString()),
    transferNullifier: transferNullifier.toString(),
  };

  try {
    const { proof: expProof, publicSignals: expSignals } = await snarkjs.groth16.fullProve(
      expiredInput,
      COMPLIANCE_WASM,
      COMPLIANCE_ZKEY,
    );
    const expValid = await snarkjs.groth16.verify(complianceVk, expSignals, expProof);
    assert(expValid, "Expired credential proof verifies (validCredential=0)");
    assert(expSignals[5] === "0", `validCredential signal = ${expSignals[5]} (expected 0 for expired)`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: Expired credential test: ${e}`);
  }

  // =========================================================================
  // 6. Insufficient KYC level → validCredential = 0
  // =========================================================================
  console.log("\n--- 6. Insufficient KYC Level ---");

  const lowKycLevel = 0n; // < requiredKycLevel (1)
  const lowKycLeaf = computeCredentialLeaf(poseidon, F, userSecret, lowKycLevel, expiryEpoch, issuerId);
  const { root: lowRoot, layers: lowLayers } = buildMerkleTree(poseidon, F, [lowKycLeaf], 20);
  const { pathElements: lowPath, pathIndices: lowIdx } = getMerkleProof(lowLayers, 0, 20);

  const lowContextId = hash(6n, transferNullifier, userSecret);
  const lowNullifier = hash(5n, userSecret, lowContextId);

  const lowKycInput = {
    merkleRoot: lowRoot.toString(),
    currentEpoch: currentEpoch.toString(),
    contextId: lowContextId.toString(),
    requiredKycLevel: "1",
    nullifier: lowNullifier.toString(),
    validCredential: "0", // KYC 0 < required 1
    userSecret: userSecret.toString(),
    kycLevel: lowKycLevel.toString(),
    expiryEpoch: expiryEpoch.toString(),
    issuerId: issuerId.toString(),
    pathElements: lowPath.map((e) => e.toString()),
    pathIndices: lowIdx.map((i) => i.toString()),
    transferNullifier: transferNullifier.toString(),
  };

  try {
    const { proof: lowProof, publicSignals: lowSignals } = await snarkjs.groth16.fullProve(
      lowKycInput,
      COMPLIANCE_WASM,
      COMPLIANCE_ZKEY,
    );
    const lowValid = await snarkjs.groth16.verify(complianceVk, lowSignals, lowProof);
    assert(lowValid, "Low KYC proof verifies (validCredential=0)");
    assert(lowSignals[5] === "0", `validCredential signal = ${lowSignals[5]} (expected 0 for KYC 0 < 1)`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: Low KYC test: ${e}`);
  }

  // =========================================================================
  // 7. Auditor encryption (real ECDH P-256 + AES-GCM)
  // =========================================================================
  console.log("\n--- 7. Auditor Encryption (ECDH P-256 + AES-GCM) ---");

  const subtle = crypto.webcrypto.subtle;

  // Generate auditor keypair (P-256)
  const auditorKeyPair = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const auditorPubRaw = new Uint8Array(
    await subtle.exportKey("raw", auditorKeyPair.publicKey),
  );
  assert(auditorPubRaw.length === 65, "Auditor public key is 65 bytes (uncompressed P-256)");

  // Sender generates ephemeral keypair
  const ephemeralKeyPair = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const ephemeralPubRaw = new Uint8Array(
    await subtle.exportKey("raw", ephemeralKeyPair.publicKey),
  );

  // Derive shared secret (sender side)
  const sharedBits = await subtle.deriveBits(
    { name: "ECDH", public: auditorKeyPair.publicKey },
    ephemeralKeyPair.privateKey,
    256,
  );
  const sharedKeyMaterial = await subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const aesKey = await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephemeralPubRaw,
      info: new TextEncoder().encode("veil-auditor-v1"),
    },
    sharedKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Encrypt (fixed 128-byte plaintext for privacy)
  const txAmount = 100_000_000n;
  const encSalt = randomField();
  const jsonPayload = JSON.stringify({
    txAmount: txAmount.toString(),
    salt: encSalt.toString(),
  });
  const rawBytes = new TextEncoder().encode(jsonPayload);
  const paddedPlaintext = new Uint8Array(128);
  paddedPlaintext.set(rawBytes);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, paddedPlaintext);
  const ciphertext = new Uint8Array(encrypted);
  assert(
    ciphertext.length === 128 + 16,
    `Ciphertext is ${ciphertext.length} bytes (128 data + 16 GCM tag)`,
  );

  // Decrypt (auditor side)
  const auditorSharedBits = await subtle.deriveBits(
    { name: "ECDH", public: ephemeralKeyPair.publicKey },
    auditorKeyPair.privateKey,
    256,
  );
  const auditorKeyMaterial = await subtle.importKey("raw", auditorSharedBits, "HKDF", false, ["deriveKey"]);
  const auditorAesKey = await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephemeralPubRaw,
      info: new TextEncoder().encode("veil-auditor-v1"),
    },
    auditorKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const decrypted = await subtle.decrypt({ name: "AES-GCM", iv }, auditorAesKey, encrypted);
  const decryptedStr = new TextDecoder().decode(new Uint8Array(decrypted).slice(0, rawBytes.length));
  const decryptedData = JSON.parse(decryptedStr);

  assert(
    decryptedData.txAmount === txAmount.toString(),
    "Auditor decrypted correct txAmount",
  );
  assert(
    decryptedData.salt === encSalt.toString(),
    "Auditor decrypted correct salt",
  );

  // Verify binding: Poseidon(3, txAmount, salt)
  const txAmountHash = hash(3n, txAmount, encSalt);
  assert(txAmountHash > 0n, "txAmountHash binding = Poseidon(3, amount, salt) is nonzero");

  // Wrong key cannot decrypt
  const wrongKeyPair = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const wrongSharedBits = await subtle.deriveBits(
    { name: "ECDH", public: ephemeralKeyPair.publicKey },
    wrongKeyPair.privateKey,
    256,
  );
  const wrongKeyMaterial = await subtle.importKey("raw", wrongSharedBits, "HKDF", false, ["deriveKey"]);
  const wrongAesKey = await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephemeralPubRaw,
      info: new TextEncoder().encode("veil-auditor-v1"),
    },
    wrongKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  let wrongDecryptFailed = false;
  try {
    await subtle.decrypt({ name: "AES-GCM", iv }, wrongAesKey, encrypted);
  } catch {
    wrongDecryptFailed = true;
  }
  assert(wrongDecryptFailed, "Wrong key cannot decrypt auditor payload (GCM auth fails)");

  // =========================================================================
  // 8. Nullifier determinism
  // =========================================================================
  console.log("\n--- 8. Nullifier Determinism ---");

  // Same inputs produce same nullifier
  const nf1 = hash(5n, userSecret, contextId);
  const nf2 = hash(5n, userSecret, contextId);
  assert(nf1 === nf2, "Same inputs produce same credential nullifier");

  // Different transferNullifier produces different contextId and nullifier
  const otherTransferNf = randomField();
  const otherContextId = hash(6n, otherTransferNf, userSecret);
  const nf3 = hash(5n, userSecret, otherContextId);
  assert(nf1 !== nf3, "Different transferNullifier produces different credential nullifier");

  // computeCredentialNullifier matches manual hash
  const utilNullifier = computeCredentialNullifier(poseidon, F, userSecret, contextId);
  assert(utilNullifier === nf1, "computeCredentialNullifier matches manual Poseidon(5, secret, contextId)");

  // Transfer nullifier (tag 2) never collides with credential nullifier (tag 5)
  const transferNf = hash(2n, userSecret, currentEpoch, 0n);
  const credNf = hash(5n, userSecret, contextId);
  assert(transferNf !== credNf, "Transfer nullifier (tag 2) != credential nullifier (tag 5)");

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("\nTier 3 E2E verification COMPLETE. All tests pass with real proofs.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
