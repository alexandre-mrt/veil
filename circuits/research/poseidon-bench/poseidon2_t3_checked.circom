pragma circom 2.1.0;

include "./poseidon2_t3_template.circom";

// Soundness check wrapper: pins the permutation's output against an independently
// supplied `expectedOut`, the same pattern transfer.circom itself uses for its
// commitment hashes (`oldCommitment === oldHash.out`). Exists so a witness with a
// mismatched (malicious) `expectedOut` can be shown to be rejected at witness-generation
// time — see scripts/bench/poseidon-arity.mjs's negative test.
template Poseidon2T3Checked() {
    signal input inputs[2];
    signal input expectedOut;

    component p = Poseidon2T3();
    p.inputs[0] <== inputs[0];
    p.inputs[1] <== inputs[1];

    expectedOut === p.out;
}

component main = Poseidon2T3Checked();
