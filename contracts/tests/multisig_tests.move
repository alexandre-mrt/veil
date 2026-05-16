#[test_only]
module veil::multisig_tests;

use sui::clock;
use sui::test_scenario;
use veil::compliance::{Self, ComplianceConfig};
use veil::multisig::{Self, MultisigConfig};
use veil::pool::{Self, Pool, AdminCap};
use veil::test_helpers;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
const SIGNER1: address = @0xB;
const SIGNER2: address = @0xC;
const SIGNER3: address = @0xD;
const NON_SIGNER: address = @0xE;

const THRESHOLD: u64 = 1_000_000_000;
const EPOCH_DURATION_MS: u64 = 3_600_000;

const UPDATED_ROOT: vector<u8> = vector[
    2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8, 9u8,
    10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8, 17u8,
    18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8, 25u8,
    26u8, 27u8, 28u8, 29u8, 30u8, 31u8, 32u8, 33u8,
];
const REQUIRED_APPROVALS: u64 = 2;

const ACTION_FREEZE: vector<u8> = vector[1u8, 0u8, 0u8, 0u8];

// ===========================================================================
// 1. Create multisig config (3 signers, 2 required) — happy path
// ===========================================================================
#[test]
fun test_create_multisig_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
    // Verify and consume — should succeed with 2 approvals (aborts internally if insufficient)
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::verify_and_consume_approval(&mut config, ACTION_FREEZE);
        // After consumption, approval count should be 0 (record removed)
        assert!(multisig::approval_count(&config, ACTION_FREEZE) == 0, 3);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 3. Approve action by 1 signer -> verify aborts (insufficient approvals)
// ===========================================================================
#[test]
#[expected_failure(abort_code = 202, location = veil::multisig)]
fun test_one_approval_insufficient() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
    // Verify — aborts with E_INSUFFICIENT_APPROVALS (1 < 2 required)
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::verify_and_consume_approval(&mut config, ACTION_FREEZE);
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        multisig::verify_and_consume_approval(&mut config, ACTION_FREEZE);
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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

// ===========================================================================
// 11. verify_and_consume_approval is now public(package) — cannot be called
//     externally. This test verifies the function aborts on insufficient
//     approvals rather than silently returning false (the old behavior).
// ===========================================================================
#[test]
#[expected_failure(abort_code = 202, location = veil::multisig)]
fun test_consume_insufficient_approvals_aborts() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        // 3-of-3 required — very strict
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], 3, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Only 2 signers approve (need 3)
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
    // Attempt to consume — must abort with E_INSUFFICIENT_APPROVALS (not return false)
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::verify_and_consume_approval(&mut config, ACTION_FREEZE);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// 12. Stale ComplianceConfig after replacement — create config A, replace it,
//     try to use old config A via multisig operations on the pool.
//     Since multisig_freeze only checks pool_id match (not compliance_config),
//     this test verifies that the pool's compliance_config reference is updated.
// ===========================================================================
#[test]
fun test_stale_compliance_config_pool_reference_updated() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    // Create compliance config A
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            1,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Capture config A's ID
    scenario.next_tx(ADMIN);
    let config_a_id;
    {
        let config = scenario.take_shared<ComplianceConfig>();
        config_a_id = object::id(&config);
        test_scenario::return_shared(config);
    };
    // Freeze pool and replace compliance config
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::freeze_pool(&mut pool, &cap, &clock);
        compliance::replace_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            UPDATED_ROOT,
            2,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        pool::unfreeze_pool(&mut pool, &cap);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Verify: pool's compliance_config now points to config B (not A)
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let pool_config_id = pool::pool_compliance_config(&pool);
        assert!(pool_config_id.is_some(), 0);
        // Config A's ID should NOT match the pool's current compliance config
        assert!(*pool_config_id.borrow() != config_a_id, 1);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// 13. multisig_propose_withdrawal — end-to-end with 2-of-3 approval
// ===========================================================================
#[test]
fun test_multisig_propose_withdrawal_end_to_end() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    // Deposit so pool has funds
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let deposit = sui::coin::mint_for_testing<veil::token::TOKEN>(500_000_000, scenario.ctx());
        pool::deposit(&mut pool, deposit);
        multisig::create_multisig(
            &pool, &cap, vector[SIGNER1, SIGNER2, SIGNER3], REQUIRED_APPROVALS, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    let action_hash: vector<u8> = vector[3u8, 0u8, 0u8, 0u8]; // unique action for withdrawal
    // Signer 1 approves
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, action_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Signer 2 approves
    scenario.next_tx(SIGNER2);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, action_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Admin executes multisig_propose_withdrawal
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        multisig::multisig_propose_withdrawal(
            &mut config, &mut pool, &cap, action_hash,
            200_000_000, ADMIN, &clock,
        );
        // Withdrawal is now pending (timelock)
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// 14. multisig_propose_withdrawal — fails with only 1 approval
// ===========================================================================
#[test]
#[expected_failure(abort_code = 202, location = veil::multisig)]
fun test_multisig_propose_withdrawal_insufficient_approvals() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
    let action_hash: vector<u8> = vector[3u8, 0u8, 0u8, 0u8];
    // Only 1 approval
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, action_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Admin tries to execute — should fail
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        multisig::multisig_propose_withdrawal(
            &mut config, &mut pool, &cap, action_hash,
            200_000_000, ADMIN, &clock,
        );
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// 15. multisig_propose_vk_update — end-to-end with 2-of-3 approval
// ===========================================================================
#[test]
fun test_multisig_propose_vk_update_end_to_end() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
    let action_hash: vector<u8> = vector[4u8, 0u8, 0u8, 0u8]; // unique action for VK update
    // Signer 1 approves
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, action_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Signer 2 approves
    scenario.next_tx(SIGNER2);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, action_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Admin executes multisig_propose_vk_update
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        multisig::multisig_propose_vk_update(
            &mut config, &mut pool, &cap, action_hash,
            test_helpers::dummy_vk(), &clock,
        );
        // VK update is now pending (timelock)
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// 16. multisig_propose_vk_update — fails with only 1 approval
// ===========================================================================
#[test]
#[expected_failure(abort_code = 202, location = veil::multisig)]
fun test_multisig_propose_vk_update_insufficient_approvals() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
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
    let action_hash: vector<u8> = vector[4u8, 0u8, 0u8, 0u8];
    // Only 1 approval
    scenario.next_tx(SIGNER1);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        multisig::approve_action(&mut config, action_hash, scenario.ctx());
        test_scenario::return_shared(config);
    };
    // Admin tries to execute — should fail
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<MultisigConfig>();
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        multisig::multisig_propose_vk_update(
            &mut config, &mut pool, &cap, action_hash,
            test_helpers::dummy_vk(), &clock,
        );
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}
