module veil::compliance;

use sui::dynamic_field;
use sui::event;
use veil::pool::{Self, Pool, AdminCap};
use veil::verifier;

const E_COMPLIANCE_PROOF_INVALID: u64 = 20;
const E_CREDENTIAL_NULLIFIER_SPENT: u64 = 21;
const E_CREDENTIAL_ROOT_MISMATCH: u64 = 22;
const E_INVALID_COMPLIANCE_INPUTS: u64 = 23;
const E_CREDENTIAL_INVALID: u64 = 25;
const E_CONFIG_POOL_MISMATCH: u64 = 26;
const E_EPOCH_MISMATCH: u64 = 8;

public struct ComplianceConfig has key {
    id: UID,
    pool_id: ID,
    compliance_vk: vector<u8>,
    credential_root: vector<u8>,
    required_kyc_level: u64,
    auditor_key: vector<u8>,
}

public struct CredentialNullifierKey has copy, drop, store { bytes: vector<u8> }

public struct ComplianceConfigCreatedEvent has copy, drop {
    config_id: ID,
    pool_id: ID,
    required_kyc_level: u64,
}

public struct ComplianceVerifiedEvent has copy, drop {
    credential_nullifier: vector<u8>,
    encrypted_amount: vector<u8>,
}

public struct CredentialRootUpdatedEvent has copy, drop {
    config_id: ID,
    new_root: vector<u8>,
}

public struct AuditorKeyUpdatedEvent has copy, drop {
    config_id: ID,
}

public struct KycLevelUpdatedEvent has copy, drop {
    config_id: ID,
    new_level: u64,
}

public fun create_compliance_config(
    cap: &AdminCap,
    pool: &Pool,
    compliance_vk: vector<u8>,
    credential_root: vector<u8>,
    required_kyc_level: u64,
    auditor_key: vector<u8>,
    ctx: &mut TxContext,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(credential_root.length() == 32, E_INVALID_COMPLIANCE_INPUTS);

    let config_uid = object::new(ctx);
    let config_id = config_uid.to_inner();
    let pool_id = object::id(pool);

    let config = ComplianceConfig {
        id: config_uid,
        pool_id,
        compliance_vk,
        credential_root,
        required_kyc_level,
        auditor_key,
    };

    transfer::share_object(config);
    event::emit(ComplianceConfigCreatedEvent { config_id, pool_id, required_kyc_level });
}

public fun compliant_transfer(
    pool: &mut Pool,
    config: &mut ComplianceConfig,
    transfer_proof_bytes: vector<u8>,
    transfer_inputs_bytes: vector<u8>,
    compliance_proof_bytes: vector<u8>,
    compliance_inputs_bytes: vector<u8>,
    encrypted_amount: vector<u8>,
    clock: &sui::clock::Clock,
    _ctx: &TxContext,
) {
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);

    pool::verify_and_execute_transfer(pool, transfer_proof_bytes, transfer_inputs_bytes, clock);

    assert!(compliance_inputs_bytes.length() == 192, E_INVALID_COMPLIANCE_INPUTS);

    let proof_root = extract_bytes(&compliance_inputs_bytes, 0, 32);
    assert!(proof_root == config.credential_root, E_CREDENTIAL_ROOT_MISMATCH);

    let proof_epoch = le_bytes_to_u64(&compliance_inputs_bytes, 32);
    assert_upper_bytes_zero(&compliance_inputs_bytes, 40, 64);
    let on_chain_epoch = pool::current_epoch(clock);
    assert!(proof_epoch == on_chain_epoch, E_EPOCH_MISMATCH);

    // contextId binding to transferNullifier is proven inside the ZK circuit
    // (contextId = Poseidon(6, transferNullifier, userSecret)), verified by Groth16

    let proof_kyc_level = le_bytes_to_u64(&compliance_inputs_bytes, 96);
    assert_upper_bytes_zero(&compliance_inputs_bytes, 104, 128);
    assert!(proof_kyc_level == config.required_kyc_level, E_INVALID_COMPLIANCE_INPUTS);

    let credential_nullifier = extract_bytes(&compliance_inputs_bytes, 128, 160);
    let cred_nf_key = CredentialNullifierKey { bytes: credential_nullifier };
    assert!(
        !dynamic_field::exists_(pool::pool_uid(pool), cred_nf_key),
        E_CREDENTIAL_NULLIFIER_SPENT,
    );

    let valid_flag = le_bytes_to_u64(&compliance_inputs_bytes, 160);
    assert_upper_bytes_zero(&compliance_inputs_bytes, 168, 192);
    assert!(valid_flag == 1, E_CREDENTIAL_INVALID);

    let valid = verifier::verify_compliance_proof(
        &config.compliance_vk,
        compliance_proof_bytes,
        compliance_inputs_bytes,
    );
    assert!(valid, E_COMPLIANCE_PROOF_INVALID);

    dynamic_field::add(pool::pool_uid_mut(pool), cred_nf_key, true);

    event::emit(ComplianceVerifiedEvent {
        credential_nullifier,
        encrypted_amount,
    });
}

public fun update_credential_root(
    config: &mut ComplianceConfig,
    cap: &AdminCap,
    pool: &Pool,
    new_root: vector<u8>,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);
    assert!(new_root.length() == 32, E_INVALID_COMPLIANCE_INPUTS);
    config.credential_root = new_root;
    event::emit(CredentialRootUpdatedEvent { config_id: config.id.to_inner(), new_root });
}

public fun update_auditor_key(
    config: &mut ComplianceConfig,
    cap: &AdminCap,
    pool: &Pool,
    new_key: vector<u8>,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);
    config.auditor_key = new_key;
    event::emit(AuditorKeyUpdatedEvent { config_id: config.id.to_inner() });
}

public fun update_required_kyc_level(
    config: &mut ComplianceConfig,
    cap: &AdminCap,
    pool: &Pool,
    new_level: u64,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);
    config.required_kyc_level = new_level;
    event::emit(KycLevelUpdatedEvent {
        config_id: config.id.to_inner(),
        new_level,
    });
}

public fun credential_root(config: &ComplianceConfig): vector<u8> { config.credential_root }
public fun required_kyc_level(config: &ComplianceConfig): u64 { config.required_kyc_level }
public fun auditor_key(config: &ComplianceConfig): vector<u8> { config.auditor_key }
public fun config_pool_id(config: &ComplianceConfig): ID { config.pool_id }

fun extract_bytes(data: &vector<u8>, start: u64, end: u64): vector<u8> {
    let mut result = vector[];
    let mut i = start;
    while (i < end) { result.push_back(data[i]); i = i + 1; };
    result
}

fun le_bytes_to_u64(data: &vector<u8>, offset: u64): u64 {
    let mut result: u64 = 0;
    let mut i: u64 = 0;
    while (i < 8) {
        let byte_val = data[offset + i] as u64;
        result = result | (byte_val << ((i * 8) as u8));
        i = i + 1;
    };
    result
}

fun assert_upper_bytes_zero(data: &vector<u8>, start: u64, end: u64) {
    let mut i = start;
    while (i < end) {
        assert!(data[i] == 0, E_INVALID_COMPLIANCE_INPUTS);
        i = i + 1;
    };
}
