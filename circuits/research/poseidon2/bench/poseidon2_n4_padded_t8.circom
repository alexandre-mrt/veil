pragma circom 2.2.2;

include "../hash.circom";

// t = 5 has no native Poseidon2 parameters in the vendored library (only 2,3,4,8,12,16 are
// defined). This measures the practical fallback: pad up to t=8 with zeros. Matches
// Poseidon(4) (commitment hash — the most-called gadget in transfer.circom/withdraw.circom).
component main = Poseidon2HashPadded(4, 8);
