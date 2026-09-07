pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

// Isolates one Poseidon(4) instance — the commitment/nullifier hasher used
// three times each in transfer.circom and withdraw.circom.
component main {public [inputs]} = Poseidon(4);
