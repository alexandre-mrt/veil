pragma circom 2.1.0;
include "../templates/merkle_proof.circom";
template ProbeMerkleProof20() {
    signal input leaf;
    signal input pathElements[20];
    signal input pathIndices[20];
    signal output root;
    component mp = MerkleProof(20);
    mp.leaf <== leaf;
    for (var i = 0; i < 20; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    root <== mp.root;
}
component main {public [leaf]} = ProbeMerkleProof20();
