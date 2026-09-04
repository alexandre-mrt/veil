pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/mux1.circom";
include "poseidon2_compress.circom";

// Poseidon2 equivalent of templates/merkle_proof.circom — same mux-based
// left/right selection per level, same depth-parameterized interface, only the
// per-level hash (MerkleLevelPoseidon2) differs.
template MerkleProofPoseidon2(depth, MERKLE_TAG) {
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

        hashers[i] = MerkleLevelPoseidon2(MERKLE_TAG);
        hashers[i].left <== mux[i].out[0];
        hashers[i].right <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}
