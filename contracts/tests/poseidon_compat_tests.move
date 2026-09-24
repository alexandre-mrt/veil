#[test_only]
module veil::poseidon_compat_tests;

use sui::poseidon;

// Reference values computed independently off-chain with circomlibjs 0.1.7's buildPoseidon()
// (the exact permutation withdraw.circom's `Poseidon(2)` template compiles to). If this test
// ever fails after a Sui framework upgrade, sui::poseidon::poseidon_bn254 has diverged from
// circomlib's Poseidon and the on-chain recipient-hash check in pool.move::zk_withdraw is no
// longer sound — treat as a critical regression, not a flake.
#[test]
fun test_poseidon_bn254_matches_circomlibjs_reference_vectors() {
    assert!(
        poseidon::poseidon_bn254(&vector[8u256, 12345u256])
            == 7163575327242158666077169141605442609494059320358707772268333069888638990040u256,
        0,
    );
    assert!(
        poseidon::poseidon_bn254(&vector[8u256, 0u256])
            == 3389212708216144879186174190097808449254289024066134177507956630700586741844u256,
        1,
    );
    assert!(
        poseidon::poseidon_bn254(&vector[8u256, 1u256])
            == 365457035153223777471802539189832243157897367080642673562402074993874281703u256,
        2,
    );
    assert!(
        poseidon::poseidon_bn254(
            &vector[8u256, 739782792349518527365724145340899278661696636413071683630452473529711456000u256]
        ) == 334127709492056454786748719113802606371996487778193307372369739479136801427u256,
        3,
    );
}
