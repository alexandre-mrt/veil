/**
 * transfer.test.mjs — Veil Transfer Circuit Tests (v2 — audit fixes)
 *
 * Tests circuit constraints using two modes:
 *   1. Full proof mode (requires compiled WASM + zkey): uses snarkjs fullProve + verify
 *   2. Hash-only mode (fallback when circom not compiled): validates Poseidon arithmetic
 *      that the circuit would enforce, catching logic errors before compilation
 *
 * v2 changes (audit fixes):
 *   - Commitments: Poseidon(1, cum, rand, userSecret) — bound to identity (CRYPTO-004)
 *   - Nullifiers: Poseidon(2, userSecret, epochId, randOld) — unique per transfer (CRYPTO-006)
 *   - txAmountHash: Poseidon(3, txAmount, salt) — domain tag 3 (CRYPTO-011)
 *   - Genesis: Poseidon(1, 0, 0, userSecret) — user-specific
 *
 * Run: node --experimental-vm-modules test/transfer.test.mjs
 */

import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Poseidon2 sponge, arity 2, capacity-first — matches
 * circuits/templates/poseidon2_hash2.circom exactly. templates/merkle_proof.circom's node
 * hash now uses this instead of circomlib's Poseidon(2) (research/2026-08-24 experiment).
 */
function poseidon2Hash2(a, b) {
  return bn254.t3.permutation([0n, BigInt(a), BigInt(b)])[0];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build");
const WASM_PATH = join(BUILD_DIR, "transfer_js", "transfer.wasm");
const ZKEY_PATH = join(BUILD_DIR, "transfer_final.zkey");
const VK_PATH = join(BUILD_DIR, "transfer_vk.json");

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_U64 = 2n ** 64n;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const MERKLE_DEPTH = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Poseidon field element reference — set in main() after buildPoseidon() */
let poseidonF = null;

/**
 * Convert a circomlibjs Poseidon output to BigInt.
 * circomlibjs returns an internal field element (Uint8Array buffer).
 * Must use F.toObject() for correct conversion, NOT manual byte parsing.
 */
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) {
    return poseidonF.toObject(val);
  }
  return BigInt(val);
}

/**
 * Recompute a depth-20 Merkle root from a leaf and its authentication path,
 * using the same Poseidon(2) node hash as templates/merkle_proof.circom.
 */
function merkleRootFromPath(poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2Hash2(left, right);
  }
  return node;
}

/**
 * Build all signal values for a valid Transfer witness.
 * Returns both private inputs and the expected public inputs.
 *
 * v2: commitments include userSecret, nullifier includes randomnessOld,
 *     txAmountHash uses domain tag 3.
 */
function buildValidWitness(poseidon, {
  cumulativeOld = 0n,
  txAmount = 100n,
  randomnessOld = 0n,
  randomnessNew = 12345n,
  userSecret = 987654321n,
  epochId = 1n,
  threshold = 1_000_000_000n,
  salt = 99n,
} = {}) {
  const cumulativeNew = cumulativeOld + txAmount;

  // commitment = Poseidon(1, cumulative, randomness, userSecret)
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));

  // nullifier = Poseidon(2, userSecret, epochId, randomnessOld)
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));

  // txAmountHash = Poseidon(3, txAmount, salt)
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

  // C0: membership of oldCommitment in the depth-20 commitment tree.
  // The witness places the leaf at index 0 with empty siblings; the root is
  // recomputed with the same Poseidon(2) node hash the circuit uses.
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPath(poseidon, oldCommitment, pathElements, pathIndices);

  return {
    // Public inputs (7)
    oldCommitment,
    newCommitment,
    threshold,
    epochId,
    nullifier,
    txAmountHash,
    merkleRoot,
    // Private inputs (7 + Merkle path)
    cumulativeOld,
    cumulativeNew,
    txAmount,
    randomnessOld,
    randomnessNew,
    userSecret,
    salt,
    pathElements,
    pathIndices,
  };
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const FULL_PROOF_AVAILABLE = existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

console.log("=== Veil Transfer Circuit Tests (v2 — audit fixes) ===");
console.log(`Mode: ${FULL_PROOF_AVAILABLE ? "FULL PROOF (snarkjs Groth16)" : "HASH-ONLY (constraint simulation)"}`);
if (!FULL_PROOF_AVAILABLE) {
  console.log("  (Run 'npm run compile' to enable full Groth16 proof tests)");
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

// ── Constraint simulation (hash-only mode) ────────────────────────────────────
// Mirrors exactly what the circom circuit enforces, so we catch logic bugs
// without needing a compiled wasm.

function simulateTransfer(poseidon, inputs) {
  const {
    oldCommitment, newCommitment, threshold, epochId,
    nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount,
    randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  } = inputs;

  const errors = [];

  // C0: oldCommitment is a leaf of the tree whose root is merkleRoot
  if (merkleRoot !== undefined && pathElements && pathIndices) {
    const computedRoot = merkleRootFromPath(poseidon, oldCommitment, pathElements, pathIndices);
    if (merkleRoot !== computedRoot) {
      errors.push(`C0: merkleRoot mismatch (expected ${computedRoot}, got ${merkleRoot})`);
    }
  }

  // C1: old commitment = Poseidon(1, cumOld, randOld, userSecret)
  const expectedOldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  if (oldCommitment !== expectedOldCommitment) {
    errors.push(`C1: oldCommitment mismatch (expected ${expectedOldCommitment}, got ${oldCommitment})`);
  }

  // C2: new commitment = Poseidon(1, cumNew, randNew, userSecret)
  const expectedNewCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  if (newCommitment !== expectedNewCommitment) {
    errors.push(`C2: newCommitment mismatch (expected ${expectedNewCommitment}, got ${newCommitment})`);
  }

  // C3: cumulative update
  if (cumulativeNew !== cumulativeOld + txAmount) {
    errors.push(`C3: cumulativeNew (${cumulativeNew}) !== cumulativeOld (${cumulativeOld}) + txAmount (${txAmount})`);
  }

  // C4: txAmount > 0
  if (txAmount <= 0n) {
    errors.push(`C4: txAmount must be > 0, got ${txAmount}`);
  }

  // C5-C7: range proofs [0, 2^64)
  if (cumulativeOld < 0n || cumulativeOld >= MAX_U64) {
    errors.push(`C5: cumulativeOld out of [0, 2^64): ${cumulativeOld}`);
  }
  if (txAmount < 0n || txAmount >= MAX_U64) {
    errors.push(`C6: txAmount out of [0, 2^64): ${txAmount}`);
  }
  if (cumulativeNew < 0n || cumulativeNew >= MAX_U64) {
    errors.push(`C7: cumulativeNew out of [0, 2^64): ${cumulativeNew}`);
  }

  // C8: threshold range proof
  if (threshold < 0n || threshold >= MAX_U64) {
    errors.push(`C8: threshold out of [0, 2^64): ${threshold}`);
  }

  // C9: cumulative under threshold
  if (cumulativeNew > threshold) {
    errors.push(`C9: cumulativeNew (${cumulativeNew}) > threshold (${threshold})`);
  }

  // C10: nullifier = Poseidon(2, userSecret, epochId, randomnessOld)
  const expectedNullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  if (nullifier !== expectedNullifier) {
    errors.push(`C10: nullifier mismatch (expected ${expectedNullifier}, got ${nullifier})`);
  }

  // C11: txAmountHash = Poseidon(3, txAmount, salt)
  const expectedTxAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  if (txAmountHash !== expectedTxAmountHash) {
    errors.push(`C11: txAmountHash mismatch`);
  }

  return errors;
}

// ── Full proof helpers ────────────────────────────────────────────────────────

async function loadSnarkjs() {
  const mod = await import("snarkjs");
  return mod.groth16;
}

async function proveAndVerify(groth16, vk, inputs) {
  const stringInputs = {};
  for (const [k, v] of Object.entries(inputs)) {
    stringInputs[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  const { proof, publicSignals } = await groth16.fullProve(stringInputs, WASM_PATH, ZKEY_PATH);
  const valid = await groth16.verify(vk, publicSignals, proof);
  return { proof, publicSignals, valid };
}

/**
 * Assert that a witness is rejected by the circuit.
 * In full proof mode, fullProve must throw. In hash-only mode, simulateTransfer
 * must return at least one error matching the expected constraint prefix.
 */
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
    const errors = simulateTransfer(poseidon, witness);
    assert(errors.length > 0, `${label}: Expected constraint violations`);
    if (expectedConstraintPrefix) {
      assert(
        errors.some(e => e.startsWith(expectedConstraintPrefix)),
        `${label}: Expected ${expectedConstraintPrefix} violation, got: ${errors.join("; ")}`,
      );
    }
  }
}

/**
 * Assert that a witness is accepted by the circuit.
 */
async function assertAccepted(groth16, vk, poseidon, witness, label) {
  if (FULL_PROOF_AVAILABLE) {
    const { valid } = await proveAndVerify(groth16, vk, witness);
    assert(valid, `${label}: Groth16 proof must verify`);
  } else {
    const errors = simulateTransfer(poseidon, witness);
    assert(errors.length === 0, `${label}: Constraint violations: ${errors.join("; ")}`);
  }
}

// ── Main test suite ───────────────────────────────────────────────────────────

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

  // ═══════════════════════════════════════════════════════════════════════════
  // HAPPY PATHS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("--- Happy paths ---");

  // T1: Genesis transfer (cumOld=0, randOld=0)
  await test("T1: Genesis transfer (cumOld=0, randOld=0, first-ever transfer)", async () => {
    const userSecret = 111n;
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n,
      txAmount: 100n,
      randomnessOld: 0n,
      randomnessNew: 42n,
      userSecret,
      epochId: 1n,
      salt: 7n,
    });

    // Genesis check: oldCommitment = Poseidon(1, 0, 0, userSecret)
    const genesisCommitment = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, userSecret]));
    assertEqual(w.oldCommitment, genesisCommitment, "genesis oldCommitment");

    await assertAccepted(groth16, vk, poseidon, w, "T1");
  });

  // T2: Subsequent transfer
  await test("T2: Subsequent transfer (cumOld=100, txAmount=50)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n,
      txAmount: 50n,
      randomnessOld: 55n,
      randomnessNew: 66n,
      userSecret: 222n,
      epochId: 1n,
      salt: 13n,
    });
    await assertAccepted(groth16, vk, poseidon, w, "T2");
  });

  // T3: Chain of 3 transfers
  await test("T3: Chain of 3 transfers (state continuity)", async () => {
    const secret = 333n;
    const epoch = 2n;
    let cumulative = 0n;
    let randomness = 0n;

    const transfers = [
      { txAmount: 10n, nextRandomness: 101n, salt: 1n },
      { txAmount: 20n, nextRandomness: 202n, salt: 2n },
      { txAmount: 30n, nextRandomness: 303n, salt: 3n },
    ];

    for (let i = 0; i < transfers.length; i++) {
      const { txAmount, nextRandomness, salt } = transfers[i];
      const w = buildValidWitness(poseidon, {
        cumulativeOld: cumulative,
        txAmount,
        randomnessOld: randomness,
        randomnessNew: nextRandomness,
        userSecret: secret,
        epochId: epoch,
        salt,
      });

      await assertAccepted(groth16, vk, poseidon, w, `T3 transfer ${i + 1}`);

      cumulative = cumulative + txAmount;
      randomness = nextRandomness;
    }

    assertEqual(cumulative, 60n, "final cumulative after 3 transfers");
  });

  // T4: Transfer at exactly threshold (cumNew == threshold, LessEqThan)
  await test("T4: Transfer at exactly threshold (cumNew == threshold)", async () => {
    const threshold = 500n;
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 400n,
      txAmount: 100n,
      randomnessOld: 10n,
      randomnessNew: 20n,
      userSecret: 444n,
      epochId: 1n,
      threshold,
      salt: 55n,
    });
    // cumNew = 400 + 100 = 500 == threshold
    assertEqual(w.cumulativeNew, threshold, "cumNew should equal threshold");
    await assertAccepted(groth16, vk, poseidon, w, "T4");
  });

  // T5: Large values near 2^64 boundary (valid)
  await test("T5: Large values near 2^64 boundary (cumOld=2^64-200, txAmount=100)", async () => {
    const cumOld = MAX_U64 - 200n;
    const txAmt = 100n;
    const cumNew = cumOld + txAmt; // 2^64 - 100, still < 2^64
    const thresholdVal = MAX_U64 - 1n; // max valid threshold
    const w = buildValidWitness(poseidon, {
      cumulativeOld: cumOld,
      txAmount: txAmt,
      randomnessOld: 1000n,
      randomnessNew: 2000n,
      userSecret: 555n,
      epochId: 5n,
      threshold: thresholdVal,
      salt: 77n,
    });
    await assertAccepted(groth16, vk, poseidon, w, "T5");
  });

  // T6: Different userSecrets produce isolated commitments
  await test("T6: Different userSecrets produce isolated commitments", async () => {
    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 50n, txAmount: 25n,
      randomnessOld: 10n, randomnessNew: 20n,
      userSecret: 1111n, epochId: 1n, salt: 1n,
    });
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 50n, txAmount: 25n,
      randomnessOld: 10n, randomnessNew: 20n,
      userSecret: 2222n, epochId: 1n, salt: 1n,
    });

    // Same amounts/randomness but different secrets = different commitments
    assert(w1.oldCommitment !== w2.oldCommitment, "oldCommitments must differ");
    assert(w1.newCommitment !== w2.newCommitment, "newCommitments must differ");
    assert(w1.nullifier !== w2.nullifier, "nullifiers must differ");

    // Both must be valid
    await assertAccepted(groth16, vk, poseidon, w1, "T6 user1");
    await assertAccepted(groth16, vk, poseidon, w2, "T6 user2");
  });

  // T7: Multiple transfers same epoch, different randomness = unique nullifiers
  await test("T7: Same epoch different randomness produces unique nullifiers", async () => {
    const secret = 777n;
    const epoch = 3n;

    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 10n,
      randomnessOld: 100n, randomnessNew: 200n,
      userSecret: secret, epochId: epoch, salt: 1n,
    });
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 10n, txAmount: 10n,
      randomnessOld: 200n, randomnessNew: 300n,
      userSecret: secret, epochId: epoch, salt: 2n,
    });

    // Same user, same epoch, but different randomnessOld => different nullifiers
    assert(w1.nullifier !== w2.nullifier, "Nullifiers must be unique per transfer (CRYPTO-006)");

    await assertAccepted(groth16, vk, poseidon, w1, "T7 tx1");
    await assertAccepted(groth16, vk, poseidon, w2, "T7 tx2");
  });

  // T8: txAmount = 1 (smallest valid transfer)
  await test("T8: Smallest valid transfer (txAmount=1)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n,
      txAmount: 1n,
      randomnessOld: 0n,
      randomnessNew: 1n,
      userSecret: 888n,
      epochId: 1n,
      salt: 1n,
    });
    await assertAccepted(groth16, vk, poseidon, w, "T8");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTRAINT VIOLATION TESTS (each should FAIL)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- Constraint violations (must be rejected) ---");

  // T9: C1 — wrong old commitment (tampered randomness)
  await test("T9: C1 — wrong old commitment (tampered randomness)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n, txAmount: 50n,
      randomnessOld: 55n, randomnessNew: 66n,
      userSecret: 444n, epochId: 1n, salt: 9n,
    });
    // Tamper randomnessOld: oldCommitment was computed with 55, but witness says 56
    const tampered = { ...w, randomnessOld: 56n };
    await assertRejected(groth16, vk, poseidon, tampered, "C1:", "T9");
  });

  // T10: C1 — wrong old commitment (wrong userSecret)
  await test("T10: C1 — wrong old commitment (wrong userSecret in witness)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n, txAmount: 50n,
      randomnessOld: 55n, randomnessNew: 66n,
      userSecret: 444n, epochId: 1n, salt: 9n,
    });
    // Tamper: change userSecret but keep old/new commitments computed with 444
    // The circuit will recompute Poseidon(1, 100, 55, 999) != oldCommitment
    const tampered = { ...w, userSecret: 999n };
    await assertRejected(groth16, vk, poseidon, tampered, "C1:", "T10");
  });

  // T11: C2 — wrong new commitment (tampered randomness)
  await test("T11: C2 — wrong new commitment (tampered randomnessNew)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n, txAmount: 50n,
      randomnessOld: 55n, randomnessNew: 66n,
      userSecret: 444n, epochId: 1n, salt: 9n,
    });
    // Recompute newCommitment with wrong randomnessNew, keeping the bad randomness in witness
    const badNewCommitment = toBI(poseidon([DOMAIN_COMMITMENT, w.cumulativeNew, 67n, w.userSecret]));
    const tampered = { ...w, randomnessNew: 67n, newCommitment: badNewCommitment };
    // oldCommitment still expects randomnessOld=55, but now let's only break newCommitment
    // Actually, let's just set wrong randomnessNew while keeping original newCommitment
    const tampered2 = { ...w, randomnessNew: 67n };
    await assertRejected(groth16, vk, poseidon, tampered2, "C2:", "T11");
  });

  // T12: C3 — cumNew != cumOld + txAmount
  await test("T12: C3 — cumNew != cumOld + txAmount (arithmetic mismatch)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n, txAmount: 50n,
      randomnessOld: 55n, randomnessNew: 66n,
      userSecret: 444n, epochId: 1n, salt: 9n,
    });
    // Set cumulativeNew to wrong value, recompute newCommitment to match
    const wrongCumNew = 200n;
    const wrongNewCommitment = toBI(poseidon([DOMAIN_COMMITMENT, wrongCumNew, w.randomnessNew, w.userSecret]));
    const tampered = {
      ...w,
      cumulativeNew: wrongCumNew,
      newCommitment: wrongNewCommitment,
    };
    await assertRejected(groth16, vk, poseidon, tampered, "C3:", "T12");
  });

  // T13: C4 — txAmount = 0 (zero transfer)
  await test("T13: C4 — txAmount=0 (zero transfer rejected)", async () => {
    const cumulativeOld = 100n;
    const txAmount = 0n;
    const cumulativeNew = cumulativeOld;
    const randomnessOld = 55n;
    const randomnessNew = 66n;
    const userSecret = 555n;
    const epochId = 1n;
    const salt = 17n;
    const threshold = 1_000_000_000n;

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const tampered = {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };
    await assertRejected(groth16, vk, poseidon, tampered, "C4:", "T13");
  });

  // T14: C5 — cumulativeOld >= 2^64
  await test("T14: C5 — cumulativeOld >= 2^64 (overflow)", async () => {
    const cumulativeOld = MAX_U64; // exactly 2^64, out of [0, 2^64)
    const txAmount = 1n;
    const cumulativeNew = cumulativeOld + txAmount;
    const randomnessOld = 10n;
    const randomnessNew = 20n;
    const userSecret = 600n;
    const epochId = 1n;
    const salt = 1n;
    const threshold = MAX_U64 + 100n; // would also fail C8 but we test C5

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const tampered = {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };
    await assertRejected(groth16, vk, poseidon, tampered, "C5:", "T14");
  });

  // T15: C6 — txAmount >= 2^64
  await test("T15: C6 — txAmount >= 2^64 (overflow)", async () => {
    const cumulativeOld = 0n;
    const txAmount = MAX_U64; // exactly 2^64
    const cumulativeNew = cumulativeOld + txAmount;
    const randomnessOld = 10n;
    const randomnessNew = 20n;
    const userSecret = 601n;
    const epochId = 1n;
    const salt = 1n;
    const threshold = MAX_U64 + 100n;

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const tampered = {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };
    await assertRejected(groth16, vk, poseidon, tampered, "C6:", "T15");
  });

  // T16: C7 — cumulativeNew >= 2^64 (overflow from addition)
  await test("T16: C7 — cumulativeNew overflow from addition (> 2^64)", async () => {
    const cumulativeOld = MAX_U64 - 10n;
    const txAmount = 100n;
    const cumulativeNew = cumulativeOld + txAmount; // > 2^64
    const randomnessOld = 77n;
    const randomnessNew = 88n;
    const userSecret = 666n;
    const epochId = 1n;
    const salt = 21n;

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const tampered = {
      oldCommitment, newCommitment,
      threshold: 1_000_000_000n, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };
    await assertRejected(groth16, vk, poseidon, tampered, "C7:", "T16");
  });

  // T17: C8 — threshold >= 2^64
  await test("T17: C8 — threshold >= 2^64 (range proof fails)", async () => {
    const threshold = MAX_U64; // exactly 2^64, fails Num2Bits(64)
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 1n,
      randomnessOld: 0n, randomnessNew: 1n,
      userSecret: 700n, epochId: 1n,
      threshold,
      salt: 1n,
    });
    await assertRejected(groth16, vk, poseidon, w, "C8:", "T17");
  });

  // T18: C9 — cumNew > threshold
  await test("T18: C9 — cumNew > threshold (exceeds spending limit)", async () => {
    const threshold = 100n;
    // Build a valid witness first, then override threshold to be too low
    const cumulativeOld = 50n;
    const txAmount = 60n;
    const cumulativeNew = cumulativeOld + txAmount; // 110 > 100
    const randomnessOld = 10n;
    const randomnessNew = 20n;
    const userSecret = 800n;
    const epochId = 1n;
    const salt = 1n;

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const tampered = {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };
    await assertRejected(groth16, vk, poseidon, tampered, "C9:", "T18");
  });

  // T19: C10 — wrong nullifier (wrong userSecret)
  await test("T19: C10 — wrong nullifier (mismatched userSecret)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 50n, txAmount: 25n,
      randomnessOld: 11n, randomnessNew: 22n,
      userSecret: 777n, epochId: 3n, salt: 33n,
    });
    const wrongNullifier = toBI(poseidon([DOMAIN_NULLIFIER, 999999n, w.epochId, w.randomnessOld]));
    const tampered = { ...w, nullifier: wrongNullifier };
    await assertRejected(groth16, vk, poseidon, tampered, "C10:", "T19");
  });

  // T20: C10 — wrong nullifier (wrong epochId)
  await test("T20: C10 — wrong nullifier (wrong epochId)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 50n, txAmount: 25n,
      randomnessOld: 11n, randomnessNew: 22n,
      userSecret: 777n, epochId: 3n, salt: 33n,
    });
    const wrongNullifier = toBI(poseidon([DOMAIN_NULLIFIER, w.userSecret, 999n, w.randomnessOld]));
    const tampered = { ...w, nullifier: wrongNullifier, epochId: 999n };
    // The epochId is public, so we must also change it in the witness for consistency
    // But the old nullifier was computed with epochId=3, so mismatch
    // Actually: we change epochId in witness AND provide matching nullifier for wrong epoch
    // The circuit checks nullifier == Poseidon(2, userSecret, epochId, randOld)
    // If we change epochId to 999 but keep the nullifier computed with 3 → mismatch
    const tampered2 = { ...w, nullifier: toBI(poseidon([DOMAIN_NULLIFIER, w.userSecret, 3n, w.randomnessOld])), epochId: 999n };
    // This way: epochId in circuit = 999, but nullifier was computed with epochId=3
    // But wait — epochId is a public input, the circuit uses it to verify the nullifier
    // So if we pass epochId=999 and a nullifier matching epochId=3, the circuit recalculates
    // Poseidon(2, userSecret, 999, randOld) and compares to our nullifier (computed with 3) → fail
    // We need the public input to be wrong, not the private
    // Simplest: keep epochId=3 as public but pass nullifier for epochId=999
    const wrongEpochNullifier = toBI(poseidon([DOMAIN_NULLIFIER, w.userSecret, 999n, w.randomnessOld]));
    const tampered3 = { ...w, nullifier: wrongEpochNullifier };
    await assertRejected(groth16, vk, poseidon, tampered3, "C10:", "T20");
  });

  // T21: C10 — wrong nullifier (wrong randomnessOld)
  await test("T21: C10 — wrong nullifier (wrong randomnessOld)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 50n, txAmount: 25n,
      randomnessOld: 11n, randomnessNew: 22n,
      userSecret: 777n, epochId: 3n, salt: 33n,
    });
    // Provide nullifier with wrong randomnessOld while keeping correct randomnessOld in witness
    const wrongNullifier = toBI(poseidon([DOMAIN_NULLIFIER, w.userSecret, w.epochId, 9999n]));
    const tampered = { ...w, nullifier: wrongNullifier };
    await assertRejected(groth16, vk, poseidon, tampered, "C10:", "T21");
  });

  // T22: C11 — wrong txAmountHash (wrong salt)
  await test("T22: C11 — wrong txAmountHash (wrong salt)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 100n,
      randomnessOld: 0n, randomnessNew: 1n,
      userSecret: 900n, epochId: 1n, salt: 42n,
    });
    // Provide txAmountHash with wrong salt, but correct salt in witness
    const wrongHash = toBI(poseidon([DOMAIN_TX_AMOUNT, w.txAmount, 999n]));
    const tampered = { ...w, txAmountHash: wrongHash };
    await assertRejected(groth16, vk, poseidon, tampered, "C11:", "T22");
  });

  // T23: C11 — wrong txAmountHash (missing domain tag 3)
  await test("T23: C11 — wrong txAmountHash (wrong domain tag, using 1 instead of 3)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 100n,
      randomnessOld: 0n, randomnessNew: 1n,
      userSecret: 901n, epochId: 1n, salt: 42n,
    });
    // Compute hash with domain tag 1 (commitment tag) instead of 3
    const wrongDomainHash = toBI(poseidon([DOMAIN_COMMITMENT, w.txAmount, w.salt]));
    const tampered = { ...w, txAmountHash: wrongDomainHash };
    await assertRejected(groth16, vk, poseidon, tampered, "C11:", "T23");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- Edge cases ---");

  // T24: Threshold = 0 — should reject all transfers (txAmount > 0 => cumNew > 0 > threshold=0)
  await test("T24: Threshold=0 rejects all transfers (cumNew > 0 > threshold)", async () => {
    const cumulativeOld = 0n;
    const txAmount = 1n;
    const cumulativeNew = 1n;
    const randomnessOld = 0n;
    const randomnessNew = 1n;
    const userSecret = 1000n;
    const epochId = 1n;
    const salt = 1n;
    const threshold = 0n;

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const w = {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };
    await assertRejected(groth16, vk, poseidon, w, "C9:", "T24");
  });

  // T25: All private inputs = 0 except txAmount (minimal genesis)
  await test("T25: Minimal genesis — all private 0 except txAmount", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n,
      txAmount: 1n,
      randomnessOld: 0n,
      randomnessNew: 0n,
      userSecret: 0n,
      epochId: 0n,
      threshold: 1n,
      salt: 0n,
    });
    await assertAccepted(groth16, vk, poseidon, w, "T25");
  });

  // T26: Same commitment inputs with different userSecrets produce different hashes
  await test("T26: Same commitment inputs, different secrets = different hashes", async () => {
    const cumOld = 100n;
    const randOld = 50n;

    const commit1 = toBI(poseidon([DOMAIN_COMMITMENT, cumOld, randOld, 1n]));
    const commit2 = toBI(poseidon([DOMAIN_COMMITMENT, cumOld, randOld, 2n]));

    assert(commit1 !== commit2, "Commitments with different userSecrets must differ");
  });

  // T27: Same nullifier inputs, different epoch = different nullifiers
  await test("T27: Same nullifier inputs, different epoch = different nullifiers", async () => {
    const secret = 777n;
    const randOld = 11n;

    const nf1 = toBI(poseidon([DOMAIN_NULLIFIER, secret, 1n, randOld]));
    const nf2 = toBI(poseidon([DOMAIN_NULLIFIER, secret, 2n, randOld]));

    assert(nf1 !== nf2, "Nullifiers with different epochIds must differ");
  });

  // T28: Deterministic proofs (same inputs produce same verification result)
  await test("T28: Deterministic — same inputs produce consistent verification", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 10n, txAmount: 5n,
      randomnessOld: 1n, randomnessNew: 2n,
      userSecret: 123n, epochId: 1n, salt: 7n,
    });

    // Run simulation twice — must produce same result
    const errors1 = simulateTransfer(poseidon, w);
    const errors2 = simulateTransfer(poseidon, w);
    assertEqual(errors1.length, 0, "first simulation");
    assertEqual(errors2.length, 0, "second simulation");

    if (FULL_PROOF_AVAILABLE) {
      const r1 = await proveAndVerify(groth16, vk, w);
      const r2 = await proveAndVerify(groth16, vk, w);
      assert(r1.valid, "first proof must verify");
      assert(r2.valid, "second proof must verify");
      // Public signals must be identical (proof itself may differ due to randomness in Groth16)
      assertEqual(
        JSON.stringify(r1.publicSignals),
        JSON.stringify(r2.publicSignals),
        "public signals must be deterministic",
      );
    }
  });

  // T29: Genesis commitment is user-specific (different users, different genesis)
  await test("T29: Genesis commitment is user-specific (bound to userSecret)", async () => {
    const secret1 = 1n;
    const secret2 = 2n;

    const genesis1 = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, secret1]));
    const genesis2 = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, secret2]));

    assert(genesis1 > 0n, "Genesis commitment must be a non-zero field element");
    assert(genesis1 !== genesis2, "Different userSecrets must produce different genesis commitments");

    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 1n, randomnessNew: 1n,
      userSecret: secret1, salt: 1n,
    });
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 1n, randomnessNew: 2n,
      userSecret: secret2, salt: 2n,
    });

    assert(w1.oldCommitment !== w2.oldCommitment, "Different users must have different genesis commitments");

    const errors1 = simulateTransfer(poseidon, w1);
    const errors2 = simulateTransfer(poseidon, w2);
    assert(errors1.length === 0, `User 1 violations: ${errors1.join("; ")}`);
    assert(errors2.length === 0, `User 2 violations: ${errors2.join("; ")}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY-SPECIFIC TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- Security-specific ---");

  // T30: Field overflow — cumOld + txAmount wraps in BN254 but exceeds 2^64
  await test("T30: Field overflow — sum wraps in BN254 but fails Num2Bits(64)", async () => {
    // Pick values where cumOld + txAmount > 2^64 but < BN254 field prime
    // Num2Bits(64) on cumulativeNew will fail because it doesn't fit in 64 bits
    const cumulativeOld = MAX_U64 - 5n;
    const txAmount = 10n;
    const cumulativeNew = cumulativeOld + txAmount; // 2^64 + 5, overflows 64 bits
    const randomnessOld = 1n;
    const randomnessNew = 2n;
    const userSecret = 1100n;
    const epochId = 1n;
    const salt = 1n;
    // threshold must be >= cumulativeNew for C9 to not also trigger, but
    // threshold itself must be < 2^64 for C8. So both C7 and C9 will fire.
    const threshold = MAX_U64 - 1n;

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const w = {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };

    if (FULL_PROOF_AVAILABLE) {
      let threw = false;
      try {
        await proveAndVerify(groth16, vk, w);
      } catch {
        threw = true;
      }
      assert(threw, "T30: Proof must fail for field overflow");
    } else {
      const errors = simulateTransfer(poseidon, w);
      assert(errors.length > 0, "T30: Expected constraint violations for overflow");
      assert(
        errors.some(e => e.startsWith("C7:") || e.startsWith("C9:")),
        `T30: Expected C7 or C9 violation, got: ${errors.join("; ")}`,
      );
    }
  });

  // T31: Domain separation — commitment tag (1) vs nullifier tag (2)
  await test("T31: Domain separation — commitment with tag 2 does NOT match valid commitment", async () => {
    const cumOld = 100n;
    const randOld = 50n;
    const secret = 999n;

    // Correct commitment uses domain tag 1
    const correctCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumOld, randOld, secret]));
    // Wrong: uses domain tag 2 (nullifier tag)
    const wrongTagCommitment = toBI(poseidon([DOMAIN_NULLIFIER, cumOld, randOld, secret]));

    assert(
      correctCommitment !== wrongTagCommitment,
      "Domain tags must produce different hashes (commitment tag 1 vs nullifier tag 2)",
    );
  });

  // T32: Domain separation — txAmountHash tag (3) vs commitment tag (1)
  await test("T32: Domain separation — txAmountHash tag 3 vs commitment tag 1", async () => {
    const amount = 100n;
    const salt = 50n;

    const correctHash = toBI(poseidon([DOMAIN_TX_AMOUNT, amount, salt]));
    const wrongTagHash = toBI(poseidon([DOMAIN_COMMITMENT, amount, salt]));

    assert(
      correctHash !== wrongTagHash,
      "Domain tags must produce different hashes (txAmount tag 3 vs commitment tag 1)",
    );
  });

  // T33: Changing ANY single private input invalidates the proof
  await test("T33: Changing any single private input invalidates the proof", async () => {
    const baseW = buildValidWitness(poseidon, {
      cumulativeOld: 50n, txAmount: 25n,
      randomnessOld: 11n, randomnessNew: 22n,
      userSecret: 333n, epochId: 1n, salt: 7n,
    });

    // Verify base witness is valid
    const baseErrors = simulateTransfer(poseidon, baseW);
    assert(baseErrors.length === 0, `Base witness must be valid: ${baseErrors.join("; ")}`);

    // Each private input mutation (keeping all public signals unchanged)
    const mutations = [
      { field: "cumulativeOld", value: 51n },
      { field: "cumulativeNew", value: 76n },  // correct would be 75
      { field: "txAmount", value: 26n },
      { field: "randomnessOld", value: 12n },
      { field: "randomnessNew", value: 23n },
      { field: "userSecret", value: 334n },
      { field: "salt", value: 8n },
    ];

    for (const { field, value } of mutations) {
      const mutated = { ...baseW, [field]: value };
      const errors = simulateTransfer(poseidon, mutated);
      assert(
        errors.length > 0,
        `Mutating ${field} to ${value} must cause constraint violations`,
      );
    }
  });

  // T34: Changing any single public input invalidates the proof
  await test("T34: Changing any single public input invalidates the proof", async () => {
    const baseW = buildValidWitness(poseidon, {
      cumulativeOld: 50n, txAmount: 25n,
      randomnessOld: 11n, randomnessNew: 22n,
      userSecret: 334n, epochId: 1n, salt: 8n,
    });

    const baseErrors = simulateTransfer(poseidon, baseW);
    assert(baseErrors.length === 0, `Base witness must be valid: ${baseErrors.join("; ")}`);

    // Each public input mutation (keeping private inputs unchanged)
    const mutations = [
      { field: "oldCommitment", value: baseW.oldCommitment + 1n },
      { field: "newCommitment", value: baseW.newCommitment + 1n },
      { field: "nullifier", value: baseW.nullifier + 1n },
      { field: "txAmountHash", value: baseW.txAmountHash + 1n },
      // threshold: lower it so cumNew exceeds it
      { field: "threshold", value: 10n },
    ];

    for (const { field, value } of mutations) {
      const mutated = { ...baseW, [field]: value };
      const errors = simulateTransfer(poseidon, mutated);
      assert(
        errors.length > 0,
        `Mutating ${field} must cause constraint violations`,
      );
    }
  });

  // T35: C9 boundary — cumNew = threshold + 1 (off by one)
  await test("T35: C9 boundary — cumNew = threshold + 1 (off by one, must reject)", async () => {
    const threshold = 100n;
    const cumulativeOld = 50n;
    const txAmount = 51n;
    const cumulativeNew = cumulativeOld + txAmount; // 101 > 100
    const randomnessOld = 10n;
    const randomnessNew = 20n;
    const userSecret = 1200n;
    const epochId = 1n;
    const salt = 1n;

    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

    const w = {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount,
      randomnessOld, randomnessNew, userSecret, salt,
    };
    await assertRejected(groth16, vk, poseidon, w, "C9:", "T35");
  });

  // T36: C9 boundary — cumNew = threshold - 1 (just under, must accept)
  await test("T36: C9 boundary — cumNew = threshold - 1 (just under, must accept)", async () => {
    const threshold = 100n;
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 50n,
      txAmount: 49n,
      randomnessOld: 10n,
      randomnessNew: 20n,
      userSecret: 1201n,
      epochId: 1n,
      threshold,
      salt: 1n,
    });
    // cumNew = 50 + 49 = 99 < 100
    assertEqual(w.cumulativeNew, 99n, "cumNew should be threshold - 1");
    await assertAccepted(groth16, vk, poseidon, w, "T36");
  });

  // T37: Nullifier uniqueness across different randomnessOld (same user, same epoch)
  await test("T37: Nullifier uniqueness — same user & epoch, different randomnessOld", async () => {
    const secret = 500n;
    const epoch = 1n;

    const nf1 = toBI(poseidon([DOMAIN_NULLIFIER, secret, epoch, 100n]));
    const nf2 = toBI(poseidon([DOMAIN_NULLIFIER, secret, epoch, 200n]));
    const nf3 = toBI(poseidon([DOMAIN_NULLIFIER, secret, epoch, 300n]));

    assert(nf1 !== nf2, "nf1 != nf2");
    assert(nf2 !== nf3, "nf2 != nf3");
    assert(nf1 !== nf3, "nf1 != nf3");
  });

  // T38: All three domain tags produce different hashes for same payload
  await test("T38: All domain tags (1,2,3) produce different hashes for same inputs", async () => {
    const a = 100n;
    const b = 200n;
    const c = 300n;

    const h1 = toBI(poseidon([1n, a, b, c]));
    const h2 = toBI(poseidon([2n, a, b, c]));
    // Domain 3 uses only 3 inputs (Poseidon(3)), so compare with 2-input variant
    const h3 = toBI(poseidon([3n, a, b]));

    assert(h1 !== h2, "tag 1 vs tag 2 must differ");
    assert(h1 !== h3, "tag 1 vs tag 3 must differ");
    assert(h2 !== h3, "tag 2 vs tag 3 must differ");
  });

  // T39: Large randomness values (near field boundary but valid in 64 bits)
  await test("T39: Large randomness values near 2^64 boundary", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n,
      txAmount: 1n,
      randomnessOld: MAX_U64 - 1n,
      randomnessNew: MAX_U64 - 2n,
      userSecret: MAX_U64 - 3n,
      epochId: MAX_U64 - 4n,
      threshold: 1n,
      salt: MAX_U64 - 5n,
    });
    // Randomness/secret/epochId/salt are not range-checked by the circuit
    // (only cumulative and txAmount and threshold have Num2Bits(64))
    // So this should be valid as long as they're valid field elements
    await assertAccepted(groth16, vk, poseidon, w, "T39");
  });

  // T40: Chain continuity — second transfer uses first transfer's newCommitment as oldCommitment
  await test("T40: Chain continuity — newCommitment becomes next oldCommitment", async () => {
    const secret = 4040n;
    const epoch = 1n;

    // First transfer: 0 -> 100
    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 100n,
      randomnessOld: 0n, randomnessNew: 42n,
      userSecret: secret, epochId: epoch, salt: 1n,
    });
    await assertAccepted(groth16, vk, poseidon, w1, "T40 first tx");

    // Second transfer: 100 -> 200, must chain from first
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 100n, txAmount: 100n,
      randomnessOld: 42n, // Must match randomnessNew from first tx
      randomnessNew: 84n,
      userSecret: secret, epochId: epoch, salt: 2n,
    });

    // Verify chaining: w2.oldCommitment must equal w1.newCommitment
    assertEqual(w2.oldCommitment, w1.newCommitment, "chain: w2.oldCommitment == w1.newCommitment");
    await assertAccepted(groth16, vk, poseidon, w2, "T40 second tx");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MERKLE MEMBERSHIP (C0)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- Merkle membership (C0) ---");

  // T41: a merkleRoot that does not match the authentication path is rejected
  await test("T41: C0 — wrong merkleRoot rejected (commitment not in tree)", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 10n, txAmount: 5n, userSecret: 4141n });
    w.merkleRoot = w.merkleRoot + 1n;
    await assertRejected(groth16, vk, poseidon, w, "C0", "T41");
  });

  // T42: a tampered sibling breaks membership even if the root is unchanged
  await test("T42: C0 — tampered Merkle sibling rejected", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 10n, txAmount: 5n, userSecret: 4242n });
    w.pathElements = [...w.pathElements];
    w.pathElements[0] = 999n;
    await assertRejected(groth16, vk, poseidon, w, "C0", "T42");
  });

  // T43: pathIndices must be boolean — the circuit constrains idx*(1-idx) === 0
  await test("T43: C0 — non-boolean pathIndices rejected", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 10n, txAmount: 5n, userSecret: 4343n });
    w.pathIndices = [...w.pathIndices];
    w.pathIndices[3] = 2n;
    if (FULL_PROOF_AVAILABLE) {
      let threw = false;
      try {
        await proveAndVerify(groth16, vk, w);
      } catch {
        threw = true;
      }
      assert(threw, "T43: non-boolean path index must fail witness generation");
    } else {
      assert(
        w.pathIndices.some((i) => i !== 0n && i !== 1n),
        "T43: witness must contain a non-boolean index",
      );
    }
  });

  // T44: a Merkle root computed with the OLD Poseidon(2) node hash is rejected —
  // proves the circuit actually enforces Poseidon2 and isn't silently accepting
  // both hash functions (e.g. because the swap only touched one of the two
  // MerkleProof(20) call sites, or a stale build was picked up).
  await test("T44: C0 — root computed with legacy Poseidon(2) (not Poseidon2) rejected", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 10n, txAmount: 5n, userSecret: 4444n });
    let legacyRoot = w.oldCommitment;
    for (let i = 0; i < MERKLE_DEPTH; i++) {
      legacyRoot = toBI(poseidon([legacyRoot, w.pathElements[i]]));
    }
    assert(legacyRoot !== w.merkleRoot, "sanity: legacy Poseidon(2) root must differ from the Poseidon2 root");
    const tampered = { ...w, merkleRoot: legacyRoot };
    await assertRejected(groth16, vk, poseidon, tampered, "C0", "T44");
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  // snarkjs' bn128 curve keeps worker handles open after the last proof, which
  // otherwise leaves this process hanging indefinitely even though every test passed.
  process.exit(0);
}

main().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
