pragma circom 2.1.0;

// Cross-check: the whole depth-20 accumulator template as used by
// transfer.circom / compliance.circom, compiled in isolation.

include "../../../circuits/templates/merkle_proof.circom";

template Gadget() {
    signal input leaf;
    signal input pathElements[20];
    signal input pathIndices[20];
    signal output root;

    component m = MerkleProof(20);
    m.leaf <== leaf;
    for (var i = 0; i < 20; i++) {
        m.pathElements[i] <== pathElements[i];
        m.pathIndices[i] <== pathIndices[i];
    }
    root <== m.root;
}

component main = Gadget();
