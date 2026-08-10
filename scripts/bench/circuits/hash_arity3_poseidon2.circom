pragma circom 2.2.2;

// Benchmark: single Poseidon2(4) sponge call (t=4, capacity 0 + 3-element
// rate) — the natively-supported Poseidon2 equivalent of Poseidon(3), no
// padding needed since t=4 is one of @taceo/circom-lib's supported widths.
// Counterpart: hash_arity3_poseidon.circom.

include "../../../circuits/templates/poseidon2_hash.circom";

template HashArity3Poseidon2() {
    signal input in[3];
    signal output out;
    signal h <== Poseidon2Hash(4)([0, in[0], in[1], in[2]]);
    out <== h;
}

component main = HashArity3Poseidon2();
