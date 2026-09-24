module veil::verifier;

use sui::address;
use sui::bcs;
use sui::groth16;
use sui::poseidon;

/// BN254 scalar field size (Fr). Matches `R` in `scripts/src/proof-converter.ts` and the
/// modulus circom/snarkjs reduce every signal into.
const BN254_SCALAR_FIELD: u256 =
    21888242871839275222246405745257275088548364400416034343698204186575808495617;

/// Domain tag for `withdraw.circom`'s recipient binding (`recipientHash = Poseidon(8, recipient)`).
const RECIPIENT_DOMAIN_TAG: u256 = 8;

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

public(package) fun verify_withdraw_proof(
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

/// Reads a 32-byte little-endian public-input chunk as a BN254 field element. Public inputs
/// are serialized little-endian by `publicInputsToSuiBytes` (`scripts/src/proof-converter.ts`).
public(package) fun bytes_to_field(data: &vector<u8>, start: u64, end: u64): u256 {
    bcs::new(extract_bytes(data, start, end)).peel_u256()
}

/// Reduces a Sui address into the BN254 scalar field exactly as the withdraw witness generator
/// must: `address::to_u256` treats the 32 raw address bytes as a big-endian integer, and the
/// circuit's `recipient` signal is that integer reduced mod the field size (addresses are
/// 256-bit; the field is ~254-bit, so an unreduced address is not always a canonical field
/// element). This mapping is 4-to-1 (not 1-to-1), but every one of the ~3 other addresses that
/// reduce to the same field element is a uniformly random 256-bit value nobody can select a
/// keypair for — see the recipient-binding soundness argument in
/// `docs/research/2026-09-24-recipient-binding-fix.md`.
public(package) fun recipient_to_field(recipient: address): u256 {
    address::to_u256(recipient) % BN254_SCALAR_FIELD
}

/// Recomputes `recipientHash = Poseidon(8, recipient)` exactly as `withdraw.circom`'s C9
/// constraint does, using Sui's native BN254 Poseidon precompile. `poseidon_compat_tests.move`
/// pins this against independently-computed circomlibjs reference vectors so a future Sui
/// framework upgrade that silently changed the permutation would fail loudly here instead of
/// quietly breaking the on-chain binding check in `pool::zk_withdraw`.
public(package) fun expected_recipient_hash(recipient: address): u256 {
    poseidon::poseidon_bn254(&vector[RECIPIENT_DOMAIN_TAG, recipient_to_field(recipient)])
}
