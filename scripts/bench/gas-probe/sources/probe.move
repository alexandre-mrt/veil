/// Gas probe — NOT part of the Veil protocol. Isolates the cost of the `sui::groth16` natives that
/// `veil::verifier` calls, by repeating them n times inside one transaction so the result can be
/// read against Sui's computation-gas buckets (see scripts/bench/gas-probe.ts).
module gas_probe::probe;

use sui::groth16;

/// What veil::verifier does today: prepare the VK from raw bytes and verify, per call.
public fun prepare_and_verify_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let mut i = 0;
    while (i < n) {
        let curve = groth16::bn254();
        let pvk = groth16::prepare_verifying_key(&curve, &vk);
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 1);
        i = i + 1;
    }
}

/// Only prepare_verifying_key, n times.
public fun prepare_n(vk: vector<u8>, n: u64) {
    let mut i = 0;
    while (i < n) {
        let _pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
        i = i + 1;
    }
}

/// Prepare once, verify n times — the cost if the PreparedVerifyingKey were stored on-chain.
public fun verify_prepared_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let mut i = 0;
    while (i < n) {
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 1);
        i = i + 1;
    }
}

/// Empty loop control (call overhead + argument bytes only).
public fun noop(_vk: vector<u8>, _proof: vector<u8>, _inputs: vector<u8>, _n: u64) {}
