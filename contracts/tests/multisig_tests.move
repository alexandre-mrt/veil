#[test_only]
module veil::multisig_tests;

use sui::clock;
use sui::test_scenario;
use veil::multisig::{Self, MultisigConfig};
use veil::pool::{Self, Pool, AdminCap};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
const SIGNER1: address = @0xB;
const SIGNER2: address = @0xC;
const SIGNER3: address = @0xD;
const NON_SIGNER: address = @0xE;

const DUMMY_VK: vector<u8> = vector[
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0
];
const THRESHOLD: u64 = 1_000_000_000;
const EPOCH_DURATION_MS: u64 = 3_600_000;
const REQUIRED_APPROVALS: u64 = 2;

const ACTION_FREEZE: vector<u8> = vector[1u8, 0u8, 0u8, 0u8];

// ===========================================================================
// 1. Create multisig config (3 signers, 2 required) — happy path
// ===========================================================================
#[test]
fun test_create_multisig_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let signers = vector[SIGNER1, SIGNER2, SIGNER3];
        multisig::create_multisig(&pool, &cap, signers, REQUIRED_APPROVALS, scenario.ctx());
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<MultisigConfig>();
        assert!(config.required_approvals() == REQUIRED_APPROVALS, 0);
        assert!(config.signers().length() == 3, 1);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 2. Approve action by 2 signers -> verify_and_consume succeeds
// ===========================================================================
#[test]
fun test_two_approvals_succeed() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Signer 1 approves
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        assert!(multisig::approval_count(&config, ACTION_FREEZE) == 1, 0);
        test_scenario::return_shared(config);
    };
    // Signer 2 approves
    scenario.next_tx(SIGNER2);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        assert!(multisig::approval_count(&config, ACTION_FREEZE) == 2, 1);
        test_scenario::return_shared(config);
    };
    // Verify and consume — should succeed with 2 approvals
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let approved = multisig::verify_and_consume_approval(&mut config, ACTION_FREEZE);
        assert!(approved, 2);
        // After consumption, approval count should be 0 (record removed)
        assert!(multisig::approval_count(&config, ACTION_FREEZE) == 0, 3);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 3. Approve action by 1 signer -> verify fails (insufficient approvals)
// ===========================================================================
#[test]
fun test_one_approval_insufficient() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Only signer 1 approves
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Verify — returns false (1 < 2 required)
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let approved = multisig::verify_and_consume_approval(&mut config, ACTION_FREEZE);
        assert!(!approved, 0);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 4. Non-signer cannot approve
// ===========================================================================
#[test]
#[expected_failure(abort_code = 200, location = veil::multisig)]
fun test_non_signer_cannot_approve() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Non-signer tries to approve -> E_NOT_SIGNER (200)
    scenario.next_tx(NON_SIGNER);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 5. Double-approve by same signer fails
// ===========================================================================
#[test]
#[expected_failure(abort_code = 201, location = veil::multisig)]
fun test_double_approve_fails() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Signer 1 approves once
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Signer 1 tries to approve again -> E_ALREADY_APPROVED (201)
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 6. multisig_freeze — end-to-end with 2-of-3 approval
// ===========================================================================
#[test]
fun test_multisig_freeze_end_to_end() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Signer 1 approves
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Signer 2 approves
    scenario.next_tx(SIGNER2);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Admin executes multisig_freeze
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        assert!(!pool.is_frozen(), 0);
        multisig::multisig_freeze(&mut config, &mut pool, &cap, ACTION_FREEZE, &clock);
        assert!(pool.is_frozen(), 1);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// 7. multisig_freeze fails with only 1 approval
// ===========================================================================
#[test]
#[expected_failure(abort_code = 202, location = veil::multisig)]
fun test_multisig_freeze_insufficient_approvals() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Only 1 approval
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Admin tries to execute — should fail with E_INSUFFICIENT_APPROVALS
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        multisig::multisig_freeze(&mut config, &mut pool, &cap, ACTION_FREEZE, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// 8. verify_and_consume with no proposal fails
// ===========================================================================
#[test]
#[expected_failure(abort_code = 203, location = veil::multisig)]
fun test_verify_no_proposal_fails() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Try to verify without any approvals -> E_ACTION_NOT_APPROVED (203)
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let _approved = multisig::verify_and_consume_approval(&mut config, ACTION_FREEZE);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 9. Pool mismatch — config for pool A used with pool B
// ===========================================================================
#[test]
#[expected_failure(abort_code = 205, location = veil::multisig)]
fun test_pool_mismatch() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Create pool A (by ADMIN)
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Create pool B (by NON_SIGNER — different address owns its AdminCap)
    scenario.next_tx(NON_SIGNER);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    // Approve the action on config (which is for pool A)
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    scenario.next_tx(SIGNER2);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, ACTION_FREEZE, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // NON_SIGNER tries to freeze pool B using config for pool A
    // cap_b matches pool B (assert_pool_admin passes), but config is for pool A -> E_POOL_MISMATCH
    scenario.next_tx(NON_SIGNER);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let pool_b_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
        let mut pool_b = scenario.take_shared_by_id<Pool>(pool_b_id);
        let cap_b = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        multisig::multisig_freeze(&mut config, &mut pool_b, &cap_b, ACTION_FREEZE, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool_b);
        scenario.return_to_sender(cap_b);
    };
    scenario.end();
}

// ===========================================================================
// 10. multisig_unfreeze end-to-end
// ===========================================================================
#[test]
fun test_multisig_unfreeze_end_to_end() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Freeze the pool directly first (using AdminCap)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::freeze_pool(&mut pool, &cap, &clock);
        assert!(pool.is_frozen(), 0);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Approve unfreeze
    let unfreeze_hash: vector<u8> = vector[2u8, 0u8, 0u8, 0u8];
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, unfreeze_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    scenario.next_tx(SIGNER3);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, unfreeze_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Execute unfreeze
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        assert!(pool.is_frozen(), 1);
        multisig::multisig_unfreeze(&mut config, &mut pool, &cap, unfreeze_hash);
        assert!(!pool.is_frozen(), 2);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}
