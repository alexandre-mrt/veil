pragma circom 2.2.2;

include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2 shadow of withdraw.circom. See transfer2.circom's header for
// shared design notes.
//
// Domain tags (unchanged from withdraw.circom):
//   1 -> commitment hash (shared with transfer2.circom)
//   7 -> withdrawal nullifier    8 -> recipient binding

template Withdraw2() {
    // --- PUBLIC INPUTS (5 total) ---
    signal input commitment;
    signal input withdrawAmount;
    signal input nullifier;
    signal input recipientHash;
    signal input newCommitment;

    // --- PRIVATE INPUTS (5) ---
    signal input cumulativeOld;
    signal input randomnessOld;
    signal input userSecret;
    signal input recipient;
    signal input randomnessNew;

    // --- C1: Commitment is well-formed ---
    // commitment = Poseidon2Sponge(DS=1)(cumulativeOld, randomnessOld, userSecret)
    signal commHash <== Poseidon2Sponge(3, 4, 1)([cumulativeOld, randomnessOld, userSecret]);
    commitment === commHash;

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

    // --- C6: Change commitment for remaining balance ---
    signal remainingBalance;
    remainingBalance <== cumulativeOld - withdrawAmount;

    // changeHash = Poseidon2Sponge(DS=1)(remainingBalance, randomnessNew, userSecret)
    signal changeHash <== Poseidon2Sponge(3, 4, 1)([remainingBalance, randomnessNew, userSecret]);
    newCommitment === changeHash;

    // --- C7: Remaining balance range proof ---
    component remBits = Num2Bits(64);
    remBits.in <== remainingBalance;

    // --- C8: Nullifier is correctly derived ---
    // nullifier = Poseidon2Sponge(DS=7)(userSecret, randomnessOld, cumulativeOld)
    signal nfHash <== Poseidon2Sponge(3, 4, 7)([userSecret, randomnessOld, cumulativeOld]);
    nullifier === nfHash;

    // --- C9: Recipient hash binds the withdrawal to a specific address ---
    // recipientHash = Poseidon2Sponge(DS=8)(recipient)
    signal recipHash <== Poseidon2Sponge(1, 2, 8)([recipient]);
    recipientHash === recipHash;
}

component main {public [commitment, withdrawAmount, nullifier, recipientHash, newCommitment]} = Withdraw2();
