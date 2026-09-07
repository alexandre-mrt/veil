pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/comparators.circom";

// Isolates one GreaterThan(64) — used for the txAmount/withdrawAmount > 0
// checks in transfer.circom and withdraw.circom.
component main {public [in]} = GreaterThan(64);
