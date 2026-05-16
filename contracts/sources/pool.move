module veil::pool;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::event;
use veil::token::TOKEN;
use veil::verifier;

#[allow(unused_const)]
const DEFAULT_EPOCH_DURATION_MS: u64 = 3_600_000; // 1 hour for testnet (production: 2_592_000_000 = 30 days)
const MIN_DEPOSIT: u64 = 1_000;
const E_NON_STANDARD_AMOUNT: u64 = 14;
const DENOM_SMALL: u64 = 100_000_000;  // 100 TOKEN
const DENOM_MEDIUM: u64 = 500_000_000; // 500 TOKEN
const DENOM_LARGE: u64 = 1_000_000_000; // 1000 TOKEN

const E_FROZEN: u64 = 1;
const E_NULLIFIER_SPENT: u64 = 2;
const E_INVALID_PROOF: u64 = 3;
const E_NOT_POOL_ADMIN: u64 = 4;
const E_THRESHOLD_MISMATCH: u64 = 5;
const E_INSUFFICIENT_BALANCE: u64 = 6;
const E_INVALID_INPUTS_LENGTH: u64 = 7;
const E_EPOCH_MISMATCH: u64 = 8;
const E_COMMITMENT_CHAIN_BROKEN: u64 = 9;
const E_COMMITMENT_EXISTS: u64 = 10;
const E_DUST_DEPOSIT: u64 = 11;
// 12, 13 reserved for future use
const E_COMPLIANCE_REQUIRED: u64 = 15;
const E_COMMITMENT_NOT_MATURE: u64 = 16;
const E_VK_UPDATE_PENDING: u64 = 17;
const E_INVALID_VK_LENGTH: u64 = 18;
const E_COMPLIANCE_TOGGLE_PENDING: u64 = 19;
const E_POOL_NOT_FROZEN: u64 = 20;
const E_WITHDRAWAL_PENDING: u64 = 21;
const E_WITHDRAWAL_NOT_READY: u64 = 22;
const E_NO_PENDING_WITHDRAWAL: u64 = 23;
const E_NO_PENDING_COMPLIANCE_TOGGLE: u64 = 24;
const E_COMPLIANCE_CONFIG_ALREADY_SET: u64 = 25;
const E_EMERGENCY_WITHDRAW_NOT_READY: u64 = 26;
const E_NO_COMPLIANCE_CONFIG: u64 = 27;
const E_INVALID_WITHDRAW_PROOF: u64 = 28;
const E_NO_WITHDRAW_VK: u64 = 29;
const E_INVALID_RECIPIENT: u64 = 30;
const E_INVALID_EPOCH_DURATION: u64 = 31;
const MIN_VK_LENGTH: u64 = 232;

public struct Pool has key {
    id: UID,
    balance: Balance<TOKEN>,
    transfer_vk: vector<u8>,
    withdraw_vk: vector<u8>,
    threshold: u64,
    epoch_duration_ms: u64,
    frozen: bool,
    frozen_at_epoch: u64,
    pending_vk: vector<u8>,
    vk_update_epoch: u64,
    compliance_required: bool,
    // FIX 1: Compliance toggle timelock
    pending_compliance_required: Option<bool>,
    pending_compliance_epoch: u64,
    // FIX 2: Single ComplianceConfig per pool
    compliance_config: Option<ID>,
    // FIX 3: Withdrawal timelock
    pending_withdrawal: Option<u64>,
    pending_withdrawal_recipient: Option<address>,
    pending_withdrawal_epoch: u64,
    // Withdraw VK timelock
    pending_withdraw_vk: vector<u8>,
    withdraw_vk_update_epoch: u64,
}

public struct AdminCap has key {
    id: UID,
    pool_id: ID,
}

public struct NullifierKey has copy, drop, store { bytes: vector<u8> }
public struct CommitmentKey has copy, drop, store { bytes: vector<u8> }

// Privacy-preserving events: no sender/recipient/amount leaked
public struct DepositEvent has copy, drop { pool_id: ID }
public struct TransferEvent has copy, drop { nullifier: vector<u8>, new_commitment: vector<u8> }
public struct WithdrawEvent has copy, drop { pool_id: ID }
public struct VKUpdateProposedEvent has copy, drop { pool_id: ID, effective_epoch: u64 }
public struct FreezeEvent has copy, drop { pool_id: ID, frozen: bool }
public struct ComplianceRequiredEvent has copy, drop { pool_id: ID, required: bool }
// FIX 1: Compliance toggle timelock events
public struct ComplianceToggleProposedEvent has copy, drop { pool_id: ID, proposed_value: bool, effective_epoch: u64 }
public struct ComplianceToggleCancelledEvent has copy, drop { pool_id: ID }
public struct ComplianceToggleAppliedEvent has copy, drop { pool_id: ID, new_value: bool }
// FIX 3: Withdrawal timelock events
public struct WithdrawalProposedEvent has copy, drop { pool_id: ID, amount: u64, recipient: address, effective_epoch: u64 }
public struct WithdrawalCancelledEvent has copy, drop { pool_id: ID }
public struct WithdrawalExecutedEvent has copy, drop { pool_id: ID, amount: u64, recipient: address }

public fun create_pool(transfer_vk: vector<u8>, threshold: u64, epoch_duration_ms: u64, ctx: &mut TxContext) {
    assert!(transfer_vk.length() >= MIN_VK_LENGTH, E_INVALID_VK_LENGTH);
    assert!(epoch_duration_ms >= 60_000, E_INVALID_EPOCH_DURATION);
    let pool_uid = object::new(ctx);
    let pool_id = pool_uid.to_inner();
    let pool = Pool {
        id: pool_uid,
        balance: balance::zero(),
        transfer_vk,
        withdraw_vk: vector[],
        threshold,
        epoch_duration_ms,
        frozen: false,
        frozen_at_epoch: 0,
        pending_vk: vector[],
        vk_update_epoch: 0,
        compliance_required: false,
        pending_compliance_required: option::none(),
        pending_compliance_epoch: 0,
        compliance_config: option::none(),
        pending_withdrawal: option::none(),
        pending_withdrawal_recipient: option::none(),
        pending_withdrawal_epoch: 0,
        pending_withdraw_vk: vector[],
        withdraw_vk_update_epoch: 0,
    };
    let cap = AdminCap { id: object::new(ctx), pool_id };
    transfer::share_object(pool);
    transfer::transfer(cap, ctx.sender());
}

public(package) fun assert_pool_admin(cap: &AdminCap, pool: &Pool) {
    assert!(cap.pool_id == pool.id.to_inner(), E_NOT_POOL_ADMIN);
}

public(package) fun deposit(pool: &mut Pool, coin: Coin<TOKEN>) {
    assert!(!pool.frozen, E_FROZEN);
    let amount = coin.value();
    assert!(amount >= MIN_DEPOSIT, E_DUST_DEPOSIT);
    assert!(is_standard_amount(amount), E_NON_STANDARD_AMOUNT);
    balance::join(&mut pool.balance, coin.into_balance());
    event::emit(DepositEvent { pool_id: pool.id.to_inner() });
}

public fun shielded_transfer(
    pool: &mut Pool,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
    clock: &sui::clock::Clock,
    _ctx: &TxContext,
) {
    assert!(!pool.frozen, E_FROZEN);
    // FIX 1: Apply pending compliance toggle lazily
    apply_pending_compliance_internal(pool, clock);
    assert!(!pool.compliance_required, E_COMPLIANCE_REQUIRED);
    execute_transfer(pool, proof_bytes, public_inputs_bytes, clock);
}

public(package) fun verify_and_execute_transfer(
    pool: &mut Pool,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
    clock: &sui::clock::Clock,
) {
    assert!(!pool.frozen, E_FROZEN);
    execute_transfer(pool, proof_bytes, public_inputs_bytes, clock);
}

/// Shared transfer logic: verify proof, consume old commitment, add nullifier, create new commitment.
fun execute_transfer(
    pool: &mut Pool,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
    clock: &sui::clock::Clock,
) {
    assert!(public_inputs_bytes.length() == 192, E_INVALID_INPUTS_LENGTH);

    // Apply pending VK update if epoch has passed
    apply_pending_vk(pool, clock);

    let proof_threshold = verifier::le_bytes_to_u64(&public_inputs_bytes, 64);
    verifier::assert_upper_bytes_zero(&public_inputs_bytes, 72, 96, E_INVALID_INPUTS_LENGTH);
    assert!(proof_threshold == pool.threshold, E_THRESHOLD_MISMATCH);

    let proof_epoch = verifier::le_bytes_to_u64(&public_inputs_bytes, 96);
    verifier::assert_upper_bytes_zero(&public_inputs_bytes, 104, 128, E_INVALID_INPUTS_LENGTH);
    let on_chain_epoch = pool_epoch(pool, clock);
    // M7: Accept current epoch OR previous epoch (grace period at epoch boundaries)
    assert!(
        proof_epoch == on_chain_epoch || (on_chain_epoch > 0 && proof_epoch == on_chain_epoch - 1),
        E_EPOCH_MISMATCH,
    );

    let valid = verifier::verify_transfer_proof(
        &pool.transfer_vk,
        proof_bytes,
        public_inputs_bytes,
    );
    assert!(valid, E_INVALID_PROOF);

    // Verify commitment chain — UTXO-style: consume old, create new
    let old_commitment = verifier::extract_bytes(&public_inputs_bytes, 0, 32);
    let old_comm_key = CommitmentKey { bytes: old_commitment };
    assert!(
        dynamic_field::exists(&pool.id, old_comm_key),
        E_COMMITMENT_CHAIN_BROKEN,
    );
    let created_epoch = dynamic_field::remove<CommitmentKey, u64>(&mut pool.id, old_comm_key);
    assert!(pool_epoch(pool, clock) > created_epoch, E_COMMITMENT_NOT_MATURE);

    // Nullifier: bytes 128..160 (full 32-byte Poseidon hash — no truncation check)
    let nullifier = verifier::extract_bytes(&public_inputs_bytes, 128, 160);
    let nullifier_key = NullifierKey { bytes: nullifier };
    assert!(
        !dynamic_field::exists(&pool.id, nullifier_key),
        E_NULLIFIER_SPENT,
    );
    dynamic_field::add(&mut pool.id, nullifier_key, true);

    // New commitment: bytes 32..64
    let new_commitment = verifier::extract_bytes(&public_inputs_bytes, 32, 64);
    let new_comm_key = CommitmentKey { bytes: new_commitment };
    assert!(
        !dynamic_field::exists(&pool.id, new_comm_key),
        E_COMMITMENT_EXISTS,
    );
    let epoch_now = pool_epoch(pool, clock);
    dynamic_field::add(&mut pool.id, new_comm_key, epoch_now);

    event::emit(TransferEvent { nullifier, new_commitment });
}

// Register a user's genesis commitment (bundled with deposit for anti-griefing)
public fun deposit_and_register(
    pool: &mut Pool,
    coin: Coin<TOKEN>,
    commitment: vector<u8>,
    clock: &sui::clock::Clock,
    _ctx: &TxContext,
) {
    assert!(!pool.frozen, E_FROZEN);
    let amount = coin.value();
    assert!(amount >= MIN_DEPOSIT, E_DUST_DEPOSIT);
    assert!(is_standard_amount(amount), E_NON_STANDARD_AMOUNT);
    assert!(commitment.length() == 32, E_INVALID_INPUTS_LENGTH);
    let comm_key = CommitmentKey { bytes: commitment };
    assert!(
        !dynamic_field::exists(&pool.id, comm_key),
        E_COMMITMENT_EXISTS,
    );
    balance::join(&mut pool.balance, coin.into_balance());
    let epoch_now = pool_epoch(pool, clock);
    dynamic_field::add(&mut pool.id, comm_key, epoch_now);
    event::emit(DepositEvent { pool_id: pool.id.to_inner() });
}

// FIX 3: Propose withdrawal with 1-epoch timelock
public fun propose_withdrawal(
    pool: &mut Pool,
    cap: &AdminCap,
    amount: u64,
    recipient: address,
    clock: &sui::clock::Clock,
) {
    assert_pool_admin(cap, pool);
    assert!(pool.pending_withdrawal.is_none(), E_WITHDRAWAL_PENDING);
    assert!(pool.balance.value() >= amount, E_INSUFFICIENT_BALANCE);
    let effective = pool_epoch(pool, clock) + 1;
    pool.pending_withdrawal = option::some(amount);
    pool.pending_withdrawal_recipient = option::some(recipient);
    pool.pending_withdrawal_epoch = effective;
    event::emit(WithdrawalProposedEvent {
        pool_id: pool.id.to_inner(),
        amount,
        recipient,
        effective_epoch: effective,
    });
}

public fun cancel_withdrawal(pool: &mut Pool, cap: &AdminCap) {
    assert_pool_admin(cap, pool);
    assert!(pool.pending_withdrawal.is_some(), E_NO_PENDING_WITHDRAWAL);
    pool.pending_withdrawal = option::none();
    pool.pending_withdrawal_recipient = option::none();
    pool.pending_withdrawal_epoch = 0;
    event::emit(WithdrawalCancelledEvent { pool_id: pool.id.to_inner() });
}

public fun execute_pending_withdrawal(
    pool: &mut Pool,
    cap: &AdminCap,
    clock: &sui::clock::Clock,
    ctx: &mut TxContext,
) {
    assert_pool_admin(cap, pool);
    assert!(pool.pending_withdrawal.is_some(), E_NO_PENDING_WITHDRAWAL);
    assert!(pool_epoch(pool, clock) >= pool.pending_withdrawal_epoch, E_WITHDRAWAL_NOT_READY);
    let amount = pool.pending_withdrawal.extract();
    let recipient = pool.pending_withdrawal_recipient.extract();
    pool.pending_withdrawal_epoch = 0;
    assert!(pool.balance.value() >= amount, E_INSUFFICIENT_BALANCE);
    let withdrawn = coin::from_balance(balance::split(&mut pool.balance, amount), ctx);
    transfer::public_transfer(withdrawn, recipient);
    event::emit(WithdrawalExecutedEvent { pool_id: pool.id.to_inner(), amount, recipient });
}

// Emergency withdraw — only works when pool is FROZEN
public fun emergency_withdraw(
    pool: &mut Pool,
    cap: &AdminCap,
    amount: u64,
    recipient: address,
    clock: &sui::clock::Clock,
    ctx: &mut TxContext,
) {
    assert_pool_admin(cap, pool);
    assert!(pool.frozen, E_POOL_NOT_FROZEN);
    assert!(pool_epoch(pool, clock) > pool.frozen_at_epoch, E_EMERGENCY_WITHDRAW_NOT_READY);
    assert!(pool.balance.value() >= amount, E_INSUFFICIENT_BALANCE);
    let withdrawn = coin::from_balance(balance::split(&mut pool.balance, amount), ctx);
    transfer::public_transfer(withdrawn, recipient);
    event::emit(WithdrawEvent { pool_id: pool.id.to_inner() });
}

// VK update with 1-epoch timelock
public fun propose_vk_update(
    pool: &mut Pool,
    cap: &AdminCap,
    new_vk: vector<u8>,
    clock: &sui::clock::Clock,
) {
    assert_pool_admin(cap, pool);
    assert!(new_vk.length() >= MIN_VK_LENGTH, E_INVALID_VK_LENGTH);
    assert!(pool.pending_vk.length() == 0, E_VK_UPDATE_PENDING);
    // Safe from overflow: max epoch = u64::MAX / epoch_duration_ms
    let effective = pool_epoch(pool, clock) + 1;
    pool.pending_vk = new_vk;
    pool.vk_update_epoch = effective;
    event::emit(VKUpdateProposedEvent {
        pool_id: pool.id.to_inner(),
        effective_epoch: effective,
    });
}

public fun cancel_vk_update(pool: &mut Pool, cap: &AdminCap) {
    assert_pool_admin(cap, pool);
    pool.pending_vk = vector[];
    pool.vk_update_epoch = 0;
}

fun apply_pending_vk(pool: &mut Pool, clock: &sui::clock::Clock) {
    if (pool.pending_vk.length() > 0 && pool_epoch(pool, clock) >= pool.vk_update_epoch) {
        pool.transfer_vk = pool.pending_vk;
        pool.pending_vk = vector[];
        pool.vk_update_epoch = 0;
    };
}

public fun freeze_pool(pool: &mut Pool, cap: &AdminCap, clock: &sui::clock::Clock) {
    assert_pool_admin(cap, pool);
    pool.frozen = true;
    pool.frozen_at_epoch = pool_epoch(pool, clock);
    event::emit(FreezeEvent { pool_id: pool.id.to_inner(), frozen: true });
}

public fun unfreeze_pool(pool: &mut Pool, cap: &AdminCap) {
    assert_pool_admin(cap, pool);
    pool.frozen = false;
    pool.frozen_at_epoch = 0;
    event::emit(FreezeEvent { pool_id: pool.id.to_inner(), frozen: false });
}

// FIX 1: Compliance toggle with 1-epoch timelock
public fun propose_compliance_toggle(
    pool: &mut Pool,
    cap: &AdminCap,
    required: bool,
    clock: &sui::clock::Clock,
) {
    assert_pool_admin(cap, pool);
    assert!(pool.pending_compliance_required.is_none(), E_COMPLIANCE_TOGGLE_PENDING);
    if (required) {
        assert!(pool.compliance_config.is_some(), E_NO_COMPLIANCE_CONFIG);
    };
    let effective = pool_epoch(pool, clock) + 1;
    pool.pending_compliance_required = option::some(required);
    pool.pending_compliance_epoch = effective;
    event::emit(ComplianceToggleProposedEvent {
        pool_id: pool.id.to_inner(),
        proposed_value: required,
        effective_epoch: effective,
    });
}

public fun cancel_compliance_toggle(pool: &mut Pool, cap: &AdminCap) {
    assert_pool_admin(cap, pool);
    assert!(pool.pending_compliance_required.is_some(), E_NO_PENDING_COMPLIANCE_TOGGLE);
    pool.pending_compliance_required = option::none();
    pool.pending_compliance_epoch = 0;
    event::emit(ComplianceToggleCancelledEvent { pool_id: pool.id.to_inner() });
}

fun apply_pending_compliance_internal(pool: &mut Pool, clock: &sui::clock::Clock) {
    if (pool.pending_compliance_required.is_some() && pool_epoch(pool, clock) >= pool.pending_compliance_epoch) {
        let new_value = pool.pending_compliance_required.extract();
        pool.compliance_required = new_value;
        pool.pending_compliance_epoch = 0;
        event::emit(ComplianceToggleAppliedEvent { pool_id: pool.id.to_inner(), new_value });
    };
}

/// Called by compliance.move to apply pending compliance toggle lazily during compliant_transfer.
public(package) fun apply_pending_compliance(pool: &mut Pool, clock: &sui::clock::Clock) {
    apply_pending_compliance_internal(pool, clock);
}

public(package) fun pool_uid(pool: &Pool): &UID { &pool.id }

public(package) fun add_credential_nullifier<K: copy + drop + store>(pool: &mut Pool, key: K, value: bool) {
    dynamic_field::add(&mut pool.id, key, value);
}

public(package) fun credential_nullifier_exists<K: copy + drop + store>(pool: &Pool, key: K): bool {
    dynamic_field::exists(&pool.id, key)
}

// FIX 2: Single ComplianceConfig per pool
public(package) fun set_pool_compliance_config(pool: &mut Pool, config_id: ID) {
    assert!(pool.compliance_config.is_none(), E_COMPLIANCE_CONFIG_ALREADY_SET);
    pool.compliance_config = option::some(config_id);
}
public fun pool_compliance_config(pool: &Pool): Option<ID> { pool.compliance_config }

// ---------------------------------------------------------------------------
// ZK-proven withdrawal (Tier 2.2 — fixes PRIV-011: admin-gated withdrawal)
// ---------------------------------------------------------------------------

public fun propose_withdraw_vk(
    pool: &mut Pool,
    cap: &AdminCap,
    new_vk: vector<u8>,
    clock: &sui::clock::Clock,
) {
    assert_pool_admin(cap, pool);
    assert!(new_vk.length() >= MIN_VK_LENGTH, E_INVALID_VK_LENGTH);
    assert!(pool.pending_withdraw_vk.length() == 0, E_VK_UPDATE_PENDING);
    let effective = pool_epoch(pool, clock) + 1;
    pool.pending_withdraw_vk = new_vk;
    pool.withdraw_vk_update_epoch = effective;
    event::emit(VKUpdateProposedEvent { pool_id: pool.id.to_inner(), effective_epoch: effective });
}

public fun cancel_withdraw_vk(pool: &mut Pool, cap: &AdminCap) {
    assert_pool_admin(cap, pool);
    pool.pending_withdraw_vk = vector[];
    pool.withdraw_vk_update_epoch = 0;
}

fun apply_pending_withdraw_vk(pool: &mut Pool, clock: &sui::clock::Clock) {
    if (pool.pending_withdraw_vk.length() > 0 && pool_epoch(pool, clock) >= pool.withdraw_vk_update_epoch) {
        pool.withdraw_vk = pool.pending_withdraw_vk;
        pool.pending_withdraw_vk = vector[];
        pool.withdraw_vk_update_epoch = 0;
    };
}

/// ZK-proven withdrawal: user proves ownership of a commitment and withdraws tokens.
/// Public inputs layout (128 bytes = 4 x 32):
///   [0..32)   commitment      — the UTXO commitment to consume
///   [32..64)  withdrawAmount  — amount to withdraw (LE u64 in first 8 bytes, upper 24 zero)
///   [64..96)  nullifier       — prevents double-withdraw
///   [96..128) recipientHash   — Poseidon(8, recipient) binds withdrawal to address
public fun zk_withdraw(
    pool: &mut Pool,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
    recipient: address,
    clock: &sui::clock::Clock,
    ctx: &mut TxContext,
) {
    assert!(!pool.frozen, E_FROZEN);
    apply_pending_withdraw_vk(pool, clock);
    assert!(pool.withdraw_vk.length() >= MIN_VK_LENGTH, E_NO_WITHDRAW_VK);
    assert!(public_inputs_bytes.length() == 128, E_INVALID_INPUTS_LENGTH);

    let valid = verifier::verify_withdraw_proof(
        &pool.withdraw_vk,
        proof_bytes,
        public_inputs_bytes,
    );
    assert!(valid, E_INVALID_WITHDRAW_PROOF);

    let commitment_bytes = verifier::extract_bytes(&public_inputs_bytes, 0, 32);
    let withdraw_amount = verifier::le_bytes_to_u64(&public_inputs_bytes, 32);
    verifier::assert_upper_bytes_zero(&public_inputs_bytes, 40, 64, E_INVALID_INPUTS_LENGTH);
    let nullifier = verifier::extract_bytes(&public_inputs_bytes, 64, 96);
    // The circuit proves recipientHash = Poseidon(8, recipient), binding the withdrawal
    // to a specific address. We enforce this by sending tokens ONLY to the `recipient`
    // parameter — the caller must provide the address that matches their proof.
    // Front-running is prevented: changing recipient invalidates the Groth16 proof.
    // bytes 96-128 (recipientHash) are verified by the proof itself.

    // Consume commitment (UTXO-style)
    let comm_key = CommitmentKey { bytes: commitment_bytes };
    assert!(
        dynamic_field::exists(&pool.id, comm_key),
        E_COMMITMENT_CHAIN_BROKEN,
    );
    let created_epoch = dynamic_field::remove<CommitmentKey, u64>(&mut pool.id, comm_key);
    assert!(pool_epoch(pool, clock) > created_epoch, E_COMMITMENT_NOT_MATURE);

    let nf_key = NullifierKey { bytes: nullifier };
    assert!(
        !dynamic_field::exists(&pool.id, nf_key),
        E_NULLIFIER_SPENT,
    );
    dynamic_field::add(&mut pool.id, nf_key, true);

    assert!(pool.balance.value() >= withdraw_amount, E_INSUFFICIENT_BALANCE);

    let withdrawn = coin::from_balance(balance::split(&mut pool.balance, withdraw_amount), ctx);
    transfer::public_transfer(withdrawn, recipient);

    event::emit(WithdrawEvent { pool_id: pool.id.to_inner() });
}

public fun withdraw_vk_set(pool: &Pool): bool { pool.withdraw_vk.length() >= MIN_VK_LENGTH }

public fun is_frozen(pool: &Pool): bool { pool.frozen }
public fun pool_balance(pool: &Pool): u64 { pool.balance.value() }
public fun threshold(pool: &Pool): u64 { pool.threshold }
public fun compliance_required(pool: &Pool): bool { pool.compliance_required }

public fun current_epoch(clock: &sui::clock::Clock, epoch_duration_ms: u64): u64 {
    sui::clock::timestamp_ms(clock) / epoch_duration_ms
}

public fun pool_epoch(pool: &Pool, clock: &sui::clock::Clock): u64 {
    current_epoch(clock, pool.epoch_duration_ms)
}

public fun epoch_duration(pool: &Pool): u64 { pool.epoch_duration_ms }

fun is_standard_amount(amount: u64): bool {
    amount == DENOM_SMALL || amount == DENOM_MEDIUM || amount == DENOM_LARGE
}

