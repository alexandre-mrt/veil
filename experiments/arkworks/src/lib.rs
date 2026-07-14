//! Arkworks prover-parity spike for the Veil transfer circuit.
//!
//! Answers: can an ark-groth16 (BN254) proof of the transfer relation be
//! verified by sui::groth16, and do circomlib / arkworks Poseidon agree?

pub mod circuit;
pub mod poseidon;
pub mod sui;
pub mod witness;

#[cfg(test)]
mod tests {
    use ark_bn254::{Bn254, Fr};
    use ark_crypto_primitives::sponge::poseidon::find_poseidon_ark_and_mds;
    use ark_groth16::Groth16;
    use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
    use ark_serialize::CanonicalSerialize;
    #[allow(unused_imports)]
    use ark_snark::{CircuitSpecificSetupSNARK, SNARK};
    use ark_std::rand::rngs::StdRng;
    use ark_std::rand::SeedableRng;

    use crate::circuit::{TransferCircuit, TAG_COMMITMENT};
    use crate::poseidon::{circom_hash, circom_params, permute_native, poseidon_circom_gadget};
    use crate::sui::{
        manual_compress_g1, manual_compress_g2, proof_to_sui_bytes, public_inputs_to_sui_bytes,
        vk_to_sui_bytes,
    };
    use crate::witness::{canonical_circuit, fr, *};
    use ark_ff::PrimeField;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(42)
    }

    // ── Finding 1: light-poseidon (circom constants) == circomlibjs ─────────

    #[test]
    fn poseidon_native_matches_circomlib() {
        assert_eq!(
            circom_hash(&[Fr::from(1u64), Fr::from(2u64), Fr::from(3u64), Fr::from(4u64)]),
            fr(CIRCOMLIB_H4_1234)
        );
        assert_eq!(
            circom_hash(&[Fr::from(1u64), Fr::from(2u64)]),
            fr(CIRCOMLIB_H2_12)
        );
        assert_eq!(
            circom_hash(&[Fr::from(1u64), Fr::from(2u64), Fr::from(3u64)]),
            fr(CIRCOMLIB_H3_123)
        );
    }

    #[test]
    fn canonical_witness_matches_circomlib_ground_truth() {
        let c = canonical_circuit();
        assert_eq!(c.old_commitment, fr(CIRCOMLIB_OLD_COMMITMENT));
        assert_eq!(c.new_commitment, fr(CIRCOMLIB_NEW_COMMITMENT));
        assert_eq!(c.nullifier, fr(CIRCOMLIB_NULLIFIER));
        assert_eq!(c.tx_amount_hash, fr(CIRCOMLIB_TX_AMOUNT_HASH));
        assert_eq!(c.merkle_root, fr(CIRCOMLIB_MERKLE_ROOT));
    }

    // ── Finding 2 (empirical, and it REFUTES the naive assumption in part):
    //
    // (a) The ROUND CONSTANTS AND MDS MATCH: ark-crypto-primitives'
    //     `find_poseidon_ark_and_mds::<Fr>(254, rate=4, R_F=8, R_P=60, 0)`
    //     reproduces circomlib's t=5 constants exactly — both derive from the
    //     official hadeshash Grain-LFSR generation.
    //
    // (b) The CONSTRUCTION DIFFERS: ark's PoseidonSponge over the very same
    //     config hashes [1,2,3,4] to a DIFFERENT value than circomlib
    //     (different absorb/domain/output-selection semantics). So any
    //     off-the-shelf arkworks Poseidon (sponge or CRH gadget) is NOT
    //     circom-compatible; a faithful reimplementation of the circom
    //     permutation (as in poseidon.rs) is required — and suffices.

    #[test]
    fn arkworks_grain_constants_match_but_sponge_construction_differs() {
        use ark_crypto_primitives::sponge::poseidon::{PoseidonConfig, PoseidonSponge};
        use ark_crypto_primitives::sponge::{CryptographicSponge, FieldBasedCryptographicSponge};

        let p = circom_params(4); // t=5: full=8, partial=60
        let (ark_rounds, mds) = find_poseidon_ark_and_mds::<Fr>(
            Fr::MODULUS_BIT_SIZE as u64,
            4, // rate (width 5 = rate 4 + capacity 1)
            p.full_rounds as u64,
            p.partial_rounds as u64,
            0,
        );
        let ark_flat: Vec<Fr> = ark_rounds.iter().flatten().cloned().collect();

        // (a) constants are identical
        assert_eq!(ark_flat, p.ark, "Grain round constants match circomlib");
        assert_eq!(mds, p.mds, "Grain MDS matches circomlib");

        // sanity: reference permutation with these constants IS circomlib
        let inputs = [Fr::from(1u64), Fr::from(2u64), Fr::from(3u64), Fr::from(4u64)];
        let with_circom_constants =
            permute_native(&p.ark, &p.mds, p.width, p.full_rounds, p.partial_rounds, &inputs);
        assert_eq!(with_circom_constants, fr(CIRCOMLIB_H4_1234));

        // (b) ark's own sponge construction over the SAME config differs
        let cfg = PoseidonConfig::new(8, 60, 5, mds, ark_rounds, 4, 1);
        let mut sponge = PoseidonSponge::new(&cfg);
        sponge.absorb(&inputs.to_vec());
        let sponge_out: Vec<Fr> = sponge.squeeze_native_field_elements(1);
        assert_ne!(
            sponge_out[0],
            fr(CIRCOMLIB_H4_1234),
            "ark sponge construction unexpectedly matched circomlib"
        );
        println!("circomlib  H(1,2,3,4)     = {}", fr(CIRCOMLIB_H4_1234));
        println!("ark sponge H(1,2,3,4)     = {}", sponge_out[0]);
    }

    // ── Gadget correctness ───────────────────────────────────────────────────

    #[test]
    fn poseidon_gadget_matches_native() {
        use ark_r1cs_std::alloc::AllocVar;
        use ark_r1cs_std::fields::fp::FpVar;
        use ark_r1cs_std::R1CSVar;

        let cs = ConstraintSystem::<Fr>::new_ref();
        for arity in [2usize, 3, 4] {
            let inputs: Vec<Fr> = (1..=arity as u64).map(Fr::from).collect();
            let vars: Vec<FpVar<Fr>> = inputs
                .iter()
                .map(|x| FpVar::new_witness(cs.clone(), || Ok(*x)).unwrap())
                .collect();
            let out = poseidon_circom_gadget(&circom_params(arity), &vars).unwrap();
            assert_eq!(out.value().unwrap(), circom_hash(&inputs), "arity {arity}");
        }
        assert!(cs.is_satisfied().unwrap());
    }

    // ── The relation: satisfied by circomlib-derived values ─────────────────

    #[test]
    fn transfer_circuit_satisfied_by_canonical_witness() {
        let cs = ConstraintSystem::<Fr>::new_ref();
        canonical_circuit().generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
        println!("constraints: {}", cs.num_constraints());
        println!("public inputs (excl. one): {}", cs.num_instance_variables() - 1);
        println!("witness vars: {}", cs.num_witness_variables());
    }

    // ── Groth16 end-to-end ───────────────────────────────────────────────────

    #[test]
    fn groth16_prove_and_verify() {
        let mut rng = rng();
        let (pk, vk) =
            Groth16::<Bn254>::circuit_specific_setup(TransferCircuit::blank(), &mut rng).unwrap();
        let circuit = canonical_circuit();
        let public_inputs = circuit.public_inputs();
        let proof = Groth16::<Bn254>::prove(&pk, circuit, &mut rng).unwrap();
        assert!(Groth16::<Bn254>::verify(&vk, &public_inputs, &proof).unwrap());

        // Wrong public input must not verify.
        let mut bad = public_inputs.clone();
        bad[3] += Fr::from(1u64); // epochId + 1
        assert!(!Groth16::<Bn254>::verify(&vk, &bad, &proof).unwrap());
    }

    // ── Negative tests: malicious witnesses ──────────────────────────────────

    #[test]
    fn malicious_witness_bad_sum_fails() {
        // cumulativeNew = cumulativeOld + txAmount + 1, with newCommitment
        // recomputed over the bogus value so C2 holds — C3 must catch it.
        let mut c = canonical_circuit();
        c.cumulative_new += Fr::from(1u64);
        c.new_commitment = circom_hash(&[
            Fr::from(TAG_COMMITMENT),
            c.cumulative_new,
            c.randomness_new,
            c.user_secret,
        ]);

        let cs = ConstraintSystem::<Fr>::new_ref();
        c.clone().generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap(), "bad-sum witness must not satisfy");

        // And it must not yield a verifying proof.
        let mut rng = rng();
        let (pk, vk) =
            Groth16::<Bn254>::circuit_specific_setup(TransferCircuit::blank(), &mut rng).unwrap();
        let public_inputs = c.public_inputs();
        let result = std::panic::catch_unwind(move || {
            let mut rng = StdRng::seed_from_u64(7);
            Groth16::<Bn254>::prove(&pk, c, &mut rng)
        });
        match result {
            Err(_) => (), // prover refused (debug assertion) — cannot produce proof
            Ok(Err(_)) => (),
            Ok(Ok(proof)) => {
                assert!(
                    !Groth16::<Bn254>::verify(&vk, &public_inputs, &proof).unwrap(),
                    "proof from bad-sum witness must not verify"
                );
            }
        }
    }

    #[test]
    fn malicious_witness_bogus_merkle_path_fails() {
        let mut c = canonical_circuit();
        c.path_elements[5] += Fr::from(1u64);

        let cs = ConstraintSystem::<Fr>::new_ref();
        c.clone().generate_constraints(cs.clone()).unwrap();
        assert!(
            !cs.is_satisfied().unwrap(),
            "bogus merkle path must not satisfy"
        );

        let mut rng = rng();
        let (pk, vk) =
            Groth16::<Bn254>::circuit_specific_setup(TransferCircuit::blank(), &mut rng).unwrap();
        let public_inputs = c.public_inputs();
        let result = std::panic::catch_unwind(move || {
            let mut rng = StdRng::seed_from_u64(7);
            Groth16::<Bn254>::prove(&pk, c, &mut rng)
        });
        match result {
            Err(_) => (),
            Ok(Err(_)) => (),
            Ok(Ok(proof)) => {
                assert!(
                    !Groth16::<Bn254>::verify(&vk, &public_inputs, &proof).unwrap(),
                    "proof from bogus merkle path must not verify"
                );
            }
        }
    }

    #[test]
    fn malicious_witness_over_threshold_fails() {
        // cumulativeNew > threshold (recompute commitments consistently).
        let mut c = canonical_circuit();
        c.cumulative_old = Fr::from(800u64);
        c.tx_amount = Fr::from(400u64);
        c.cumulative_new = Fr::from(1200u64); // threshold = 1000
        c.old_commitment = circom_hash(&[
            Fr::from(TAG_COMMITMENT),
            c.cumulative_old,
            c.randomness_old,
            c.user_secret,
        ]);
        c.new_commitment = circom_hash(&[
            Fr::from(TAG_COMMITMENT),
            c.cumulative_new,
            c.randomness_new,
            c.user_secret,
        ]);
        // Rebuild merkle path over new old_commitment (leaf 0, zero siblings).
        let mut zeros = vec![Fr::from(0u64)];
        for i in 0..crate::circuit::MERKLE_DEPTH {
            zeros.push(circom_hash(&[zeros[i], zeros[i]]));
        }
        let mut node = c.old_commitment;
        for i in 0..crate::circuit::MERKLE_DEPTH {
            c.path_elements[i] = zeros[i];
            node = circom_hash(&[node, zeros[i]]);
        }
        c.merkle_root = node;
        // recompute other hashes touched by changed inputs
        c.nullifier = circom_hash(&[
            Fr::from(crate::circuit::TAG_NULLIFIER),
            c.user_secret,
            c.epoch_id,
            c.randomness_old,
        ]);
        c.tx_amount_hash = circom_hash(&[
            Fr::from(crate::circuit::TAG_TX_AMOUNT),
            c.tx_amount,
            c.salt,
        ]);

        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(
            !cs.is_satisfied().unwrap(),
            "over-threshold witness must not satisfy"
        );
    }

    // ── Sui serialization layout parity with proof-converter.ts ─────────────

    #[test]
    fn sui_byte_layout_matches_proof_converter() {
        let mut rng = rng();
        let (pk, vk) =
            Groth16::<Bn254>::circuit_specific_setup(TransferCircuit::blank(), &mut rng).unwrap();
        let circuit = canonical_circuit();
        let public_inputs = circuit.public_inputs();
        let proof = Groth16::<Bn254>::prove(&pk, circuit, &mut rng).unwrap();

        // Proof: 128 bytes = A(32) | B(64) | C(32)
        let proof_bytes = proof_to_sui_bytes(&proof);
        assert_eq!(proof_bytes.len(), 128);
        assert_eq!(&proof_bytes[0..32], &manual_compress_g1(&proof.a)[..]);
        assert_eq!(&proof_bytes[32..96], &manual_compress_g2(&proof.b)[..]);
        assert_eq!(&proof_bytes[96..128], &manual_compress_g1(&proof.c)[..]);

        // VK: 32 + 64 + 64 + 64 + 8 + 8*32 = 488 bytes (7 public inputs → 8 IC)
        let vk_bytes = vk_to_sui_bytes(&vk);
        assert_eq!(vk_bytes.len(), 488);
        assert_eq!(&vk_bytes[0..32], &manual_compress_g1(&vk.alpha_g1)[..]);
        assert_eq!(&vk_bytes[32..96], &manual_compress_g2(&vk.beta_g2)[..]);
        assert_eq!(&vk_bytes[96..160], &manual_compress_g2(&vk.gamma_g2)[..]);
        assert_eq!(&vk_bytes[160..224], &manual_compress_g2(&vk.delta_g2)[..]);
        // ic_len as u64 LE
        assert_eq!(&vk_bytes[224..232], &8u64.to_le_bytes()[..]);
        for (i, ic) in vk.gamma_abc_g1.iter().enumerate() {
            let start = 232 + i * 32;
            assert_eq!(&vk_bytes[start..start + 32], &manual_compress_g1(ic)[..]);
        }

        // Public inputs: 7 * 32 LE bytes
        let pi_bytes = public_inputs_to_sui_bytes(&public_inputs);
        assert_eq!(pi_bytes.len(), 224);
        // First scalar LE roundtrip check
        let mut first = Vec::new();
        public_inputs[0].serialize_compressed(&mut first).unwrap();
        assert_eq!(&pi_bytes[0..32], &first[..]);
    }
}
