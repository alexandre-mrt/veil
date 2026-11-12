pragma circom 2.1.0;

// Poseidon2 over BN254, t=3, d=5, R_F=8 (4+4), R_P=56 — HorizenLabs/poseidon2 reference instance.
// Research artifact (docs/research/2026-11-12-poseidon2-vs-poseidon.md). NOT wired into any
// production circuit. Verified against the reference KAT and against
// scripts/bench/poseidon2/poseidon2.mjs by circuits/test/poseidon2.test.mjs.
//
// Every S-box is x^5 = 3 multiplication constraints (x2 = x*x, x4 = x2*x2, y = x4*x).
// The external (circ(2,1,1)) and internal ([[2,1,1],[1,2,1],[1,1,3]]) linear layers are free in
// R1CS — they are carried as linear combinations in `var`s and folded into the next S-box input.

include "poseidon2_constants.circom";

// One x^5 S-box round on a linear combination `lc` (not a signal), costing exactly 3
// multiplication constraints and no linear constraint: x2 = lc*lc, x4 = x2*x2, y = x4*lc.
// Written as a macro-style block in each round below because circom templates cannot take a
// linear combination as an input without materialising it as a signal (+1 linear constraint).

template Poseidon2PermT3() {
    signal input in[3];
    signal output out[3];

    // 8 full rounds x 3 S-boxes + 56 partial rounds x 1 S-box = 80 S-boxes.
    signal x2[80];
    signal x4[80];
    signal y[80];

    var s[3];
    var sum;
    var lc;
    var k = 0;

    // Initial external linear layer.
    sum = in[0] + in[1] + in[2];
    for (var i = 0; i < 3; i++) s[i] = in[i] + sum;

    for (var r = 0; r < 64; r++) {
        if (r < 4 || r >= 60) {
            // Full round: add RC, S-box every lane, external matrix circ(2,1,1).
            for (var i = 0; i < 3; i++) {
                lc = s[i] + POSEIDON2_T3_RC(r, i);
                x2[k] <== lc * lc;
                x4[k] <== x2[k] * x2[k];
                y[k] <== x4[k] * lc;
                s[i] = y[k];
                k++;
            }
            sum = s[0] + s[1] + s[2];
            for (var i = 0; i < 3; i++) s[i] = s[i] + sum;
        } else {
            // Partial round: add RC to lane 0, S-box lane 0, internal matrix [[2,1,1],[1,2,1],[1,1,3]].
            lc = s[0] + POSEIDON2_T3_RC(r, 0);
            x2[k] <== lc * lc;
            x4[k] <== x2[k] * x2[k];
            y[k] <== x4[k] * lc;
            s[0] = y[k];
            k++;
            sum = s[0] + s[1] + s[2];
            s[0] = s[0] + sum;
            s[1] = s[1] + sum;
            s[2] = 2 * s[2] + sum;
        }
    }

    for (var i = 0; i < 3; i++) out[i] <== s[i];
}

// 2-to-1 compression: perm([a, b, 0])[0], same convention as the reference MerkleTreeHash.
template Poseidon2Hash2() {
    signal input inputs[2];
    signal output out;
    component p = Poseidon2PermT3();
    p.in[0] <== inputs[0];
    p.in[1] <== inputs[1];
    p.in[2] <== 0;
    out <== p.out[0];
}
