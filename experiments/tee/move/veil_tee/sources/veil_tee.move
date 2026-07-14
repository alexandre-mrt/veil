// Veil TEE credential issuance — on-chain verification (spike).
//
// Verifies that a credential leaf was derived by the attested issuer enclave,
// then emits it for the credential-tree maintainer. In the target design the
// pool admin no longer vouches for leaves: a leaf enters the tree only with a
// valid enclave signature, so the issuer is exactly the code measured by the
// PCRs pinned in EnclaveConfig<VEIL_TEE>.
//
// Integration boundary (kept out of this spike on purpose): a production
// version would call veil::compliance::update_credential_root from a module
// that accumulates CredentialIssuedEvent leaves. This package only proves the
// enclave-signature layer.

module veil_tee::veil_tee;

use enclave::enclave::{Self, Enclave};
use sui::clock::Clock;
use sui::event;

// === Constants ===

/// Intent scope for credential issuance. Must match Rust
/// CREDENTIAL_ISSUANCE_INTENT (enclave-service/src/lib.rs).
const CREDENTIAL_ISSUANCE_INTENT: u8 = 1;
/// Maximum accepted age of an enclave signature (replay window).
const MAX_SIGNATURE_AGE_MS: u64 = 600_000;
/// Credential leaves are 32-byte little-endian BN254 field elements.
const LEAF_LENGTH_BYTES: u64 = 32;

// === Errors ===

const E_INVALID_SIGNATURE: u64 = 1;
const E_STALE_SIGNATURE: u64 = 2;
const E_INVALID_LEAF_LENGTH: u64 = 3;

// === Types ===

/// OTW for the enclave witness pattern.
public struct VEIL_TEE has drop {}

/// Signed payload. BCS layout MUST match Rust struct CredentialIssuance
/// (enclave-service/src/issuance.rs) field-for-field, in declaration order.
public struct CredentialIssuance has copy, drop {
    leaf: vector<u8>,
    kyc_level: u64,
    expiry_epoch: u64,
    issuer_id: u64,
}

/// Emitted once an enclave-signed issuance is verified on-chain. The
/// credential-tree maintainer consumes these to insert leaves and publish the
/// new root via compliance::update_credential_root. Contains no applicant
/// identity — only the blinded Poseidon leaf.
public struct CredentialIssuedEvent has copy, drop {
    leaf: vector<u8>,
    kyc_level: u64,
    expiry_epoch: u64,
    issuer_id: u64,
    timestamp_ms: u64,
}

// === Init ===

fun init(otw: VEIL_TEE, ctx: &mut TxContext) {
    let cap = enclave::new_cap(otw, ctx);
    // PCRs start zeroed (dev). MUST be set to the reproducible-build values
    // via update_pcrs before production registration — see README.
    cap.create_enclave_config(
        b"veil credential issuer enclave".to_string(),
        x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        ctx,
    );
    transfer::public_transfer(cap, ctx.sender())
}

// === Public API ===

/// Verify an enclave-signed credential issuance and emit the leaf.
///
/// Bound to `Enclave<VEIL_TEE>` on purpose (NOT generic): `Enclave<VEIL_TEE>`
/// can only be created by `enclave::register_enclave` against the single
/// `EnclaveConfig<VEIL_TEE>` from this module's `init` (its `Cap<VEIL_TEE>`
/// requires the one-time witness). A generic `Enclave<T>` would let anyone
/// register an enclave under their own witness type and forge events.
public fun record_issuance(
    leaf: vector<u8>,
    kyc_level: u64,
    expiry_epoch: u64,
    issuer_id: u64,
    timestamp_ms: u64,
    sig: &vector<u8>,
    enclave: &Enclave<VEIL_TEE>,
    clock: &Clock,
) {
    assert!(leaf.length() == LEAF_LENGTH_BYTES, E_INVALID_LEAF_LENGTH);
    assert!(timestamp_ms + MAX_SIGNATURE_AGE_MS >= clock.timestamp_ms(), E_STALE_SIGNATURE);
    let valid = enclave.verify_signature(
        CREDENTIAL_ISSUANCE_INTENT,
        timestamp_ms,
        CredentialIssuance { leaf, kyc_level, expiry_epoch, issuer_id },
        sig,
    );
    assert!(valid, E_INVALID_SIGNATURE);
    event::emit(CredentialIssuedEvent {
        leaf,
        kyc_level,
        expiry_epoch,
        issuer_id,
        timestamp_ms,
    });
}

// === Test helpers ===

#[test_only]
public fun new_credential_issuance_for_testing(
    leaf: vector<u8>,
    kyc_level: u64,
    expiry_epoch: u64,
    issuer_id: u64,
): CredentialIssuance {
    CredentialIssuance { leaf, kyc_level, expiry_epoch, issuer_id }
}

#[test_only]
public fun credential_issuance_intent_for_testing(): u8 { CREDENTIAL_ISSUANCE_INTENT }
