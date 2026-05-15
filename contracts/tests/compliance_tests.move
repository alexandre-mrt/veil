#[test_only]
module veil::compliance_tests;

use sui::test_scenario;
use sui::clock;
use veil::compliance::{Self, ComplianceConfig};
use veil::pool::{Self, Pool, AdminCap};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
const USER: address = @0xB;
const ATTACKER: address = @0xC;

/// A minimal dummy VK — real Groth16 VKs are not needed for config tests.
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

/// A valid 32-byte credential Merkle root.
const DUMMY_ROOT: vector<u8> = vector[
    1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
    9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8,
    17u8, 18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8,
    25u8, 26u8, 27u8, 28u8, 29u8, 30u8, 31u8, 32u8,
];

/// An updated 32-byte root (all bytes incremented by 1 for uniqueness).
const UPDATED_ROOT: vector<u8> = vector[
    2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8, 9u8,
    10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8, 17u8,
    18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8, 25u8,
    26u8, 27u8, 28u8, 29u8, 30u8, 31u8, 32u8, 33u8,
];

const DUMMY_AUDITOR_KEY: vector<u8> = vector[
    0xABu8, 0xCDu8, 0xEFu8, 0x01u8, 0x02u8, 0x03u8, 0x04u8, 0x05u8,
    0x06u8, 0x07u8, 0x08u8, 0x09u8, 0x0Au8, 0x0Bu8, 0x0Cu8, 0x0Du8,
    0x0Eu8, 0x0Fu8, 0x10u8, 0x11u8, 0x12u8, 0x13u8, 0x14u8, 0x15u8,
    0x16u8, 0x17u8, 0x18u8, 0x19u8, 0x1Au8, 0x1Bu8, 0x1Cu8, 0x1Du8,
    0x1Eu8,
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
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<ComplianceConfig>();
        assert!(compliance::required_kyc_level(&config) == REQUIRED_KYC_LEVEL, 0);
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 1);
        assert!(compliance::auditor_key(&config) == DUMMY_AUDITOR_KEY, 2);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// 2. update_credential_root — admin proposes root update with timelock
#[test]
fun test_update_credential_root() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 0);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 2b. update_credential_root — double proposal blocked by pending check
#[test]
#[expected_failure(abort_code = 28, location = veil::compliance)]
fun test_update_credential_root_double_proposal_blocked() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 0);
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
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
        assert!(compliance::auditor_key(&config) == DUMMY_AUDITOR_KEY, 0);
        clock::destroy_for_testing(test_clock);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 4. update_required_kyc_level — admin changes level successfully
#[test]
fun test_update_required_kyc_level() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
        compliance::update_required_kyc_level(&mut config, &cap, &pool, UPDATED_KYC_LEVEL);
        assert!(compliance::required_kyc_level(&config) == UPDATED_KYC_LEVEL, 0);
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
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 1);
        assert!(compliance::auditor_key(&config) == DUMMY_AUDITOR_KEY, 2);
        assert!(compliance::config_pool_id(&config) == object::id(&pool), 3);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — INPUT VALIDATION
// ===========================================================================

// 6. create_config_invalid_root_length — 16-byte root fails
#[test]
#[expected_failure(abort_code = 23, location = veil::compliance)]
fun test_create_config_invalid_root_length() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let short_root = vector[
            1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
            9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8,
        ]; // 16 bytes — must be 32
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            short_root,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 7. create_config_empty_root_fails — 0-byte root fails
#[test]
#[expected_failure(abort_code = 23, location = veil::compliance)]
fun test_create_config_empty_root_fails() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            vector[],
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 8. update_root_invalid_length — 3-byte replacement root fails
#[test]
#[expected_failure(abort_code = 23, location = veil::compliance)]
fun test_update_root_invalid_length() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        // Attacker's cap (from pool 2) used against pool 1
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
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
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
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
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
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

// 12. attacker_cannot_update_kyc_level — wrong AdminCap fails on update_required_kyc_level
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_attacker_cannot_update_kyc_level() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap from pool 2
        compliance::update_required_kyc_level(&mut config, &cap, &pool, UPDATED_KYC_LEVEL);
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
#[expected_failure(abort_code = 26, location = veil::compliance)]
fun test_update_root_pool_mismatch() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Create pool 1 (ADMIN) + compliance config tied to it
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Create pool 2 (still ADMIN) — same admin, different pool object
    scenario.next_tx(ADMIN);
    pool::create_pool(DUMMY_VK, POOL_THRESHOLD, scenario.ctx());
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
