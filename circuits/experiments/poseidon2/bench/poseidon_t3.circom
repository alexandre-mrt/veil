pragma circom 2.1.0;
include "../../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated single-call microbenchmark: circomlib Poseidon(2) (t=3, e.g. one
// Merkle-tree node hash). Paired with poseidon2_t3.circom for a clean
// per-primitive constraint delta. See docs/research/2026-08-22-poseidon2-hash-swap.md.
template BenchPoseidonT3() {
    signal input a;
    signal input b;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    out <== h.out;
}
component main = BenchPoseidonT3();
