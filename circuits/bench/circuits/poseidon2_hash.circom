pragma circom 2.2.2;

include "../../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Poseidon2Hash(nInputs) mirrors circomlib's Poseidon(nInputs) sponge shape exactly:
// state = [0 (capacity), inputs[0..nInputs-1]], padded with zeros to the nearest state
// width @taceo/circom-lib has round constants for ({2,3,4,8,12,16}), run the Poseidon2
// permutation, squeeze state[0]. Domain separation (the numeric tag Veil puts in
// inputs[0]) is unchanged from the current scheme -- only the permutation is swapped.
template Poseidon2Hash(nInputs) {
    signal input inputs[nInputs];
    signal output out;

    var need = nInputs + 1;
    var t = 16;
    if (need <= 2) { t = 2; }
    else if (need <= 3) { t = 3; }
    else if (need <= 4) { t = 4; }
    else if (need <= 8) { t = 8; }
    else if (need <= 12) { t = 12; }

    signal state[t];
    state[0] <== 0;
    for (var i = 0; i < nInputs; i++) {
        state[i + 1] <== inputs[i];
    }
    for (var i = need; i < t; i++) {
        state[i] <== 0;
    }

    component perm = Poseidon2(t);
    perm.in <== state;
    out <== perm.out[0];
}
