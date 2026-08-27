pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2 equivalent of old_recipient2.circom: 1 real data input, domain
// tag 8 moved into the dedicated capacity element instead of the rate.
// T=2 (rate 1, capacity 1) is a supported Poseidon2 state size.
template NewRecipient2() {
    signal input data;
    signal output out;
    signal in[1];
    in[0] <== data;
    out <== Poseidon2Sponge(1, 2, 8)(in);
}

component main = NewRecipient2();
