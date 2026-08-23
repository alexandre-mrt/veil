pragma circom 2.2.2;

include "poseidon2.circom";

// Single-permutation Poseidon2 sponge with domain separation in the capacity element.
//
// State layout: state[0] = ds (compile-time domain separator, 0 for "no domain tag"),
// state[1..N] = msg[0..N-1], any remaining rate slots zero-padded. One Poseidon2(T)
// permutation is applied and the digest is squeezed from state[0] (rate slot 0 after
// the permutation), matching circomlib's Poseidon(nInputs) squeeze convention (see
// PoseidonEx.mixLast in circomlib/circuits/poseidon.circom, which also outputs state[0]
// through the MDS matrix's first column) and @taceo/circom-lib's own Poseidon2Sponge
// (compression.circom), of which this is the fixed single-block special case.
//
// Requires N <= T - 1 (message fits in one permutation's rate) — the constructor asserts
// this. T must be one of Poseidon2's supported state sizes: 2, 3, 4, 8, 12, 16.
template Poseidon2Hash(N, T, DS) {
    assert(N <= T - 1);

    signal input msg[N];
    signal output out;

    signal state_in[T];
    state_in[0] <== DS;
    for (var i = 0; i < N; i++) {
        state_in[i + 1] <== msg[i];
    }
    for (var i = N + 1; i < T; i++) {
        state_in[i] <== 0;
    }

    signal state_out[T] <== Poseidon2(T)(state_in);
    out <== state_out[0];
}

// 2-to-1 compression for a binary Merkle tree node, no domain tag (capacity = 0),
// mirroring circomlib's `Poseidon(2)` usage in templates/merkle_proof.circom exactly —
// same interface, same absence of domain separation, only the permutation differs.
template Poseidon2Compress2() {
    signal input left;
    signal input right;
    signal output out;

    out <== Poseidon2Hash(2, 3, 0)([left, right]);
}
