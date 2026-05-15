module veil::verifier;

use sui::groth16;

// OPTIMIZATION NOTE: For production, store PreparedVerifyingKey in Pool/ComplianceConfig
// at creation time instead of raw VK bytes. Saves ~82K gas per verification.
// Current approach: prepare VK on every call (simpler, correct, but ~82K gas overhead).

public(package) fun verify_transfer_proof(
    vk_bytes: &vector<u8>,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
): bool {
    let pvk = groth16::prepare_verifying_key(&groth16::bn254(), vk_bytes);
    let proof = groth16::proof_points_from_bytes(proof_bytes);
    let inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
    groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &inputs, &proof)
}

public(package) fun verify_compliance_proof(
    vk_bytes: &vector<u8>,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
): bool {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, vk_bytes);
    let proof = groth16::proof_points_from_bytes(proof_bytes);
    let inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
    groth16::verify_groth16_proof(&curve, &pvk, &inputs, &proof)
}

// ---------------------------------------------------------------------------
// Shared byte-manipulation utilities (used by pool.move and compliance.move)
// ---------------------------------------------------------------------------

public(package) fun extract_bytes(data: &vector<u8>, start: u64, end: u64): vector<u8> {
    let mut result = vector[];
    let mut i = start;
    while (i < end) { result.push_back(data[i]); i = i + 1; };
    result
}

public(package) fun le_bytes_to_u64(data: &vector<u8>, offset: u64): u64 {
    let mut result: u64 = 0;
    let mut i: u64 = 0;
    while (i < 8) {
        let byte_val = data[offset + i] as u64;
        // Safe: max shift = 7 * 8 = 56, fits u8 and is valid for u64 shift
        result = result | (byte_val << ((i * 8) as u8));
        i = i + 1;
    };
    result
}

public(package) fun assert_upper_bytes_zero(data: &vector<u8>, start: u64, end: u64, error_code: u64) {
    let mut i = start;
    while (i < end) {
        assert!(data[i] == 0, error_code);
        i = i + 1;
    };
}
