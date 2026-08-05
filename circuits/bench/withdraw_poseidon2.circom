// Poseidon2 variant of withdraw.circom, for a full-circuit constraint-count
// and proving-time comparison against the real circuit (see BASELINE.md).
//
// NOT wired into the protocol — no VK for this circuit exists on-chain, and
// none should be generated from it without a fresh security review (see the
// soundness note in the accompanying research report). This is a research
// artifact: same public/private input layout and same nine constraints
// (C1-C9) as withdraw.circom, byte-for-byte, with only the Poseidon(4) and
// Poseidon(2) calls swapped for the Poseidon2Bench wrapper from wrappers.circom
// (Poseidon(4)'s width, t=5, is not one of taceo's supported Poseidon2 widths
// {2,3,4,8,12,16}; padded to t=8. Poseidon(2) maps to t=3, which Poseidon2
// supports natively).
pragma circom 2.1.0;

include "wrappers.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

template WithdrawPoseidon2() {
    signal input commitment;
    signal input withdrawAmount;
    signal input nullifier;
    signal input recipientHash;
    signal input newCommitment;

    signal input cumulativeOld;
    signal input randomnessOld;
    signal input userSecret;
    signal input recipient;
    signal input randomnessNew;

    // --- C1: Commitment is well-formed (Poseidon2, t=8 padded, nReal=4) ---
    component commHash = Poseidon2Bench(8, 4);
    commHash.in[0] <== 1;
    commHash.in[1] <== cumulativeOld;
    commHash.in[2] <== randomnessOld;
    commHash.in[3] <== userSecret;
    commitment === commHash.out;

    // --- C2: withdrawAmount fits in 64 bits ---
    component amountBits = Num2Bits(64);
    amountBits.in <== withdrawAmount;

    // --- C3: withdrawAmount > 0 ---
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== withdrawAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // --- C4: cumulativeOld fits in 64 bits ---
    component cumBits = Num2Bits(64);
    cumBits.in <== cumulativeOld;

    // --- C5: withdrawAmount <= cumulativeOld ---
    component amountCheck = LessEqThan(64);
    amountCheck.in[0] <== withdrawAmount;
    amountCheck.in[1] <== cumulativeOld;
    amountCheck.out === 1;

    // --- C6: Change commitment (Poseidon2, t=8 padded, nReal=4) ---
    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    component changeHash = Poseidon2Bench(8, 4);
    changeHash.in[0] <== 1;
    changeHash.in[1] <== remainingBalance;
    changeHash.in[2] <== randomnessNew;
    changeHash.in[3] <== userSecret;
    newCommitment === changeHash.out;

    // --- C7: Remaining balance range proof ---
    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    // --- C8: Nullifier (Poseidon2, t=8 padded, nReal=4) ---
    component nfHash = Poseidon2Bench(8, 4);
    nfHash.in[0] <== 7;
    nfHash.in[1] <== userSecret;
    nfHash.in[2] <== randomnessOld;
    nfHash.in[3] <== cumulativeOld;
    nullifier === nfHash.out;

    // --- C9: Recipient hash (Poseidon2, t=3 native, nReal=2) ---
    component recipHash = Poseidon2Bench(3, 2);
    recipHash.in[0] <== 8;
    recipHash.in[1] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = WithdrawPoseidon2();
