pragma circom 2.2.2;

// Benchmark: single Poseidon(4) call (t=5), production circomlib — the exact
// shape of transfer.circom's oldCommitment/newCommitment/nullifier hashes,
// e.g. Poseidon(4, tag, cumulative, randomness, userSecret).
// Counterpart: hash_arity4_poseidon2_padded.circom.

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template HashArity4Poseidon() {
    signal input in[4];
    signal output out;
    out <== Poseidon(4)(in);
}

component main = HashArity4Poseidon();
