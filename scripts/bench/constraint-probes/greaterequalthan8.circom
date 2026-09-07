pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/comparators.circom";

// Isolates one GreaterEqThan(8) — used for the KYC-level check in
// compliance.circom (C5).
component main {public [in]} = GreaterEqThan(8);
