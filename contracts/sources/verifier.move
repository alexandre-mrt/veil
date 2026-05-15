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
