// Attestation endpoint.
//
// The genuine path (feature = "nitro") mirrors Nautilus
// src/nautilus-server/src/common.rs get_attestation: it asks the Nitro Secure
// Module for an attestation document committed to the enclave's ephemeral
// public key. It only works inside an AWS Nitro Enclave (/dev/nsm).
//
// UNPROVEN IN THIS SPIKE: this machine is a Mac with no NSM device, so the
// `nitro` feature has never been compiled or executed here. The default build
// returns 501 with an honest error instead of a fake attestation document.

use std::sync::Arc;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::{AppState, EnclaveError};

/// Hex-encoded CBOR attestation document (matches Nautilus GetAttestationResponse).
#[derive(Debug, Serialize, Deserialize)]
pub struct GetAttestationResponse {
    pub attestation: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthCheckResponse {
    /// Hex-encoded ephemeral Ed25519 public key generated at boot.
    pub pk: String,
    pub issuer_id: u64,
    /// True only when built with the `nitro` feature inside a Nitro Enclave.
    pub attestation_available: bool,
}

/// GET /health_check
pub async fn health_check(
    State(state): State<Arc<AppState>>,
) -> Result<Json<HealthCheckResponse>, EnclaveError> {
    Ok(Json(HealthCheckResponse {
        pk: hex::encode(state.eph_kp.verifying_key().to_bytes()),
        issuer_id: state.issuer_id,
        attestation_available: cfg!(feature = "nitro"),
    }))
}

/// GET /get_attestation — genuine NSM path, Nitro hardware only.
#[cfg(feature = "nitro")]
pub async fn get_attestation(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GetAttestationResponse>, EnclaveError> {
    use nsm_api::api::{Request as NsmRequest, Response as NsmResponse};
    use nsm_api::driver;
    use serde_bytes::ByteBuf;

    let pk = state.eph_kp.verifying_key().to_bytes().to_vec();
    let fd = driver::nsm_init();
    let request = NsmRequest::Attestation {
        user_data: None,
        nonce: None,
        public_key: Some(ByteBuf::from(pk)),
    };
    let response = driver::nsm_process_request(fd, request);
    driver::nsm_exit(fd);
    match response {
        NsmResponse::Attestation { document } => Ok(Json(GetAttestationResponse {
            attestation: hex::encode(document),
        })),
        _ => Err(EnclaveError::Internal(
            "unexpected NSM response".to_string(),
        )),
    }
}

/// GET /get_attestation — dev build: honest failure, never a fake document.
#[cfg(not(feature = "nitro"))]
pub async fn get_attestation(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<GetAttestationResponse>, EnclaveError> {
    Err(EnclaveError::AttestationUnavailable(
        "built without the `nitro` feature: no Nitro Secure Module on this host. \
         A genuine attestation document requires running inside an AWS Nitro Enclave."
            .to_string(),
    ))
}
