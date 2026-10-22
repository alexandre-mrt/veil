module gasbench::gasbench;

use sui::groth16;

/// n x (prepare_verifying_key + verify) — exactly what veil::verifier does per call today.
public fun full_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) {
        let pvk = groth16::prepare_verifying_key(&curve, &vk);
        let p = groth16::proof_points_from_bytes(copy proof);
        let x = groth16::public_proof_inputs_from_bytes(copy inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 1);
        i = i + 1;
    };
}

/// n x prepare_verifying_key only.
public fun prepare_n(vk: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) {
        let _pvk = groth16::prepare_verifying_key(&curve, &vk);
        i = i + 1;
    };
}

/// prepare once, then n x verify with the prepared key (what storing a PVK on-chain would cost).
public fun prepared_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let mut i = 0;
    while (i < n) {
        let p = groth16::proof_points_from_bytes(copy proof);
        let x = groth16::public_proof_inputs_from_bytes(copy inputs);
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &x, &p), 1);
        i = i + 1;
    };
}
