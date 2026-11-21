/// Bench-only probe (never deployed): isolates the per-call cost of sui::groth16 so it can be
/// measured above the per-transaction computation floor. Mirrors veil::verifier exactly.
module veil_gas_probe::probe;

use sui::groth16;

/// n × (prepare_verifying_key + verify) — what veil::verifier does on every proof today.
public fun prepare_and_verify_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) {
        let pvk = groth16::prepare_verifying_key(&curve, &vk);
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 0);
        i = i + 1;
    };
}

/// prepare once, then n × verify — the "store PreparedVerifyingKey" alternative.
public fun verify_prepared_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let mut i = 0;
    while (i < n) {
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 0);
        i = i + 1;
    };
}

/// n × prepare only.
public fun prepare_n(vk: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) {
        let _pvk = groth16::prepare_verifying_key(&curve, &vk);
        i = i + 1;
    };
}
