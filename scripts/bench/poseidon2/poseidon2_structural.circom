pragma circom 2.0.0;
// STRUCTURAL Poseidon2 permutation (x^5 S-box, BN254) for R1CS-cost measurement ONLY.
// Round constants and the internal diagonal are PLACEHOLDERS (small integers), NOT a secure
// instance: constraint count depends on structure (S-box count, linear-layer shape), not on
// constants. Do not use for hashing. Structure per Poseidon2 (eprint 2023/323):
//   x -> M_E x ; R_F/2 full rounds (add rc, x^5 on all, M_E) ;
//   R_P partial rounds (add rc[0], x^5 on lane 0, M_I) ; R_F/2 full rounds.
template Pow5() {
    signal input in; signal output out;
    signal s2; signal s4;
    s2 <== in*in; s4 <== s2*s2; out <== s4*in;
}
// external linear layer: t=2: circ(2,1); t=3: circ(2,1,1); t=4: M4 block matrix
template ExtMix(t) {
    signal input in[t]; signal output out[t];
    if (t == 2) { out[0] <== 2*in[0]+in[1]; out[1] <== in[0]+2*in[1]; }
    if (t == 3) { var s = in[0]+in[1]+in[2]; for (var i=0;i<3;i++) out[i] <== s+in[i]; }
    if (t == 4) {
        var m[4][4] = [[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]];
        for (var i=0;i<4;i++) { var a=0; for (var j=0;j<4;j++) a += m[i][j]*in[j]; out[i] <== a; }
    }
}
template IntMix(t) {
    signal input in[t]; signal output out[t];
    var s = 0; for (var i=0;i<t;i++) s += in[i];
    for (var i=0;i<t;i++) out[i] <== s + (i+2)*in[i]; // placeholder diagonal
}
template Poseidon2Perm(t, RF, RP) {
    signal input in[t]; signal output out[t];
    signal st[RF+RP+1][t];
    component e0 = ExtMix(t);
    for (var i=0;i<t;i++) e0.in[i] <== in[i];
    for (var i=0;i<t;i++) st[0][i] <== e0.out[i];
    component sb[RF+RP][t]; component ex[RF]; component ix[RP];
    var fi = 0; var pi = 0;
    for (var r=0; r<RF+RP; r++) {
        var full = (r < RF/2 || r >= RF/2+RP);
        if (full) {
            ex[fi] = ExtMix(t);
            for (var i=0;i<t;i++) { sb[r][i] = Pow5(); sb[r][i].in <== st[r][i] + (r+i+1); ex[fi].in[i] <== sb[r][i].out; }
            for (var i=0;i<t;i++) st[r+1][i] <== ex[fi].out[i];
            fi++;
        } else {
            ix[pi] = IntMix(t);
            sb[r][0] = Pow5(); sb[r][0].in <== st[r][0] + (r+1);
            ix[pi].in[0] <== sb[r][0].out;
            for (var i=1;i<t;i++) ix[pi].in[i] <== st[r][i];
            for (var i=0;i<t;i++) st[r+1][i] <== ix[pi].out[i];
            pi++;
        }
    }
    for (var i=0;i<t;i++) out[i] <== st[RF+RP][i];
}
// Drop-in shim for circomlib's Poseidon(N) (same `inputs[N]` / `out` interface) using ONLY the
// standardised Poseidon2 widths t in {2,3,4} (no t=5/6 instance exists), so cost is realistic:
//   N<=3 : one permutation, t=N+1, capacity lane = 0, all N inputs absorbed (same t as circomlib)
//   N==4 : one permutation, t=4, inputs[0] (the domain tag) seeds the capacity lane, rest absorbed
//   N==5 : two permutations at t=4 (tag in capacity, absorb 3 then 1), sponge rate 3
template Poseidon2Shim(N) {
    signal input inputs[N]; signal output out;
    if (N <= 3) {
        component p = Poseidon2Perm(N+1, 8, 56);
        p.in[0] <== 0;
        for (var i=0;i<N;i++) p.in[i+1] <== inputs[i];
        out <== p.out[0];
    }
    if (N == 4) {
        component p = Poseidon2Perm(4, 8, 56);
        for (var i=0;i<4;i++) p.in[i] <== inputs[i];
        out <== p.out[0];
    }
    if (N == 5) {
        component p1 = Poseidon2Perm(4, 8, 56);
        for (var i=0;i<4;i++) p1.in[i] <== inputs[i];
        component p2 = Poseidon2Perm(4, 8, 56);
        p2.in[0] <== p1.out[0];
        p2.in[1] <== p1.out[1] + inputs[4];
        p2.in[2] <== p1.out[2];
        p2.in[3] <== p1.out[3];
        out <== p2.out[0];
    }
}
