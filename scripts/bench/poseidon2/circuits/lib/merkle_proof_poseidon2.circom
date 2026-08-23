pragma circom 2.2.2;

include "poseidon2_hash.circom";
include "../../../../../circuits/node_modules/circomlib/circuits/mux1.circom";

// Exact structural copy of circuits/templates/merkle_proof.circom, with the single line
// `hashers[i] = Poseidon(2)` swapped for `Poseidon2Compress2()`. Everything else —
// the MultiMux1 left/right selection, the depth-20 loop, the public root output — is
// byte-for-byte identical, so any constraint delta is attributable to the hash swap alone.
template MerkleProofPoseidon2(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal nodes[depth + 1];
    nodes[0] <== leaf;

    component mux[depth];
    component hashers[depth];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== nodes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== nodes[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon2Compress2();
        hashers[i].left <== mux[i].out[0];
        hashers[i].right <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}
