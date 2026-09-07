pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/comparators.circom";

// Isolates one LessEqThan(64) — used for the threshold check in
// transfer.circom (C9) and the withdraw-amount check in withdraw.circom (C5).
component main {public [in]} = LessEqThan(64);
