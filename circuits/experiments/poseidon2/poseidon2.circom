pragma circom 2.1.0;
// Poseidon2 over BN254 Fr (d=5, R_F=8, R_P=56), t in {3,4}. EXPERIMENTAL — see
// docs/research/2026-11-08-poseidon2-r1cs.md. Not used by any production circuit.
include "constants.circom";

// x^5 : 3 R1CS constraints
template P2Sbox5() {
    signal input in;
    signal output out;
    signal x2; signal x4;
    x2 <== in * in;
    x4 <== x2 * x2;
    out <== x4 * in;
}

// External (full-round) linear layer. t=3: circ(2,1,1). t=4: Poseidon2 M4. Returns T linear forms.
function p2_ext(T, x) {
    var y[4];
    if (T == 3) {
        var s = x[0] + x[1] + x[2];
        for (var i = 0; i < 3; i++) { y[i] = x[i] + s; }
    } else {
        var t0 = x[0] + x[1];
        var t1 = x[2] + x[3];
        var t2 = 2 * x[1] + t1;
        var t3 = 2 * x[3] + t0;
        var t4 = 4 * t1 + t3;
        var t5 = 4 * t0 + t2;
        y[0] = t3 + t5; y[1] = t5; y[2] = t2 + t4; y[3] = t4;
    }
    return y;
}

// Internal (partial-round) linear layer: y_i = diag_i * x_i + sum(x). diag3=[1,1,2].
function p2_int(T, x) {
    var y[4];
    var d4[4] = P2_DIAG4();
    var s = 0;
    for (var i = 0; i < T; i++) { s += x[i]; }
    for (var i = 0; i < T; i++) {
        if (T == 3) {
            y[i] = (i == 2 ? 2 : 1) * x[i] + s;
        } else {
            y[i] = d4[i] * x[i] + s;
        }
    }
    return y;
}

template Poseidon2Perm(T) {
    assert(T == 3 || T == 4);
    signal input in[T];
    signal output out[T];
    var RF = 8; var RP = 56; var ROUNDS = RF + RP;

    var rc[64][4];
    var rc3[64][3] = P2_RC3();
    var rc4[64][4] = P2_RC4();
    for (var r = 0; r < ROUNDS; r++) {
        for (var i = 0; i < T; i++) { rc[r][i] = (T == 3) ? rc3[r][i] : rc4[r][i]; }
    }

    signal L[ROUNDS + 1][T];          // state after each linear layer (L[0] = initial external layer)
    component sb[ROUNDS][T];

    var x[4];
    var y[4];
    for (var i = 0; i < T; i++) { x[i] = in[i]; }
    y = p2_ext(T, x);
    for (var i = 0; i < T; i++) { L[0][i] <== y[i]; }

    for (var r = 0; r < ROUNDS; r++) {
        var full = (r < RF / 2) || (r >= RF / 2 + RP);
        var z[4];
        for (var i = 0; i < T; i++) {
            if (full || i == 0) {
                sb[r][i] = P2Sbox5();
                sb[r][i].in <== L[r][i] + rc[r][i];
                z[i] = sb[r][i].out;
            } else {
                z[i] = L[r][i];
            }
        }
        if (full) { y = p2_ext(T, z); } else { y = p2_int(T, z); }
        for (var i = 0; i < T; i++) { L[r + 1][i] <== y[i]; }
    }
    for (var i = 0; i < T; i++) { out[i] <== L[ROUNDS][i]; }
}

// 2 data inputs, capacity = CAP (constant). t=3. Same shape as circomlib Poseidon(2) when CAP=0.
template Poseidon2Hash2(CAP) {
    signal input inputs[2];
    signal output out;
    component p = Poseidon2Perm(3);
    p.in[0] <== inputs[0]; p.in[1] <== inputs[1]; p.in[2] <== CAP;
    out <== p.out[0];
}

// 3 data inputs, capacity = CAP (constant). t=4.
template Poseidon2Hash3(CAP) {
    signal input inputs[3];
    signal output out;
    component p = Poseidon2Perm(4);
    p.in[0] <== inputs[0]; p.in[1] <== inputs[1]; p.in[2] <== inputs[2]; p.in[3] <== CAP;
    out <== p.out[0];
}
