pragma circom 2.2.2;
include "@taceo/circom-lib/circuits/precomputations.circom";
template CompressionProbe() {
    signal input a;
    signal input b;
    signal output out;
    var res[2] = TACEO_PRECOMPUTATION_Poseidon2(2)([a, b]);
    out <== res[0] + a;
}
component main = CompressionProbe();
