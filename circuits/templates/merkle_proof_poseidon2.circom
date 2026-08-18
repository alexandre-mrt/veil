pragma circom 2.1.0;

include "../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Poseidon2 variant of merkle_proof.circom — identical structure (same depth-first
// path-folding loop, same MultiMux1 left/right selection), the ONLY change is the
// per-level hash: Poseidon(2) (circomlib, sponge mode, internal state t=3) is
// replaced by Poseidon2(2) in *compression* mode (state t=2, Miyaguchi-Preneel
// feed-forward: out = permute(left, right)[0] + left).
//
// Compression mode (not sponge mode) is used deliberately — it's the construction
// the Poseidon2 paper (and the zk-kit binary-merkle-root Poseidon2 port this
// permutation is adapted from) recommends specifically for fixed-arity 2-to-1
// Merkle hashing, where there's no need for a sponge's spare capacity element.
// See the report for the soundness argument and what changes vs. the original.
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
