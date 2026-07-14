//! Measured benchmarks: constraint count, setup / prove / verify time, proof size.
//! Run with: cargo run --release --bin bench

use ark_bn254::{Bn254, Fr};
use ark_groth16::Groth16;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_snark::{CircuitSpecificSetupSNARK, SNARK};
use ark_std::rand::rngs::StdRng;
use ark_std::rand::SeedableRng;
use std::time::Instant;

use veil_arkworks_spike::circuit::TransferCircuit;
use veil_arkworks_spike::sui::proof_to_sui_bytes;
use veil_arkworks_spike::witness::canonical_circuit;

const PROVE_ITERS: u32 = 5;
const VERIFY_ITERS: u32 = 100;

fn main() {
    // Constraint count
    let cs = ConstraintSystem::<Fr>::new_ref();
    canonical_circuit().generate_constraints(cs.clone()).unwrap();
    assert!(cs.is_satisfied().unwrap());
    println!("constraints:        {}", cs.num_constraints());
    println!("instance variables: {} (incl. constant one)", cs.num_instance_variables());
    println!("witness variables:  {}", cs.num_witness_variables());

    let mut rng = StdRng::seed_from_u64(42);

    // Setup
    let t0 = Instant::now();
    let (pk, vk) =
        Groth16::<Bn254>::circuit_specific_setup(TransferCircuit::blank(), &mut rng).unwrap();
    println!("setup:              {:?}", t0.elapsed());

    // Prove (average over PROVE_ITERS)
    let circuit = canonical_circuit();
    let public_inputs = circuit.public_inputs();
    let t0 = Instant::now();
    let mut proof = None;
    for _ in 0..PROVE_ITERS {
        proof = Some(Groth16::<Bn254>::prove(&pk, circuit.clone(), &mut rng).unwrap());
    }
    let prove_avg = t0.elapsed() / PROVE_ITERS;
    let proof = proof.unwrap();
    println!("prove (avg of {}):   {:?}", PROVE_ITERS, prove_avg);

    // Verify with plain vk, and with processed vk (what Sui does on-chain)
    let t0 = Instant::now();
    let mut ok = false;
    for _ in 0..VERIFY_ITERS {
        ok = Groth16::<Bn254>::verify(&vk, &public_inputs, &proof).unwrap();
    }
    let verify_avg = t0.elapsed() / VERIFY_ITERS;
    assert!(ok);
    println!("verify (avg of {}): {:?} (includes vk preparation)", VERIFY_ITERS, verify_avg);

    let pvk = Groth16::<Bn254>::process_vk(&vk).unwrap();
    let t0 = Instant::now();
    for _ in 0..VERIFY_ITERS {
        ok = Groth16::<Bn254>::verify_with_processed_vk(&pvk, &public_inputs, &proof).unwrap();
    }
    let verify_pvk_avg = t0.elapsed() / VERIFY_ITERS;
    assert!(ok);
    println!("verify w/ pvk (avg of {}): {:?}", VERIFY_ITERS, verify_pvk_avg);

    println!("proof size:         {} bytes (compressed)", proof_to_sui_bytes(&proof).len());
}
