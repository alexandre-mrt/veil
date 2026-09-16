pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

// Baseline (current production) Poseidon, isolated for constraint/proving-time
// measurement against circuits/bench/poseidon2.circom. Same arities Veil
// actually uses: 2 inputs (Merkle sibling hash, templates/merkle_proof.circom,
// 20x per transfer/compliance proof) and 3 inputs (txAmountHash / compliance
// nfHash / compliance ctxHash).
template PoseidonHash2() {
    signal input inputs[2];
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    out <== h.out;
}

template PoseidonHash3() {
    signal input inputs[3];
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    h.inputs[2] <== inputs[2];
    out <== h.out;
}
