// Generates the deterministic cross-language test vector consumed by
// move/veil_tee/tests/veil_tee_tests.move.
//
// TEST-ONLY KEY: the fixed seed below exists so the Move test is reproducible.
// The production boot path (main.rs) always generates a fresh random key.
//
// Run: cargo run --bin gen_vector

use ed25519_dalek::{Signer, SigningKey};

use veil_tee_enclave::intent::IntentMessage;
use veil_tee_enclave::issuance::CredentialIssuance;
use veil_tee_enclave::leaf::{compute_credential_leaf, field_to_le32, parse_field_element};
use veil_tee_enclave::CREDENTIAL_ISSUANCE_INTENT;

/// Fixed, publicly-known test seed. NEVER use for a real enclave.
const TEST_SEED: [u8; 32] = [42u8; 32];
/// Fixed timestamp for the vector (2026-07-14, arbitrary but pinned).
const TEST_TIMESTAMP_MS: u64 = 1_784_000_000_000;

fn main() {
    let kp = SigningKey::from_bytes(&TEST_SEED);

    // Veil demo credential (scripts/src/seed-credential-tree.ts parameters).
    let user_secret = parse_field_element("12345").expect("valid field element");
    let leaf = compute_credential_leaf(user_secret, 1, 99_999_999, 42).expect("leaf");
    let payload = CredentialIssuance {
        leaf: field_to_le32(leaf).to_vec(),
        kyc_level: 1,
        expiry_epoch: 99_999_999,
        issuer_id: 42,
    };

    let msg = IntentMessage::new(payload, TEST_TIMESTAMP_MS, CREDENTIAL_ISSUANCE_INTENT);
    let bcs_bytes = bcs::to_bytes(&msg).expect("bcs");
    let sig = kp.sign(&bcs_bytes);

    println!(
        "pk_hex        = {}",
        hex::encode(kp.verifying_key().to_bytes())
    );
    println!("timestamp_ms  = {TEST_TIMESTAMP_MS}");
    println!("intent        = {CREDENTIAL_ISSUANCE_INTENT}");
    println!("leaf_le_hex   = {}", hex::encode(&msg.data.leaf));
    println!("bcs_hex       = {}", hex::encode(&bcs_bytes));
    println!("sig_hex       = {}", hex::encode(sig.to_bytes()));
}
