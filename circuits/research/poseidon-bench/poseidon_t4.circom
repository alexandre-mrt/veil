pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated wrapper: circomlib's Poseidon(3) (t=4) — the arity transfer.circom's
// txAmountHash uses (Poseidon(3, txAmount, salt) with the domain tag as input[0]).
component main = Poseidon(3);
