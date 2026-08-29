pragma circom 2.2.2;

// Benchmark-only wrapper used solely for the negative test in
// scripts/bench/poseidon2-negative.mjs: takes a claimed permutation output as
// an explicit *input* signal (rather than deriving it) so a malicious witness
// that asserts a wrong output is something the R1CS can actually reject.
// Poseidon2(4) itself has no such failure mode when used normally (its output
// is always computed, never claimed), so this wrapper exists only to give the
// negative-witness test something to attack. Not wired into any protocol circuit.
include "@taceo/circom-lib/circuits/poseidon2.circom";

template Poseidon2Check4() {
    signal input in[4];
    signal input claimedOut[4];

    signal computed[4] <== Poseidon2(4)(in);

    for (var i = 0; i < 4; i++) {
        claimedOut[i] === computed[i];
    }
}

component main = Poseidon2Check4();
