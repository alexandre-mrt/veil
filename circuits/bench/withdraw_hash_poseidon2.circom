pragma circom 2.1.0;

include "lib/poseidon2_compress.circom";

// Poseidon2 counterpart of withdraw_hash_current.circom.
template WithdrawHashPoseidon2() {
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

    signal commVals[3];
    commVals[0] <== cumulativeOld;
    commVals[1] <== randomnessOld;
    commVals[2] <== userSecret;
    signal commHashOut <== Poseidon2CompressTagged(3, 4, 1)(commVals);
    commitment === commHashOut;

    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    signal changeVals[3];
    changeVals[0] <== remainingBalance;
    changeVals[1] <== randomnessNew;
    changeVals[2] <== userSecret;
    signal changeHashOut <== Poseidon2CompressTagged(3, 4, 1)(changeVals);
    newCommitment === changeHashOut;

    signal nfVals[3];
    nfVals[0] <== userSecret;
    nfVals[1] <== randomnessOld;
    nfVals[2] <== cumulativeOld;
    signal nfHashOut <== Poseidon2CompressTagged(3, 4, 7)(nfVals);
    nullifier === nfHashOut;

    signal recipVals[1];
    recipVals[0] <== recipient;
    signal recipHashOut <== Poseidon2CompressTagged(1, 2, 8)(recipVals);
    recipientHash === recipHashOut;
}

component main {public [commitment, nullifier, recipientHash, newCommitment]} = WithdrawHashPoseidon2();
