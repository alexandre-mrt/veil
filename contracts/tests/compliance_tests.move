#[test_only]
module veil::compliance_tests;

use sui::test_scenario;
use sui::clock;
use veil::compliance::{Self, ComplianceConfig};
use veil::pool::{Self, Pool, AdminCap};
use veil::test_helpers;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
#[allow(unused_const)]
const USER: address = @0xB;
const ATTACKER: address = @0xC;

/// An updated 32-byte root (all bytes incremented by 1 for uniqueness).
const UPDATED_ROOT: vector<u8> = vector[
    2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8, 9u8,
    10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8, 17u8,
    18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8, 25u8,
    26u8, 27u8, 28u8, 29u8, 30u8, 31u8, 32u8, 33u8,
];
const UPDATED_AUDITOR_KEY: vector<u8> = vector[
    0x01u8, 0x02u8, 0x03u8, 0x04u8, 0x05u8, 0x06u8, 0x07u8, 0x08u8,
    0x09u8, 0x0Au8, 0x0Bu8, 0x0Cu8, 0x0Du8, 0x0Eu8, 0x0Fu8, 0x10u8,
    0x11u8, 0x12u8, 0x13u8, 0x14u8, 0x15u8, 0x16u8, 0x17u8, 0x18u8,
    0x19u8, 0x1Au8, 0x1Bu8, 0x1Cu8, 0x1Du8, 0x1Eu8, 0x1Fu8, 0x20u8,
    0x21u8,
];
const POOL_THRESHOLD: u64 = 1_000_000_000;
const REQUIRED_KYC_LEVEL: u64 = 1;
const UPDATED_KYC_LEVEL: u64 = 2;

/// EPOCH_DURATION_MS from pool.move — needed to advance clock past timelock.
const EPOCH_DURATION_MS: u64 = 3_600_000;

// ===========================================================================
// HAPPY PATH TESTS
// ===========================================================================

// 1. create_compliance_config — config created with correct fields
#[test]
fun test_create_compliance_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<ComplianceConfig>();
        assert!(compliance::required_kyc_level(&config) == REQUIRED_KYC_LEVEL, 0);
        assert!(compliance::credential_root(&config) == test_helpers::dummy_root(), 1);
        assert!(compliance::auditor_key(&config) == test_helpers::dummy_auditor_key(), 2);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// 2. update_credential_root — admin proposes root update with timelock
#[test]
fun test_update_credential_root() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        // Propose update — root should NOT change immediately (timelock)
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &test_clock);
        assert!(compliance::credential_root(&config) == test_helpers::dummy_root(), 0);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 2b. update_credential_root — double proposal blocked by pending check
#[test]
#[expected_failure(abort_code = 108, location = veil::compliance)]
fun test_update_credential_root_double_proposal_blocked() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &test_clock);
        // Second proposal while first is pending — should abort with E_CREDENTIAL_ROOT_UPDATE_PENDING
        let another_root = vector[
            3u8, 4u8, 5u8, 6u8, 7u8, 8u8, 9u8, 10u8,
            11u8, 12u8, 13u8, 14u8, 15u8, 16u8, 17u8, 18u8,
            19u8, 20u8, 21u8, 22u8, 23u8, 24u8, 25u8, 26u8,
            27u8, 28u8, 29u8, 30u8, 31u8, 32u8, 33u8, 34u8,
        ];
        compliance::update_credential_root(&mut config, &cap, &pool, another_root, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 2c. cancel_credential_root_update — admin can cancel pending root update
#[test]
fun test_cancel_credential_root_update() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &test_clock);
        // Cancel the pending update
        compliance::cancel_credential_root_update(&mut config, &cap, &pool);
        // Root should still be the original
        assert!(compliance::credential_root(&config) == test_helpers::dummy_root(), 0);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 3. propose_auditor_key_update — admin proposes key update with timelock
#[test]
fun test_propose_auditor_key_update() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_auditor_key_update(&mut config, &cap, &pool, UPDATED_AUDITOR_KEY, &test_clock);
        // Key should NOT change immediately (timelock)
        assert!(compliance::auditor_key(&config) == test_helpers::dummy_auditor_key(), 0);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 4. propose_kyc_level_update — admin proposes level update with timelock (does NOT apply immediately)
#[test]
fun test_propose_kyc_level_update() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_kyc_level_update(&mut config, &cap, &pool, UPDATED_KYC_LEVEL, &test_clock);
        // Level should NOT change immediately (timelock)
        assert!(compliance::required_kyc_level(&config) == REQUIRED_KYC_LEVEL, 0);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 4b. propose_kyc_level_update — double proposal blocked
#[test]
#[expected_failure(abort_code = 113, location = veil::compliance)]
fun test_propose_kyc_level_update_double_proposal_blocked() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_kyc_level_update(&mut config, &cap, &pool, UPDATED_KYC_LEVEL, &test_clock);
        // Second proposal while first pending — should abort with E_KYC_LEVEL_UPDATE_PENDING
        compliance::propose_kyc_level_update(&mut config, &cap, &pool, 3, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 4c. cancel_kyc_level_update — admin can cancel pending KYC level update
#[test]
fun test_cancel_kyc_level_update() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_kyc_level_update(&mut config, &cap, &pool, UPDATED_KYC_LEVEL, &test_clock);
        // Cancel the pending update
        compliance::cancel_kyc_level_update(&mut config, &cap, &pool);
        // Level should still be the original
        assert!(compliance::required_kyc_level(&config) == REQUIRED_KYC_LEVEL, 0);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 5. accessors — verify all getter functions return expected values
#[test]
fun test_accessors() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let config = scenario.take_shared<ComplianceConfig>();
        assert!(compliance::required_kyc_level(&config) == REQUIRED_KYC_LEVEL, 0);
        assert!(compliance::credential_root(&config) == test_helpers::dummy_root(), 1);
        assert!(compliance::auditor_key(&config) == test_helpers::dummy_auditor_key(), 2);
        assert!(compliance::config_pool_id(&config) == object::id(&pool), 3);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// COMPLIANCE CONFIG REPLACEMENT TESTS
// ===========================================================================

// 5b. replace_compliance_config — admin replaces config on frozen pool
#[test]
fun test_replace_compliance_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        // Freeze pool — required for replacement
        pool::freeze_pool(&mut pool, &cap, &test_clock);
        assert!(pool::is_frozen(&pool), 0);
        // Replace compliance config with new parameters
        compliance::replace_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            UPDATED_ROOT,
            UPDATED_KYC_LEVEL,
            UPDATED_AUDITOR_KEY,
            scenario.ctx(),
        );
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Verify the new config has the updated values
    scenario.next_tx(ADMIN);
    {
        // There are now 2 ComplianceConfig objects — take the most recent one
        let config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        // New config should have updated values
        assert!(compliance::credential_root(&config) == UPDATED_ROOT, 1);
        assert!(compliance::required_kyc_level(&config) == UPDATED_KYC_LEVEL, 2);
        assert!(compliance::auditor_key(&config) == UPDATED_AUDITOR_KEY, 3);
        assert!(compliance::config_pool_id(&config) == object::id(&pool), 4);
        // Pool should reference the new config
        assert!(pool::pool_compliance_config(&pool).is_some(), 5);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// 5c. replace_compliance_config — fails on unfrozen pool
#[test]
#[expected_failure(abort_code = 115, location = veil::compliance)]
fun test_replace_compliance_config_not_frozen() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        // Pool is NOT frozen — replacement should fail
        compliance::replace_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            UPDATED_ROOT,
            UPDATED_KYC_LEVEL,
            UPDATED_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 5d. replace_compliance_config — wrong AdminCap fails
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_replace_compliance_config_wrong_admin() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        let test_clock = clock::create_for_testing(scenario.ctx());
        pool::freeze_pool(&mut pool, &cap, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Attacker creates their own pool to get an AdminCap
    scenario.next_tx(ATTACKER);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap
        compliance::replace_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            UPDATED_ROOT,
            UPDATED_KYC_LEVEL,
            UPDATED_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — INPUT VALIDATION
// ===========================================================================

// 6a. create_compliance_config with short VK — VK shorter than 232 bytes fails
#[test]
#[expected_failure(abort_code = 112, location = veil::compliance)]
fun test_create_compliance_config_short_vk() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let short_vk = test_helpers::make_n_zero_bytes(100); // < MIN_VK_LENGTH (232)
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            short_vk,
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 6b. create_compliance_config with short auditor key — key shorter than 33 bytes fails
#[test]
#[expected_failure(abort_code = 110, location = veil::compliance)]
fun test_create_compliance_config_short_auditor_key() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let short_key = vector[0x01u8, 0x02u8, 0x03u8, 0x04u8, 0x05u8]; // 5 bytes < 33
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            short_key,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 6c. propose_auditor_key_update with short key — key shorter than 33 bytes fails
#[test]
#[expected_failure(abort_code = 110, location = veil::compliance)]
fun test_propose_auditor_key_short() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        let short_key = vector[0x01u8, 0x02u8, 0x03u8]; // 3 bytes < 33
        compliance::propose_auditor_key_update(&mut config, &cap, &pool, short_key, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 6d. propose_compliance_vk_update with short VK — VK shorter than 232 bytes fails
#[test]
#[expected_failure(abort_code = 112, location = veil::compliance)]
fun test_propose_compliance_vk_short() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        let short_vk = test_helpers::make_n_zero_bytes(100); // < MIN_VK_LENGTH (232)
        compliance::propose_compliance_vk_update(&mut config, &cap, &pool, short_vk, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 7. create_config_invalid_root_length — 16-byte root fails
#[test]
#[expected_failure(abort_code = 103, location = veil::compliance)]
fun test_create_config_invalid_root_length() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let short_root = vector[
            1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
            9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8,
        ]; // 16 bytes — must be 32
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            short_root,
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 7. create_config_empty_root_fails — 0-byte root fails
#[test]
#[expected_failure(abort_code = 103, location = veil::compliance)]
fun test_create_config_empty_root_fails() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            vector[],
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 8. update_root_invalid_length — 3-byte replacement root fails
#[test]
#[expected_failure(abort_code = 103, location = veil::compliance)]
fun test_update_root_invalid_length() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        let bad_root = vector[1u8, 2u8, 3u8]; // 3 bytes — must be 32
        compliance::update_credential_root(&mut config, &cap, &pool, bad_root, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — ACCESS CONTROL
// Uses a second pool to give ATTACKER their own AdminCap, then tries to use
// it on the original pool/config — pattern matches pool_tests.move.
// ===========================================================================

// 9. attacker_cannot_create_config — wrong AdminCap (from a different pool) fails
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_attacker_cannot_create_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    scenario.next_tx(ATTACKER);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        // Attacker's cap (from pool 2) used against pool 1
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 10. attacker_cannot_update_root — wrong AdminCap fails on update_credential_root
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_attacker_cannot_update_root() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap from pool 2
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 11. attacker_cannot_update_key — wrong AdminCap fails on propose_auditor_key_update
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_attacker_cannot_update_key() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap from pool 2
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_auditor_key_update(&mut config, &cap, &pool, UPDATED_AUDITOR_KEY, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 12. attacker_cannot_update_kyc_level — wrong AdminCap fails on propose_kyc_level_update
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_attacker_cannot_update_kyc_level() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap from pool 2
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_kyc_level_update(&mut config, &cap, &pool, UPDATED_KYC_LEVEL, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — POOL MISMATCH
// ===========================================================================

// 13. update_root_pool_mismatch — correct cap but wrong pool fails
#[test]
#[expected_failure(abort_code = 106, location = veil::compliance)]
fun test_update_root_pool_mismatch() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Create pool 1 (ADMIN) + compliance config tied to it
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Create pool 2 (still ADMIN) — same admin, different pool object
    scenario.next_tx(ADMIN);
    pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let pool2 = scenario.take_shared<Pool>(); // pool 2 — different ID
        let mut config = scenario.take_shared<ComplianceConfig>(); // config linked to pool 1
        let cap = scenario.take_from_sender<AdminCap>(); // cap for pool 2 (valid for pool 2)
        let test_clock = clock::create_for_testing(scenario.ctx());
        // AdminCap matches pool 2, but config.pool_id == pool 1 → E_CONFIG_POOL_MISMATCH
        compliance::update_credential_root(&mut config, &cap, &pool2, UPDATED_ROOT, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool2);
        test_scenario::return_shared(config);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — DUPLICATE CONFIG / DOUBLE PROPOSALS
// ===========================================================================

// 14. create_compliance_config on pool that already has one — must fail E_COMPLIANCE_CONFIG_ALREADY_SET
#[test]
#[expected_failure(abort_code = 25, location = veil::pool)]
fun test_create_second_compliance_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        // Second compliance config on same pool — must abort
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 15. propose_compliance_vk_update twice — must fail E_COMPLIANCE_VK_UPDATE_PENDING
#[test]
#[expected_failure(abort_code = 114, location = veil::compliance)]
fun test_propose_compliance_vk_double() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_compliance_vk_update(&mut config, &cap, &pool, test_helpers::dummy_vk(), &test_clock);
        // Second proposal while first is pending — must abort
        compliance::propose_compliance_vk_update(&mut config, &cap, &pool, test_helpers::dummy_vk(), &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 16. propose_auditor_key_update twice — must fail E_AUDITOR_KEY_UPDATE_PENDING
#[test]
#[expected_failure(abort_code = 111, location = veil::compliance)]
fun test_propose_auditor_key_double() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        compliance::propose_auditor_key_update(&mut config, &cap, &pool, UPDATED_AUDITOR_KEY, &test_clock);
        // Second proposal while first is pending — must abort
        compliance::propose_auditor_key_update(&mut config, &cap, &pool, UPDATED_AUDITOR_KEY, &test_clock);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// STALE CONFIG TESTS
// ===========================================================================

// 17. stale ComplianceConfig after replacement — compliant_transfer with old config fails
// Steps: create config A, freeze pool, replace with config B, unfreeze, try compliant_transfer
// with config A — should fail E_CONFIG_POOL_MISMATCH since pool now points to config B.
#[test]
#[expected_failure(abort_code = 106, location = veil::compliance)]
fun test_stale_config_after_replacement() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(test_helpers::dummy_vk(), POOL_THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    };
    // Create ComplianceConfig A
    scenario.next_tx(ADMIN);
    let config_a_id;
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            test_helpers::dummy_root(),
            REQUIRED_KYC_LEVEL,
            test_helpers::dummy_auditor_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Capture config A's object ID
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<ComplianceConfig>();
        config_a_id = object::id(&config);
        test_scenario::return_shared(config);
    };
    // Freeze pool + replace with ComplianceConfig B
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let test_clock = clock::create_for_testing(scenario.ctx());
        pool::freeze_pool(&mut pool, &cap, &test_clock);
        compliance::replace_compliance_config(
            &cap,
            &mut pool,
            test_helpers::dummy_vk(),
            UPDATED_ROOT,
            UPDATED_KYC_LEVEL,
            UPDATED_AUDITOR_KEY,
            scenario.ctx(),
        );
        // Unfreeze pool
        pool::unfreeze_pool(&mut pool, &cap);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Try compliant_transfer with stale config A — should fail E_CONFIG_POOL_MISMATCH (106)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let mut config_a = scenario.take_shared_by_id<ComplianceConfig>(config_a_id);
        let test_clock = clock::create_for_testing(scenario.ctx());
        let dummy_proof = test_helpers::make_n_zero_bytes(128);
        let dummy_inputs = test_helpers::make_n_zero_bytes(224);
        let dummy_compliance_proof = test_helpers::make_n_zero_bytes(128);
        let dummy_compliance_inputs = test_helpers::make_n_zero_bytes(192);
        let dummy_encrypted = test_helpers::make_n_zero_bytes(93);
        // This should abort at config mismatch before any proof verification
        compliance::compliant_transfer(
            &mut pool,
            &mut config_a,
            dummy_proof,
            dummy_inputs,
            dummy_compliance_proof,
            dummy_compliance_inputs,
            dummy_encrypted,
            &test_clock,
            scenario.ctx(),
        );
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config_a);
    };
    scenario.end();
}

