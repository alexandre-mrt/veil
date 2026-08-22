pragma circom 2.1.0;
include "../../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated single-call microbenchmark: circomlib Poseidon(3) (t=4, e.g.
// txAmountHash / compliance nullifier / context-binding hash). Paired with
// poseidon2_t4.circom. See docs/research/2026-08-22-poseidon2-hash-swap.md.
template BenchPoseidonT4() {
    signal input a;
    signal input b;
    signal input c;
    signal output out;

    component h = Poseidon(3);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    h.inputs[2] <== c;
    out <== h.out;
}
component main = BenchPoseidonT4();
