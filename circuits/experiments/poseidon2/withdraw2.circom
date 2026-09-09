pragma circom 2.2.2;

include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "templates/poseidon2_hash.circom";

// Experiment mirror of ../../withdraw.circom — see transfer2.circom's header comment for the swap
// rule. withdraw.circom has no Merkle proof, so `MerkleProof2` is not used here.
template Withdraw2() {
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

    component commHash = Poseidon2Hash(4);
    commHash.inputs[0] <== 1;
    commHash.inputs[1] <== cumulativeOld;
    commHash.inputs[2] <== randomnessOld;
    commHash.inputs[3] <== userSecret;
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

    component changeHash = Poseidon2Hash(4);
    changeHash.inputs[0] <== 1;
    changeHash.inputs[1] <== remainingBalance;
    changeHash.inputs[2] <== randomnessNew;
    changeHash.inputs[3] <== userSecret;
    newCommitment === changeHash.out;

    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    component nfHash = Poseidon2Hash(4);
    nfHash.inputs[0] <== 7;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== randomnessOld;
    nfHash.inputs[3] <== cumulativeOld;
    nullifier === nfHash.out;

    component recipHash = Poseidon2Hash(2);
    recipHash.inputs[0] <== 8;
    recipHash.inputs[1] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = Withdraw2();
