module veil::verifier;

use sui::groth16;

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
