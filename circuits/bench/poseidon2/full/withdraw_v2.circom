pragma circom 2.2.2;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2 variant of withdraw.circom, for benchmarking only -- see
// transfer_v2.circom's header for scope notes.
template WithdrawV2() {
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

    // C1: commitment = H(1, cumulativeOld, randomnessOld, userSecret)
    component commHash = Poseidon2Sponge(3, 4, 1);
    commHash.in[0] <== cumulativeOld;
    commHash.in[1] <== randomnessOld;
    commHash.in[2] <== userSecret;
    commitment === commHash.out;

    component amountBits = Num2Bits(64);
    amountBits.in <== withdrawAmount;

    component gtZero = GreaterThan(64);
    gtZero.in[0] <== withdrawAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    component cumBits = Num2Bits(64);
    cumBits.in <== cumulativeOld;

    component amountCheck = LessEqThan(64);
    amountCheck.in[0] <== withdrawAmount;
    amountCheck.in[1] <== cumulativeOld;
    amountCheck.out === 1;

    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    // C6: newCommitment = H(1, remainingBalance, randomnessNew, userSecret)
    component changeHash = Poseidon2Sponge(3, 4, 1);
    changeHash.in[0] <== remainingBalance;
    changeHash.in[1] <== randomnessNew;
    changeHash.in[2] <== userSecret;
    newCommitment === changeHash.out;

    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    // C8: nullifier = H(7, userSecret, randomnessOld, cumulativeOld)
    component nfHash = Poseidon2Sponge(3, 4, 7);
    nfHash.in[0] <== userSecret;
    nfHash.in[1] <== randomnessOld;
    nfHash.in[2] <== cumulativeOld;
    nullifier === nfHash.out;

    // C9: recipientHash = H(8, recipient)
    component recipHash = Poseidon2Sponge(1, 2, 8);
    recipHash.in[0] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = WithdrawV2();
