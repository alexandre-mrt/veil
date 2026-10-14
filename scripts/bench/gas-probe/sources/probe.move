/// Bench-only package: repeats Veil's on-chain Groth16 primitives n times inside one
/// transaction so that the (bucketed) computation charge can be resolved by bisection on n.
/// Uses the same `sui::groth16` natives and the same call sequence as contracts/sources/verifier.move.
module veil_gas_probe::probe;

use sui::groth16;

/// n x prepare_verifying_key (the part Veil repeats on every call).
public fun loop_prepare(vk: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) { let _ = groth16::prepare_verifying_key(&curve, &vk); i = i + 1; };
}

/// n x (prepare_verifying_key + verify) — exactly what verifier::verify_*_proof does per call today.
public fun loop_verify_full(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) {
        let pvk = groth16::prepare_verifying_key(&curve, &vk);
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 1);
        i = i + 1;
    };
}

/// prepare once, then n x verify — the "store the PreparedVerifyingKey" optimisation.
public fun loop_verify_prepared(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let mut i = 0;
    while (i < n) {
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 1);
        i = i + 1;
    };
}

/// Empty loop: interpreter/loop overhead floor.
public fun loop_noop(n: u64) {
    let mut i = 0;
    while (i < n) { i = i + 1; };
}
