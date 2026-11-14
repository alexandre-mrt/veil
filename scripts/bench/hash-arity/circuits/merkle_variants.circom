pragma circom 2.1.0;
// Merkle-membership variants benchmarked by scripts/bench/hash-arity/bench.mjs.
//   MerkleBinaryPoseidon(depth)   — byte-for-byte the production circuits/templates/merkle_proof.circom
//   MerkleBinaryPoseidon2(depth)  — same tree shape, Poseidon2 t=3 compression
//   MerkleQuadPoseidon(depth)     — 4-ary tree, circomlib Poseidon(4) (t=5) per level
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";
include "poseidon2.circom";

template MerkleBinaryPoseidon(depth) {
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
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }
    root <== nodes[depth];
}

template MerkleBinaryPoseidon2(depth) {
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
        hashers[i] = Poseidon2Hash2();
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }
    root <== nodes[depth];
}

// Places `node` at position p = b0 + 2*b1 among three siblings s[0..2] (siblings in left-to-right
// order with the node's slot removed). Indicators e_k = [p == k] are derived from two boolean bits;
// exactly one e_k is 1 for every boolean (b0, b1), so the output is a permutation of
// {node, s0, s1, s2} with node at slot p — no other assignment satisfies the constraints.
template QuadPlace() {
    signal input node;
    signal input s[3];
    signal input b[2];
    signal output out[4];
    b[0] * (1 - b[0]) === 0;
    b[1] * (1 - b[1]) === 0;
    signal e3;
    e3 <== b[0] * b[1];
    var e1 = b[0] - e3;
    var e2 = b[1] - e3;
    var e0 = 1 - b[0] - b[1] + e3;
    // slot 0: node if p==0 else s0
    out[0] <== s[0] + e0 * (node - s[0]);
    // slot 3: node if p==3 else s2
    out[3] <== s[2] + e3 * (node - s[2]);
    // slot 1: p==0 -> s0, p==1 -> node, p>=2 -> s1
    signal t1a; signal t1b;
    t1a <== e0 * s[0];
    t1b <== e1 * node;
    out[1] <== t1a + t1b + b[1] * s[1];
    // slot 2: p<=1 -> s1, p==2 -> node, p==3 -> s2
    signal t2a; signal t2b;
    t2a <== (1 - b[1]) * s[1];
    t2b <== e2 * node;
    out[2] <== t2a + t2b + e3 * s[2];
}

template MerkleQuadPoseidon(depth) {
    signal input leaf;
    signal input pathElements[depth][3];
    signal input pathIndices[depth][2];
    signal output root;
    signal nodes[depth + 1];
    nodes[0] <== leaf;
    component place[depth];
    component hashers[depth];
    for (var i = 0; i < depth; i++) {
        place[i] = QuadPlace();
        place[i].node <== nodes[i];
        for (var j = 0; j < 3; j++) place[i].s[j] <== pathElements[i][j];
        place[i].b[0] <== pathIndices[i][0];
        place[i].b[1] <== pathIndices[i][1];
        hashers[i] = Poseidon(4);
        for (var j = 0; j < 4; j++) hashers[i].inputs[j] <== place[i].out[j];
        nodes[i + 1] <== hashers[i].out;
    }
    root <== nodes[depth];
}

// Membership wrapper: root is public, leaf/path private — exactly the role MerkleProof(20) plays in
// transfer.circom (merkleRoot public input, oldCommitment's membership).
template BinaryMember(depth) {
    signal input root;
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    component m = MerkleBinaryPoseidon(depth);
    m.leaf <== leaf;
    for (var i = 0; i < depth; i++) { m.pathElements[i] <== pathElements[i]; m.pathIndices[i] <== pathIndices[i]; }
    root === m.root;
}
template BinaryMemberP2(depth) {
    signal input root;
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    component m = MerkleBinaryPoseidon2(depth);
    m.leaf <== leaf;
    for (var i = 0; i < depth; i++) { m.pathElements[i] <== pathElements[i]; m.pathIndices[i] <== pathIndices[i]; }
    root === m.root;
}
template QuadMember(depth) {
    signal input root;
    signal input leaf;
    signal input pathElements[depth][3];
    signal input pathIndices[depth][2];
    component m = MerkleQuadPoseidon(depth);
    m.leaf <== leaf;
    for (var i = 0; i < depth; i++) {
        for (var j = 0; j < 3; j++) m.pathElements[i][j] <== pathElements[i][j];
        m.pathIndices[i][0] <== pathIndices[i][0];
        m.pathIndices[i][1] <== pathIndices[i][1];
    }
    root === m.root;
}
