pragma circom 2.1.0;
include "../../../templates/poseidon2_hash.circom";

// Isolated single-call microbenchmark: Poseidon2Hash(2) (t=3). Paired with
// poseidon_t3.circom. See docs/research/2026-08-22-poseidon2-hash-swap.md.
template BenchPoseidon2T3() {
    signal input a;
    signal input b;
    signal output out;

    component h = Poseidon2Hash(2);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    out <== h.out;
}
component main = BenchPoseidon2T3();
