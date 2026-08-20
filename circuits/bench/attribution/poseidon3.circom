pragma circom 2.1.0;

// Isolation fixture — a single Poseidon(3) instance (transfer.circom's txHash,
// compliance.circom's nfHash/ctxHash). See poseidon2.circom for why this exists.

include "../../node_modules/circomlib/circuits/poseidon.circom";

component main = Poseidon(3);
