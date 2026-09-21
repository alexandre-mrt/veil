pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/mux1.circom";
include "./poseidon2_t3_template.circom";

// Same structure as templates/merkle_proof.circom (MultiMux1 select + hash per level,
// depth 20), but the per-level hasher is Poseidon2T3 (this directory's benchmark-only
// Poseidon2-structured permutation) instead of circomlib's Poseidon(2). Benchmark-only —
// isolates exactly one variable (the hasher) to measure its effect on the one gadget
// that is called 20x per Veil proof (transfer.circom / compliance.circom's Merkle
// membership check), the dominant constraint cost identified by this experiment.
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

        hashers[i] = Poseidon2T3();
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}

component main = MerkleProofPoseidon2(20);
