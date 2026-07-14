// Credential issuance endpoint.
//
// Flow (mirrors Nautilus process_data, src/nautilus-server/src/apps/*):
//   1. Receive a KYC claim.
//   2. Verify it (MOCK here — see `verify_kyc_claim`).
//   3. Derive the Veil credential leaf Poseidon(4, userSecret, kycLevel,
//      expiryEpoch, issuerId).
//   4. Return the leaf wrapped in a signed IntentMessage that Move verifies
//      via enclave::verify_signature.
//
// STATELESSNESS: the claim is consumed by value, `user_secret` is zeroized on
// drop, and nothing in this module (or crate) can persist it — there is no
// storage handle, no static, no interior mutability to write to.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::intent::{to_signed_response, IntentMessage, ProcessDataRequest, ProcessedDataResponse};
use crate::leaf::{compute_credential_leaf, field_to_le32, parse_field_element};
use crate::{AppState, EnclaveError, CREDENTIAL_ISSUANCE_INTENT, MAX_KYC_LEVEL};

/// Applicant claim. In production the enclave would additionally receive KYC
/// provider artifacts (document check results, liveness attestation, ...) and
/// verify them against an allowed endpoint (allowed_endpoints.yaml) before
/// issuing. The secret is wiped from memory when this struct drops.
#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct KycClaim {
    /// User's private secret as decimal or 0x-hex field element. The same
    /// secret the user later feeds to compliance.circom as `userSecret`.
    pub user_secret: String,
    pub kyc_level: u8,
    pub expiry_epoch: u64,
}

/// Signed payload. BCS layout MUST match Move struct
/// veil_tee::veil_tee::CredentialIssuance field-for-field, in order:
///   leaf: vector<u8> (32 bytes, little-endian field element)
///   kyc_level: u64
///   expiry_epoch: u64
///   issuer_id: u64
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CredentialIssuance {
    pub leaf: Vec<u8>,
    pub kyc_level: u64,
    pub expiry_epoch: u64,
    pub issuer_id: u64,
}

/// MOCK KYC verification — the single deliberately-unreal step in this spike.
/// A production enclave performs the actual identity verification here
/// (calls to the KYC provider pinned in allowed_endpoints.yaml, document and
/// liveness checks). Only structural claim validation is done in the spike.
fn verify_kyc_claim(claim: &KycClaim) -> Result<(), EnclaveError> {
    if claim.kyc_level == 0 || claim.kyc_level > MAX_KYC_LEVEL {
        return Err(EnclaveError::KycRejected(format!(
            "kyc_level must be 1..={MAX_KYC_LEVEL}"
        )));
    }
    if claim.expiry_epoch == 0 {
        return Err(EnclaveError::KycRejected(
            "expiry_epoch must be non-zero".to_string(),
        ));
    }
    Ok(())
}

fn current_timestamp_ms() -> Result<u64, EnclaveError> {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| EnclaveError::Internal(format!("system clock before epoch: {e}")))?;
    Ok(dur.as_millis() as u64)
}

/// Pure issuance logic: claim in, signed payload out. Consumes the claim.
pub fn issue(
    state: &AppState,
    claim: KycClaim,
) -> Result<ProcessedDataResponse<IntentMessage<CredentialIssuance>>, EnclaveError> {
    verify_kyc_claim(&claim)?;
    let user_secret = parse_field_element(&claim.user_secret)?;
    let leaf = compute_credential_leaf(
        user_secret,
        claim.kyc_level,
        claim.expiry_epoch,
        state.issuer_id,
    )?;
    let payload = CredentialIssuance {
        leaf: field_to_le32(leaf).to_vec(),
        kyc_level: claim.kyc_level as u64,
        expiry_epoch: claim.expiry_epoch,
        issuer_id: state.issuer_id,
    };
    let timestamp_ms = current_timestamp_ms()?;
    // `claim` (including user_secret) drops — and zeroizes — here.
    to_signed_response(
        &state.eph_kp,
        payload,
        timestamp_ms,
        CREDENTIAL_ISSUANCE_INTENT,
    )
}

/// POST /issue_credential
pub async fn issue_credential(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProcessDataRequest<KycClaim>>,
) -> Result<Json<ProcessedDataResponse<IntentMessage<CredentialIssuance>>>, EnclaveError> {
    // Deliberately no logging of the request body: the claim must leave no trace.
    tracing::info!("issue_credential called");
    issue(&state, request.payload).map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, SigningKey, Verifier};

    fn test_state() -> AppState {
        AppState {
            eph_kp: SigningKey::from_bytes(&[7u8; 32]),
            issuer_id: 42,
        }
    }

    /// Full issuance path for the Veil demo credential: the returned leaf must
    /// be the exact leaf in frontend/src/lib/demoCredential.json (LE bytes),
    /// and the signature must verify over the BCS bytes of the response.
    #[test]
    fn test_issue_demo_credential() {
        let state = test_state();
        let claim = KycClaim {
            user_secret: "12345".to_string(),
            kyc_level: 1,
            expiry_epoch: 99_999_999,
        };
        let resp = issue(&state, claim).unwrap();

        let mut be = resp.response.data.leaf.clone();
        be.reverse();
        assert_eq!(
            hex::encode(be),
            "058716c244de50aff018d87da1f3649ca547a7a0ac66bc120a5789d3a2e5e0c3"
        );
        assert_eq!(resp.response.data.issuer_id, 42);
        assert_eq!(resp.response.intent, CREDENTIAL_ISSUANCE_INTENT);

        let bytes = bcs::to_bytes(&resp.response).unwrap();
        let sig_bytes: [u8; 64] = hex::decode(&resp.signature).unwrap().try_into().unwrap();
        let sig = Signature::from_bytes(&sig_bytes);
        state.eph_kp.verifying_key().verify(&bytes, &sig).unwrap();
    }

    #[test]
    fn test_rejects_kyc_level_zero_and_above_max() {
        let state = test_state();
        for level in [0u8, MAX_KYC_LEVEL + 1] {
            let claim = KycClaim {
                user_secret: "12345".to_string(),
                kyc_level: level,
                expiry_epoch: 99_999_999,
            };
            assert!(
                issue(&state, claim).is_err(),
                "level {level} must be rejected"
            );
        }
    }

    #[test]
    fn test_rejects_invalid_secret() {
        let state = test_state();
        let claim = KycClaim {
            user_secret: "not-a-number".to_string(),
            kyc_level: 1,
            expiry_epoch: 99_999_999,
        };
        assert!(issue(&state, claim).is_err());
    }
}
