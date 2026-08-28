pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Experimental variant of merkle_proof.circom's MerkleProof(depth), identical
// interface and left/right selection logic, but with each internal-node hash
// replaced by a 2-to-1 compression built from the Poseidon2 permutation
// instead of circomlib's (Poseidon1) sponge:
//
//   node = Poseidon2Perm(t=2)([left, right])[0] + left    (Miyaguchi-Preneel feedforward)
//
// This is the same "compression mode" construction @taceo/circom-lib's own
// binary_merkle_root.circom uses (that file additionally supports a dynamic
// depth via IsEqual selectors, which this repo does not need — Veil's tree
// depth is fixed at compile time — so this template keeps the static-depth
// shape of the original for an apples-to-apples constraint comparison).
//
// NOT wired into any production circuit. See
// docs/research/2026-08-28-poseidon2-merkle-hash.md for the soundness
// argument, leakage analysis, and why this is not (yet) a drop-in swap for
// merkle_proof.circom.
template MerkleProofPoseidon2(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal nodes[depth + 1];
    nodes[0] <== leaf;

    component mux[depth];
    component perm[depth];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== nodes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== nodes[i];
        mux[i].s <== pathIndices[i];

        perm[i] = Poseidon2(2);
        perm[i].in[0] <== mux[i].out[0];
        perm[i].in[1] <== mux[i].out[1];
        nodes[i + 1] <== perm[i].out[0] + mux[i].out[0];
    }

    root <== nodes[depth];
}
