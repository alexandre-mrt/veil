#[test_only]
module veil::pool_withdraw_tests;

use sui::clock;
use sui::coin;
use sui::test_scenario;
use veil::compliance;
use veil::pool::{Self, Pool, AdminCap};
use veil::test_helpers;
use veil::token::TOKEN;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
const USER: address = @0xB;
const ATTACKER: address = @0xC;
const RECIPIENT: address = @0xD;

const THRESHOLD: u64 = 1_000_000_000;
const DEPOSIT_AMOUNT: u64 = 500_000_000;
const WITHDRAW_AMOUNT: u64 = 200_000_000;
const EPOCH_DURATION_MS: u64 = 3_600_000;
// Shared test constants: dummy_root() and dummy_auditor_key() from test_helpers

// ===========================================================================
// EDGE CASE TESTS (continued from pool_tests.move)
// ===========================================================================

// 36. shielded_transfer with 225 bytes (too long, expected 224)
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_shielded_transfer_225_bytes_public_inputs() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let long_inputs = test_helpers::make_n_zero_bytes(225);
        pool::shielded_transfer(&mut pool, proof, long_inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 37. deposit_and_register with empty commitment (0 bytes)
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_deposit_and_register_empty_commitment() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let empty_commitment = vector[];
        let clock = clock::create_for_testing(scenario.ctx());
        pool::deposit_and_register(&mut pool, deposit_coin, empty_commitment, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — EMERGENCY WITHDRAW / WITHDRAWAL TIMELOCK
// ===========================================================================

// 38. emergency_withdraw on unfrozen pool — must fail E_POOL_NOT_FROZEN
#[test]
#[expected_failure(abort_code = 20, location = veil::pool)]
fun test_emergency_withdraw_not_frozen() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        // Pool is NOT frozen — emergency_withdraw must abort
        pool::emergency_withdraw(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 39. propose_withdrawal twice — must fail E_WITHDRAWAL_PENDING
#[test]
#[expected_failure(abort_code = 21, location = veil::pool)]
fun test_propose_withdrawal_double() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdrawal(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, &clock);
        // Second proposal while first is pending — must abort
        pool::propose_withdrawal(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 40. execute_withdrawal too early (same epoch) — must fail E_WITHDRAWAL_NOT_READY
#[test]
#[expected_failure(abort_code = 22, location = veil::pool)]
fun test_execute_withdrawal_too_early() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx()); // epoch 0
        pool::propose_withdrawal(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, &clock);
        // Execute immediately at same epoch (epoch 0, effective epoch 1) — must abort
        pool::execute_pending_withdrawal(&mut pool, &cap, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 41. cancel_withdrawal then re-propose — verify pending_withdrawal is cleared
#[test]
fun test_cancel_withdrawal_success() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdrawal(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, &clock);
        // Cancel the pending withdrawal
        pool::cancel_withdrawal(&mut pool, &cap);
        // Re-propose should succeed (proving pending_withdrawal was cleared)
        pool::propose_withdrawal(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 42. cancel_withdrawal with nothing pending — must fail E_NO_PENDING_WITHDRAWAL
#[test]
#[expected_failure(abort_code = 23, location = veil::pool)]
fun test_cancel_withdrawal_no_pending() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        // No withdrawal was proposed — cancel must abort
        pool::cancel_withdrawal(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — COMPLIANCE TOGGLE TIMELOCK
// ===========================================================================

// 43. propose_compliance_toggle twice — must fail E_COMPLIANCE_TOGGLE_PENDING
#[test]
#[expected_failure(abort_code = 19, location = veil::pool)]
fun test_propose_compliance_toggle_double() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    // Create compliance config so toggle to true is allowed
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap, &mut pool, test_helpers::dummy_vk(), test_helpers::dummy_root(), 1, test_helpers::dummy_auditor_key(), scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_compliance_toggle(&mut pool, &cap, true, &clock);
        // Second proposal while first is pending — must abort
        pool::propose_compliance_toggle(&mut pool, &cap, false, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 44. cancel_compliance_toggle — propose then cancel, verify cleared (re-propose works)
#[test]
fun test_cancel_compliance_toggle() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    // Create compliance config so toggle to true is allowed
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap, &mut pool, test_helpers::dummy_vk(), test_helpers::dummy_root(), 1, test_helpers::dummy_auditor_key(), scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_compliance_toggle(&mut pool, &cap, true, &clock);
        // Cancel the pending toggle
        pool::cancel_compliance_toggle(&mut pool, &cap);
        // Re-propose should succeed (proving pending was cleared)
        pool::propose_compliance_toggle(&mut pool, &cap, true, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ZK WITHDRAW TESTS
// ===========================================================================

// 45. propose_withdraw_vk — admin proposes, applied after 1 epoch
#[test]
fun test_propose_withdraw_vk() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        assert!(!pool.withdraw_vk_set(), 0);
        pool::propose_withdraw_vk(&mut pool, &cap, test_helpers::dummy_vk(), &clock);
        // Not yet applied (timelock)
        assert!(!pool.withdraw_vk_set(), 1);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 46. propose_withdraw_vk with wrong admin cap — must fail E_NOT_POOL_ADMIN
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_propose_withdraw_vk_wrong_admin() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ATTACKER);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdraw_vk(&mut pool, &cap, test_helpers::dummy_vk(), &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 47. zk_withdraw fails if no withdraw VK set — E_NO_WITHDRAW_VK
#[test]
#[expected_failure(abort_code = 29, location = veil::pool)]
fun test_zk_withdraw_no_vk() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let inputs = test_helpers::make_n_zero_bytes(160);
        // No withdraw VK set — must abort with E_NO_WITHDRAW_VK
        pool::zk_withdraw(&mut pool, proof, inputs, USER, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 48. zk_withdraw fails when pool is frozen — E_FROZEN
#[test]
#[expected_failure(abort_code = 1, location = veil::pool)]
fun test_zk_withdraw_frozen() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdraw_vk(&mut pool, &cap, test_helpers::dummy_vk(), &clock);
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS);
        pool::freeze_pool(&mut pool, &cap, &clock);
        let proof = vector[0u8];
        let inputs = test_helpers::make_n_zero_bytes(160);
        pool::zk_withdraw(&mut pool, proof, inputs, USER, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 49. zk_withdraw with wrong input length (100 bytes) — E_INVALID_INPUTS_LENGTH
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_zk_withdraw_short_inputs() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdraw_vk(&mut pool, &cap, test_helpers::dummy_vk(), &clock);
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS);
        let proof = vector[0u8];
        let short_inputs = test_helpers::make_n_zero_bytes(100);
        pool::zk_withdraw(&mut pool, proof, short_inputs, USER, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// 50. Propose withdrawal for full balance, then emergency_withdraw reduces
// balance between propose and execute — execute should fail E_INSUFFICIENT_BALANCE
// ===========================================================================
#[test]
#[expected_failure(abort_code = 6, location = veil::pool)]
fun test_execute_withdrawal_balance_decreased() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Create pool
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    // Deposit 500 TOKEN
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin);
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT, 0);
        test_scenario::return_shared(pool);
    };
    // Propose withdrawal for full balance (500 TOKEN) at epoch 0
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdrawal(&mut pool, &cap, DEPOSIT_AMOUNT, RECIPIENT, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Freeze pool at epoch 0
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::freeze_pool(&mut pool, &cap, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // At epoch 1: emergency_withdraw 100 TOKEN (reduces balance to 400)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS); // epoch 1
        pool::emergency_withdraw(&mut pool, &cap, 100_000_000, ADMIN, &clock, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT - 100_000_000, 1);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Unfreeze pool
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        pool::unfreeze_pool(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // At epoch 2: try execute_pending_withdrawal for 500 TOKEN — only 400 left
    // Should fail with E_INSUFFICIENT_BALANCE (6)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS * 2); // epoch 2
        pool::execute_pending_withdrawal(&mut pool, &cap, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

