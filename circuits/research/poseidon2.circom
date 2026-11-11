pragma circom 2.1.0;

// RESEARCH ONLY — not used by any production circuit (see
// docs/research/2026-11-11-poseidon2-r1cs-cost.md). Poseidon2 permutation over BN254, t=3, d=5,
// RF=8, RP=56 (HorizenLabs reference parameters). The JS twin is
// scripts/bench/poseidon2/poseidon2.mjs; both read the same constants.
//
// Every S-box is x^5 = 3 multiplication constraints. Linear layers are carried as linear
// expressions in `var`s, so they cost zero R1CS constraints (R1CS has free linear combinations;
// this is exactly why Poseidon2's cheaper linear layer buys nothing in Groth16).

include "poseidon2_constants.circom";

template Poseidon2Sbox() {
    signal input in;
    signal output out;
    signal x2;
    signal x4;
    x2 <== in * in;
    x4 <== x2 * x2;
    out <== x4 * in;
}

template Poseidon2Perm3() {
    signal input in[3];
    signal output out[3];

    var RC[64][3] = POSEIDON2_T3_RC();
    var s[3];
    var sum;

    // initial external linear layer, circ(2,1,1)
    sum = in[0] + in[1] + in[2];
    for (var i = 0; i < 3; i++) { s[i] = in[i] + sum; }

    component fullA[4][3];
    for (var r = 0; r < 4; r++) {
        for (var i = 0; i < 3; i++) {
            fullA[r][i] = Poseidon2Sbox();
            fullA[r][i].in <== s[i] + RC[r][i];
        }
        sum = fullA[r][0].out + fullA[r][1].out + fullA[r][2].out;
        for (var i = 0; i < 3; i++) { s[i] = fullA[r][i].out + sum; }
    }

    component partial[56];
    for (var r = 0; r < 56; r++) {
        partial[r] = Poseidon2Sbox();
        partial[r].in <== s[0] + RC[4 + r][0];
        // internal matrix [[2,1,1],[1,2,1],[1,1,3]]
        sum = partial[r].out + s[1] + s[2];
        s[0] = partial[r].out + sum;
        s[1] = s[1] + sum;
        s[2] = 2 * s[2] + sum;
    }

    component fullB[4][3];
    for (var r = 0; r < 4; r++) {
        for (var i = 0; i < 3; i++) {
            fullB[r][i] = Poseidon2Sbox();
            fullB[r][i].in <== s[i] + RC[60 + r][i];
        }
        sum = fullB[r][0].out + fullB[r][1].out + fullB[r][2].out;
        for (var i = 0; i < 3; i++) { s[i] = fullB[r][i].out + sum; }
    }

    for (var i = 0; i < 3; i++) { out[i] <== s[i]; }
}

// Drop-in for circomlib Poseidon(2): same sponge layout, state [0, a, b] -> out[0].
template Poseidon2Hash2() {
    signal input inputs[2];
    signal output out;
    component p = Poseidon2Perm3();
    p.in[0] <== 0;
    p.in[1] <== inputs[0];
    p.in[2] <== inputs[1];
    out <== p.out[0];
}
