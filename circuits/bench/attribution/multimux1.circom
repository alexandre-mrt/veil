pragma circom 2.1.0;

// Isolation fixture — a single MultiMux1(2) instance, the sibling-order
// selector inside templates/merkle_proof.circom's per-level loop. Included to
// confirm the R1CS-linearity argument in the report: a mux built from
// multiplications by a *witness* bit is non-linear (one constraint per output
// wire), unlike an MDS/linear-diffusion layer multiplied by *constants*.

include "../../node_modules/circomlib/circuits/mux1.circom";

component main = MultiMux1(2);
