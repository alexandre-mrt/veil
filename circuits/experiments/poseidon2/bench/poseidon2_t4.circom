pragma circom 2.1.0;
include "../../../templates/poseidon2_hash.circom";

// Isolated single-call microbenchmark: Poseidon2Hash(3) (t=4). Paired with
// poseidon_t4.circom. See docs/research/2026-08-22-poseidon2-hash-swap.md.
template BenchPoseidon2T4() {
    signal input a;
    signal input b;
    signal input c;
    signal output out;

    component h = Poseidon2Hash(3);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    h.inputs[2] <== c;
    out <== h.out;
}
component main = BenchPoseidon2T4();
