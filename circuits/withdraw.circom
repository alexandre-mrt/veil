// Note: withdrawals reveal which commitment is consumed (via dynamic field removal
// on-chain). The Merkle accumulator provides anonymity for transfers but not
// withdrawals. This is an inherent design choice — the exit path is identifiable.

pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";

// Withdrawal circuit for Veil privacy protocol.
//
// Proves ownership of a commitment and authorizes withdrawal of funds.
// Partial withdrawal: creates a change commitment for the remaining balance.
// Users can exit the pool without admin involvement (fixes PRIV-011).
//
// Public inputs (5):
//   commitment, withdrawAmount, nullifier, recipientHash, newCommitment
//
// Domain separation tags (first Poseidon input):
//   1 -> commitment hash   H(1, cumulative, randomness, userSecret)  (shared with transfer.circom)
//   7 -> withdrawal nullifier  H(7, userSecret, randomnessOld, cumulativeOld)
//   8 -> recipient binding     H(8, recipient)
//
// Tags 1-6 are reserved by transfer.circom (1-3) and compliance.circom (4-6).
//
// Constraints (10):
//   C1  commitment well-formed       (Poseidon(4) identity-bound)
//   C2  withdrawAmount range proof   (64-bit, prevents field overflow)
//   C3  withdrawAmount > 0           (no zero withdrawals)
//   C4  cumulativeOld range proof    (64-bit, prevents field overflow)
//   C5  withdrawAmount <= cumulativeOld (can only withdraw deposited amount)
//   C6  change commitment            (Poseidon(4) with domain tag 1, remaining balance)
//   C7  remaining balance range proof (64-bit, prevents field overflow)
//   C8  nullifier correctly derived  (domain tag 7, unique per commitment)
//   C9  recipient hash binding       (domain tag 8, ties withdrawal to address)
//
// Curve: BN254 (Groth16, Sui curve id 1)
// Compiled with circom 2.1.x, proven with snarkjs 0.7.x

template Withdraw() {
    // --- PUBLIC INPUTS (5 total -- order matters for Sui on-chain verification) ---
    signal input commitment;      // Poseidon(1, cumulativeOld, randomnessOld, userSecret)
    signal input withdrawAmount;  // Amount to withdraw (public for token transfer)
    signal input nullifier;       // Poseidon(7, userSecret, randomnessOld, cumulativeOld)
    signal input recipientHash;   // Poseidon(8, recipient) -- binds withdrawal to address
    signal input newCommitment;   // Change commitment for remaining balance

    // --- PRIVATE INPUTS (5) ---
    signal input cumulativeOld;   // Current cumulative value in commitment
    signal input randomnessOld;   // Blinding factor for commitment
    signal input userSecret;      // User's master secret (proves ownership)
    signal input recipient;       // Sui address as field element
    signal input randomnessNew;   // Blinding factor for change commitment

    // --- C1: Commitment is well-formed ---
    // Uses same structure as transfer.circom (domain tag 1, Poseidon(4))
    // CRYPTO-004: commitment bound to userSecret
    component commHash = Poseidon(4);
    commHash.inputs[0] <== 1;
    commHash.inputs[1] <== cumulativeOld;
    commHash.inputs[2] <== randomnessOld;
    commHash.inputs[3] <== userSecret;
    commitment === commHash.out;

    // --- C2: withdrawAmount fits in 64 bits (range proof) ---
    component amountBits = Num2Bits(64);
    amountBits.in <== withdrawAmount;

    // --- C3: withdrawAmount > 0 ---
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== withdrawAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // --- C4: cumulativeOld fits in 64 bits (range proof) ---
    component cumBits = Num2Bits(64);
    cumBits.in <== cumulativeOld;

    // --- C5: withdrawAmount <= cumulativeOld (can only withdraw up to deposited amount) ---
    component amountCheck = LessEqThan(64);
    amountCheck.in[0] <== withdrawAmount;
    amountCheck.in[1] <== cumulativeOld;
    amountCheck.out === 1;

    // --- C6: Change commitment for remaining balance ---
    // remainingBalance = cumulativeOld - withdrawAmount (safe: C5 ensures >= 0)
    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    component changeHash = Poseidon(4);
    changeHash.inputs[0] <== 1;  // domain tag 1 = commitment (same as transfer)
    changeHash.inputs[1] <== remainingBalance;
    changeHash.inputs[2] <== randomnessNew;
    changeHash.inputs[3] <== userSecret;
    newCommitment === changeHash.out;

    // --- C7: Remaining balance range proof (64-bit) ---
    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    // --- C8: Nullifier is correctly derived (domain tag 7) ---

    // Unique per commitment (randomnessOld + cumulativeOld make it unique)
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 7;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== randomnessOld;
    nfHash.inputs[3] <== cumulativeOld;
    nullifier === nfHash.out;

    // --- C9: Recipient hash binds the withdrawal to a specific address ---
    // Prevents front-running: attacker cannot redirect withdrawal to another address
    component recipHash = Poseidon(2);
    recipHash.inputs[0] <== 8;
    recipHash.inputs[1] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = Withdraw();
