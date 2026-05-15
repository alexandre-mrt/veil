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
const E_CREDENTIAL_ROOT_UPDATE_PENDING: u64 = 28;
const E_INVALID_ENCRYPTED_AMOUNT: u64 = 29;
const E_INVALID_AUDITOR_KEY: u64 = 30;
const E_AUDITOR_KEY_UPDATE_PENDING: u64 = 31;
const E_INVALID_VK_LENGTH: u64 = 32;
const MIN_ENCRYPTED_AMOUNT_LEN: u64 = 93; // 65 (ephemeral key) + 12 (IV) + 16 (GCM tag) minimum
const MIN_VK_LENGTH: u64 = 232;
const MIN_AUDITOR_KEY_LENGTH: u64 = 33;

public struct ComplianceConfig has key {
    id: UID,
    pool_id: ID,
    compliance_vk: vector<u8>,
    credential_root: vector<u8>,
    required_kyc_level: u64,
    auditor_key: vector<u8>,
    pending_credential_root: vector<u8>,
    credential_root_update_epoch: u64,
    pending_auditor_key: Option<vector<u8>>,
    pending_auditor_key_epoch: u64,
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

public struct AuditorKeyUpdateProposedEvent has copy, drop {
    config_id: ID,
    effective_epoch: u64,
}

public struct AuditorKeyUpdateCancelledEvent has copy, drop {
    config_id: ID,
}

public struct AuditorKeyAppliedEvent has copy, drop {
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
    assert!(compliance_vk.length() >= MIN_VK_LENGTH, E_INVALID_VK_LENGTH);
    assert!(credential_root.length() == 32, E_INVALID_COMPLIANCE_INPUTS);
    assert!(auditor_key.length() >= MIN_AUDITOR_KEY_LENGTH, E_INVALID_AUDITOR_KEY);

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
        pending_credential_root: vector[],
        credential_root_update_epoch: 0,
        pending_auditor_key: option::none(),
        pending_auditor_key_epoch: 0,
    };

    transfer::share_object(config);
    event::emit(ComplianceConfigCreatedEvent { config_id, pool_id, required_kyc_level });
}

/// Apply pending credential root if the timelock epoch has passed (mirrors VK timelock in pool.move).
fun apply_pending_credential_root(config: &mut ComplianceConfig, clock: &sui::clock::Clock) {
    if (config.pending_credential_root.length() > 0 && pool::current_epoch(clock) >= config.credential_root_update_epoch) {
        config.credential_root = config.pending_credential_root;
        config.pending_credential_root = vector[];
        config.credential_root_update_epoch = 0;
    };
}

/// Apply pending auditor key if the timelock epoch has passed (mirrors credential root timelock).
fun apply_pending_auditor_key(config: &mut ComplianceConfig, clock: &sui::clock::Clock) {
    if (config.pending_auditor_key.is_some() && pool::current_epoch(clock) >= config.pending_auditor_key_epoch) {
        config.auditor_key = config.pending_auditor_key.extract();
        config.pending_auditor_key_epoch = 0;
        event::emit(AuditorKeyAppliedEvent { config_id: config.id.to_inner() });
    };
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

    // [M9] Validate encrypted_amount minimum length (ephemeral key + IV + GCM tag)
    assert!(encrypted_amount.length() >= MIN_ENCRYPTED_AMOUNT_LEN, E_INVALID_ENCRYPTED_AMOUNT);

    // Apply pending timelocked updates before checking state
    apply_pending_credential_root(config, clock);
    apply_pending_auditor_key(config, clock);

    // [M3] All compliance validations BEFORE any pool state mutation
    assert!(compliance_inputs_bytes.length() == 192, E_INVALID_COMPLIANCE_INPUTS);

    let proof_root = verifier::extract_bytes(&compliance_inputs_bytes, 0, 32);
    assert!(proof_root == config.credential_root, E_CREDENTIAL_ROOT_MISMATCH);

    let proof_epoch = verifier::le_bytes_to_u64(&compliance_inputs_bytes, 32);
    verifier::assert_upper_bytes_zero(&compliance_inputs_bytes, 40, 64, E_INVALID_COMPLIANCE_INPUTS);
    let on_chain_epoch = pool::current_epoch(clock);
    assert!(
        proof_epoch == on_chain_epoch || (on_chain_epoch > 0 && proof_epoch == on_chain_epoch - 1),
        E_EPOCH_MISMATCH,
    );

    let proof_kyc_level = verifier::le_bytes_to_u64(&compliance_inputs_bytes, 96);
    verifier::assert_upper_bytes_zero(&compliance_inputs_bytes, 104, 128, E_INVALID_COMPLIANCE_INPUTS);
    assert!(proof_kyc_level >= config.required_kyc_level, E_INVALID_COMPLIANCE_INPUTS);

    let credential_nullifier = verifier::extract_bytes(&compliance_inputs_bytes, 128, 160);
    let cred_nf_key = CredentialNullifierKey { bytes: credential_nullifier };
    assert!(
        !dynamic_field::exists(pool::pool_uid(pool), cred_nf_key),
        E_CREDENTIAL_NULLIFIER_SPENT,
    );

    let valid_flag = verifier::le_bytes_to_u64(&compliance_inputs_bytes, 160);
    verifier::assert_upper_bytes_zero(&compliance_inputs_bytes, 168, 192, E_INVALID_COMPLIANCE_INPUTS);
    assert!(valid_flag == 1, E_CREDENTIAL_INVALID);

    let valid = verifier::verify_compliance_proof(
        &config.compliance_vk,
        compliance_proof_bytes,
        compliance_inputs_bytes,
    );
    assert!(valid, E_COMPLIANCE_PROOF_INVALID);

    // [M3] THEN mutate pool state (transfer proof verification + state changes)
    pool::verify_and_execute_transfer(pool, transfer_proof_bytes, transfer_inputs_bytes, clock);

    // Store credential nullifier after all verifications pass
    dynamic_field::add(pool::pool_uid_mut(pool), cred_nf_key, true);

    event::emit(ComplianceVerifiedEvent {
        credential_nullifier,
        encrypted_amount,
    });
}

/// [H2] Propose credential root update with 1-epoch timelock (mirrors VK timelock pattern).
public fun update_credential_root(
    config: &mut ComplianceConfig,
    cap: &AdminCap,
    pool: &Pool,
    new_root: vector<u8>,
    clock: &sui::clock::Clock,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);
    assert!(new_root.length() == 32, E_INVALID_COMPLIANCE_INPUTS);
    assert!(config.pending_credential_root.length() == 0, E_CREDENTIAL_ROOT_UPDATE_PENDING);
    config.pending_credential_root = new_root;
    config.credential_root_update_epoch = pool::current_epoch(clock) + 1;
    event::emit(CredentialRootUpdatedEvent { config_id: config.id.to_inner(), new_root });
}

public fun cancel_credential_root_update(
    config: &mut ComplianceConfig,
    cap: &AdminCap,
    pool: &Pool,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);
    config.pending_credential_root = vector[];
    config.credential_root_update_epoch = 0;
}

public fun propose_auditor_key_update(
    config: &mut ComplianceConfig,
    cap: &AdminCap,
    pool: &Pool,
    new_key: vector<u8>,
    clock: &sui::clock::Clock,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);
    assert!(new_key.length() >= MIN_AUDITOR_KEY_LENGTH, E_INVALID_AUDITOR_KEY);
    assert!(config.pending_auditor_key.is_none(), E_AUDITOR_KEY_UPDATE_PENDING);
    let effective = pool::current_epoch(clock) + 1;
    config.pending_auditor_key = option::some(new_key);
    config.pending_auditor_key_epoch = effective;
    event::emit(AuditorKeyUpdateProposedEvent {
        config_id: config.id.to_inner(),
        effective_epoch: effective,
    });
}

public fun cancel_auditor_key_update(
    config: &mut ComplianceConfig,
    cap: &AdminCap,
    pool: &Pool,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_CONFIG_POOL_MISMATCH);
    config.pending_auditor_key = option::none();
    config.pending_auditor_key_epoch = 0;
    event::emit(AuditorKeyUpdateCancelledEvent { config_id: config.id.to_inner() });
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

