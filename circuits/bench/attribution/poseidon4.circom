pragma circom 2.1.0;

// Isolation fixture — a single Poseidon(4) instance (transfer.circom's oldHash/
// newHash/nfHash, withdraw.circom's commHash/changeHash/nfHash). See
// poseidon2.circom for why this exists.

include "../../node_modules/circomlib/circuits/poseidon.circom";

component main = Poseidon(4);
