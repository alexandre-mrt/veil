pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

// Isolates one Poseidon(5) instance — the credential-leaf hasher used once
// in compliance.circom.
component main {public [inputs]} = Poseidon(5);
