pragma circom 2.2.2;
include "@taceo/circom-lib/circuits/poseidon2.circom";
template RawPerm2() {
    signal input in[2];
    signal output out[2];
    out <== Poseidon2(2)(in);
}
component main = RawPerm2();
