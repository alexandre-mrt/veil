pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/comparators.circom";

// Isolates one GreaterEqThan(64) — used for the credential-expiry check in
// compliance.circom (C4).
component main {public [in]} = GreaterEqThan(64);
