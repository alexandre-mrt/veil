pragma circom 2.2.2;

// Benchmark: single Poseidon2 sponge call for 4 real inputs (tag + 3 fields).
// @taceo/circom-lib's Poseidon2(t) only supports t in {2,3,4,8,12,16} — the
// Poseidon2 paper's efficient external matrix trick needs t in {2,3} or a
// multiple of 4, so t=5 (this arity's natural width) does not exist. The
// only supported width above 4 is t=8, so this pads 3 unused rate slots with
// zero: capacity(0) + 4 real inputs + 3 padding = 8. This is the HONEST
// number, not a best-case one — see docs/research/2026-08-10-poseidon2-merkle.md
// for why this arity is where Poseidon2 stops being a clean win.
// Counterpart: hash_arity4_poseidon.circom.

include "../../../circuits/templates/poseidon2_hash.circom";

template HashArity4Poseidon2Padded() {
    signal input in[4];
    signal output out;
    signal h <== Poseidon2Hash(8)([0, in[0], in[1], in[2], in[3], 0, 0, 0]);
    out <== h;
}

component main = HashArity4Poseidon2Padded();
