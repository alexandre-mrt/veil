// Note: withdrawals reveal which commitment is consumed (via dynamic field removal
// on-chain). The Merkle accumulator provides anonymity for transfers but not
// withdrawals. This is an inherent design choice — the exit path is identifiable.
// (unchanged from withdraw.circom)

pragma circom 2.2.2;

include "templates/poseidon2_compat.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";

// Poseidon2 variant of withdraw.circom — see transfer_poseidon2.circom and
// docs/research/2026-07-29-poseidon2-migration.md. Same domain tags (1/7/8), same
// constraints, only the hash primitive changes. No Merkle tree in this circuit.

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

    // C1: Commitment is well-formed
    component commHash = Poseidon2Hash(4);
    commHash.inputs[0] <== 1;
    commHash.inputs[1] <== cumulativeOld;
    commHash.inputs[2] <== randomnessOld;
    commHash.inputs[3] <== userSecret;
    commitment === commHash.out;

    // C2: withdrawAmount fits in 64 bits
    component amountBits = Num2Bits(64);
    amountBits.in <== withdrawAmount;

    // C3: withdrawAmount > 0
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== withdrawAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // C4: cumulativeOld fits in 64 bits
    component cumBits = Num2Bits(64);
    cumBits.in <== cumulativeOld;

    // C5: withdrawAmount <= cumulativeOld
    component amountCheck = LessEqThan(64);
    amountCheck.in[0] <== withdrawAmount;
    amountCheck.in[1] <== cumulativeOld;
    amountCheck.out === 1;

    // C6: Change commitment for remaining balance
    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    component changeHash = Poseidon2Hash(4);
    changeHash.inputs[0] <== 1;
    changeHash.inputs[1] <== remainingBalance;
    changeHash.inputs[2] <== randomnessNew;
    changeHash.inputs[3] <== userSecret;
    newCommitment === changeHash.out;

    // C7: Remaining balance range proof
    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    // C8: Nullifier is correctly derived
    component nfHash = Poseidon2Hash(4);
    nfHash.inputs[0] <== 7;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== randomnessOld;
    nfHash.inputs[3] <== cumulativeOld;
    nullifier === nfHash.out;

    // C9: Recipient hash binds the withdrawal to a specific address
    component recipHash = Poseidon2Hash(2);
    recipHash.inputs[0] <== 8;
    recipHash.inputs[1] <== recipient;
    recipientHash === recipHash.out;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = Withdraw2();
