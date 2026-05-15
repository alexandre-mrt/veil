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
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

  return {
    // Public inputs (6)
    oldCommitment,
    newCommitment,
    threshold,
    epochId,
    nullifier,
    txAmountHash,
    // Private inputs (7)
    cumulativeOld,
    cumulativeNew,
    txAmount,
    randomnessOld,
    randomnessNew,
    userSecret,
    salt,
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
    nullifier, txAmountHash,
    cumulativeOld, cumulativeNew, txAmount,
    randomnessOld, randomnessNew, userSecret, salt,
  } = inputs;

  const errors = [];

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
    stringInputs[k] = v.toString();
  }
  const { proof, publicSignals } = await groth16.fullProve(stringInputs, WASM_PATH, ZKEY_PATH);
  const valid = await groth16.verify(vk, publicSignals, proof);
  return { proof, publicSignals, valid };
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

  console.log("--- Valid inputs ---");

  // Test 1: Valid first-epoch transfer (genesis: cumOld=0, randOld=0, userSecret-bound)
  await test("T1: Valid first-epoch transfer (genesis commitment bound to userSecret)", async () => {
    const userSecret = 111n;
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n,
      txAmount: 100n,
      randomnessOld: 0n,  // genesis: randOld=0
      randomnessNew: 42n,
      userSecret,
      epochId: 1n,
      salt: 7n,
    });

    // Genesis check: oldCommitment = Poseidon(1, 0, 0, userSecret) — now user-specific
    const genesisCommitment = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, userSecret]));
    assertEqual(w.oldCommitment, genesisCommitment, "genesis oldCommitment");

    if (FULL_PROOF_AVAILABLE) {
      const { valid } = await proveAndVerify(groth16, vk, w);
      assert(valid, "Groth16 proof must verify");
    } else {
      const errors = simulateTransfer(poseidon, w);
      assert(errors.length === 0, `Constraint violations: ${errors.join("; ")}`);
    }
  });

  // Test 2: Valid subsequent transfer (cumOld=100, txAmount=50)
  await test("T2: Valid subsequent transfer (cumOld=100, txAmount=50)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n,
      txAmount: 50n,
      randomnessOld: 55n,
      randomnessNew: 66n,
      userSecret: 222n,
      epochId: 1n,
      salt: 13n,
    });

    if (FULL_PROOF_AVAILABLE) {
      const { valid } = await proveAndVerify(groth16, vk, w);
      assert(valid, "Groth16 proof must verify");
    } else {
      const errors = simulateTransfer(poseidon, w);
      assert(errors.length === 0, `Constraint violations: ${errors.join("; ")}`);
    }
  });

  // Test 3: Chain of 3 transfers (output commitment becomes next input)
  await test("T3: Chain of 3 transfers", async () => {
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

      if (FULL_PROOF_AVAILABLE) {
        const { valid } = await proveAndVerify(groth16, vk, w);
        assert(valid, `Transfer ${i + 1}: Groth16 proof must verify`);
      } else {
        const errors = simulateTransfer(poseidon, w);
        assert(errors.length === 0, `Transfer ${i + 1}: ${errors.join("; ")}`);
      }

      // State transition: next tx starts where this one ended
      cumulative = cumulative + txAmount;
      randomness = nextRandomness;
    }

    assertEqual(cumulative, 60n, "final cumulative after 3 transfers");
  });

  console.log("\n--- Invalid inputs (must be rejected) ---");

  // Test 4: FAIL — wrong old commitment (bad randomness)
  await test("T4: FAIL: wrong old commitment (tampered randomness)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n,
      txAmount: 50n,
      randomnessOld: 55n,
      randomnessNew: 66n,
      userSecret: 444n,
      epochId: 1n,
      salt: 9n,
    });

    // Tamper: use wrong randomness for the old commitment (off by one)
    const tampered = { ...w, randomnessOld: 56n };

    if (FULL_PROOF_AVAILABLE) {
      let threw = false;
      try {
        await proveAndVerify(groth16, vk, tampered);
      } catch {
        threw = true;
      }
      assert(threw, "Proof generation must fail with invalid witness");
    } else {
      const errors = simulateTransfer(poseidon, tampered);
      assert(errors.length > 0, "Expected constraint violations for bad randomness");
      assert(
        errors.some(e => e.startsWith("C1:")),
        `Expected C1 violation, got: ${errors.join("; ")}`,
      );
    }
  });

  // Test 5: FAIL — txAmount = 0 (GreaterThan fails)
  await test("T5: FAIL: txAmount=0 (zero transfer rejected)", async () => {
    const cumulativeOld = 100n;
    const txAmount = 0n;
    const cumulativeNew = cumulativeOld; // C3 holds, but C4 fails
    const randomnessOld = 55n;
    const randomnessNew = 66n;
    const userSecret = 555n;
    const epochId = 1n;
    const salt = 17n;

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

    if (FULL_PROOF_AVAILABLE) {
      let threw = false;
      try {
        await proveAndVerify(groth16, vk, tampered);
      } catch {
        threw = true;
      }
      assert(threw, "Proof generation must fail for txAmount=0");
    } else {
      const errors = simulateTransfer(poseidon, tampered);
      assert(errors.length > 0, "Expected constraint violation for txAmount=0");
      assert(
        errors.some(e => e.startsWith("C4:")),
        `Expected C4 violation, got: ${errors.join("; ")}`,
      );
    }
  });

  // Test 6: FAIL — cumulativeNew overflow (exceeds 2^64)
  await test("T6: FAIL: cumulativeNew overflow (> 2^64)", async () => {
    const cumulativeOld = MAX_U64 - 10n;
    const txAmount = 100n;
    const cumulativeNew = cumulativeOld + txAmount; // > 2^64, fails Num2Bits(64)

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

    if (FULL_PROOF_AVAILABLE) {
      let threw = false;
      try {
        await proveAndVerify(groth16, vk, tampered);
      } catch {
        threw = true;
      }
      assert(threw, "Proof generation must fail for u64 overflow");
    } else {
      const errors = simulateTransfer(poseidon, tampered);
      assert(errors.length > 0, "Expected constraint violation for overflow");
      assert(
        errors.some(e => e.startsWith("C5:") || e.startsWith("C7:")),
        `Expected C5 or C7 violation, got: ${errors.join("; ")}`,
      );
    }
  });

  // Test 7: FAIL — wrong nullifier (bad user secret)
  await test("T7: FAIL: wrong nullifier (mismatched userSecret)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 50n,
      txAmount: 25n,
      randomnessOld: 11n,
      randomnessNew: 22n,
      userSecret: 777n,
      epochId: 3n,
      salt: 33n,
    });

    // Tamper: use a different secret to compute a wrong nullifier
    const wrongNullifier = toBI(poseidon([DOMAIN_NULLIFIER, 999999n, w.epochId, w.randomnessOld]));
    const tampered = { ...w, nullifier: wrongNullifier };

    if (FULL_PROOF_AVAILABLE) {
      let threw = false;
      try {
        await proveAndVerify(groth16, vk, tampered);
      } catch {
        threw = true;
      }
      assert(threw, "Proof generation must fail for wrong nullifier");
    } else {
      const errors = simulateTransfer(poseidon, tampered);
      assert(errors.length > 0, "Expected constraint violation for wrong nullifier");
      assert(
        errors.some(e => e.startsWith("C10:")),
        `Expected C10 violation, got: ${errors.join("; ")}`,
      );
    }
  });

  // ── Additional edge cases ──────────────────────────────────────────────────
  console.log("\n--- Edge cases ---");

  // Test 8: Genesis commitment is user-specific (different users → different genesis)
  await test("T8: Genesis commitment is user-specific (bound to userSecret)", async () => {
    const secret1 = 1n;
    const secret2 = 2n;

    // Genesis for each user: Poseidon(1, 0, 0, userSecret)
    const genesis1 = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, secret1]));
    const genesis2 = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, secret2]));

    assert(genesis1 > 0n, "Genesis commitment must be a non-zero field element");
    assert(genesis1 !== genesis2, "Different userSecrets must produce different genesis commitments");

    // Build witnesses for both users — verify both are valid
    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 1n, randomnessNew: 1n,
      userSecret: secret1, salt: 1n,
    });
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 1n, randomnessNew: 2n,
      userSecret: secret2, salt: 2n,
    });

    // Genesis commitments are now different (bound to userSecret)
    assert(w1.oldCommitment !== w2.oldCommitment, "Different users must have different genesis commitments");
    assert(w1.newCommitment !== w2.newCommitment, "Different randomness + secret → different new commitments");
    assert(w1.nullifier !== w2.nullifier, "Different secrets → different nullifiers");

    // Both must pass simulation
    const errors1 = simulateTransfer(poseidon, w1);
    const errors2 = simulateTransfer(poseidon, w2);
    assert(errors1.length === 0, `User 1 violations: ${errors1.join("; ")}`);
    assert(errors2.length === 0, `User 2 violations: ${errors2.join("; ")}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
