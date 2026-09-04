pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

// Hash-only skeleton of withdraw.circom: 3x Poseidon(4) (commitment, change
// commitment, nullifier) + 1x Poseidon(2) (recipient binding). No Merkle proof —
// withdraw.circom does not have one (see its file header: withdrawals are
// identifiable by design). Drops the range-check/comparator constraints.
template WithdrawHashCurrent() {
    signal input commitment;
    signal input nullifier;
    signal input recipientHash;
    signal input newCommitment;

    signal input cumulativeOld;
    signal input randomnessOld;
    signal input userSecret;
    signal input recipient;
    signal input randomnessNew;
    signal input withdrawAmount;

    component commHash = Poseidon(4);
    commHash.inputs[0] <== 1;
    commHash.inputs[1] <== cumulativeOld;
    commHash.inputs[2] <== randomnessOld;
    commHash.inputs[3] <== userSecret;
    commitment === commHash.out;

    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    component changeHash = Poseidon(4);
    changeHash.inputs[0] <== 1;
    changeHash.inputs[1] <== remainingBalance;
    changeHash.inputs[2] <== randomnessNew;
    changeHash.inputs[3] <== userSecret;
    newCommitment === changeHash.out;

    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 7;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== randomnessOld;
    nfHash.inputs[3] <== cumulativeOld;
    nullifier === nfHash.out;

    component recipHash = Poseidon(2);
    recipHash.inputs[0] <== 8;
    recipHash.inputs[1] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, nullifier, recipientHash, newCommitment]} = WithdrawHashCurrent();
