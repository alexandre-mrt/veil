pragma circom 2.1.0;

include "../templates/merkle_proof_poseidon2.circom";

// Minimal wrapper mirroring the `merkleRoot === membershipProof.root`
// equality check that transfer.circom/compliance.circom actually enforce
// against the Merkle template, so the Poseidon2 variant's rejection of a
// malicious witness (wrong sibling, wrong index bit) can be tested directly
// without needing every other signal in the full Transfer/Compliance
// circuits. See docs/research/2026-08-28-poseidon2-merkle-hash.md.
template MerkleMembershipPoseidon2(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input expectedRoot;

    component proof = MerkleProofPoseidon2(depth);
    proof.leaf <== leaf;
    for (var i = 0; i < depth; i++) {
        proof.pathElements[i] <== pathElements[i];
        proof.pathIndices[i] <== pathIndices[i];
    }
    expectedRoot === proof.root;
}

component main {public [expectedRoot]} = MerkleMembershipPoseidon2(20);
