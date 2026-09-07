pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

// Isolates one Poseidon(3) instance — used for txAmountHash/context-binding
// hashes in transfer.circom and compliance.circom (2 domain-tagged inputs + tag).
component main {public [inputs]} = Poseidon(3);
