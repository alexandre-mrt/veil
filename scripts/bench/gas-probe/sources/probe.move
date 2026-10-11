/// Bench-only wrappers around sui::groth16, so a PTB can call the exact primitives
/// veil::verifier uses N times in one transaction and the computation bucket can be bracketed.
/// Never deployed outside a local benchmark network.
module gas_probe::probe;

use sui::groth16;

/// Same sequence as veil::verifier::verify_*_proof: prepare VK, parse proof + inputs, verify.
public fun verify_full(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let pp = groth16::proof_points_from_bytes(proof);
    let pi = groth16::public_proof_inputs_from_bytes(inputs);
    assert!(groth16::verify_groth16_proof(&curve, &pvk, &pi, &pp), 1);
}

/// Only the VK-preparation step (the "~82K" the verifier.move comment refers to).
public fun prepare_only(vk: vector<u8>) {
    let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
    let _ = pvk;
}

/// No-op control: same PTB shape and argument sizes, zero crypto.
public fun noop(_vk: vector<u8>, _proof: vector<u8>, _inputs: vector<u8>) {}
