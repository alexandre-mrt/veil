// Note: withdrawals reveal which commitment is consumed (via dynamic field removal
// on-chain). The Merkle accumulator provides anonymity for transfers but not
// withdrawals. This is an inherent design choice — the exit path is identifiable.
// (Copied from ../../withdraw.circom; unchanged by this experiment.)

pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../templates/poseidon2_hash.circom";

// EXPERIMENTAL variant of ../../withdraw.circom — see
// docs/research/2026-08-22-poseidon2-hash-swap.md. NOT wired into the pool
// (contracts/), NOT a drop-in replacement for withdraw.circom.
//
// Swapped to Poseidon2 (verified round constants exist at this width):
//   - C9: recipientHash, Poseidon(2)/t=3 -> Poseidon2Hash(2)
//
// Left UNCHANGED on the original Poseidon (no audited t=5 Poseidon2 BN254
// round constants were found in any reachable package this session — this is
// the majority of withdraw.circom's hash cost, see the report):
//   - C1: commitment, Poseidon(4)/t=5
//   - C6: change commitment, Poseidon(4)/t=5
//   - C8: nullifier, Poseidon(4)/t=5
template WithdrawPoseidon2() {
    // --- PUBLIC INPUTS (5 total -- order matters for Sui on-chain verification) ---
    signal input commitment;      // Poseidon(1, cumulativeOld, randomnessOld, userSecret)
    signal input withdrawAmount;  // Amount to withdraw (public for token transfer)
    signal input nullifier;       // Poseidon(7, userSecret, randomnessOld, cumulativeOld)
    signal input recipientHash;   // Poseidon2(8, recipient) -- binds withdrawal to address
    signal input newCommitment;   // Change commitment for remaining balance

    // --- PRIVATE INPUTS (5) ---
    signal input cumulativeOld;   // Current cumulative value in commitment
    signal input randomnessOld;   // Blinding factor for commitment
    signal input userSecret;      // User's master secret (proves ownership)
    signal input recipient;       // Sui address as field element
    signal input randomnessNew;   // Blinding factor for change commitment

    // --- C1: Commitment is well-formed (unchanged: Poseidon(4), t=5) ---
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

    // --- C5: withdrawAmount <= cumulativeOld ---
    component amountCheck = LessEqThan(64);
    amountCheck.in[0] <== withdrawAmount;
    amountCheck.in[1] <== cumulativeOld;
    amountCheck.out === 1;

    // --- C6: Change commitment for remaining balance (unchanged: Poseidon(4), t=5) ---
    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    component changeHash = Poseidon(4);
    changeHash.inputs[0] <== 1;
    changeHash.inputs[1] <== remainingBalance;
    changeHash.inputs[2] <== randomnessNew;
    changeHash.inputs[3] <== userSecret;
    newCommitment === changeHash.out;

    // --- C7: Remaining balance range proof (64-bit) ---
    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    // --- C8: Nullifier is correctly derived (unchanged: Poseidon(4), t=5) ---
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 7;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== randomnessOld;
    nfHash.inputs[3] <== cumulativeOld;
    nullifier === nfHash.out;

    // --- C9: Recipient hash (Poseidon2Hash(2), t=3) ---
    component recipHash = Poseidon2Hash(2);
    recipHash.inputs[0] <== 8;
    recipHash.inputs[1] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = WithdrawPoseidon2();
