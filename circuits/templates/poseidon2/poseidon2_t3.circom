pragma circom 2.1.0;

include "poseidon2_t3_constants.circom";

// Poseidon2 permutation, t=3, d=5 (x^5 S-box), R_F=8 full rounds, R_P=56 partial
// rounds, over the BN254 scalar field.
//
// Parameters and algorithm transcribed from HorizenLabs/poseidon2
// (plain_implementations/src/poseidon2/poseidon2.rs `permutation`, instantiated with
// poseidon2_instance_bn256.rs's POSEIDON2_BN256_PARAMS). Cross-validated in
// scripts/bench/poseidon2-kat.mjs against that repo's own `kats()` unit test
// (permutation([0,1,2])) before being ported here — see
// docs/research/2026-09-09-poseidon2-merkle-hasher.md for the full methodology.
//
// This is a *different* permutation from circomlib's Poseidon (different linear
// layer, different round constants) — not a drop-in constant swap. Do not reuse
// these constants with circomlib's Poseidon template or vice versa.
template Poseidon2Perm3() {
    signal input in[3];
    signal output out[3];

    var RC[64][3] = POSEIDON2_T3_RC();
    var DIAG[3] = POSEIDON2_T3_DIAG();
    var RF_HALF = 4;
    var RP = 56;

    signal state[64 + 1][3];

    // External linear layer: circ(2,1,1) — out_i = in_i + (in_0+in_1+in_2)
    var sum0 = in[0] + in[1] + in[2];
    state[0][0] <== in[0] + sum0;
    state[0][1] <== in[1] + sum0;
    state[0][2] <== in[2] + sum0;

    signal fullArk[RF_HALF * 2][3];
    signal fullSq[RF_HALF * 2][3];
    signal fullQuad[RF_HALF * 2][3];
    signal fullSbox[RF_HALF * 2][3];

    signal partArk[RP];
    signal partSq[RP];
    signal partQuad[RP];
    signal partSbox[RP];

    var r = 0;

    // First RF_HALF full rounds
    for (var i = 0; i < RF_HALF; i++) {
        for (var j = 0; j < 3; j++) {
            fullArk[i][j] <== state[r][j] + RC[r][j];
            fullSq[i][j] <== fullArk[i][j] * fullArk[i][j];
            fullQuad[i][j] <== fullSq[i][j] * fullSq[i][j];
            fullSbox[i][j] <== fullQuad[i][j] * fullArk[i][j];
        }
        var s = fullSbox[i][0] + fullSbox[i][1] + fullSbox[i][2];
        state[r + 1][0] <== fullSbox[i][0] + s;
        state[r + 1][1] <== fullSbox[i][1] + s;
        state[r + 1][2] <== fullSbox[i][2] + s;
        r++;
    }

    // RP partial rounds: S-box only on state[0], internal (diagonal) linear layer
    for (var i = 0; i < RP; i++) {
        partArk[i] <== state[r][0] + RC[r][0];
        partSq[i] <== partArk[i] * partArk[i];
        partQuad[i] <== partSq[i] * partSq[i];
        partSbox[i] <== partQuad[i] * partArk[i];

        var s = partSbox[i] + state[r][1] + state[r][2];
        state[r + 1][0] <== partSbox[i] + s;
        state[r + 1][1] <== state[r][1] * DIAG[1] + s;
        state[r + 1][2] <== state[r][2] * DIAG[2] + s;
        r++;
    }

    // Final RF_HALF full rounds
    for (var i = RF_HALF; i < RF_HALF * 2; i++) {
        for (var j = 0; j < 3; j++) {
            fullArk[i][j] <== state[r][j] + RC[r][j];
            fullSq[i][j] <== fullArk[i][j] * fullArk[i][j];
            fullQuad[i][j] <== fullSq[i][j] * fullSq[i][j];
            fullSbox[i][j] <== fullQuad[i][j] * fullArk[i][j];
        }
        var s = fullSbox[i][0] + fullSbox[i][1] + fullSbox[i][2];
        state[r + 1][0] <== fullSbox[i][0] + s;
        state[r + 1][1] <== fullSbox[i][1] + s;
        state[r + 1][2] <== fullSbox[i][2] + s;
        r++;
    }

    out[0] <== state[64][0];
    out[1] <== state[64][1];
    out[2] <== state[64][2];
}

// 2-to-1 compression, matching HorizenLabs's `MerkleTreeHash::compress`:
// permutation([left, right, 0])[0]. Drop-in replacement for circomlib's
// `Poseidon(2)` as a Merkle-tree node hasher — same (left, right) -> single-field
// interface, different permutation underneath.
template Poseidon2Hash2() {
    signal input inputs[2];
    signal output out;

    component perm = Poseidon2Perm3();
    perm.in[0] <== inputs[0];
    perm.in[1] <== inputs[1];
    perm.in[2] <== 0;

    out <== perm.out[0];
}
