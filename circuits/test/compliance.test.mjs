/**
 * compliance.test.mjs -- Veil Compliance Circuit Tests
 *
 * Tests circuit constraints using two modes:
 *   1. Full proof mode (requires compiled WASM + zkey): uses snarkjs fullProve + verify
 *   2. Hash-only mode (fallback when circom not compiled): validates Poseidon arithmetic
 *      that the circuit would enforce, catching logic errors before compilation
 *
 * Compliance circuit (compliance.circom) constraints:
 *   C1   credential leaf hash       Poseidon(5) with domain tag 4
 *   C2   Merkle membership          depth-20 Poseidon binary tree
 *   C3   nullifier derivation       Poseidon(3) with domain tag 5
 *   C_BIND context binding          Poseidon(3) with domain tag 6
 *   C4   expiry check               expiryEpoch >= currentEpoch
 *   C5   KYC level check            kycLevel >= requiredKycLevel
 *   C6   validCredential output     expiryValid AND kycValid
 *   C7-C8 epoch range proofs        Num2Bits(64)
 *   C9   kycLevel range proof       Num2Bits(8)
 *   C10  requiredKycLevel range     Num2Bits(8)
 *   C11  issuerId range proof       Num2Bits(64)
 *
 * Run: node --experimental-vm-modules test/compliance.test.mjs
 */

import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build");
const WASM_PATH = join(BUILD_DIR, "compliance_js", "compliance.wasm");
const ZKEY_PATH = join(BUILD_DIR, "compliance_final.zkey");
const VK_PATH = join(BUILD_DIR, "compliance_vk.json");

// -- Constants ----------------------------------------------------------------

const MERKLE_DEPTH = 20;
const MAX_U64 = 2n ** 64n;
const MAX_U8 = 2n ** 8n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;

// -- Helpers ------------------------------------------------------------------

let poseidonF = null;

/** Convert circomlibjs Poseidon output to BigInt. */
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) {
    return poseidonF.toObject(val);
  }
  return BigInt(val);
}

/**
 * Build a Merkle tree of given depth from a single leaf.
 * Returns { root, pathElements, pathIndices } for the leaf at index 0.
 */
function buildMerkleTree(poseidon, leaf, depth) {
  // Place leaf at index 0, all siblings are zero hashes
  const pathElements = [];
  const pathIndices = [];
  let current = leaf;

  // Zero hash at each level (sibling of the only occupied node)
  let zeroHash = 0n;
  for (let i = 0; i < depth; i++) {
    pathElements.push(zeroHash);
    pathIndices.push(0n); // leaf is always on the left (index 0)

    // Parent = Poseidon(current, zeroHash) since pathIndex=0 means current is left child
    current = toBI(poseidon([current, zeroHash]));

    // Next level zero hash = Poseidon(zeroHash, zeroHash)
    zeroHash = toBI(poseidon([zeroHash, zeroHash]));
  }

  return { root: current, pathElements, pathIndices };
}

/**
 * Build all signal values for a valid Compliance witness.
 */
function buildValidWitness(poseidon, {
  userSecret = 987654321n,
  kycLevel = 2n,
  expiryEpoch = 1000n,
  issuerId = 42n,
  currentEpoch = 500n,
  requiredKycLevel = 1n,
  transferNullifier = 111222333n,
} = {}) {
  // C1: credential leaf = Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));

  // C2: Merkle proof
  const { root: merkleRoot, pathElements, pathIndices } = buildMerkleTree(poseidon, credentialLeaf, MERKLE_DEPTH);

  // C_BIND: contextId = Poseidon(6, transferNullifier, userSecret)
  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));

  // C3: nullifier = Poseidon(5, userSecret, contextId)
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));

  // C4+C5+C6: validCredential = (expiryEpoch >= currentEpoch) AND (kycLevel >= requiredKycLevel)
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;

  return {
    // Public inputs (6)
    merkleRoot,
    currentEpoch,
    contextId,
    requiredKycLevel,
    nullifier,
    validCredential,
    // Private inputs
    userSecret,
    kycLevel,
    expiryEpoch,
    issuerId,
    pathElements,
    pathIndices,
    transferNullifier,
  };
}

// -- Test runner --------------------------------------------------------------

let passed = 0;
let failed = 0;
const FULL_PROOF_AVAILABLE = existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

console.log("=== Veil Compliance Circuit Tests ===");
console.log(`Mode: ${FULL_PROOF_AVAILABLE ? "FULL PROOF (snarkjs Groth16)" : "HASH-ONLY (constraint simulation)"}`);
if (!FULL_PROOF_AVAILABLE) {
  console.log("  (Run 'bash scripts/compile-compliance.sh' to enable full Groth16 proof tests)");
}
console.log("");

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

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

function assertEqual(a, b, label) {
  if (a !== b) throw new Error(`${label ?? "assertEqual"}: expected ${b}, got ${a}`);
}

// -- Constraint simulation (hash-only mode) -----------------------------------

function simulateCompliance(poseidon, inputs) {
  const {
    merkleRoot, currentEpoch, contextId, requiredKycLevel,
    nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId,
    pathElements, pathIndices, transferNullifier,
  } = inputs;

  const errors = [];

  // C1: credential leaf
  const expectedLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));

  // C2: Merkle proof verification
  let current = expectedLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const idx = pathIndices[i];
    if (idx !== 0n && idx !== 1n) {
      errors.push(`C2: pathIndices[${i}] must be 0 or 1, got ${idx}`);
    }
    const left = idx === 0n ? current : pathElements[i];
    const right = idx === 0n ? pathElements[i] : current;
    current = toBI(poseidon([left, right]));
  }
  if (current !== merkleRoot) {
    errors.push(`C2: Merkle root mismatch (expected ${merkleRoot}, computed ${current})`);
  }

  // C3: nullifier = Poseidon(5, userSecret, contextId)
  const expectedNullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  if (nullifier !== expectedNullifier) {
    errors.push(`C3: nullifier mismatch (expected ${expectedNullifier}, got ${nullifier})`);
  }

  // C_BIND: contextId = Poseidon(6, transferNullifier, userSecret)
  const expectedContextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  if (contextId !== expectedContextId) {
    errors.push(`C_BIND: contextId mismatch (expected ${expectedContextId}, got ${contextId})`);
  }

  // C4: expiryEpoch >= currentEpoch
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;

  // C5: kycLevel >= requiredKycLevel
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;

  // C6: validCredential = expiryValid AND kycValid
  const expectedValid = expiryValid * kycValid;
  if (validCredential !== expectedValid) {
    errors.push(`C6: validCredential mismatch (expected ${expectedValid}, got ${validCredential})`);
  }

  // C7: currentEpoch range proof
  if (currentEpoch < 0n || currentEpoch >= MAX_U64) {
    errors.push(`C7: currentEpoch out of [0, 2^64): ${currentEpoch}`);
  }

  // C8: expiryEpoch range proof
  if (expiryEpoch < 0n || expiryEpoch >= MAX_U64) {
    errors.push(`C8: expiryEpoch out of [0, 2^64): ${expiryEpoch}`);
  }

  // C9: kycLevel range proof (8-bit)
  if (kycLevel < 0n || kycLevel >= MAX_U8) {
    errors.push(`C9: kycLevel out of [0, 2^8): ${kycLevel}`);
  }

  // C10: requiredKycLevel range proof (8-bit)
  if (requiredKycLevel < 0n || requiredKycLevel >= MAX_U8) {
    errors.push(`C10: requiredKycLevel out of [0, 2^8): ${requiredKycLevel}`);
  }

  // C11: issuerId range proof (64-bit)
  if (issuerId < 0n || issuerId >= MAX_U64) {
    errors.push(`C11: issuerId out of [0, 2^64): ${issuerId}`);
  }

  return errors;
}

// -- Full proof helpers -------------------------------------------------------

async function loadSnarkjs() {
  const mod = await import("snarkjs");
  return mod.groth16;
}

function witnessToStringInputs(inputs) {
  const stringInputs = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (Array.isArray(v)) {
      stringInputs[k] = v.map((x) => x.toString());
    } else {
      stringInputs[k] = v.toString();
    }
  }
  return stringInputs;
}

async function proveAndVerify(groth16, vk, inputs) {
  const stringInputs = witnessToStringInputs(inputs);
  const { proof, publicSignals } = await groth16.fullProve(stringInputs, WASM_PATH, ZKEY_PATH);
  const valid = await groth16.verify(vk, publicSignals, proof);
  return { proof, publicSignals, valid };
}

async function assertRejected(groth16, vk, poseidon, witness, expectedConstraintPrefix, label) {
  if (FULL_PROOF_AVAILABLE) {
    let threw = false;
    try {
      await proveAndVerify(groth16, vk, witness);
    } catch {
      threw = true;
    }
    assert(threw, `${label}: Proof generation must fail`);
  } else {
    const errors = simulateCompliance(poseidon, witness);
    assert(errors.length > 0, `${label}: Expected constraint violations`);
    if (expectedConstraintPrefix) {
      assert(
        errors.some((e) => e.startsWith(expectedConstraintPrefix)),
        `${label}: Expected ${expectedConstraintPrefix} violation, got: ${errors.join("; ")}`,
      );
    }
  }
}

async function assertAccepted(groth16, vk, poseidon, witness, label) {
  if (FULL_PROOF_AVAILABLE) {
    const { valid } = await proveAndVerify(groth16, vk, witness);
    assert(valid, `${label}: Groth16 proof must verify`);
  } else {
    const errors = simulateCompliance(poseidon, witness);
    assert(errors.length === 0, `${label}: Constraint violations: ${errors.join("; ")}`);
  }
}

// -- Main test suite ----------------------------------------------------------

async function main() {
  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;
  let groth16 = null;
  let vk = null;

  if (FULL_PROOF_AVAILABLE) {
    groth16 = await loadSnarkjs();
    const { readFileSync } = await import("fs");
    vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
  }

  // ===========================================================================
  // HAPPY PATHS
  // ===========================================================================
  console.log("--- Happy paths ---");

  // CC1: Valid credential, valid Merkle proof, correct nullifier
  await test("CC1: Valid credential with valid Merkle proof and correct nullifier", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 111n,
      kycLevel: 2n,
      expiryEpoch: 2000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 5555n,
    });
    assertEqual(w.validCredential, 1n, "validCredential should be 1");
    await assertAccepted(groth16, vk, poseidon, w, "CC1");
  });

  // CC2: kycLevel exactly at required level (boundary)
  await test("CC2: kycLevel exactly equals requiredKycLevel (boundary pass)", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 222n,
      kycLevel: 3n,
      expiryEpoch: 5000n,
      issuerId: 10n,
      currentEpoch: 1000n,
      requiredKycLevel: 3n,
      transferNullifier: 777n,
    });
    assertEqual(w.validCredential, 1n, "validCredential should be 1 when kycLevel == required");
    await assertAccepted(groth16, vk, poseidon, w, "CC2");
  });

  // CC3: expiryEpoch exactly at currentEpoch (boundary)
  await test("CC3: expiryEpoch exactly equals currentEpoch (boundary pass)", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 333n,
      kycLevel: 2n,
      expiryEpoch: 1000n,
      issuerId: 5n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 888n,
    });
    assertEqual(w.validCredential, 1n, "validCredential should be 1 when expiryEpoch == currentEpoch");
    await assertAccepted(groth16, vk, poseidon, w, "CC3");
  });

  // CC4: Maximum valid values (kycLevel=255, large epochs)
  await test("CC4: Maximum valid values (kycLevel=255, large epoch values)", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 444n,
      kycLevel: 255n,
      expiryEpoch: MAX_U64 - 1n,
      issuerId: MAX_U64 - 1n,
      currentEpoch: MAX_U64 - 2n,
      requiredKycLevel: 255n,
      transferNullifier: 999n,
    });
    assertEqual(w.validCredential, 1n, "validCredential should be 1");
    await assertAccepted(groth16, vk, poseidon, w, "CC4");
  });

  // ===========================================================================
  // EXPIRED CREDENTIAL
  // ===========================================================================
  console.log("\n--- Expired credential ---");

  // CC5: Expired credential (expiryEpoch < currentEpoch) => validCredential=0
  await test("CC5: Expired credential (expiryEpoch < currentEpoch) => validCredential=0", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 555n,
      kycLevel: 2n,
      expiryEpoch: 999n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 1111n,
    });
    assertEqual(w.validCredential, 0n, "validCredential should be 0 when expired");
    await assertAccepted(groth16, vk, poseidon, w, "CC5");
  });

  // CC6: Expired credential with wrong validCredential=1 should fail
  await test("CC6: Expired credential with validCredential=1 forced => fails C6", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 556n,
      kycLevel: 2n,
      expiryEpoch: 999n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 1112n,
    });
    // Override validCredential to 1 (should be 0)
    const tampered = { ...w, validCredential: 1n };
    await assertRejected(groth16, vk, poseidon, tampered, "C6:", "CC6");
  });

  // ===========================================================================
  // KYC LEVEL TOO LOW
  // ===========================================================================
  console.log("\n--- KYC level too low ---");

  // CC7: kycLevel < requiredKycLevel => validCredential=0
  await test("CC7: kycLevel < requiredKycLevel => validCredential=0", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 777n,
      kycLevel: 1n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 2n,
      transferNullifier: 2222n,
    });
    assertEqual(w.validCredential, 0n, "validCredential should be 0 when kycLevel too low");
    await assertAccepted(groth16, vk, poseidon, w, "CC7");
  });

  // CC8: kycLevel too low with wrong validCredential=1 should fail
  await test("CC8: kycLevel too low with validCredential=1 forced => fails C6", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 778n,
      kycLevel: 1n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 2n,
      transferNullifier: 2223n,
    });
    const tampered = { ...w, validCredential: 1n };
    await assertRejected(groth16, vk, poseidon, tampered, "C6:", "CC8");
  });

  // CC9: Both expired AND kycLevel too low => validCredential=0
  await test("CC9: Both expired AND kycLevel too low => validCredential=0", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 999n,
      kycLevel: 1n,
      expiryEpoch: 500n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 3n,
      transferNullifier: 3333n,
    });
    assertEqual(w.validCredential, 0n, "validCredential should be 0");
    await assertAccepted(groth16, vk, poseidon, w, "CC9");
  });

  // ===========================================================================
  // WRONG MERKLE ROOT
  // ===========================================================================
  console.log("\n--- Wrong Merkle root ---");

  // CC10: Wrong Merkle root => fails C2
  await test("CC10: Wrong Merkle root => fails C2", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 1010n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 4444n,
    });
    const tampered = { ...w, merkleRoot: w.merkleRoot + 1n };
    await assertRejected(groth16, vk, poseidon, tampered, "C2:", "CC10");
  });

  // CC11: Tampered path element => fails C2
  await test("CC11: Tampered Merkle path element => fails C2", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 1111n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 5555n,
    });
    const tamperedPath = [...w.pathElements];
    tamperedPath[0] = tamperedPath[0] + 1n;
    const tampered = { ...w, pathElements: tamperedPath };
    await assertRejected(groth16, vk, poseidon, tampered, "C2:", "CC11");
  });

  // CC12: Wrong credential fields => Merkle root won't match
  await test("CC12: Wrong kycLevel in leaf => Merkle root won't match", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 1212n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 6666n,
    });
    // Change kycLevel in witness but keep original Merkle root (computed with kycLevel=2)
    const tampered = { ...w, kycLevel: 3n };
    await assertRejected(groth16, vk, poseidon, tampered, "C2:", "CC12");
  });

  // ===========================================================================
  // CONTEXT BINDING
  // ===========================================================================
  console.log("\n--- Context binding ---");

  // CC13: contextId = Poseidon(6, transferNullifier, userSecret)
  await test("CC13: contextId correctly derived from transferNullifier and userSecret", async () => {
    const userSecret = 1313n;
    const transferNullifier = 7777n;
    const expectedContextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));

    const w = buildValidWitness(poseidon, {
      userSecret,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier,
    });

    assertEqual(w.contextId, expectedContextId, "contextId derivation");
    await assertAccepted(groth16, vk, poseidon, w, "CC13");
  });

  // CC14: Wrong transferNullifier => contextId mismatch
  await test("CC14: Wrong transferNullifier => fails C_BIND", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 1414n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 8888n,
    });
    // Change transferNullifier in witness but keep original contextId
    const tampered = { ...w, transferNullifier: 9999n };
    await assertRejected(groth16, vk, poseidon, tampered, "C_BIND:", "CC14");
  });

  // CC15: Wrong contextId => fails both C3 (nullifier) and C_BIND
  await test("CC15: Wrong contextId => fails C3 and C_BIND", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 1515n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 101010n,
    });
    const tampered = { ...w, contextId: w.contextId + 1n };
    // This will fail both C3 (nullifier recomputed with wrong contextId) and C_BIND
    const errors = simulateCompliance(poseidon, tampered);
    assert(errors.length > 0, "CC15: Expected constraint violations");
  });

  // ===========================================================================
  // NULLIFIER UNIQUENESS
  // ===========================================================================
  console.log("\n--- Nullifier uniqueness ---");

  // CC16: Same inputs with different contextId produce different nullifiers
  await test("CC16: Different contextId => different nullifiers", async () => {
    const userSecret = 1616n;

    const ctx1 = toBI(poseidon([DOMAIN_CONTEXT_BINDING, 1000n, userSecret]));
    const ctx2 = toBI(poseidon([DOMAIN_CONTEXT_BINDING, 2000n, userSecret]));

    const nf1 = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, ctx1]));
    const nf2 = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, ctx2]));

    assert(nf1 !== nf2, "Nullifiers with different contextId must differ");
  });

  // CC17: Same transfer, different users produce different nullifiers
  await test("CC17: Different users, same transfer => different nullifiers", async () => {
    const transferNullifier = 123456n;

    const ctx1 = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, 1n]));
    const ctx2 = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, 2n]));

    const nf1 = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, 1n, ctx1]));
    const nf2 = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, 2n, ctx2]));

    assert(nf1 !== nf2, "Different users must produce different compliance nullifiers");
  });

  // CC18: Same user, different transfers produce different nullifiers
  await test("CC18: Same user, different transfers => different nullifiers", async () => {
    const userSecret = 1818n;

    const ctx1 = toBI(poseidon([DOMAIN_CONTEXT_BINDING, 100n, userSecret]));
    const ctx2 = toBI(poseidon([DOMAIN_CONTEXT_BINDING, 200n, userSecret]));

    const nf1 = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, ctx1]));
    const nf2 = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, ctx2]));

    assert(nf1 !== nf2, "Same user, different transfers must produce different nullifiers");
  });

  // CC19: Wrong nullifier (mismatched userSecret) => fails C3
  await test("CC19: Wrong nullifier (mismatched userSecret) => fails C3", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 1919n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 111111n,
    });
    // Compute a wrong nullifier with different secret but keep userSecret in witness
    const wrongCtx = toBI(poseidon([DOMAIN_CONTEXT_BINDING, w.transferNullifier, 9999n]));
    const wrongNullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, 9999n, wrongCtx]));
    const tampered = { ...w, nullifier: wrongNullifier };
    await assertRejected(groth16, vk, poseidon, tampered, "C3:", "CC19");
  });

  // ===========================================================================
  // DOMAIN SEPARATION
  // ===========================================================================
  console.log("\n--- Domain separation ---");

  // CC20: Domain tag 4 (credential) vs 5 (nullifier) vs 6 (context) produce different hashes
  await test("CC20: Domain tags 4, 5, 6 produce different hashes for same inputs", async () => {
    const a = 100n;
    const b = 200n;

    const h4 = toBI(poseidon([4n, a, b]));
    const h5 = toBI(poseidon([5n, a, b]));
    const h6 = toBI(poseidon([6n, a, b]));

    assert(h4 !== h5, "tag 4 vs tag 5 must differ");
    assert(h4 !== h6, "tag 4 vs tag 6 must differ");
    assert(h5 !== h6, "tag 5 vs tag 6 must differ");
  });

  // CC21: Domain tags don't collide with transfer circuit tags (1,2,3)
  await test("CC21: Compliance domain tags (4,5,6) don't collide with transfer tags (1,2,3)", async () => {
    const a = 100n;
    const b = 200n;
    const c = 300n;

    // All 6 domain tags with the same payload
    const hashes = [];
    for (let tag = 1n; tag <= 6n; tag++) {
      hashes.push(toBI(poseidon([tag, a, b, c])));
    }

    // All pairwise different
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        assert(hashes[i] !== hashes[j], `tag ${i + 1} vs tag ${j + 1} must differ`);
      }
    }
  });

  // ===========================================================================
  // RANGE PROOF VIOLATIONS
  // ===========================================================================
  console.log("\n--- Range proof violations ---");

  // CC22: kycLevel >= 256 (exceeds 8-bit range proof)
  await test("CC22: kycLevel >= 256 => fails C9 range proof", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 2222n,
      kycLevel: 256n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 222222n,
    });
    await assertRejected(groth16, vk, poseidon, w, "C9:", "CC22");
  });

  // CC23: requiredKycLevel >= 256 => fails C10
  await test("CC23: requiredKycLevel >= 256 => fails C10 range proof", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 2323n,
      kycLevel: 1n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 256n,
      transferNullifier: 333333n,
    });
    await assertRejected(groth16, vk, poseidon, w, "C10:", "CC23");
  });

  // CC24: currentEpoch >= 2^64 => fails C7
  await test("CC24: currentEpoch >= 2^64 => fails C7 range proof", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 2424n,
      kycLevel: 2n,
      expiryEpoch: MAX_U64 + 1n,
      issuerId: 1n,
      currentEpoch: MAX_U64,
      requiredKycLevel: 1n,
      transferNullifier: 444444n,
    });
    await assertRejected(groth16, vk, poseidon, w, "C7:", "CC24");
  });

  // CC25: expiryEpoch >= 2^64 => fails C8
  await test("CC25: expiryEpoch >= 2^64 => fails C8 range proof", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 2525n,
      kycLevel: 2n,
      expiryEpoch: MAX_U64,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 555555n,
    });
    await assertRejected(groth16, vk, poseidon, w, "C8:", "CC25");
  });

  // CC26: issuerId >= 2^64 => fails C11
  await test("CC26: issuerId >= 2^64 => fails C11 range proof", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 2626n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: MAX_U64,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 666666n,
    });
    await assertRejected(groth16, vk, poseidon, w, "C11:", "CC26");
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================
  console.log("\n--- Edge cases ---");

  // CC27: Minimal values (kycLevel=0, requiredKycLevel=0, epoch=0)
  await test("CC27: Minimal values (kycLevel=0, requiredKycLevel=0, epochs=0)", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 0n,
      kycLevel: 0n,
      expiryEpoch: 0n,
      issuerId: 0n,
      currentEpoch: 0n,
      requiredKycLevel: 0n,
      transferNullifier: 0n,
    });
    assertEqual(w.validCredential, 1n, "validCredential should be 1 with all-zero valid inputs");
    await assertAccepted(groth16, vk, poseidon, w, "CC27");
  });

  // CC28: Changing userSecret changes everything (credential leaf, contextId, nullifier)
  await test("CC28: Different userSecret produces entirely different witness hashes", async () => {
    const base = {
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 777777n,
    };
    const w1 = buildValidWitness(poseidon, { ...base, userSecret: 1n });
    const w2 = buildValidWitness(poseidon, { ...base, userSecret: 2n });

    assert(w1.merkleRoot !== w2.merkleRoot, "Different secrets => different Merkle roots");
    assert(w1.contextId !== w2.contextId, "Different secrets => different contextIds");
    assert(w1.nullifier !== w2.nullifier, "Different secrets => different nullifiers");
  });

  // CC29: Deterministic proofs (same inputs produce same simulation result)
  await test("CC29: Deterministic -- same inputs produce consistent verification", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 2929n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 888888n,
    });

    const errors1 = simulateCompliance(poseidon, w);
    const errors2 = simulateCompliance(poseidon, w);
    assertEqual(errors1.length, 0, "first simulation");
    assertEqual(errors2.length, 0, "second simulation");
  });

  // CC30: Changing any single private input invalidates the proof
  await test("CC30: Changing any single private input invalidates the proof", async () => {
    const w = buildValidWitness(poseidon, {
      userSecret: 3030n,
      kycLevel: 2n,
      expiryEpoch: 5000n,
      issuerId: 1n,
      currentEpoch: 1000n,
      requiredKycLevel: 1n,
      transferNullifier: 999999n,
    });

    const baseErrors = simulateCompliance(poseidon, w);
    assert(baseErrors.length === 0, `Base witness must be valid: ${baseErrors.join("; ")}`);

    // Mutate each private input individually (keeping public signals fixed)
    const mutations = [
      { field: "userSecret", value: 3031n },
      { field: "kycLevel", value: 3n },
      { field: "expiryEpoch", value: 5001n },
      { field: "issuerId", value: 2n },
      { field: "transferNullifier", value: 1000000n },
    ];

    for (const { field, value } of mutations) {
      const mutated = { ...w, [field]: value };
      const errors = simulateCompliance(poseidon, mutated);
      assert(
        errors.length > 0,
        `Mutating ${field} to ${value} must cause constraint violations`,
      );
    }
  });

  // -- Summary ----------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  // snarkjs' bn128 curve keeps worker handles open after the last proof, which
  // otherwise leaves this process hanging indefinitely even though every test passed.
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
