pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";

// Transfer circuit for Veil privacy protocol.
//
// Proves that a cumulative spending update is valid:
// - Old and new commitments are well-formed Poseidon hashes
// - New cumulative = old cumulative + tx amount
// - tx amount > 0
// - All values fit in 64 bits (no overflow)
// - Nullifier is correctly derived from the user secret and epoch
// - tx amount hash is correctly derived (for receiver verification)
//
// Domain separation tags (first Poseidon input):
//   1 → commitment hash  H(1, cumulative, randomness)
//   2 → nullifier hash   H(2, userSecret, epochId)
//
// Curve: BN254 (Groth16, Sui curve id 1)
// Compiled with circom 2.1.x, proven with snarkjs 0.7.x

template Transfer() {
    // ─── PUBLIC INPUTS (6 total — order matters for Sui on-chain verification) ───
    signal input oldCommitment;    // Poseidon(1, cumulativeOld, randomnessOld)
    signal input newCommitment;    // Poseidon(1, cumulativeNew, randomnessNew)
    signal input threshold;        // KYC-free epoch limit (informational, verified off-circuit by contract)
    signal input epochId;          // Current epoch identifier (from on-chain Clock)
    signal input nullifier;        // Poseidon(2, userSecret, epochId)
    signal input txAmountHash;     // Poseidon(txAmount, salt) — for receiver-side verification

    // ─── PRIVATE INPUTS ───────────────────────────────────────────────────────
    signal input cumulativeOld;    // Previous cumulative spending this epoch
    signal input cumulativeNew;    // cumulativeOld + txAmount
    signal input txAmount;         // This transaction's amount
    signal input randomnessOld;    // Blinding factor for oldCommitment
    signal input randomnessNew;    // Blinding factor for newCommitment
    signal input userSecret;       // User's master secret (never revealed)
    signal input salt;             // Salt for txAmountHash

    // ─── CONSTRAINT 1: Old commitment is well-formed ─────────────────────────
    // oldCommitment = Poseidon(1, cumulativeOld, randomnessOld)
    component oldHash = Poseidon(3);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldCommitment === oldHash.out;

    // ─── CONSTRAINT 2: New commitment is well-formed ─────────────────────────
    // newCommitment = Poseidon(1, cumulativeNew, randomnessNew)
    component newHash = Poseidon(3);
    newHash.inputs[0] <== 1;
    newHash.inputs[1] <== cumulativeNew;
    newHash.inputs[2] <== randomnessNew;
    newCommitment === newHash.out;

    // ─── CONSTRAINT 3: Cumulative update is correct ───────────────────────────
    // cumulativeNew must equal cumulativeOld + txAmount
    cumulativeNew === cumulativeOld + txAmount;

    // ─── CONSTRAINT 4: txAmount > 0 ──────────────────────────────────────────
    // Reject zero-value transfers
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // ─── CONSTRAINTS 5-7: Range proofs [0, 2^64) ─────────────────────────────
    // Ensures no overflow and all values are non-negative.
    // Num2Bits(64) implicitly constrains input to [0, 2^64).
    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;

    component txBits = Num2Bits(64);
    txBits.in <== txAmount;

    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;

    // ─── CONSTRAINT 8: Cumulative spending under threshold ─────────────────────
    // cumulativeNew <= threshold (anonymous tier allowed)
    // If cumulativeNew > threshold, the prover needs a separate compliance proof
    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;

    // ─── CONSTRAINT 9: Nullifier is correctly derived ─────────────────────────
    // nullifier = Poseidon(2, userSecret, epochId)
    // Domain tag 2 separates nullifiers from commitments (tag 1)
    component nfHash = Poseidon(3);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nullifier === nfHash.out;

    // ─── CONSTRAINT 9: tx amount hash is correctly derived ───────────────────
    // txAmountHash = Poseidon(txAmount, salt)
    // Allows receiver to verify the committed amount without revealing it on-chain
    component txHash = Poseidon(2);
    txHash.inputs[0] <== txAmount;
    txHash.inputs[1] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash]} = Transfer();
