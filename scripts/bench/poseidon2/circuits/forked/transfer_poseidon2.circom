pragma circom 2.2.2;

include "../../../../../circuits/node_modules/circomlib/circuits/comparators.circom";
include "../../../../../circuits/node_modules/circomlib/circuits/bitify.circom";
include "../lib/merkle_proof_poseidon2.circom";
include "../lib/poseidon2_hash.circom";

// Byte-for-byte fork of circuits/transfer.circom (v2, audit-fixed) with every Poseidon
// call replaced by a Poseidon2Hash (domain tag moved from a rate element into the
// capacity element — see docs/research/2026-08-23-poseidon2-benchmark.md for why).
// Every non-hash line (range checks, comparators, the cumulative-sum equation) is
// character-for-character identical to the original, so the only variable between this
// file and the production circuit is the hash construction. NOT wired into pool.move,
// NOT used by the frontend, NOT part of the deployed protocol — a benchmark fork only.
template TransferPoseidon2() {
    signal input oldCommitment;
    signal input newCommitment;
    signal input threshold;
    signal input epochId;
    signal input nullifier;
    signal input txAmountHash;
    signal input merkleRoot;

    signal input cumulativeOld;
    signal input cumulativeNew;
    signal input txAmount;
    signal input randomnessOld;
    signal input randomnessNew;
    signal input userSecret;
    signal input salt;
    signal input pathElements[20];
    signal input pathIndices[20];

    // C0: Merkle membership — Poseidon2 2-to-1 compression, no domain tag (Shape A)
    component membershipProof = MerkleProofPoseidon2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // C1: oldCommitment = H(1, cumulativeOld, randomnessOld, userSecret) — Shape C (tag in capacity)
    signal oldHashOut <== Poseidon2Hash(3, 4, 1)([cumulativeOld, randomnessOld, userSecret]);
    oldCommitment === oldHashOut;

    // C2: newCommitment = H(1, cumulativeNew, randomnessNew, userSecret) — Shape C
    signal newHashOut <== Poseidon2Hash(3, 4, 1)([cumulativeNew, randomnessNew, userSecret]);
    newCommitment === newHashOut;

    // C3: cumulative update
    cumulativeNew === cumulativeOld + txAmount;

    // C4: txAmount > 0
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // C5-C7: range proofs
    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;
    component txBits = Num2Bits(64);
    txBits.in <== txAmount;
    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;

    // C8: threshold range proof
    component threshBits = Num2Bits(64);
    threshBits.in <== threshold;

    // C9: cumulative under threshold
    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;

    // C10: nullifier = H(2, userSecret, epochId, randomnessOld) — Shape C
    signal nfHashOut <== Poseidon2Hash(3, 4, 2)([userSecret, epochId, randomnessOld]);
    nullifier === nfHashOut;

    // C11: txAmountHash = H(3, txAmount, salt) — Shape B
    signal txHashOut <== Poseidon2Hash(2, 3, 3)([txAmount, salt]);
    txAmountHash === txHashOut;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = TransferPoseidon2();
