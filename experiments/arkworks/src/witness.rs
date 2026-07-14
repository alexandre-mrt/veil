//! Canonical spike witness — mirrors js/gen_input.mjs exactly.
//! Ground-truth field values below were produced by circomlibjs
//! (`node js/gen_input.mjs`), the same library Veil's circuit tests use.

use ark_bn254::Fr;
use ark_ff::Zero;
use std::str::FromStr;

use crate::circuit::{TransferCircuit, MERKLE_DEPTH, TAG_COMMITMENT, TAG_NULLIFIER, TAG_TX_AMOUNT};
use crate::poseidon::circom_hash;

// circomlibjs ground truth (js/gen_input.mjs output, 2026-07-14):
pub const CIRCOMLIB_H4_1234: &str =
    "18821383157269793795438455681495246036402687001665670618754263018637548127333";
pub const CIRCOMLIB_H2_12: &str =
    "7853200120776062878684798364095072458815029376092732009249414926327459813530";
pub const CIRCOMLIB_H3_123: &str =
    "6542985608222806190361240322586112750744169038454362455181422643027100751666";
pub const CIRCOMLIB_OLD_COMMITMENT: &str =
    "7548371703584561082839658593061361980956455270690868633197161736002960647843";
pub const CIRCOMLIB_NEW_COMMITMENT: &str =
    "2688629887148342073537685838145252797753711201479693288926408405757990905705";
pub const CIRCOMLIB_NULLIFIER: &str =
    "19894603436503327191194712969350975337182407081962153624505437422083804659952";
pub const CIRCOMLIB_TX_AMOUNT_HASH: &str =
    "9599742744390998394304154161770143278532581444479084582470600660156920475182";
pub const CIRCOMLIB_MERKLE_ROOT: &str =
    "18696181160328159397418193105550380513674592505828123992071068571729439995962";

pub fn fr(s: &str) -> Fr {
    Fr::from_str(s).expect("valid decimal field element")
}

/// Builds the canonical witness with all hashes computed in Rust
/// (light-poseidon circom parameters). Tests assert these equal the
/// circomlibjs ground truth above.
pub fn canonical_circuit() -> TransferCircuit {
    let user_secret = Fr::from(123456789u64);
    let randomness_old = Fr::from(111111u64);
    let randomness_new = Fr::from(222222u64);
    let cumulative_old = Fr::from(100u64);
    let tx_amount = Fr::from(400u64);
    let cumulative_new = cumulative_old + tx_amount;
    let threshold = Fr::from(1000u64);
    let epoch_id = Fr::from(42u64);
    let salt = Fr::from(987654321u64);

    let tag1 = Fr::from(TAG_COMMITMENT);
    let tag2 = Fr::from(TAG_NULLIFIER);
    let tag3 = Fr::from(TAG_TX_AMOUNT);

    let old_commitment = circom_hash(&[tag1, cumulative_old, randomness_old, user_secret]);
    let new_commitment = circom_hash(&[tag1, cumulative_new, randomness_new, user_secret]);
    let nullifier = circom_hash(&[tag2, user_secret, epoch_id, randomness_old]);
    let tx_amount_hash = circom_hash(&[tag3, tx_amount, salt]);

    // Depth-20 tree: single leaf (oldCommitment) at index 0, empty leaves = 0.
    let mut zeros = vec![Fr::zero()];
    for i in 0..MERKLE_DEPTH {
        zeros.push(circom_hash(&[zeros[i], zeros[i]]));
    }
    let mut node = old_commitment;
    let mut path_elements = [Fr::zero(); MERKLE_DEPTH];
    for i in 0..MERKLE_DEPTH {
        path_elements[i] = zeros[i];
        node = circom_hash(&[node, zeros[i]]);
    }
    let merkle_root = node;

    TransferCircuit {
        old_commitment,
        new_commitment,
        threshold,
        epoch_id,
        nullifier,
        tx_amount_hash,
        merkle_root,
        cumulative_old,
        cumulative_new,
        tx_amount,
        randomness_old,
        randomness_new,
        user_secret,
        salt,
        path_elements,
        path_indices: [false; MERKLE_DEPTH],
    }
}
