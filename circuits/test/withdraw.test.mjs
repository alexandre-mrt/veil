/**
 * withdraw.test.mjs -- Veil Withdraw Circuit Tests
 *
 * Tests circuit constraints using two modes:
 *   1. Full proof mode (requires compiled WASM + zkey): uses snarkjs fullProve + verify
 *   2. Hash-only mode (fallback when circom not compiled): validates Poseidon arithmetic
 *      that the circuit would enforce, catching logic errors before compilation
 *
 * Withdraw circuit (withdraw.circom) constraints:
 *   C1  commitment well-formed       Poseidon(4) with domain tag 1 (shared with transfer.circom)
 *   C2  withdrawAmount range proof   Num2Bits(64)
 *   C3  withdrawAmount > 0           GreaterThan(64)
 *   C4  cumulativeOld range proof    Num2Bits(64)
 *   C5  withdrawAmount <= cumulativeOld  LessEqThan(64)
 *   C6  nullifier derivation         Poseidon(4) with domain tag 7
 *   C7  recipient hash binding       Poseidon(2) with domain tag 8
 *
 * Run: node --experimental-vm-modules test/withdraw.test.mjs
 *
 * NOTE: Withdraw circuit artifacts must be compiled first:
 *   bash scripts/compile-withdraw.sh
 * Without artifacts, tests run in hash-only simulation mode.
 */

import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// withdraw compile script outputs to build-withdraw/, but check build/ as fallback
const BUILD_DIR_PRIMARY = join(__dirname, "..", "build-withdraw");
const BUILD_DIR_FALLBACK = join(__dirname, "..", "build");

function findArtifact(name) {
  const primary = join(BUILD_DIR_PRIMARY, name);
  if (existsSync(primary)) return primary;
  return join(BUILD_DIR_FALLBACK, name);
}

const WASM_PATH = findArtifact(join("withdraw_js", "withdraw.wasm"));
const ZKEY_PATH = findArtifact("withdraw_final.zkey");
const VK_PATH = findArtifact("withdraw_vk.json");

// -- Constants ----------------------------------------------------------------

const MAX_U64 = 2n ** 64n;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;

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
 * Build all signal values for a valid Withdraw witness.
 */
function buildValidWitness(poseidon, {
  cumulativeOld = 500n,
  randomnessOld = 12345n,
  userSecret = 987654321n,
  withdrawAmount = 100n,
  recipient = 0xABCDEF123456n,
} = {}) {
  // C1: commitment = Poseidon(1, cumulativeOld, randomnessOld, userSecret)
  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));

  // C6: nullifier = Poseidon(7, userSecret, randomnessOld, cumulativeOld)
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));

  // C7: recipientHash = Poseidon(8, recipient)
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

  return {
    // Public inputs (4)
    commitment,
    withdrawAmount,
    nullifier,
    recipientHash,
    // Private inputs (4)
    cumulativeOld,
    randomnessOld,
    userSecret,
    recipient,
  };
}

// -- Test runner --------------------------------------------------------------

let passed = 0;
let failed = 0;
const FULL_PROOF_AVAILABLE = existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

console.log("=== Veil Withdraw Circuit Tests ===");
console.log(`Mode: ${FULL_PROOF_AVAILABLE ? "FULL PROOF (snarkjs Groth16)" : "HASH-ONLY (constraint simulation)"}`);
if (!FULL_PROOF_AVAILABLE) {
  console.log("  (Run 'bash scripts/compile-withdraw.sh' to enable full Groth16 proof tests)");
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

function simulateWithdraw(poseidon, inputs) {
  const {
    commitment, withdrawAmount, nullifier, recipientHash,
    cumulativeOld, randomnessOld, userSecret, recipient,
  } = inputs;

  const errors = [];

  // C1: commitment = Poseidon(1, cumulativeOld, randomnessOld, userSecret)
  const expectedCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  if (commitment !== expectedCommitment) {
    errors.push(`C1: commitment mismatch (expected ${expectedCommitment}, got ${commitment})`);
  }

  // C2: withdrawAmount in [0, 2^64)
  if (withdrawAmount < 0n || withdrawAmount >= MAX_U64) {
    errors.push(`C2: withdrawAmount out of [0, 2^64): ${withdrawAmount}`);
  }

  // C3: withdrawAmount > 0
  if (withdrawAmount <= 0n) {
    errors.push(`C3: withdrawAmount must be > 0, got ${withdrawAmount}`);
  }

  // C4: cumulativeOld in [0, 2^64)
  if (cumulativeOld < 0n || cumulativeOld >= MAX_U64) {
    errors.push(`C4: cumulativeOld out of [0, 2^64): ${cumulativeOld}`);
  }

  // C5: withdrawAmount <= cumulativeOld
  if (withdrawAmount > cumulativeOld) {
    errors.push(`C5: withdrawAmount (${withdrawAmount}) > cumulativeOld (${cumulativeOld})`);
  }

  // C6: nullifier = Poseidon(7, userSecret, randomnessOld, cumulativeOld)
  const expectedNullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  if (nullifier !== expectedNullifier) {
    errors.push(`C6: nullifier mismatch (expected ${expectedNullifier}, got ${nullifier})`);
  }

  // C7: recipientHash = Poseidon(8, recipient)
  const expectedRecipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));
  if (recipientHash !== expectedRecipientHash) {
    errors.push(`C7: recipientHash mismatch (expected ${expectedRecipientHash}, got ${recipientHash})`);
  }

  return errors;
}

// -- Full proof helpers -------------------------------------------------------

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
    const errors = simulateWithdraw(poseidon, witness);
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
    const errors = simulateWithdraw(poseidon, witness);
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

  // W1: Valid commitment ownership proof
  await test("W1: Valid withdrawal -- commitment ownership proof", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 111n,
      withdrawAmount: 100n,
      recipient: 0xDEADBEEFn,
    });
    await assertAccepted(groth16, vk, poseidon, w, "W1");
  });

  // W2: Withdraw entire balance (withdrawAmount == cumulativeOld)
  await test("W2: Withdraw entire balance (withdrawAmount == cumulativeOld)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 1000n,
      randomnessOld: 99n,
      userSecret: 222n,
      withdrawAmount: 1000n,
      recipient: 0xCAFEn,
    });
    assertEqual(w.withdrawAmount, 1000n, "withdrawAmount");
    await assertAccepted(groth16, vk, poseidon, w, "W2");
  });

  // W3: Withdraw minimum amount (1)
  await test("W3: Minimum withdrawal (withdrawAmount=1)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 1n,
      randomnessOld: 1n,
      userSecret: 333n,
      withdrawAmount: 1n,
      recipient: 1n,
    });
    await assertAccepted(groth16, vk, poseidon, w, "W3");
  });

  // W4: Large values near 2^64 boundary (valid)
  await test("W4: Large values near 2^64 boundary", async () => {
    const cumOld = MAX_U64 - 1n;
    const w = buildValidWitness(poseidon, {
      cumulativeOld: cumOld,
      randomnessOld: 1000n,
      userSecret: 444n,
      withdrawAmount: cumOld,
      recipient: MAX_U64 - 1n,
    });
    await assertAccepted(groth16, vk, poseidon, w, "W4");
  });

  // W5: Partial withdrawal
  await test("W5: Partial withdrawal (withdrawAmount < cumulativeOld)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 1000n,
      randomnessOld: 55n,
      userSecret: 555n,
      withdrawAmount: 250n,
      recipient: 0xBEEFn,
    });
    await assertAccepted(groth16, vk, poseidon, w, "W5");
  });

  // ===========================================================================
  // CONSTRAINT VIOLATIONS
  // ===========================================================================
  console.log("\n--- Constraint violations (must be rejected) ---");

  // W6: C5 -- withdrawAmount > cumulativeOld
  await test("W6: C5 -- withdrawAmount > cumulativeOld (overdraw)", async () => {
    const cumulativeOld = 100n;
    const withdrawAmount = 200n;
    const randomnessOld = 10n;
    const userSecret = 666n;
    const recipient = 0xABCn;

    const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
    const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

    const w = {
      commitment, withdrawAmount, nullifier, recipientHash,
      cumulativeOld, randomnessOld, userSecret, recipient,
    };
    await assertRejected(groth16, vk, poseidon, w, "C5:", "W6");
  });

  // W7: C3 -- withdrawAmount = 0
  await test("W7: C3 -- withdrawAmount=0 (zero withdrawal rejected)", async () => {
    const cumulativeOld = 500n;
    const withdrawAmount = 0n;
    const randomnessOld = 20n;
    const userSecret = 777n;
    const recipient = 0xDEFn;

    const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
    const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

    const w = {
      commitment, withdrawAmount, nullifier, recipientHash,
      cumulativeOld, randomnessOld, userSecret, recipient,
    };
    await assertRejected(groth16, vk, poseidon, w, "C3:", "W7");
  });

  // W8: C1 -- wrong userSecret => commitment mismatch
  await test("W8: C1 -- wrong userSecret => commitment mismatch", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 888n,
      withdrawAmount: 100n,
      recipient: 0xFACEn,
    });
    // Change userSecret but keep original commitment (computed with 888)
    const tampered = { ...w, userSecret: 999n };
    await assertRejected(groth16, vk, poseidon, tampered, "C1:", "W8");
  });

  // W9: C1 -- wrong randomnessOld => commitment mismatch
  await test("W9: C1 -- wrong randomnessOld => commitment mismatch", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 999n,
      withdrawAmount: 100n,
      recipient: 0xBBAn,
    });
    const tampered = { ...w, randomnessOld: 43n };
    await assertRejected(groth16, vk, poseidon, tampered, "C1:", "W9");
  });

  // W10: C1 -- wrong cumulativeOld => commitment mismatch
  await test("W10: C1 -- wrong cumulativeOld => commitment mismatch", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 1010n,
      withdrawAmount: 100n,
      recipient: 0xCCCn,
    });
    const tampered = { ...w, cumulativeOld: 501n };
    await assertRejected(groth16, vk, poseidon, tampered, "C1:", "W10");
  });

  // W11: C6 -- wrong nullifier (tampered userSecret)
  await test("W11: C6 -- wrong nullifier (nullifier computed with wrong secret)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 1111n,
      withdrawAmount: 100n,
      recipient: 0xDDDn,
    });
    const wrongNullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, 9999n, w.randomnessOld, w.cumulativeOld]));
    const tampered = { ...w, nullifier: wrongNullifier };
    await assertRejected(groth16, vk, poseidon, tampered, "C6:", "W11");
  });

  // W12: C7 -- wrong recipientHash
  await test("W12: C7 -- wrong recipientHash (wrong recipient address)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 1212n,
      withdrawAmount: 100n,
      recipient: 0xEEEn,
    });
    const wrongRecipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, 0xFFFn]));
    const tampered = { ...w, recipientHash: wrongRecipientHash };
    await assertRejected(groth16, vk, poseidon, tampered, "C7:", "W12");
  });

  // ===========================================================================
  // NULLIFIER DERIVATION
  // ===========================================================================
  console.log("\n--- Nullifier derivation (domain tag 7) ---");

  // W13: Nullifier uses domain tag 7
  await test("W13: Nullifier correctly uses domain tag 7", async () => {
    const userSecret = 1313n;
    const randomnessOld = 42n;
    const cumulativeOld = 500n;

    const expected = toBI(poseidon([7n, userSecret, randomnessOld, cumulativeOld]));
    const w = buildValidWitness(poseidon, { cumulativeOld, randomnessOld, userSecret, withdrawAmount: 100n });

    assertEqual(w.nullifier, expected, "nullifier derivation");
  });

  // W14: Different commitments produce different nullifiers
  await test("W14: Different commitments produce different withdrawal nullifiers", async () => {
    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 500n, randomnessOld: 42n, userSecret: 100n,
      withdrawAmount: 50n, recipient: 1n,
    });
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 500n, randomnessOld: 43n, userSecret: 100n,
      withdrawAmount: 50n, recipient: 1n,
    });
    assert(w1.nullifier !== w2.nullifier, "Different randomnessOld must produce different nullifiers");
  });

  // W15: Same randomnessOld but different cumulativeOld => different nullifiers
  await test("W15: Different cumulativeOld => different withdrawal nullifiers", async () => {
    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 500n, randomnessOld: 42n, userSecret: 100n,
      withdrawAmount: 100n, recipient: 1n,
    });
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 600n, randomnessOld: 42n, userSecret: 100n,
      withdrawAmount: 100n, recipient: 1n,
    });
    assert(w1.nullifier !== w2.nullifier, "Different cumulativeOld must produce different nullifiers");
  });

  // W16: Same user, same commitment state => same nullifier (deterministic)
  await test("W16: Same inputs produce deterministic nullifier", async () => {
    const params = {
      cumulativeOld: 500n, randomnessOld: 42n, userSecret: 1616n,
      withdrawAmount: 100n, recipient: 0xABCn,
    };
    const w1 = buildValidWitness(poseidon, params);
    const w2 = buildValidWitness(poseidon, params);
    assertEqual(w1.nullifier, w2.nullifier, "deterministic nullifier");
  });

  // ===========================================================================
  // RECIPIENT HASH BINDING
  // ===========================================================================
  console.log("\n--- Recipient hash binding (domain tag 8) ---");

  // W17: recipientHash uses domain tag 8
  await test("W17: recipientHash correctly uses domain tag 8", async () => {
    const recipient = 0xDEADBEEFCAFEn;
    const expected = toBI(poseidon([8n, recipient]));
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n, randomnessOld: 42n, userSecret: 1717n,
      withdrawAmount: 100n, recipient,
    });
    assertEqual(w.recipientHash, expected, "recipientHash derivation");
  });

  // W18: Different recipients produce different hashes
  await test("W18: Different recipients produce different hashes", async () => {
    const w1 = buildValidWitness(poseidon, {
      cumulativeOld: 500n, randomnessOld: 42n, userSecret: 1818n,
      withdrawAmount: 100n, recipient: 0xAAn,
    });
    const w2 = buildValidWitness(poseidon, {
      cumulativeOld: 500n, randomnessOld: 42n, userSecret: 1818n,
      withdrawAmount: 100n, recipient: 0xBBn,
    });
    assert(w1.recipientHash !== w2.recipientHash, "Different recipients must produce different hashes");
  });

  // W19: Recipient cannot be swapped (front-run protection)
  await test("W19: Swapping recipient in witness but keeping recipientHash fails C7", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n, randomnessOld: 42n, userSecret: 1919n,
      withdrawAmount: 100n, recipient: 0xA11CEn,
    });
    // Attacker tries to redirect to their address
    const tampered = { ...w, recipient: 0xA77AC8E2n };
    await assertRejected(groth16, vk, poseidon, tampered, "C7:", "W19");
  });

  // ===========================================================================
  // DOMAIN SEPARATION
  // ===========================================================================
  console.log("\n--- Domain separation ---");

  // W20: Domain tag 7 (withdraw nullifier) vs tag 2 (transfer nullifier) differ
  await test("W20: Withdraw nullifier (tag 7) differs from transfer nullifier (tag 2)", async () => {
    const a = 100n;
    const b = 200n;
    const c = 300n;

    const withdrawNf = toBI(poseidon([7n, a, b, c]));
    const transferNf = toBI(poseidon([2n, a, b, c]));

    assert(withdrawNf !== transferNf, "Domain tag 7 vs 2 must produce different hashes");
  });

  // W21: Domain tag 8 (recipient) vs tag 1 (commitment) differ
  await test("W21: Recipient hash (tag 8) differs from commitment (tag 1)", async () => {
    const a = 100n;

    const recipHash = toBI(poseidon([8n, a]));
    const commHash = toBI(poseidon([1n, a]));

    assert(recipHash !== commHash, "Domain tag 8 vs 1 must produce different hashes");
  });

  // W22: All 8 domain tags produce different hashes
  await test("W22: All 8 domain tags (1-8) produce pairwise different hashes", async () => {
    const a = 42n;

    const hashes = [];
    for (let tag = 1n; tag <= 8n; tag++) {
      hashes.push(toBI(poseidon([tag, a])));
    }

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

  // W23: C2 -- withdrawAmount >= 2^64
  await test("W23: C2 -- withdrawAmount >= 2^64 (range overflow)", async () => {
    const cumulativeOld = MAX_U64;
    const withdrawAmount = MAX_U64;
    const randomnessOld = 10n;
    const userSecret = 2323n;
    const recipient = 1n;

    const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
    const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

    const w = {
      commitment, withdrawAmount, nullifier, recipientHash,
      cumulativeOld, randomnessOld, userSecret, recipient,
    };
    await assertRejected(groth16, vk, poseidon, w, "C2:", "W23");
  });

  // W24: C4 -- cumulativeOld >= 2^64
  await test("W24: C4 -- cumulativeOld >= 2^64 (range overflow)", async () => {
    const cumulativeOld = MAX_U64;
    const withdrawAmount = 1n;
    const randomnessOld = 10n;
    const userSecret = 2424n;
    const recipient = 1n;

    const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
    const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

    const w = {
      commitment, withdrawAmount, nullifier, recipientHash,
      cumulativeOld, randomnessOld, userSecret, recipient,
    };
    await assertRejected(groth16, vk, poseidon, w, "C4:", "W24");
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================
  console.log("\n--- Edge cases ---");

  // W25: C5 boundary -- withdrawAmount = cumulativeOld (exact balance)
  await test("W25: C5 boundary -- withdrawAmount == cumulativeOld (exact, accepted)", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 100n,
      randomnessOld: 42n,
      userSecret: 2525n,
      withdrawAmount: 100n,
      recipient: 1n,
    });
    assertEqual(w.withdrawAmount, w.cumulativeOld, "withdrawAmount should equal cumulativeOld");
    await assertAccepted(groth16, vk, poseidon, w, "W25");
  });

  // W26: C5 boundary -- withdrawAmount = cumulativeOld + 1 (off by one, rejected)
  await test("W26: C5 boundary -- withdrawAmount = cumulativeOld + 1 (off by one, rejected)", async () => {
    const cumulativeOld = 100n;
    const withdrawAmount = 101n;
    const randomnessOld = 42n;
    const userSecret = 2626n;
    const recipient = 1n;

    const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
    const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));

    const w = {
      commitment, withdrawAmount, nullifier, recipientHash,
      cumulativeOld, randomnessOld, userSecret, recipient,
    };
    await assertRejected(groth16, vk, poseidon, w, "C5:", "W26");
  });

  // W27: Commitment uses same domain tag as transfer circuit (tag 1)
  await test("W27: Withdraw commitment uses same Poseidon(4) structure as transfer", async () => {
    const cumulativeOld = 500n;
    const randomnessOld = 42n;
    const userSecret = 2727n;

    // The withdraw circuit commitment == transfer circuit commitment (same structure)
    const transferCommitment = toBI(poseidon([1n, cumulativeOld, randomnessOld, userSecret]));
    const w = buildValidWitness(poseidon, { cumulativeOld, randomnessOld, userSecret });
    assertEqual(w.commitment, transferCommitment, "commitment must match transfer circuit structure");
  });

  // W28: Changing any single private input invalidates
  await test("W28: Changing any single private input invalidates the proof", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 2828n,
      withdrawAmount: 100n,
      recipient: 0xABCn,
    });

    const baseErrors = simulateWithdraw(poseidon, w);
    assert(baseErrors.length === 0, `Base witness must be valid: ${baseErrors.join("; ")}`);

    const mutations = [
      { field: "cumulativeOld", value: 501n },
      { field: "randomnessOld", value: 43n },
      { field: "userSecret", value: 2829n },
      { field: "recipient", value: 0xDEFn },
    ];

    for (const { field, value } of mutations) {
      const mutated = { ...w, [field]: value };
      const errors = simulateWithdraw(poseidon, mutated);
      assert(
        errors.length > 0,
        `Mutating ${field} to ${value} must cause constraint violations`,
      );
    }
  });

  // W29: Deterministic proofs
  await test("W29: Deterministic -- same inputs produce consistent verification", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 2929n,
      withdrawAmount: 100n,
      recipient: 0xFACEn,
    });

    const errors1 = simulateWithdraw(poseidon, w);
    const errors2 = simulateWithdraw(poseidon, w);
    assertEqual(errors1.length, 0, "first simulation");
    assertEqual(errors2.length, 0, "second simulation");
  });

  // W30: Changing any public input invalidates
  await test("W30: Changing any single public input invalidates the proof", async () => {
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n,
      randomnessOld: 42n,
      userSecret: 3030n,
      withdrawAmount: 100n,
      recipient: 0xBEEFn,
    });

    const baseErrors = simulateWithdraw(poseidon, w);
    assert(baseErrors.length === 0, `Base witness must be valid: ${baseErrors.join("; ")}`);

    const mutations = [
      { field: "commitment", value: w.commitment + 1n },
      { field: "nullifier", value: w.nullifier + 1n },
      { field: "recipientHash", value: w.recipientHash + 1n },
    ];

    for (const { field, value } of mutations) {
      const mutated = { ...w, [field]: value };
      const errors = simulateWithdraw(poseidon, mutated);
      assert(
        errors.length > 0,
        `Mutating ${field} must cause constraint violations`,
      );
    }
  });

  // -- Summary ----------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
