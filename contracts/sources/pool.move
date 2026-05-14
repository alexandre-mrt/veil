module veil::pool;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::event;
use veil::token::TOKEN;
use veil::verifier;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------
const E_FROZEN: u64 = 1;
const E_NULLIFIER_SPENT: u64 = 2;
const E_INVALID_PROOF: u64 = 3;
const E_INSUFFICIENT_BALANCE: u64 = 6;

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------
public struct Pool has key {
    id: UID,
    balance: Balance<TOKEN>,
    transfer_vk: vector<u8>,
    threshold: u64,
    frozen: bool,
}

public struct AdminCap has key, store {
    id: UID,
}

public struct NullifierKey has copy, drop, store {
    bytes: vector<u8>,
}

public struct CommitmentKey has copy, drop, store {
    bytes: vector<u8>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
public struct DepositEvent has copy, drop {
    sender: address,
    amount: u64,
}

public struct TransferEvent has copy, drop {
    nullifier: vector<u8>,
    new_commitment: vector<u8>,
}

public struct WithdrawEvent has copy, drop {
    recipient: address,
    amount: u64,
}

// ---------------------------------------------------------------------------
// Init helpers
// ---------------------------------------------------------------------------
public fun create_pool(transfer_vk: vector<u8>, threshold: u64, ctx: &mut TxContext) {
    let pool = Pool {
        id: object::new(ctx),
        balance: balance::zero(),
        transfer_vk,
        threshold,
        frozen: false,
    };
    let cap = AdminCap { id: object::new(ctx) };

    transfer::share_object(pool);
    transfer::transfer(cap, ctx.sender());
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------
public fun deposit(pool: &mut Pool, coin: Coin<TOKEN>, ctx: &TxContext) {
    assert!(!pool.frozen, E_FROZEN);
    let amount = coin.value();
    balance::join(&mut pool.balance, coin.into_balance());
    event::emit(DepositEvent { sender: ctx.sender(), amount });
}

// ---------------------------------------------------------------------------
// Shielded transfer
// ---------------------------------------------------------------------------
public fun shielded_transfer(
    pool: &mut Pool,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
    _clock: &sui::clock::Clock,
    _ctx: &TxContext,
) {
    assert!(!pool.frozen, E_FROZEN);

    let valid = verifier::verify_transfer_proof(
        &pool.transfer_vk,
        proof_bytes,
        public_inputs_bytes,
    );
    assert!(valid, E_INVALID_PROOF);

    // Nullifier: bytes 128..160 of public_inputs_bytes (5th 32-byte input)
    let nullifier = extract_bytes(&public_inputs_bytes, 128, 160);

    let nullifier_key = NullifierKey { bytes: nullifier };
    assert!(
        !dynamic_field::exists(&pool.id, nullifier_key),
        E_NULLIFIER_SPENT,
    );

    dynamic_field::add(&mut pool.id, nullifier_key, true);

    // New commitment: bytes 32..64 of public_inputs_bytes (2nd 32-byte input)
    let new_commitment = extract_bytes(&public_inputs_bytes, 32, 64);
    dynamic_field::add(
        &mut pool.id,
        CommitmentKey { bytes: nullifier },
        new_commitment,
    );

    event::emit(TransferEvent {
        nullifier,
        new_commitment,
    });
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------
public fun withdraw(
    pool: &mut Pool,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    assert!(!pool.frozen, E_FROZEN);
    assert!(pool.balance.value() >= amount, E_INSUFFICIENT_BALANCE);

    let withdrawn = coin::from_balance(balance::split(&mut pool.balance, amount), ctx);
    transfer::public_transfer(withdrawn, recipient);
    event::emit(WithdrawEvent { recipient, amount });
}

// ---------------------------------------------------------------------------
// Admin functions
// ---------------------------------------------------------------------------
public fun freeze_pool(pool: &mut Pool, _cap: &AdminCap) {
    pool.frozen = true;
}

public fun unfreeze_pool(pool: &mut Pool, _cap: &AdminCap) {
    pool.frozen = false;
}

public fun update_vk(pool: &mut Pool, _cap: &AdminCap, new_vk: vector<u8>) {
    pool.transfer_vk = new_vk;
}

// ---------------------------------------------------------------------------
// Read helpers (for tests)
// ---------------------------------------------------------------------------
public fun is_frozen(pool: &Pool): bool {
    pool.frozen
}

public fun pool_balance(pool: &Pool): u64 {
    pool.balance.value()
}

public fun threshold(pool: &Pool): u64 {
    pool.threshold
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------
fun extract_bytes(data: &vector<u8>, start: u64, end: u64): vector<u8> {
    let mut result = vector[];
    let mut i = start;
    while (i < end) {
        result.push_back(data[i]);
        i = i + 1;
    };
    result
}
