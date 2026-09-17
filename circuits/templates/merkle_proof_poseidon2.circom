pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/poseidon2.circom";
include "circomlib/circuits/mux1.circom";

// Poseidon2-compression variant of merkle_proof.circom, for the 2026-09-17 Poseidon2 research
// experiment (docs/research/2026-09-17-poseidon2-merkle-compression.md). Structurally identical
// to MerkleProof(depth) — same MultiMux1-based left/right selection, same per-level layout — with
// the per-level hash replaced by the Poseidon2 permutation in 2-to-1 COMPRESSION mode
// (state width t=2, feed-forward: out = Poseidon2(2)([l, r])[0] + l), which is how
// @taceo/circom-lib's own audited binary_merkle_root.circom builds a Merkle node from Poseidon2 —
// not a plain sponge call. See that file's docstring for why: compression mode needs no capacity
// element, so it is cheaper per level than a sponge absorb (measured: 484 R1CS constraints vs
// circomlib's Poseidon(2) at 517 — see docs/research/2026-09-17-poseidon2-merkle-compression.md).
//
// Research artifact only — not wired into transfer.circom or compliance.circom. See the report
// for why (no official Poseidon2 parameter set exists for the t=5/t=6 states the rest of the
// protocol's commitment/nullifier/credential hashes need, so this is not a drop-in whole-protocol
// migration).
template MerkleProof2(depth) {
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

        hashers[i] = Poseidon2(2);
        hashers[i].in[0] <== mux[i].out[0];
        hashers[i].in[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out[0] + mux[i].out[0];
    }

    root <== nodes[depth];
}
