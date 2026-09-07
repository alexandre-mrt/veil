pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

// Isolates one Poseidon(2) instance — the hasher used once per Merkle-tree
// level in templates/merkle_proof.circom (arity 2: node = H(left, right)).
component main {public [inputs]} = Poseidon(2);
