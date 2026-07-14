// Veil TEE credential-issuance enclave service (spike).
//
// Follows MystenLabs Nautilus (src/nautilus-server): an ephemeral Ed25519
// keypair is generated at boot, committed to via Nitro attestation (real
// hardware only), and used to sign IntentMessage-wrapped payloads that
// Move verifies with enclave::verify_signature.
//
// STATELESSNESS IS STRUCTURAL: `AppState` holds only immutable key material
// and issuer policy. There is no storage handle, no collection, no interior
// mutability anywhere in this crate — the type system guarantees nothing
// about an applicant survives the request that carried it.

pub mod attestation;
pub mod intent;
pub mod issuance;
pub mod leaf;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use ed25519_dalek::SigningKey;

/// Issuer identifier baked into every credential leaf.
/// Matches Veil's demo issuer (scripts/src/seed-credential-tree.ts ISSUER_ID = 42).
pub const ISSUER_ID: u64 = 42;

/// Intent scope for credential issuance messages. Must match
/// veil_tee.move `CREDENTIAL_ISSUANCE_INTENT`.
pub const CREDENTIAL_ISSUANCE_INTENT: u8 = 1;

/// Highest KYC level this issuer may grant (Veil Tier 3).
pub const MAX_KYC_LEVEL: u8 = 3;

/// Immutable per-boot state. No mutability, no storage: stateless by construction.
pub struct AppState {
    /// Ephemeral keypair generated at boot. In a real Nitro enclave the public
    /// half is committed inside the attestation document (see attestation.rs).
    pub eph_kp: SigningKey,
    pub issuer_id: u64,
}

#[derive(Debug)]
pub enum EnclaveError {
    InvalidInput(String),
    KycRejected(String),
    AttestationUnavailable(String),
    Internal(String),
}

impl IntoResponse for EnclaveError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            EnclaveError::InvalidInput(m) => (StatusCode::BAD_REQUEST, m),
            EnclaveError::KycRejected(m) => (StatusCode::FORBIDDEN, m),
            EnclaveError::AttestationUnavailable(m) => (StatusCode::NOT_IMPLEMENTED, m),
            EnclaveError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, axum::Json(serde_json::json!({ "error": msg }))).into_response()
    }
}
