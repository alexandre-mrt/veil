pragma circom 2.2.2;

// Benchmark: single Poseidon(3) call (t=4), production circomlib — the exact
// shape of transfer.circom's txAmountHash = Poseidon(3, tag, txAmount, salt).
// Counterpart: hash_arity3_poseidon2.circom.

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template HashArity3Poseidon() {
    signal input in[3];
    signal output out;
    out <== Poseidon(3)(in);
}

component main = HashArity3Poseidon();
