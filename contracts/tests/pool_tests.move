#[test_only]
module veil::pool_tests;

use sui::coin;
use sui::test_scenario::{Self, Scenario};
use veil::pool::{Self, Pool, AdminCap};
use veil::token::TOKEN;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
const USER: address = @0xB;
const RECIPIENT: address = @0xC;

const DUMMY_VK: vector<u8> = vector[0u8, 0u8];
const THRESHOLD: u64 = 1_000_000_000;
const DEPOSIT_AMOUNT: u64 = 500_000_000;
const WITHDRAW_AMOUNT: u64 = 200_000_000;

// ---------------------------------------------------------------------------
// Test: create pool
// ---------------------------------------------------------------------------
#[test]
fun test_create_pool() {
    let mut scenario = test_scenario::begin(ADMIN);

    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        assert!(!pool.is_frozen(), 0);
        assert!(pool.pool_balance() == 0, 1);
        assert!(pool.threshold() == THRESHOLD, 2);
        test_scenario::return_shared(pool);

        let cap = scenario.take_from_sender<AdminCap>();
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

// ---------------------------------------------------------------------------
// Test: deposit tokens
// ---------------------------------------------------------------------------
#[test]
fun test_deposit() {
    let mut scenario = test_scenario::begin(ADMIN);

    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT, 0);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------------------
// Test: freeze blocks deposit
// ---------------------------------------------------------------------------
#[test]
#[expected_failure(abort_code = 1)] // E_FROZEN
fun test_freeze_blocks_deposit() {
    let mut scenario = test_scenario::begin(ADMIN);

    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        pool::freeze_pool(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin, scenario.ctx());
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------------------
// Test: withdraw tokens
// ---------------------------------------------------------------------------
#[test]
fun test_withdraw() {
    let mut scenario = test_scenario::begin(ADMIN);

    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        pool::withdraw(&mut pool, WITHDRAW_AMOUNT, RECIPIENT, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT - WITHDRAW_AMOUNT, 0);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------------------
// Test: shielded_transfer with invalid proof fails (E_INVALID_PROOF)
// ---------------------------------------------------------------------------
#[test]
// The groth16 native function aborts when given invalid VK/proof bytes.
// We verify that bad inputs always cause an abort — not a silent success.
#[expected_failure]
fun test_shielded_transfer_invalid_proof_fails() {
    let mut scenario = test_scenario::begin(ADMIN);

    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());

        // Invalid proof bytes — cannot form a valid Groth16 proof
        let invalid_proof = vector[1u8, 2u8, 3u8];
        // public_inputs must be >= 160 bytes for nullifier extraction (post-proof-check)
        let public_inputs = vector[
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, // input 1 (32 bytes)
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, // input 2 (32 bytes)
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, // input 3 (32 bytes)
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, // input 4 (32 bytes)
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, // input 5 / nullifier (32 bytes)
        ];

        pool::shielded_transfer(&mut pool, invalid_proof, public_inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------------------
// Test: admin cap authorization (unfreeze)
// ---------------------------------------------------------------------------
#[test]
fun test_admin_cap_unfreeze() {
    let mut scenario = test_scenario::begin(ADMIN);

    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();

        pool::freeze_pool(&mut pool, &cap);
        assert!(pool.is_frozen(), 0);

        pool::unfreeze_pool(&mut pool, &cap);
        assert!(!pool.is_frozen(), 1);

        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}
