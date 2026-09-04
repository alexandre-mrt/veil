pragma circom 2.1.0;

include "../../node_modules/@taceo/circom-lib/circuits/compression.circom";

// Poseidon2-based compression, analogous to circomlib's `Poseidon(nInputs)` but
// following the SAFE framework (https://eprint.iacr.org/2023/522): the domain tag
// goes into the sponge's capacity element (`ds`) instead of consuming a rate slot.
// One Poseidon2 permutation as long as nVals <= T - 1 (true for every shape used
// below — see docs/research/2026-09-04-poseidon2-constraints.md for the width
// table). `T` must be one of Poseidon2's supported state sizes {2,3,4,8,12,16}
// and is the caller's responsibility to pick as the smallest such T >= nVals + 1.
//
// `ds` here is a simplified stand-in for full SAFE domain separation (tag, arity
// and width folded into one field element via distinct multipliers so the three
// don't alias each other for the small values used in this repo) — not the
// paper's SHA3-256-derived tag. @taceo/circom-lib's own `Compression` template
// (circuits/compression.circom) shows the full derivation; a production port of
// this design should use that, not this shortcut.
template Poseidon2CompressTagged(nVals, T, tag) {
    signal input vals[nVals];
    signal output out;

    assert(nVals >= 1);
    assert(nVals <= T - 1);

    var ds = tag + 1009 * nVals + 1000003 * T;
    signal dsSig <== ds;

    out <== Poseidon2Sponge(nVals, T)(vals, dsSig);
}

// Poseidon2 equivalent of templates/merkle_proof.circom's per-level hash: combines
// a node with its sibling (order selected by `pathIndex`, 0 = node is left) into
// the parent. Adds a domain tag (MERKLE_TAG) the current circomlib-based Merkle
// hasher does not have — free under SAFE, and closes the (today purely
// theoretical — different arities already produce disjoint R1CS components, so
// there is no actual proof-malleability gap) possibility of a Merkle-level hash
// colliding with some other same-arity Poseidon2 use elsewhere in the protocol.
template MerkleLevelPoseidon2(MERKLE_TAG) {
    signal input left;
    signal input right;
    signal output out;

    signal vals[2];
    vals[0] <== left;
    vals[1] <== right;
    out <== Poseidon2CompressTagged(2, 3, MERKLE_TAG)(vals);
}
