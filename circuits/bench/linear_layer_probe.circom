pragma circom 2.0.0;

// linear_layer_probe.circom
//
// NOT a Poseidon or Poseidon2 implementation. This is a controlled microbenchmark that isolates
// a single variable: does the *density* of a Poseidon-style linear layer's constant linear
// combination (dense t x t MDS matmul, as circomlib's Poseidon uses in every full round, vs. a
// sparse/cheap circulant construction, the structural trick Poseidon2 uses for its external
// rounds) change the R1CS constraint count or measured proving time, once circom's default (O1)
// signal-to-signal linear simplification runs?
//
// Both variants below share, byte-for-byte:
//   - t (the real arity from a Veil circuit call site: t=3 for Poseidon(2) in merkle_proof.circom,
//     t=5 for Poseidon(4) in transfer.circom/withdraw.circom)
//   - the real nRoundsF / nRoundsP round schedule and Ark round constants from
//     circomlib's poseidon_constants.circom (POSEIDON_C, N_ROUNDS_P), so the S-box gate count
//     matches what the real circuits actually pay.
//   - the Sigma (x^5) S-box, verbatim from circomlib/circuits/poseidon.circom.
//
// They differ ONLY in the linear-mix step applied after every round (both full-round-position and
// partial-round-position rounds use the same mix here, uniformly -- this deliberately does not
// reproduce circomlib's MixS/P sparse partial-round trick, since that trick is itself already
// O(t) and mathematically tied to the specific dense M it's derived from; reproducing it for an
// arbitrary alternate matrix would require re-deriving that decomposition, which is exactly the
// "needs official audited parameters" step this experiment could not complete -- see the report's
// Approach section for why this scope was chosen).
//
// Neither variant is a validated hash function and neither is wired into any production circuit.

include "../node_modules/circomlib/circuits/poseidon.circom";

// Dense mix: circomlib's real POSEIDON_M(t) MDS matrix, t terms per output row.
template MixDense(t) {
    signal input in[t];
    signal output out[t];
    var M[t][t] = POSEIDON_M(t);
    var lc;
    for (var i = 0; i < t; i++) {
        lc = 0;
        for (var j = 0; j < t; j++) {
            lc += M[j][i] * in[j];
        }
        out[i] <== lc;
    }
}

// Cheap mix: circulant(2,1,1,...,1) = all-ones matrix + identity, i.e. out[i] = sum(in) + in[i].
// This is exactly Poseidon2's published external-round matrix for t=3 (Grassi/Khovratovich/
// Schofnegger, "Poseidon2", section on efficient external matrices for small t), generalized in
// the same structural form for t=5. Native cost: t additions to build the sum, then t more
// additions -- zero field multiplications, vs. MixDense's t^2 constant multiplications.
template MixCheap(t) {
    signal input in[t];
    signal output out[t];
    var sum = 0;
    for (var i = 0; i < t; i++) {
        sum += in[i];
    }
    for (var i = 0; i < t; i++) {
        out[i] <== sum + in[i];
    }
}

// N rounds of (Ark; Sigma S-box on the first `sboxWidth` elements; linear mix), using the real
// t, round schedule, and round constants for Poseidon(nInputs). `dense` selects which mix template
// runs. sboxWidth[r] = t for full-round positions (r < nRoundsF/2 or r >= nRoundsF/2+nRoundsP),
// 1 for partial-round positions -- matching circomlib's real full/partial split so total Sigma
// gate count equals what PoseidonEx(nInputs,1) actually pays.
template LinearLayerProbe(nInputs, dense) {
    signal input inputs[nInputs];
    signal output out[nInputs + 1];

    var t = nInputs + 1;
    var N_ROUNDS_P[16] = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];
    var nRoundsF = 8;
    var nRoundsP = N_ROUNDS_P[t - 2];
    var nRounds = nRoundsF + nRoundsP;
    var C[t*nRoundsF + nRoundsP] = POSEIDON_C(t);

    component sigma[nRounds][t];
    component mixD[dense == 1 ? nRounds : 0];
    component mixC[dense == 1 ? 0 : nRounds];

    signal state[nRounds + 1][t];
    signal postArk[nRounds][t];
    signal postSigma[nRounds][t];
    for (var j = 0; j < t; j++) {
        state[0][j] <== (j == 0) ? 0 : inputs[j - 1];
    }

    // Matches circomlib's real constant layout exactly: t constants per full round (added to
    // every element), 1 constant per partial round (added to element 0 only) -- same semantics
    // as production Ark()/MixS(), just inlined so both full- and partial-round positions can be
    // driven from the same C[] array circomlib ships (size t*nRoundsF + nRoundsP).
    var cOff = 0;
    for (var r = 0; r < nRounds; r++) {
        var full = (r < nRoundsF \ 2) || (r >= nRoundsF \ 2 + nRoundsP);

        if (full) {
            for (var j = 0; j < t; j++) {
                postArk[r][j] <== state[r][j] + C[cOff + j];
            }
            cOff += t;
        } else {
            postArk[r][0] <== state[r][0] + C[cOff];
            for (var j = 1; j < t; j++) {
                postArk[r][j] <== state[r][j];
            }
            cOff += 1;
        }

        for (var j = 0; j < t; j++) {
            if (full || j == 0) {
                sigma[r][j] = Sigma();
                sigma[r][j].in <== postArk[r][j];
                postSigma[r][j] <== sigma[r][j].out;
            } else {
                postSigma[r][j] <== postArk[r][j];
            }
        }

        if (dense == 1) {
            mixD[r] = MixDense(t);
            for (var j = 0; j < t; j++) { mixD[r].in[j] <== postSigma[r][j]; }
            for (var j = 0; j < t; j++) { state[r+1][j] <== mixD[r].out[j]; }
        } else {
            mixC[r] = MixCheap(t);
            for (var j = 0; j < t; j++) { mixC[r].in[j] <== postSigma[r][j]; }
            for (var j = 0; j < t; j++) { state[r+1][j] <== mixC[r].out[j]; }
        }
    }

    for (var j = 0; j < t; j++) {
        out[j] <== state[nRounds][j];
    }
}

