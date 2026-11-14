pragma circom 2.1.0;
// Poseidon2 permutation, BN254, t=3, d=5, R_F=8, R_P=56 (HorizenLabs parameters).
// Linear layers are folded into linear combinations (free in R1CS); only S-boxes cost constraints:
// (8*3 + 56) S-boxes * 3 constraints = 240.
include "poseidon2_constants.circom";

template P2Sbox() {
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
    var DIAG[3] = [1, 1, 2];
    var RF = 8;
    var RP = 56;

    component sf[RF][3];
    component sp[RP];

    var s[3];
    var sum;
    // initial external linear layer M_E = circ(2,1,1)
    sum = in[0] + in[1] + in[2];
    for (var i = 0; i < 3; i++) s[i] = in[i] + sum;

    for (var r = 0; r < RF / 2; r++) {
        for (var i = 0; i < 3; i++) {
            sf[r][i] = P2Sbox();
            sf[r][i].in <== s[i] + RC[r][i];
        }
        sum = sf[r][0].out + sf[r][1].out + sf[r][2].out;
        for (var i = 0; i < 3; i++) s[i] = sf[r][i].out + sum;
    }
    for (var r = 0; r < RP; r++) {
        sp[r] = P2Sbox();
        sp[r].in <== s[0] + RC[RF / 2 + r][0];
        s[0] = sp[r].out;
        sum = s[0] + s[1] + s[2];
        for (var i = 0; i < 3; i++) s[i] = s[i] * DIAG[i] + sum;
    }
    for (var r = RF / 2; r < RF; r++) {
        for (var i = 0; i < 3; i++) {
            sf[r][i] = P2Sbox();
            sf[r][i].in <== s[i] + RC[RP + r][i];
        }
        sum = sf[r][0].out + sf[r][1].out + sf[r][2].out;
        for (var i = 0; i < 3; i++) s[i] = sf[r][i].out + sum;
    }
    for (var i = 0; i < 3; i++) out[i] <== s[i];
}

// 2-to-1 compression, same convention as circomlib Poseidon(2): Perm([0, a, b])[0].
template Poseidon2Hash2() {
    signal input inputs[2];
    signal output out;
    component p = Poseidon2Perm3();
    p.in[0] <== 0;
    p.in[1] <== inputs[0];
    p.in[2] <== inputs[1];
    out <== p.out[0];
}
