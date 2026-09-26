pragma circom 2.1.0;

include "../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// MerkleProofPoseidon2 — depth-20 Merkle authentication-path verifier, identical
// in shape and swap logic to templates/merkle_proof.circom, but hashing each
// level with Poseidon2(t=2) in *compression mode* instead of Poseidon(2)
// (circomlib's sponge, t=3, capacity element fixed to 0).
//
// Compression mode: node = Perm([left, right])[0] + left  (Miyaguchi-Preneel
// feed-forward over the raw Poseidon2 permutation). This is not an invented
// construction — it is the same convention zk-kit's binary-merkle-root.circom
// uses (vendored into @taceo/circom-lib as binary_merkle_root.circom, whose
// header explicitly credits https://github.com/zk-kit/zk-kit.circom), and is
// the construction the Poseidon2 paper (eprint 2023/323, section on
// "Poseidon2 as compression function") names as the width-preserving
// alternative to sponge mode. Feed-forward is what makes t=2 (no unused
// capacity element) still collision-resistant: without it, an attacker could
// invert the last full round's linear layer and rewind to find a second
// preimage through the permutation alone.
//
// research/2026-09-26-poseidon2-merkle-path — see that report for the
// correctness verification (circuits/test/poseidon2.test.mjs) and the
// soundness/leakage analysis. Not wired into pool.move or any production
// circuit; this is a measurement-only variant.
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
