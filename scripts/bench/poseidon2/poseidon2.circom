pragma circom 2.1.0;
// Poseidon2 permutation (t=3 and t=4, BN254, d=5, RF=8, RP=56) + a drop-in `Poseidon(n)` shim.
// EXPERIMENTAL — cost measurement only. Not security-reviewed; do not use in production circuits.
include "poseidon2_consts.circom";

template P2Sbox5() {
    signal input in;
    signal output out;
    signal x2;
    signal x4;
    x2 <== in * in;
    x4 <== x2 * x2;
    out <== x4 * in;
}

// External (full-round) linear layer. t=3: circ(2,1,1). t=4: Poseidon2 M4 block.
function p2ext(T, s) {
    var o[4];
    if (T == 3) {
        var sum = s[0] + s[1] + s[2];
        o[0] = s[0] + sum; o[1] = s[1] + sum; o[2] = s[2] + sum;
    } else {
        var t0 = s[0] + s[1];
        var t1 = s[2] + s[3];
        var t2 = 2 * s[1] + t1;
        var t3 = 2 * s[3] + t0;
        var t4 = 4 * t1 + t3;
        var t5 = 4 * t0 + t2;
        o[0] = t3 + t5; o[1] = t5; o[2] = t2 + t4; o[3] = t4;
    }
    return o;
}

template Poseidon2Perm(T) {
    assert(T == 3 || T == 4);
    signal input in[T];
    signal output out[T];

    component fs[4][T];   // first 4 full rounds
    component ps[56];     // partial rounds (one sbox each)
    component ls[4][T];   // last 4 full rounds

    var st[4];
    for (var i = 0; i < T; i++) st[i] = in[i];
    st = p2ext(T, st);

    for (var r = 0; r < 64; r++) {
        var isFull = (r < 4) || (r >= 60);
        if (isFull) {
            var nx[4];
            for (var i = 0; i < T; i++) {
                var rcv = T == 3 ? p2rc3(r, i) : p2rc4(r, i);
                if (r < 4) { fs[r][i] = P2Sbox5(); fs[r][i].in <== st[i] + rcv; nx[i] = fs[r][i].out; }
                else       { ls[r - 60][i] = P2Sbox5(); ls[r - 60][i].in <== st[i] + rcv; nx[i] = ls[r - 60][i].out; }
            }
            st = p2ext(T, nx);
        } else {
            var rc0 = T == 3 ? p2rc3(r, 0) : p2rc4(r, 0);
            ps[r - 4] = P2Sbox5();
            ps[r - 4].in <== st[0] + rc0;
            var sum = ps[r - 4].out;
            for (var i = 1; i < T; i++) sum += st[i];
            var nx2[4];
            nx2[0] = (T == 3 ? p2diag3(0) : p2diag4(0)) * ps[r - 4].out + sum;
            for (var i = 1; i < T; i++) nx2[i] = (T == 3 ? p2diag3(i) : p2diag4(i)) * st[i] + sum;
            st = nx2;
        }
    }
    for (var i = 0; i < T; i++) out[i] <== st[i];
}

// Sponge over the permutation. Capacity lane 0 = n (input length), inputs added into rate lanes
// 1..T-1, output = rate lane 1 after the last permutation.
template Poseidon2Sponge(N, T) {
    signal input inputs[N];
    signal output out;
    var rate = T - 1;
    var nperm = (N + rate - 1) \ rate;
    component perm[nperm];
    var absorbed = 0;
    for (var p = 0; p < nperm; p++) {
        perm[p] = Poseidon2Perm(T);
        for (var i = 0; i < T; i++) {
            var base = 0;
            if (p == 0) { if (i == 0) base = N; }
            else base = perm[p - 1].out[i];
            var lane = base;
            if (i >= 1 && absorbed + i - 1 < N) lane += inputs[absorbed + i - 1];
            perm[p].in[i] <== lane;
        }
        absorbed += rate;
    }
    out <== perm[nperm - 1].out[1];
}

// Drop-in replacement for circomlib's Poseidon(nInputs): same port names. 2 inputs -> t=3
// (1 permutation); 3..5 inputs -> t=4 (rate 3: 1 permutation for 3, 2 for 4-5).
template Poseidon(nInputs) {
    signal input inputs[nInputs];
    signal output out;
    var T = nInputs <= 2 ? 3 : 4;
    component sp = Poseidon2Sponge(nInputs, T);
    for (var i = 0; i < nInputs; i++) sp.inputs[i] <== inputs[i];
    out <== sp.out;
}
