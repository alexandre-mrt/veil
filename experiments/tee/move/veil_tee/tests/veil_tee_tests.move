// Cross-language BCS + signature tests.
//
// Every hex constant below is raw output of the Rust vector generator:
//   cd ../../enclave-service && cargo run --bin gen_vector
// (deterministic: test seed [42u8; 32], timestamp 1784000000000).
//
// The point of this file: if the Rust IntentMessage/CredentialIssuance BCS
// layout diverged from the Move structs by even one byte, TEST_BCS below
// would differ and the Ed25519 verification in record_issuance would fail.

#[test_only]
module veil_tee::veil_tee_tests;

use enclave::enclave;
use sui::clock;
use sui::test_scenario;
use veil_tee::veil_tee;

// --- Rust-generated vector (gen_vector output, 2026-07-14) ---

/// Ed25519 public key of the Rust test keypair.
const TEST_PK: vector<u8> = x"197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61";
/// Veil demo credential leaf Poseidon(4, 12345, 1, 99999999, 42), 32B little-endian.
const TEST_LEAF_LE: vector<u8> = x"c3e0e5a2d389570a12bc66aca0a747a59c64f3a17dd818f0af50de44c2168705";
/// BCS bytes of IntentMessage{intent: 1, timestamp_ms, CredentialIssuance{...}} from Rust.
const TEST_BCS: vector<u8> = x"0100b0af5e9f01000020c3e0e5a2d389570a12bc66aca0a747a59c64f3a17dd818f0af50de44c21687050100000000000000ffe0f505000000002a00000000000000";
/// Ed25519 signature over TEST_BCS by the Rust test keypair.
const TEST_SIG: vector<u8> = x"33b4bfac4470ac1d85ff78f258a3e1366ce54c882748523c641567d89b094bc4bcb7a52fa7000444d99de8e549d38dd7f84761cbc98c130c945f225591b68506";
const TEST_TIMESTAMP_MS: u64 = 1_784_000_000_000;
const TEST_KYC_LEVEL: u64 = 1;
const TEST_EXPIRY_EPOCH: u64 = 99_999_999;
const TEST_ISSUER_ID: u64 = 42;

const ADMIN: address = @0xA;

/// Move must BCS-serialize IntentMessage<CredentialIssuance> to exactly the
/// bytes Rust signed. This is the byte-level parity proof.
#[test]
fun test_bcs_parity_with_rust() {
    let payload = veil_tee::new_credential_issuance_for_testing(
        TEST_LEAF_LE, TEST_KYC_LEVEL, TEST_EXPIRY_EPOCH, TEST_ISSUER_ID,
    );
    let msg = enclave::create_intent_message(
        veil_tee::credential_issuance_intent_for_testing(),
        TEST_TIMESTAMP_MS,
        payload,
    );
    assert!(std::bcs::to_bytes(&msg) == TEST_BCS, 0);
}

/// End-to-end: a signature produced by the Rust service verifies through
/// enclave::verify_signature inside record_issuance.
#[test]
fun test_record_issuance_with_rust_signature() {
    let mut scenario = test_scenario::begin(ADMIN);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clk.set_for_testing(TEST_TIMESTAMP_MS);

    let enc = enclave::new_enclave_for_testing<veil_tee::VEIL_TEE>(TEST_PK, scenario.ctx());
    veil_tee::record_issuance(
        TEST_LEAF_LE, TEST_KYC_LEVEL, TEST_EXPIRY_EPOCH, TEST_ISSUER_ID,
        TEST_TIMESTAMP_MS, &TEST_SIG, &enc, &clk,
    );

    clk.destroy_for_testing();
    enclave::destroy(enc);
    scenario.end();
}

/// Any tampering with the signed fields must break verification.
#[test]
#[expected_failure(abort_code = 1, location = ::veil_tee::veil_tee)]
fun test_tampered_kyc_level_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clk.set_for_testing(TEST_TIMESTAMP_MS);

    let enc = enclave::new_enclave_for_testing<veil_tee::VEIL_TEE>(TEST_PK, scenario.ctx());
    // Attacker upgrades their own KYC level: signature must not verify.
    veil_tee::record_issuance(
        TEST_LEAF_LE, 3, TEST_EXPIRY_EPOCH, TEST_ISSUER_ID,
        TEST_TIMESTAMP_MS, &TEST_SIG, &enc, &clk,
    );

    clk.destroy_for_testing();
    enclave::destroy(enc);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 1, location = ::veil_tee::veil_tee)]
fun test_tampered_leaf_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clk.set_for_testing(TEST_TIMESTAMP_MS);

    let enc = enclave::new_enclave_for_testing<veil_tee::VEIL_TEE>(TEST_PK, scenario.ctx());
    let mut bad_leaf = TEST_LEAF_LE;
    let first = bad_leaf[0] ^ 0x01;
    *(&mut bad_leaf[0]) = first;
    veil_tee::record_issuance(
        bad_leaf, TEST_KYC_LEVEL, TEST_EXPIRY_EPOCH, TEST_ISSUER_ID,
        TEST_TIMESTAMP_MS, &TEST_SIG, &enc, &clk,
    );

    clk.destroy_for_testing();
    enclave::destroy(enc);
    scenario.end();
}

/// Replayed signatures older than MAX_SIGNATURE_AGE_MS must be rejected.
#[test]
#[expected_failure(abort_code = 2, location = ::veil_tee::veil_tee)]
fun test_stale_signature_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    let mut clk = clock::create_for_testing(scenario.ctx());
    // 10 minutes + 1 ms after signing.
    clk.set_for_testing(TEST_TIMESTAMP_MS + 600_001);

    let enc = enclave::new_enclave_for_testing<veil_tee::VEIL_TEE>(TEST_PK, scenario.ctx());
    veil_tee::record_issuance(
        TEST_LEAF_LE, TEST_KYC_LEVEL, TEST_EXPIRY_EPOCH, TEST_ISSUER_ID,
        TEST_TIMESTAMP_MS, &TEST_SIG, &enc, &clk,
    );

    clk.destroy_for_testing();
    enclave::destroy(enc);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 3, location = ::veil_tee::veil_tee)]
fun test_wrong_leaf_length_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clk.set_for_testing(TEST_TIMESTAMP_MS);

    let enc = enclave::new_enclave_for_testing<veil_tee::VEIL_TEE>(TEST_PK, scenario.ctx());
    veil_tee::record_issuance(
        x"c3e0e5", TEST_KYC_LEVEL, TEST_EXPIRY_EPOCH, TEST_ISSUER_ID,
        TEST_TIMESTAMP_MS, &TEST_SIG, &enc, &clk,
    );

    clk.destroy_for_testing();
    enclave::destroy(enc);
    scenario.end();
}
