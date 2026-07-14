//! Arkworks reimplementation of circuits/transfer.circom (Veil transfer relation).
//!
//! Public inputs in the EXACT circom order (matters for sui::groth16):
//!   oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot
//!
//! Constraints mirrored from transfer.circom:
//!   C0  Merkle membership of oldCommitment, depth 20 (Poseidon(2) internal nodes)
//!   C1  oldCommitment == Poseidon(1, cumulativeOld, randomnessOld, userSecret)
//!   C2  newCommitment == Poseidon(1, cumulativeNew, randomnessNew, userSecret)
//!   C3  cumulativeNew == cumulativeOld + txAmount
//!   C4  txAmount > 0            (64-bit range + non-zero)
//!   C5-C8  cumulativeOld, txAmount, cumulativeNew, threshold in [0, 2^64)
//!   C9  cumulativeNew <= threshold   (threshold - cumulativeNew in [0, 2^64))
//!   C10 nullifier == Poseidon(2, userSecret, epochId, randomnessOld)
//!   C11 txAmountHash == Poseidon(3, txAmount, salt)

use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, BigInteger, One, PrimeField, Zero};
use ark_r1cs_std::boolean::Boolean;
use ark_r1cs_std::eq::EqGadget;
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::fields::FieldVar;
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use crate::poseidon::{circom_params, poseidon_circom_gadget};

pub const MERKLE_DEPTH: usize = 20;
pub const N_PUBLIC_INPUTS: usize = 7;
pub const RANGE_BITS: usize = 64;

/// Domain separation tags (first Poseidon input), identical to transfer.circom.
pub const TAG_COMMITMENT: u64 = 1;
pub const TAG_NULLIFIER: u64 = 2;
pub const TAG_TX_AMOUNT: u64 = 3;

#[derive(Clone, Debug)]
pub struct TransferCircuit {
    // Public (order matters)
    pub old_commitment: Fr,
    pub new_commitment: Fr,
    pub threshold: Fr,
    pub epoch_id: Fr,
    pub nullifier: Fr,
    pub tx_amount_hash: Fr,
    pub merkle_root: Fr,
    // Private
    pub cumulative_old: Fr,
    pub cumulative_new: Fr,
    pub tx_amount: Fr,
    pub randomness_old: Fr,
    pub randomness_new: Fr,
    pub user_secret: Fr,
    pub salt: Fr,
    pub path_elements: [Fr; MERKLE_DEPTH],
    pub path_indices: [bool; MERKLE_DEPTH],
}

impl TransferCircuit {
    /// Structurally valid all-zero instance, used for Groth16 setup.
    pub fn blank() -> Self {
        Self {
            old_commitment: Fr::zero(),
            new_commitment: Fr::zero(),
            threshold: Fr::zero(),
            epoch_id: Fr::zero(),
            nullifier: Fr::zero(),
            tx_amount_hash: Fr::zero(),
            merkle_root: Fr::zero(),
            cumulative_old: Fr::zero(),
            cumulative_new: Fr::zero(),
            tx_amount: Fr::zero(),
            randomness_old: Fr::zero(),
            randomness_new: Fr::zero(),
            user_secret: Fr::zero(),
            salt: Fr::zero(),
            path_elements: [Fr::zero(); MERKLE_DEPTH],
            path_indices: [false; MERKLE_DEPTH],
        }
    }

    /// Public inputs in the canonical circom / on-chain order.
    pub fn public_inputs(&self) -> Vec<Fr> {
        vec![
            self.old_commitment,
            self.new_commitment,
            self.threshold,
            self.epoch_id,
            self.nullifier,
            self.tx_amount_hash,
            self.merkle_root,
        ]
    }
}

/// Enforces `var` in [0, 2^64) by allocating 64 booleans and constraining
/// their recomposition to equal `var` (equivalent of circom Num2Bits(64)).
fn enforce_u64(var: &FpVar<Fr>) -> Result<(), SynthesisError> {
    let cs = var.cs();
    let value = var.value().unwrap_or_default();
    let bigint = value.into_bigint();

    let mut acc = FpVar::<Fr>::zero();
    let mut coeff = Fr::one();
    for i in 0..RANGE_BITS {
        let bit = Boolean::new_witness(cs.clone(), || Ok(bigint.get_bit(i)))?;
        let bit_fp: FpVar<Fr> = From::from(bit);
        acc += bit_fp * coeff;
        coeff.double_in_place();
    }
    acc.enforce_equal(var)
}

impl ConstraintSynthesizer<Fr> for TransferCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // ── Public inputs, EXACT circom order ────────────────────────────────
        let old_commitment = FpVar::new_input(cs.clone(), || Ok(self.old_commitment))?;
        let new_commitment = FpVar::new_input(cs.clone(), || Ok(self.new_commitment))?;
        let threshold = FpVar::new_input(cs.clone(), || Ok(self.threshold))?;
        let epoch_id = FpVar::new_input(cs.clone(), || Ok(self.epoch_id))?;
        let nullifier = FpVar::new_input(cs.clone(), || Ok(self.nullifier))?;
        let tx_amount_hash = FpVar::new_input(cs.clone(), || Ok(self.tx_amount_hash))?;
        let merkle_root = FpVar::new_input(cs.clone(), || Ok(self.merkle_root))?;

        // ── Private witnesses ────────────────────────────────────────────────
        let cumulative_old = FpVar::new_witness(cs.clone(), || Ok(self.cumulative_old))?;
        let cumulative_new = FpVar::new_witness(cs.clone(), || Ok(self.cumulative_new))?;
        let tx_amount = FpVar::new_witness(cs.clone(), || Ok(self.tx_amount))?;
        let randomness_old = FpVar::new_witness(cs.clone(), || Ok(self.randomness_old))?;
        let randomness_new = FpVar::new_witness(cs.clone(), || Ok(self.randomness_new))?;
        let user_secret = FpVar::new_witness(cs.clone(), || Ok(self.user_secret))?;
        let salt = FpVar::new_witness(cs.clone(), || Ok(self.salt))?;

        let path_elements: Vec<FpVar<Fr>> = self
            .path_elements
            .iter()
            .map(|e| FpVar::new_witness(cs.clone(), || Ok(*e)))
            .collect::<Result<_, _>>()?;
        // Boolean::new_witness enforces booleanity (circom: idx * (1 - idx) === 0)
        let path_indices: Vec<Boolean<Fr>> = self
            .path_indices
            .iter()
            .map(|b| Boolean::new_witness(cs.clone(), || Ok(*b)))
            .collect::<Result<_, _>>()?;

        let p2 = circom_params(2);
        let p3 = circom_params(3);
        let p4 = circom_params(4);

        // ── C0: Merkle membership, depth 20 ──────────────────────────────────
        // index bit 0 → node is left child; 1 → node is right child (MultiMux1)
        let mut node = old_commitment.clone();
        for i in 0..MERKLE_DEPTH {
            let sibling = &path_elements[i];
            let left = FpVar::conditionally_select(&path_indices[i], sibling, &node)?;
            let right = FpVar::conditionally_select(&path_indices[i], &node, sibling)?;
            node = poseidon_circom_gadget(&p2, &[left, right])?;
        }
        node.enforce_equal(&merkle_root)?;

        // ── C1/C2: commitment well-formedness, bound to userSecret ───────────
        let tag1 = FpVar::constant(Fr::from(TAG_COMMITMENT));
        let old_hash = poseidon_circom_gadget(
            &p4,
            &[
                tag1.clone(),
                cumulative_old.clone(),
                randomness_old.clone(),
                user_secret.clone(),
            ],
        )?;
        old_hash.enforce_equal(&old_commitment)?;

        let new_hash = poseidon_circom_gadget(
            &p4,
            &[
                tag1,
                cumulative_new.clone(),
                randomness_new.clone(),
                user_secret.clone(),
            ],
        )?;
        new_hash.enforce_equal(&new_commitment)?;

        // ── C3: cumulative update ─────────────────────────────────────────────
        (&cumulative_old + &tx_amount).enforce_equal(&cumulative_new)?;

        // ── C4: txAmount > 0 (non-zero; combined with C6 range check this is
        //        exactly circom GreaterThan(64) against 0) ─────────────────────
        tx_amount
            .is_eq(&FpVar::zero())?
            .enforce_equal(&Boolean::FALSE)?;

        // ── C5-C8: 64-bit range checks ────────────────────────────────────────
        enforce_u64(&cumulative_old)?;
        enforce_u64(&tx_amount)?;
        enforce_u64(&cumulative_new)?;
        enforce_u64(&threshold)?;

        // ── C9: cumulativeNew <= threshold ────────────────────────────────────
        // Both operands are 64-bit constrained, so threshold - cumulativeNew is
        // in [0, 2^64) iff cumulativeNew <= threshold (circom LessEqThan(64)).
        enforce_u64(&(&threshold - &cumulative_new))?;

        // ── C10: nullifier derivation ─────────────────────────────────────────
        let tag2 = FpVar::constant(Fr::from(TAG_NULLIFIER));
        let nf_hash = poseidon_circom_gadget(
            &p4,
            &[tag2, user_secret, epoch_id, randomness_old],
        )?;
        nf_hash.enforce_equal(&nullifier)?;

        // ── C11: txAmountHash derivation ──────────────────────────────────────
        let tag3 = FpVar::constant(Fr::from(TAG_TX_AMOUNT));
        let tx_hash = poseidon_circom_gadget(&p3, &[tag3, tx_amount, salt])?;
        tx_hash.enforce_equal(&tx_amount_hash)?;

        Ok(())
    }
}
