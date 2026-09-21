pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/poseidon_constants.circom";

// Poseidon2-structured permutation, t=3 (a 2-input hash — the same arity as the
// Poseidon(2) circomlib calls used 20x per proof in templates/merkle_proof.circom,
// Veil's Merkle-path hasher).
//
// BENCHMARK-ONLY, NOT a validated Poseidon2 instance. Round constants and matrix
// coefficients below are repurposed from circomlib's existing Poseidon(t=3) parameter
// tables (POSEIDON_C, POSEIDON_M) for convenience — they are not the output of the
// Poseidon2 reference parameter generator, and this permutation's output must never be
// used as a real hash function anywhere. Nothing in this file is included by, or
// reachable from, transfer.circom / compliance.circom / withdraw.circom; it exists only
// so scripts/bench/poseidon-arity.mjs can measure R1CS constraints for it.
//
// What IS structurally faithful to Poseidon2 (Grassi, Khovratovich, Schofnegger 2023),
// and what this circuit exists to test the constraint-count effect of:
//   - an initial linear layer applied once, before round 0;
//   - external ("full") rounds: add a round constant then S-box (x^5) EVERY state
//     element, then a full linear mix;
//   - internal ("partial") rounds: add a round constant then S-box ONLY state[0],
//     then a diag(d) + all-ones linear mix (M_I * x)_i = d_i * x_i + sum_j x_j — the
//     cheap linear layer that is Poseidon2's actual design change from Poseidon, whose
//     partial rounds mix with a full dense matrix instead.
// Same round schedule as circomlib's Poseidon(t=3): R_F = 8 full rounds, R_P = 57
// partial rounds, alpha = 5 S-box — so any constraint-count delta from this circuit is
// attributable to the linear-layer structure, not to a different round count.
template Poseidon2T3() {
    signal input inputs[2];
    signal output out;

    var t = 3;
    var nRoundsF = 8;
    var nRoundsP = 57;
    var totalRounds = nRoundsF + nRoundsP; // 65

    var C[81] = POSEIDON_C(t);   // t*nRoundsF + nRoundsP = 3*8+57 = 81, reused as round constants
    var M[3][3] = POSEIDON_M(t); // reused as the external (full-round) linear layer
    var diag[3];
    for (var i = 0; i < t; i++) {
        diag[i] = M[i][i];       // reused as the internal-round diag(d) entries
    }

    // state[0] = initial state (capacity 0, then the two inputs)
    // state[r+1] = state after round r's full add-round-constant + S-box + linear mix
    signal state[totalRounds + 2][t];
    state[0][0] <== 0;
    state[0][1] <== inputs[0];
    state[0][2] <== inputs[1];

    // Initial linear layer (Poseidon2's distinguishing extra mix before round 0).
    signal initMixed[t];
    for (var i = 0; i < t; i++) {
        var lc = 0;
        for (var j = 0; j < t; j++) {
            lc += M[j][i] * state[0][j];
        }
        initMixed[i] <== lc;
    }
    state[1][0] <== initMixed[0];
    state[1][1] <== initMixed[1];
    state[1][2] <== initMixed[2];

    component fullSigma[nRoundsF][t];
    component partialSigma[nRoundsP];
    signal arked[totalRounds][t];
    signal sboxed[totalRounds][t];
    var cIdx = 0;
    var fullCount = 0;
    var partialCount = 0;

    for (var r = 0; r < totalRounds; r++) {
        var isFull = (r < nRoundsF \ 2) || (r >= totalRounds - nRoundsF \ 2);

        if (isFull) {
            for (var i = 0; i < t; i++) {
                arked[r][i] <== state[r + 1][i] + C[cIdx + i];
            }
            cIdx += t;
        } else {
            arked[r][0] <== state[r + 1][0] + C[cIdx];
            arked[r][1] <== state[r + 1][1];
            arked[r][2] <== state[r + 1][2];
            cIdx += 1;
        }

        if (isFull) {
            for (var i = 0; i < t; i++) {
                fullSigma[fullCount][i] = Sigma();
                fullSigma[fullCount][i].in <== arked[r][i];
                sboxed[r][i] <== fullSigma[fullCount][i].out;
            }
            fullCount += 1;
        } else {
            partialSigma[partialCount] = Sigma();
            partialSigma[partialCount].in <== arked[r][0];
            sboxed[r][0] <== partialSigma[partialCount].out;
            sboxed[r][1] <== arked[r][1];
            sboxed[r][2] <== arked[r][2];
            partialCount += 1;
        }

        if (isFull) {
            for (var i = 0; i < t; i++) {
                var lc = 0;
                for (var j = 0; j < t; j++) {
                    lc += M[j][i] * sboxed[r][j];
                }
                state[r + 2][i] <== lc;
            }
        } else {
            var total = sboxed[r][0] + sboxed[r][1] + sboxed[r][2];
            for (var i = 0; i < t; i++) {
                state[r + 2][i] <== total + diag[i] * sboxed[r][i];
            }
        }
    }

    out <== state[totalRounds + 1][0];
}
