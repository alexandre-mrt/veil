pragma circom 2.0.0;

include "poseidon.circom";

// circomlib's Poseidon(2) — 2 inputs, t = nInputs + 1 = 3. This is the
// exact template Veil's circuits already use for arity-2 Poseidon calls
// (merkle path steps, recipientHash). Compared directly against
// main_poseidon2_t3.circom, both compiled with the same circom binary.
component main {public [inputs]} = Poseidon(2);
