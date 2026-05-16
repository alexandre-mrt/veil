pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";

// Withdrawal circuit for Veil privacy protocol.
//
// Proves ownership of a commitment and authorizes withdrawal of funds.
// Users can exit the pool without admin involvement (fixes PRIV-011).
//
// Public inputs (4):
//   commitment, withdrawAmount, nullifier, recipientHash
//
// Domain separation tags (first Poseidon input):
//   1 -> commitment hash   H(1, cumulative, randomness, userSecret)  (shared with transfer.circom)
//   7 -> withdrawal nullifier  H(7, userSecret, randomnessOld, cumulativeOld)
//   8 -> recipient binding     H(8, recipient)
//
// Tags 1-6 are reserved by transfer.circom (1-3) and compliance.circom (4-6).
//
// Constraints (7):
//   C1  commitment well-formed       (Poseidon(4) identity-bound)
//   C2  withdrawAmount range proof   (64-bit, prevents field overflow)
//   C3  withdrawAmount > 0           (no zero withdrawals)
//   C4  cumulativeOld range proof    (64-bit, prevents field overflow)
//   C5  nullifier correctly derived  (domain tag 7, unique per commitment)
//   C6  recipient hash binding       (domain tag 8, ties withdrawal to address)
//
// Curve: BN254 (Groth16, Sui curve id 1)
// Compiled with circom 2.1.x, proven with snarkjs 0.7.x

template Withdraw() {
    // --- PUBLIC INPUTS (4 total -- order matters for Sui on-chain verification) ---
    signal input commitment;      // Poseidon(1, cumulativeOld, randomnessOld, userSecret)
    signal input withdrawAmount;  // Amount to withdraw (public for token transfer)
    signal input nullifier;       // Poseidon(7, userSecret, randomnessOld, cumulativeOld)
    signal input recipientHash;   // Poseidon(8, recipient) -- binds withdrawal to address

    // --- PRIVATE INPUTS (4) ---
    signal input cumulativeOld;   // Current cumulative value in commitment
    signal input randomnessOld;   // Blinding factor for commitment
    signal input userSecret;      // User's master secret (proves ownership)
    signal input recipient;       // Sui address as field element

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

    // --- C5: Nullifier is correctly derived (domain tag 7) ---
    // Unique per commitment (randomnessOld + cumulativeOld make it unique)
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 7;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== randomnessOld;
    nfHash.inputs[3] <== cumulativeOld;
    nullifier === nfHash.out;

    // --- C6: Recipient hash binds the withdrawal to a specific address ---
    // Prevents front-running: attacker cannot redirect withdrawal to another address
    component recipHash = Poseidon(2);
    recipHash.inputs[0] <== 8;
    recipHash.inputs[1] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash]} = Withdraw();
