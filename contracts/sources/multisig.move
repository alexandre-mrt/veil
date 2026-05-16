/// Opt-in multi-sig approval layer for AdminCap operations.
///
/// The AdminCap stays with a designated executor. This module adds a shared
/// MultisigConfig that tracks N-of-M signer approvals for action hashes.
/// Admin functions gated by multisig require `verify_and_consume_approval`
/// to pass before execution.
///
/// Backward compatible: direct AdminCap operations still work without multisig.
module veil::multisig;

use sui::dynamic_field;
use sui::event;
use veil::pool::{Self, Pool, AdminCap};

// ---------------------------------------------------------------------------
// Error codes (200+ range to avoid collision with pool.move)
// ---------------------------------------------------------------------------
const E_NOT_SIGNER: u64 = 200;
const E_ALREADY_APPROVED: u64 = 201;
const E_INSUFFICIENT_APPROVALS: u64 = 202;
const E_ACTION_NOT_APPROVED: u64 = 203;
const E_INVALID_SIGNER_COUNT: u64 = 204;
const E_POOL_MISMATCH: u64 = 205;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Shared config object linking a pool to its multisig signer set.
public struct MultisigConfig has key {
    id: UID,
    pool_id: ID,
    signers: vector<address>,
    required_approvals: u64,
}

/// Dynamic field key for approval records, keyed by action hash.
public struct ApprovalKey has copy, drop, store { action_hash: vector<u8> }

/// Stores the set of addresses that approved a specific action.
public struct ApprovalRecord has store {
    approvals: vector<address>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

public struct MultisigCreatedEvent has copy, drop {
    config_id: ID,
    pool_id: ID,
    signers: vector<address>,
}

public struct ActionApprovedEvent has copy, drop {
    config_id: ID,
    action_hash: vector<u8>,
    approver: address,
    count: u64,
}

public struct ActionExecutedEvent has copy, drop {
    config_id: ID,
    action_hash: vector<u8>,
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/// Create a multisig config for a pool. Requires the AdminCap to prove ownership.
/// `signers` must contain at least `required` addresses.
public fun create_multisig(
    pool: &Pool,
    cap: &AdminCap,
    signers: vector<address>,
    required: u64,
    ctx: &mut TxContext,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(signers.length() >= required, E_INVALID_SIGNER_COUNT);
    assert!(required > 0, E_INVALID_SIGNER_COUNT);

    let config_uid = object::new(ctx);
    let config_id = config_uid.to_inner();
    let pool_id = object::id(pool);
    let config = MultisigConfig {
        id: config_uid,
        pool_id,
        signers,
        required_approvals: required,
    };
    transfer::share_object(config);
    event::emit(MultisigCreatedEvent { config_id, pool_id, signers });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/// A signer approves a specific action identified by `action_hash`.
/// The hash should encode the action type + parameters (e.g., keccak256("freeze", pool_id)).
public fun approve_action(
    config: &mut MultisigConfig,
    action_hash: vector<u8>,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(config.signers.contains(&sender), E_NOT_SIGNER);

    let config_id = config.id.to_inner();
    let key = ApprovalKey { action_hash };
    if (!dynamic_field::exists_with_type<ApprovalKey, ApprovalRecord>(&config.id, key)) {
        dynamic_field::add(&mut config.id, key, ApprovalRecord { approvals: vector[] });
    };
    let record = dynamic_field::borrow_mut<ApprovalKey, ApprovalRecord>(&mut config.id, key);
    assert!(!record.approvals.contains(&sender), E_ALREADY_APPROVED);
    record.approvals.push_back(sender);
    let count = record.approvals.length();

    event::emit(ActionApprovedEvent {
        config_id,
        action_hash,
        approver: sender,
        count,
    });
}

/// Check if an action has enough approvals, then consume (remove) the approval record.
/// Returns true if the threshold was met.
public fun verify_and_consume_approval(
    config: &mut MultisigConfig,
    action_hash: vector<u8>,
): bool {
    let key = ApprovalKey { action_hash };
    assert!(dynamic_field::exists_with_type<ApprovalKey, ApprovalRecord>(&config.id, key), E_ACTION_NOT_APPROVED);
    let record = dynamic_field::remove<ApprovalKey, ApprovalRecord>(&mut config.id, key);
    let approved = record.approvals.length() >= config.required_approvals;
    let ApprovalRecord { approvals: _ } = record;
    approved
}

// ---------------------------------------------------------------------------
// Multisig-gated admin operations
// ---------------------------------------------------------------------------

/// Freeze the pool, requiring multisig approval first.
public fun multisig_freeze(
    config: &mut MultisigConfig,
    pool: &mut Pool,
    cap: &AdminCap,
    action_hash: vector<u8>,
    clock: &sui::clock::Clock,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_POOL_MISMATCH);
    let approved = verify_and_consume_approval(config, action_hash);
    assert!(approved, E_INSUFFICIENT_APPROVALS);
    pool::freeze_pool(pool, cap, clock);
    event::emit(ActionExecutedEvent {
        config_id: config.id.to_inner(),
        action_hash,
    });
}

/// Unfreeze the pool, requiring multisig approval first.
public fun multisig_unfreeze(
    config: &mut MultisigConfig,
    pool: &mut Pool,
    cap: &AdminCap,
    action_hash: vector<u8>,
) {
    pool::assert_pool_admin(cap, pool);
    assert!(config.pool_id == object::id(pool), E_POOL_MISMATCH);
    let approved = verify_and_consume_approval(config, action_hash);
    assert!(approved, E_INSUFFICIENT_APPROVALS);
    pool::unfreeze_pool(pool, cap);
    event::emit(ActionExecutedEvent {
        config_id: config.id.to_inner(),
        action_hash,
    });
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

public fun signers(config: &MultisigConfig): &vector<address> { &config.signers }
public fun required_approvals(config: &MultisigConfig): u64 { config.required_approvals }
public fun multisig_pool_id(config: &MultisigConfig): ID { config.pool_id }

/// Check how many approvals an action currently has (0 if no record exists).
public fun approval_count(config: &MultisigConfig, action_hash: vector<u8>): u64 {
    let key = ApprovalKey { action_hash };
    if (!dynamic_field::exists_with_type<ApprovalKey, ApprovalRecord>(&config.id, key)) {
        0
    } else {
        let record = dynamic_field::borrow<ApprovalKey, ApprovalRecord>(&config.id, key);
        record.approvals.length()
    }
}
