pragma circom 2.1.0;

// Isolated gadget benchmark — see scripts/bench/gadget-constraints.sh.
// Measures the R1CS cost of exactly one Poseidon(2) instance in isolation,
// so the total constraint count of a full circuit (e.g. transfer.circom's
// 20-level MerkleProof, or withdraw.circom's recipHash) can be attributed
// back to this single number times however many instances it uses.

include "../node_modules/circomlib/circuits/poseidon.circom";

template BenchPoseidon2() {
    signal input in0;
    signal input in1;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== in0;
    h.inputs[1] <== in1;
    out <== h.out;
}

component main = BenchPoseidon2();
