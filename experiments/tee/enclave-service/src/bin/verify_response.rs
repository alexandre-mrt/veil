// Offline verifier for a live /issue_credential response.
//
// Reads the JSON response from stdin, takes the enclave pk (hex, from
// /health_check) as argv[1], re-derives the BCS signing bytes exactly like
// Move's enclave::verify_signature does, and checks the Ed25519 signature.
//
// Usage:
//   curl -s -X POST localhost:3000/issue_credential -d '...' \
//     | cargo run --bin verify_response -- <pk_hex>

use std::io::Read;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use veil_tee_enclave::intent::{IntentMessage, ProcessedDataResponse};
use veil_tee_enclave::issuance::CredentialIssuance;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pk_hex = std::env::args()
        .nth(1)
        .ok_or("usage: verify_response <pk_hex> (response JSON on stdin)")?;
    let pk_bytes: [u8; 32] = hex::decode(&pk_hex)?
        .try_into()
        .map_err(|_| "pk must be 32 bytes")?;
    let pk = VerifyingKey::from_bytes(&pk_bytes)?;

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let resp: ProcessedDataResponse<IntentMessage<CredentialIssuance>> =
        serde_json::from_str(&input)?;

    let bcs_bytes = bcs::to_bytes(&resp.response)?;
    let sig_bytes: [u8; 64] = hex::decode(&resp.signature)?
        .try_into()
        .map_err(|_| "signature must be 64 bytes")?;
    let sig = Signature::from_bytes(&sig_bytes);

    pk.verify(&bcs_bytes, &sig)?;
    let mut leaf_be = resp.response.data.leaf.clone();
    leaf_be.reverse();
    println!("SIGNATURE VALID");
    println!("bcs_hex      = {}", hex::encode(&bcs_bytes));
    println!("leaf (BE)    = 0x{}", hex::encode(leaf_be));
    println!("kyc_level    = {}", resp.response.data.kyc_level);
    println!("expiry_epoch = {}", resp.response.data.expiry_epoch);
    println!("issuer_id    = {}", resp.response.data.issuer_id);
    Ok(())
}
