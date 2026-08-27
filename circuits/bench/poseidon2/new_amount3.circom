pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2 equivalent of old_amount3.circom: 2 real data inputs, domain
// tag 3 moved into the capacity element. T=3 (rate 2, capacity 1).
template NewAmount3() {
    signal input data[2];
    signal output out;
    out <== Poseidon2Sponge(2, 3, 3)(data);
}

component main = NewAmount3();
