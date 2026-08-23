pragma circom 2.2.2;

include "../../../../../circuits/node_modules/circomlib/circuits/comparators.circom";
include "../../../../../circuits/node_modules/circomlib/circuits/bitify.circom";
include "../lib/poseidon2_hash.circom";

// Byte-for-byte fork of circuits/withdraw.circom with every Poseidon call replaced by
// Poseidon2Hash (domain tag in capacity). See transfer_poseidon2.circom's header — same
// caveats apply: benchmark fork only, not wired into pool.move or the frontend.
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

    // C1: commitment = H(1, cumulativeOld, randomnessOld, userSecret)
    signal commHashOut <== Poseidon2Hash(3, 4, 1)([cumulativeOld, randomnessOld, userSecret]);
    commitment === commHashOut;

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
    signal changeHashOut <== Poseidon2Hash(3, 4, 1)([remainingBalance, randomnessNew, userSecret]);
    newCommitment === changeHashOut;

    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    // C8: nullifier = H(7, userSecret, randomnessOld, cumulativeOld)
    signal nfHashOut <== Poseidon2Hash(3, 4, 7)([userSecret, randomnessOld, cumulativeOld]);
    nullifier === nfHashOut;

    // C9: recipientHash = H(8, recipient)
    signal recipHashOut <== Poseidon2Hash(1, 2, 8)([recipient]);
    recipientHash === recipHashOut;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = WithdrawPoseidon2();
