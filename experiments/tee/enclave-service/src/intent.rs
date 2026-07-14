// IntentMessage wrapper — BCS layout MUST match Move struct
// enclave::enclave::IntentMessage<T> { intent: u8, timestamp_ms: u64, payload: T }
// exactly. Field ORDER in the Rust struct definition is what BCS serializes;
// do not reorder. (Nautilus src/nautilus-server/src/common.rs is the reference.)

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct IntentMessage<T: Serialize> {
    pub intent: u8,
    pub timestamp_ms: u64,
    pub data: T,
}

impl<T: Serialize> IntentMessage<T> {
    pub fn new(data: T, timestamp_ms: u64, intent: u8) -> Self {
        Self {
            intent,
            timestamp_ms,
            data,
        }
    }
}

/// Response wrapper: the signed intent message plus the hex signature.
#[derive(Serialize, Deserialize, Debug)]
pub struct ProcessedDataResponse<T> {
    pub response: T,
    pub signature: String,
}

/// Request wrapper.
#[derive(Serialize, Deserialize, Debug)]
pub struct ProcessDataRequest<T> {
    pub payload: T,
}

/// BCS-encode IntentMessage{intent, timestamp_ms, data} and sign it with the
/// enclave ephemeral key. This is byte-for-byte what Move's verify_signature
/// rebuilds and verifies.
pub fn to_signed_response<T: Serialize + Clone>(
    kp: &SigningKey,
    payload: T,
    timestamp_ms: u64,
    intent: u8,
) -> Result<ProcessedDataResponse<IntentMessage<T>>, crate::EnclaveError> {
    let intent_msg = IntentMessage::new(payload, timestamp_ms, intent);
    let signing_bytes = bcs::to_bytes(&intent_msg)
        .map_err(|e| crate::EnclaveError::Internal(format!("BCS serialization failed: {e}")))?;
    let sig = kp.sign(&signing_bytes);
    Ok(ProcessedDataResponse {
        response: intent_msg,
        signature: hex::encode(sig.to_bytes()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Replicates the Nautilus cross-language vector (weather-example):
    /// Rust test_serde in apps/weather-example/mod.rs and Move test_serde in
    /// move/enclave/sources/enclave.move both pin this exact byte string.
    /// Passing here proves our serde+bcs setup produces Move-compatible bytes.
    #[derive(Serialize, Clone)]
    struct WeatherResponse {
        location: String,
        temperature: u64,
    }

    #[test]
    fn test_nautilus_reference_vector() {
        let payload = WeatherResponse {
            location: "San Francisco".to_string(),
            temperature: 13,
        };
        let intent_msg = IntentMessage::new(payload, 1744038900000, 0);
        let bytes = bcs::to_bytes(&intent_msg).unwrap();
        assert_eq!(
            hex::encode(bytes),
            "0020b1d110960100000d53616e204672616e636973636f0d00000000000000"
        );
    }

    #[test]
    fn test_sign_verify_roundtrip() {
        use ed25519_dalek::Verifier;
        let kp = SigningKey::from_bytes(&[7u8; 32]);
        let resp = to_signed_response(
            &kp,
            WeatherResponse {
                location: "x".into(),
                temperature: 1,
            },
            42,
            0,
        )
        .unwrap();
        let bytes = bcs::to_bytes(&resp.response).unwrap();
        let sig = ed25519_dalek::Signature::from_bytes(
            hex::decode(&resp.signature)
                .unwrap()
                .as_slice()
                .try_into()
                .unwrap(),
        );
        kp.verifying_key().verify(&bytes, &sig).unwrap();
    }
}
