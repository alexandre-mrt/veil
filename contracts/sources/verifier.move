module veil::verifier;

use sui::dynamic_field;
use sui::groth16::{Self, PreparedVerifyingKey};

// Prepared-VK cache (research 2026-11-19-onchain-gas).
// `groth16::prepare_verifying_key` is a native charged per call. The `verify_*_cached`
// functions below prepare a VK once, store the PreparedVerifyingKey as a dynamic field on the
// owning object (Pool or ComplianceConfig), and reuse it on every later verification.
// Soundness invariant: the cached PVK must always be the preparation of the VK bytes currently
// stored on the owner. Every code path that replaces those bytes MUST call `invalidate_pvk`
// for the same slot (pool.move: apply_pending_vk / apply_pending_withdraw_vk;
// compliance.move: apply_pending_compliance_vk). A dynamic field (not a struct field) keeps
// the change upgrade-compatible with already-published Pool / ComplianceConfig layouts.

/// Dynamic-field key for a cached PreparedVerifyingKey on its owning object.
public struct PvkKey has copy, drop, store { slot: u8 }

const PVK_SLOT_TRANSFER: u8 = 0;
const PVK_SLOT_WITHDRAW: u8 = 1;
const PVK_SLOT_COMPLIANCE: u8 = 2;

public(package) fun slot_transfer(): u8 { PVK_SLOT_TRANSFER }
public(package) fun slot_withdraw(): u8 { PVK_SLOT_WITHDRAW }
public(package) fun slot_compliance(): u8 { PVK_SLOT_COMPLIANCE }

/// Verify against the cached PVK for `slot`, preparing and caching it from `vk_bytes` on first use.
public(package) fun verify_cached(
    owner: &mut UID,
    slot: u8,
    vk_bytes: &vector<u8>,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
): bool {
    let key = PvkKey { slot };
    if (!dynamic_field::exists(owner, key)) {
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), vk_bytes);
        dynamic_field::add(owner, key, pvk);
    };
    let pvk: &PreparedVerifyingKey = dynamic_field::borrow(owner, key);
    let proof = groth16::proof_points_from_bytes(proof_bytes);
    let inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
    groth16::verify_groth16_proof(&groth16::bn254(), pvk, &inputs, &proof)
}

/// Drop the cached PVK for `slot` (no-op if none). Must be called whenever the VK bytes change.
public(package) fun invalidate_pvk(owner: &mut UID, slot: u8) {
    let key = PvkKey { slot };
    if (dynamic_field::exists(owner, key)) {
        let _: PreparedVerifyingKey = dynamic_field::remove(owner, key);
    };
}

public(package) fun has_cached_pvk(owner: &UID, slot: u8): bool {
    dynamic_field::exists(owner, PvkKey { slot })
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
