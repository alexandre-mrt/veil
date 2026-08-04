pragma circom 2.0.0;

include "../../../circuits/templates/poseidon2_t3.circom";

// Commitment-style wrapper used only for the negative (malicious-witness)
// test: constrains Poseidon2Hash2(in[0], in[1]) == expected. A witness
// where `expected` doesn't match the real hash must fail constraint
// satisfaction — see circuits/test/poseidon2.test.mjs.
template Poseidon2Commit() {
    signal input in[2];
    signal input expected;

    component h = Poseidon2Hash2();
    h.in[0] <== in[0];
    h.in[1] <== in[1];

    expected === h.out;
}

component main {public [expected]} = Poseidon2Commit();
