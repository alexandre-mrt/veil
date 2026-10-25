pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

// EXPERIMENT (2026-10-25-kary-merkle) — NOT used by production circuits or Move.
// K-ary Merkle membership proof. Per level the prover supplies the node's position as a
// one-hot vector and K sibling slots (the slot at the node's own position is ignored).
//   child_j = sib_j + onehot_j * (node - sib_j)       (1 mult per child)
//   onehot_j boolean, sum(onehot) == 1                (K bool + 1 linear)
//   next    = Poseidon(K)(child_0..child_{K-1})
template KaryMerkleProof(K, depth) {
    signal input leaf;
    signal input sibs[depth][K];
    signal input onehot[depth][K];
    signal output root;

    signal nodes[depth + 1];
    signal diff[depth][K];
    signal child[depth][K];
    signal acc[depth][K + 1];
    component hashers[depth];

    nodes[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        acc[i][0] <== 0;
        for (var j = 0; j < K; j++) {
            onehot[i][j] * (1 - onehot[i][j]) === 0;
            acc[i][j + 1] <== acc[i][j] + onehot[i][j];
            diff[i][j] <== onehot[i][j] * (nodes[i] - sibs[i][j]);
            child[i][j] <== sibs[i][j] + diff[i][j];
        }
        acc[i][K] === 1;
        hashers[i] = Poseidon(K);
        for (var j = 0; j < K; j++) hashers[i].inputs[j] <== child[i][j];
        nodes[i + 1] <== hashers[i].out;
    }
    root <== nodes[depth];
}
