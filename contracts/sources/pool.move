module veil::pool;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::event;
use veil::token::TOKEN;
use veil::verifier;

const EPOCH_DURATION_MS: u64 = 2_592_000_000;
const MIN_DEPOSIT: u64 = 1_000; // 0.001 TOKEN minimum

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
const E_VK_UPDATE_LOCKED: u64 = 12;
const E_NULLIFIER_NOT_CANONICAL: u64 = 13;

public struct Pool has key {
    id: UID,
    balance: Balance<TOKEN>,
    transfer_vk: vector<u8>,
    threshold: u64,
    frozen: bool,
    pending_vk: vector<u8>,
    vk_update_epoch: u64,
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

public fun create_pool(transfer_vk: vector<u8>, threshold: u64, ctx: &mut TxContext) {
    let pool_uid = object::new(ctx);
    let pool_id = pool_uid.to_inner();
    let pool = Pool {
        id: pool_uid,
        balance: balance::zero(),
        transfer_vk,
        threshold,
        frozen: false,
        pending_vk: vector[],
        vk_update_epoch: 0,
    };
    let cap = AdminCap { id: object::new(ctx), pool_id };
    transfer::share_object(pool);
    transfer::transfer(cap, ctx.sender());
}

fun assert_pool_admin(cap: &AdminCap, pool: &Pool) {
    assert!(cap.pool_id == pool.id.to_inner(), E_NOT_POOL_ADMIN);
}

public fun deposit(pool: &mut Pool, coin: Coin<TOKEN>, _ctx: &TxContext) {
    assert!(!pool.frozen, E_FROZEN);
    let amount = coin.value();
    assert!(amount >= MIN_DEPOSIT, E_DUST_DEPOSIT);
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
    assert!(public_inputs_bytes.length() >= 192, E_INVALID_INPUTS_LENGTH);

    // Apply pending VK update if epoch has passed
    apply_pending_vk(pool, clock);

    let proof_threshold = le_bytes_to_u64(&public_inputs_bytes, 64);
    assert_upper_bytes_zero(&public_inputs_bytes, 72, 96);
    assert!(proof_threshold == pool.threshold, E_THRESHOLD_MISMATCH);

    let proof_epoch = le_bytes_to_u64(&public_inputs_bytes, 96);
    assert_upper_bytes_zero(&public_inputs_bytes, 104, 128);
    let on_chain_epoch = current_epoch(clock);
    assert!(proof_epoch == on_chain_epoch, E_EPOCH_MISMATCH);

    let valid = verifier::verify_transfer_proof(
        &pool.transfer_vk,
        proof_bytes,
        public_inputs_bytes,
    );
    assert!(valid, E_INVALID_PROOF);

    // Verify commitment chain
    let old_commitment = extract_bytes(&public_inputs_bytes, 0, 32);
    let old_comm_key = CommitmentKey { bytes: old_commitment };
    assert!(
        dynamic_field::exists_(&pool.id, old_comm_key),
        E_COMMITMENT_CHAIN_BROKEN,
    );

    // Nullifier: bytes 128..160 — validate canonical (upper bytes zero)
    let nullifier = extract_bytes(&public_inputs_bytes, 128, 160);
    assert_upper_bytes_zero(&public_inputs_bytes, 152, 160);
    let nullifier_key = NullifierKey { bytes: nullifier };
    assert!(
        !dynamic_field::exists_(&pool.id, nullifier_key),
        E_NULLIFIER_SPENT,
    );
    dynamic_field::add(&mut pool.id, nullifier_key, true);

    // New commitment: bytes 32..64
    let new_commitment = extract_bytes(&public_inputs_bytes, 32, 64);
    let new_comm_key = CommitmentKey { bytes: new_commitment };
    assert!(
        !dynamic_field::exists_(&pool.id, new_comm_key),
        E_COMMITMENT_EXISTS,
    );
    dynamic_field::add(&mut pool.id, new_comm_key, true);

    event::emit(TransferEvent { nullifier, new_commitment });
}

// Register a user's genesis commitment (first step after deposit)
public fun register_commitment(
    pool: &mut Pool,
    commitment: vector<u8>,
    _ctx: &TxContext,
) {
    assert!(!pool.frozen, E_FROZEN);
    assert!(commitment.length() == 32, E_INVALID_INPUTS_LENGTH);
    let comm_key = CommitmentKey { bytes: commitment };
    assert!(
        !dynamic_field::exists_(&pool.id, comm_key),
        E_COMMITMENT_EXISTS,
    );
    dynamic_field::add(&mut pool.id, comm_key, true);
}

// Admin-gated emergency withdraw (documented as custodial — timelock in production)
public fun withdraw(
    pool: &mut Pool,
    cap: &AdminCap,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    assert_pool_admin(cap, pool);
    assert!(!pool.frozen, E_FROZEN);
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
    let effective = current_epoch(clock) + 1;
    pool.pending_vk = new_vk;
    pool.vk_update_epoch = effective;
    event::emit(VKUpdateProposedEvent {
        pool_id: pool.id.to_inner(),
        effective_epoch: effective,
    });
}

fun apply_pending_vk(pool: &mut Pool, clock: &sui::clock::Clock) {
    if (pool.pending_vk.length() > 0 && current_epoch(clock) >= pool.vk_update_epoch) {
        pool.transfer_vk = pool.pending_vk;
        pool.pending_vk = vector[];
        pool.vk_update_epoch = 0;
    };
}

public fun freeze_pool(pool: &mut Pool, cap: &AdminCap) {
    assert_pool_admin(cap, pool);
    pool.frozen = true;
    event::emit(FreezeEvent { pool_id: pool.id.to_inner(), frozen: true });
}

public fun unfreeze_pool(pool: &mut Pool, cap: &AdminCap) {
    assert_pool_admin(cap, pool);
    pool.frozen = false;
    event::emit(FreezeEvent { pool_id: pool.id.to_inner(), frozen: false });
}

public fun is_frozen(pool: &Pool): bool { pool.frozen }
public fun pool_balance(pool: &Pool): u64 { pool.balance.value() }
public fun threshold(pool: &Pool): u64 { pool.threshold }

public fun current_epoch(clock: &sui::clock::Clock): u64 {
    sui::clock::timestamp_ms(clock) / EPOCH_DURATION_MS
}

fun all_zero(data: &vector<u8>): bool {
    let mut i = 0;
    while (i < data.length()) {
        if (data[i] != 0) { return false };
        i = i + 1;
    };
    true
}

fun assert_upper_bytes_zero(data: &vector<u8>, start: u64, end: u64) {
    let mut i = start;
    while (i < end) {
        assert!(data[i] == 0, E_INVALID_INPUTS_LENGTH);
        i = i + 1;
    };
}

fun le_bytes_to_u64(data: &vector<u8>, offset: u64): u64 {
    let mut result: u64 = 0;
    let mut i: u8 = 0;
    while (i < 8) {
        let byte_val = data[offset + (i as u64)] as u64;
        result = result | (byte_val << ((i as u8) * 8));
        i = i + 1;
    };
    result
}

fun extract_bytes(data: &vector<u8>, start: u64, end: u64): vector<u8> {
    let mut result = vector[];
    let mut i = start;
    while (i < end) { result.push_back(data[i]); i = i + 1; };
    result
}
