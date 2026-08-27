pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2 equivalent of old_commit4.circom: 3 real data inputs, domain
// tag 1 moved into the capacity element. T=4 (rate 3, capacity 1).
template NewCommit4() {
    signal input data[3];
    signal output out;
    out <== Poseidon2Sponge(3, 4, 1)(data);
}

component main = NewCommit4();
