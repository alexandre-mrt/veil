pragma circom 2.2.2;
include "@taceo/circom-lib/circuits/poseidon2.circom";

// Poseidon2 in sponge/hash mode: state width t hashes (t-1) field elements
// (rate = t-1, capacity = 1), matching circomlib Poseidon(n)'s n-inputs convention.
template Poseidon2Arity(t) {
    signal input in[t-1];
    signal output out;
    signal state[t];
    state[0] <== 0;
    for (var i = 0; i < t-1; i++) { state[i+1] <== in[i]; }
    component p = Poseidon2(t);
    p.in <== state;
    out <== p.out[0];
}
