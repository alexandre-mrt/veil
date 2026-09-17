pragma circom 2.2.2;
include "@taceo/circom-lib/circuits/poseidon2.circom";

// 2-to-1 compression function built from the Poseidon2 permutation with feed-forward,
// exactly as @taceo/circom-lib's own binary_merkle_root.circom uses it for Merkle nodes
// (state width t=2, no capacity element — the permutation output is fed forward with the
// first input to guarantee one-wayness, a standard Miyaguchi-Preneel-style construction).
template Poseidon2Compress2() {
    signal input in[2];
    signal output out;
    component p = Poseidon2(2);
    p.in <== in;
    out <== p.out[0] + in[0];
}

component main = Poseidon2Compress2();
