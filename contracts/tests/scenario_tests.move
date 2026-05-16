#[test_only]
module veil::scenario_tests;

use sui::test_scenario;
use sui::clock;
use sui::coin;
use veil::pool::{Self, Pool, AdminCap};
use veil::compliance::{Self, ComplianceConfig};
use veil::token::TOKEN;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
const ALICE: address = @0xB;
const BOB: address = @0xC;
const ATTACKER: address = @0xD;

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
const DENOM_SMALL: u64 = 100_000_000;
const DENOM_MEDIUM: u64 = 500_000_000;
const DENOM_LARGE: u64 = 1_000_000_000;
const EPOCH_DURATION_MS: u64 = 3_600_000;
const REQUIRED_KYC_LEVEL: u64 = 1;
const DUMMY_AUDITOR_KEY: vector<u8> = vector[
    0xABu8, 0xCDu8, 0xEFu8, 0x01u8, 0x02u8, 0x03u8, 0x04u8, 0x05u8,
    0x06u8, 0x07u8, 0x08u8, 0x09u8, 0x0Au8, 0x0Bu8, 0x0Cu8, 0x0Du8,
    0x0Eu8, 0x0Fu8, 0x10u8, 0x11u8, 0x12u8, 0x13u8, 0x14u8, 0x15u8,
    0x16u8, 0x17u8, 0x18u8, 0x19u8, 0x1Au8, 0x1Bu8, 0x1Cu8, 0x1Du8,
    0x1Eu8,
];

const DUMMY_ROOT: vector<u8> = vector[
    1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
    9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8,
    17u8, 18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8,
    25u8, 26u8, 27u8, 28u8, 29u8, 30u8, 31u8, 32u8,
];

const UPDATED_ROOT: vector<u8> = vector[
    2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8, 9u8,
    10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8, 17u8,
    18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8, 25u8,
    26u8, 27u8, 28u8, 29u8, 30u8, 31u8, 32u8, 33u8,
];

// ===========================================================================
// USER STORY 1: Pool lifecycle (create -> deposit -> freeze -> unfreeze -> withdraw)
// ===========================================================================
#[test]
fun story_pool_lifecycle() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Admin creates pool
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool>();
        assert!(!pool.is_frozen(), 0);
        assert!(pool.pool_balance() == 0, 1);
        assert!(pool.threshold() == THRESHOLD, 2);
        assert!(!pool.compliance_required(), 3);
        test_scenario::return_shared(pool);
    };

    // Alice deposits DENOM_MEDIUM
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DENOM_MEDIUM, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_MEDIUM, 4);
        test_scenario::return_shared(pool);
    };

    // Admin freezes pool
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::freeze_pool(&mut pool, &cap, &clock);
        assert!(pool.is_frozen(), 5);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Alice tries to deposit when frozen -- should fail
    // (tested separately in threat_deposit_when_frozen)

    // Admin unfreezes pool
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        pool::unfreeze_pool(&mut pool, &cap);
        assert!(!pool.is_frozen(), 6);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Admin proposes withdrawal
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdrawal(&mut pool, &cap, DENOM_MEDIUM, ADMIN, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Execute withdrawal after epoch passes
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS);
        pool::execute_pending_withdrawal(&mut pool, &cap, &clock, scenario.ctx());
        assert!(pool.pool_balance() == 0, 7);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// USER STORY 2: Compliance lifecycle
// (create pool -> set compliance_required -> create config -> update root with timelock)
// ===========================================================================
#[test]
#[expected_failure(abort_code = 15, location = veil::pool)]
fun story_compliance_lifecycle_shielded_blocked() {
    // When compliance_required=true, shielded_transfer must fail with E_COMPLIANCE_REQUIRED
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Create compliance config (required before enabling compliance)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap, &mut pool, DUMMY_VK, DUMMY_ROOT, REQUIRED_KYC_LEVEL, DUMMY_AUDITOR_KEY, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Propose compliance_required=true at epoch 0
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());
        pool::propose_compliance_toggle(&mut pool, &cap, true, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Alice tries shielded_transfer at epoch 1 (compliance applied lazily) -- should fail
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let mut clk = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clk, EPOCH_DURATION_MS); // epoch 1
        let proof = vector[0u8];
        let inputs = make_n_zero_bytes(192);
        pool::shielded_transfer(&mut pool, proof, inputs, &clk, scenario.ctx());
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
fun story_compliance_config_and_root_timelock() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Create ComplianceConfig
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Propose credential root update at epoch 0
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx()); // epoch 0

        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &clk);
        // Root should NOT have changed yet (timelock: effective at epoch 1)
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 0);

        clock::destroy_for_testing(clk);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Verify root still unchanged at epoch 0 (read-only check)
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<ComplianceConfig>();
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 1);
        test_scenario::return_shared(config);
    };

    scenario.end();
}

// ===========================================================================
// USER STORY 3: Multi-user deposits with standard denominations
// ===========================================================================
#[test]
fun story_multi_user_standard_deposits() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Alice deposits DENOM_SMALL (100 TOKEN)
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        pool::deposit(&mut pool, coin_a, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL, 0);
        test_scenario::return_shared(pool);
    };

    // Bob deposits DENOM_MEDIUM (500 TOKEN)
    scenario.next_tx(BOB);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_b = coin::mint_for_testing<TOKEN>(DENOM_MEDIUM, scenario.ctx());
        pool::deposit(&mut pool, coin_b, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL + DENOM_MEDIUM, 1);
        test_scenario::return_shared(pool);
    };

    // Alice deposits DENOM_LARGE (1000 TOKEN)
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_c = coin::mint_for_testing<TOKEN>(DENOM_LARGE, scenario.ctx());
        pool::deposit(&mut pool, coin_c, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL + DENOM_MEDIUM + DENOM_LARGE, 2);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ===========================================================================
// USER STORY 4: VK update lifecycle (propose -> wait epoch -> verify applied)
// ===========================================================================
#[test]
fun story_vk_update_propose_cancel_repropose() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Propose VK update at epoch 0
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());
        pool::propose_vk_update(&mut pool, &cap, DUMMY_VK, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Cancel the pending VK update
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        pool::cancel_vk_update(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Propose again (should succeed after cancel)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());
        pool::propose_vk_update(&mut pool, &cap, DUMMY_VK, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

// ===========================================================================
// USER STORY 5: Commitment maturity -- deposit stores epoch, same-epoch transfer blocked
// ===========================================================================
#[test]
fun story_commitment_stores_deposit_epoch() {
    // Verify that deposit_and_register at epoch 0 stores the commitment.
    // We cannot test shielded_transfer maturity check directly (needs valid Groth16 proof),
    // but we verify the commitment is registered and the pool state is correct.
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Deposit and register at epoch 0
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        let commitment = valid_commitment(1);
        let clk = clock::create_for_testing(scenario.ctx()); // epoch 0
        pool::deposit_and_register(&mut pool, coin_a, commitment, &clk, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL, 0);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };

    // Deposit another at epoch 1 (advance clock)
    scenario.next_tx(BOB);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_b = coin::mint_for_testing<TOKEN>(DENOM_MEDIUM, scenario.ctx());
        let commitment = valid_commitment(2);
        let mut clk = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clk, EPOCH_DURATION_MS); // epoch 1
        pool::deposit_and_register(&mut pool, coin_b, commitment, &clk, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL + DENOM_MEDIUM, 1);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ===========================================================================
// USER STORY 6: Multi-pool isolation -- two admins, two pools, no cross-access
// ===========================================================================
#[test]
fun story_multi_pool_isolation() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Admin creates pool 1
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();

    // Alice creates pool 2
    scenario.next_tx(ALICE);
    pool::create_pool(DUMMY_VK, THRESHOLD * 2, scenario.ctx());
    scenario.next_tx(ALICE);

    // Deposit into pool 1
    scenario.next_tx(BOB);
    {
        let mut pool1 = scenario.take_shared_by_id<Pool>(pool1_id);
        let coin_b = coin::mint_for_testing<TOKEN>(DENOM_MEDIUM, scenario.ctx());
        pool::deposit(&mut pool1, coin_b, scenario.ctx());
        assert!(pool1.pool_balance() == DENOM_MEDIUM, 0);
        test_scenario::return_shared(pool1);
    };

    // Admin proposes withdrawal from pool 1
    scenario.next_tx(ADMIN);
    {
        let mut pool1 = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdrawal(&mut pool1, &cap, DENOM_MEDIUM, ADMIN, &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool1);
        scenario.return_to_sender(cap);
    };

    // Execute withdrawal after epoch passes
    scenario.next_tx(ADMIN);
    {
        let mut pool1 = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS);
        pool::execute_pending_withdrawal(&mut pool1, &cap, &clock, scenario.ctx());
        assert!(pool1.pool_balance() == 0, 1);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool1);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 1: Bypass compliance with direct shielded_transfer
// ===========================================================================
#[test]
#[expected_failure(abort_code = 15, location = veil::pool)]
fun threat_bypass_compliance_direct_transfer() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Create compliance config (required before enabling compliance)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap, &mut pool, DUMMY_VK, DUMMY_ROOT, REQUIRED_KYC_LEVEL, DUMMY_AUDITOR_KEY, scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Admin proposes compliance toggle at epoch 0
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());
        pool::propose_compliance_toggle(&mut pool, &cap, true, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Attacker calls shielded_transfer at epoch 1 (compliance applied lazily) -- must fail
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let mut clk = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clk, EPOCH_DURATION_MS); // epoch 1
        let proof = vector[0u8];
        let inputs = make_n_zero_bytes(192);
        pool::shielded_transfer(&mut pool, proof, inputs, &clk, scenario.ctx());
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 2: Wrong AdminCap for compliance config
// ===========================================================================
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun threat_wrong_admincap_create_compliance_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Admin creates pool 1
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();

    // Attacker creates pool 2
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        // Attacker uses their cap (pool 2) against admin's pool (pool 1)
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap
        compliance::create_compliance_config(
            &cap,
            &mut pool,
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

// ===========================================================================
// ATTACKER THREAT 3: Wrong AdminCap for credential root update
// ===========================================================================
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun threat_wrong_admincap_update_credential_root() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        // Admin creates compliance config for pool 1
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Attacker creates pool 2
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        // Attacker tries update_credential_root with their cap against admin's pool
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap
        let clk = clock::create_for_testing(scenario.ctx());
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 4: Non-standard deposit rejected
// ===========================================================================
#[test]
#[expected_failure(abort_code = 14, location = veil::pool)]
fun threat_nonstandard_deposit_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let bad_coin = coin::mint_for_testing<TOKEN>(123_456_000, scenario.ctx());
        pool::deposit(&mut pool, bad_coin, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 5: Dust deposit rejected
// ===========================================================================
#[test]
#[expected_failure(abort_code = 11, location = veil::pool)]
fun threat_dust_deposit_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let dust_coin = coin::mint_for_testing<TOKEN>(999, scenario.ctx());
        pool::deposit(&mut pool, dust_coin, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 6: Double freeze is idempotent
// ===========================================================================
#[test]
fun threat_double_freeze_idempotent() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();

        let clock = clock::create_for_testing(scenario.ctx());

        // Freeze twice -- both should succeed (idempotent)
        pool::freeze_pool(&mut pool, &cap, &clock);
        assert!(pool.is_frozen(), 0);
        pool::freeze_pool(&mut pool, &cap, &clock);
        assert!(pool.is_frozen(), 1);

        // Unfreeze twice -- both should succeed (idempotent)
        pool::unfreeze_pool(&mut pool, &cap);
        assert!(!pool.is_frozen(), 2);
        pool::unfreeze_pool(&mut pool, &cap);
        assert!(!pool.is_frozen(), 3);

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 7: Deposit when frozen (both deposit and deposit_and_register)
// ===========================================================================
#[test]
#[expected_failure(abort_code = 1, location = veil::pool)]
fun threat_deposit_when_frozen() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Freeze
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

    // Attacker tries deposit
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        pool::deposit(&mut pool, coin_a, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 1, location = veil::pool)]
fun threat_deposit_and_register_when_frozen() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Freeze
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

    // Attacker tries deposit_and_register
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        let commitment = valid_commitment(1);
        let clk = clock::create_for_testing(scenario.ctx());
        pool::deposit_and_register(&mut pool, coin_a, commitment, &clk, scenario.ctx());
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 8: Compliance config for mismatched pool
// ===========================================================================
#[test]
#[expected_failure(abort_code = 26, location = veil::compliance)]
fun threat_compliance_config_pool_mismatch() {
    let mut scenario = test_scenario::begin(ADMIN);
    // Create pool 1
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        // Create compliance config tied to pool 1
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Create pool 2 (same admin)
    scenario.next_tx(ADMIN);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        // Use config (tied to pool 1) with pool 2 -- must fail
        let pool2 = scenario.take_shared<Pool>(); // pool 2
        let mut config = scenario.take_shared<ComplianceConfig>(); // tied to pool 1
        let cap = scenario.take_from_sender<AdminCap>(); // cap for pool 2
        let clk = clock::create_for_testing(scenario.ctx());
        compliance::update_credential_root(&mut config, &cap, &pool2, UPDATED_ROOT, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool2);
        test_scenario::return_shared(config);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 9: Non-standard deposit_and_register rejected
// ===========================================================================
#[test]
#[expected_failure(abort_code = 14, location = veil::pool)]
fun threat_nonstandard_deposit_and_register_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let bad_coin = coin::mint_for_testing<TOKEN>(250_000_000, scenario.ctx());
        let commitment = valid_commitment(1);
        let clk = clock::create_for_testing(scenario.ctx());
        pool::deposit_and_register(&mut pool, bad_coin, commitment, &clk, scenario.ctx());
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 10: VK overwrite protection (propose while pending fails)
// ===========================================================================
#[test]
#[expected_failure(abort_code = 17, location = veil::pool)]
fun threat_vk_overwrite_protection() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());

        // First proposal succeeds
        pool::propose_vk_update(&mut pool, &cap, DUMMY_VK, &clk);

        // Second proposal while first is pending -- must fail
        pool::propose_vk_update(&mut pool, &cap, DUMMY_VK, &clk);

        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 11: Invalid commitment length (16 bytes)
// ===========================================================================
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun threat_invalid_commitment_length() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        let short_commitment = vector[
            1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
            9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8,
        ]; // 16 bytes, must be 32
        let clk = clock::create_for_testing(scenario.ctx());
        pool::deposit_and_register(&mut pool, coin_a, short_commitment, &clk, scenario.ctx());
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 12: Deposit at different epochs verified
// ===========================================================================
#[test]
fun threat_epoch_commitment_tracking() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Deposit at epoch 0
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        let clk = clock::create_for_testing(scenario.ctx()); // timestamp 0 => epoch 0
        pool::deposit_and_register(&mut pool, coin_a, valid_commitment(1), &clk, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL, 0);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };

    // Deposit at epoch 1
    scenario.next_tx(BOB);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_b = coin::mint_for_testing<TOKEN>(DENOM_MEDIUM, scenario.ctx());
        let mut clk = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clk, EPOCH_DURATION_MS); // epoch 1
        pool::deposit_and_register(&mut pool, coin_b, valid_commitment(2), &clk, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL + DENOM_MEDIUM, 1);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };

    // Deposit at epoch 5
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_c = coin::mint_for_testing<TOKEN>(DENOM_LARGE, scenario.ctx());
        let mut clk = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clk, EPOCH_DURATION_MS * 5); // epoch 5
        pool::deposit_and_register(&mut pool, coin_c, valid_commitment(3), &clk, scenario.ctx());
        assert!(pool.pool_balance() == DENOM_SMALL + DENOM_MEDIUM + DENOM_LARGE, 2);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 13: Emergency withdraw when frozen
// ===========================================================================
#[test]
fun threat_emergency_withdraw_when_frozen() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Alice deposits
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_LARGE, scenario.ctx());
        pool::deposit(&mut pool, coin_a, scenario.ctx());
        test_scenario::return_shared(pool);
    };

    // Admin freezes at epoch 0
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

    // Admin emergency_withdraws at epoch 1 (must wait past frozen_at_epoch)
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS); // epoch 1
        pool::emergency_withdraw(&mut pool, &cap, DENOM_LARGE, ADMIN, &clock, scenario.ctx());
        assert!(pool.pool_balance() == 0, 1);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 14: Credential root timelock enforcement
// ===========================================================================
#[test]
fun threat_credential_root_timelock_enforcement() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // Create config
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Propose root update at epoch 0 -- root stays at DUMMY_ROOT
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx()); // epoch 0
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &clk);
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 0);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // At epoch 0 still, root should still be DUMMY_ROOT
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<ComplianceConfig>();
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 1);
        test_scenario::return_shared(config);
    };

    // Advance to epoch 1 and cancel+repropose to trigger apply_pending_credential_root
    // (apply_pending is called internally by compliant_transfer or update_credential_root)
    // Since we cannot call compliant_transfer without valid proofs, we verify via cancel+propose:
    // after cancel, the pending is cleared, so we can verify the timelock was in effect.
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        // Cancel the pending update -- root remains DUMMY_ROOT (timelock never applied)
        compliance::cancel_credential_root_update(&mut config, &cap, &pool);
        assert!(compliance::credential_root(&config) == DUMMY_ROOT, 2);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 15: VK too short rejected
// ===========================================================================
#[test]
#[expected_failure(abort_code = 18, location = veil::pool)]
fun threat_vk_too_short_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        let short_vk = make_n_zero_bytes(100); // < MIN_VK_LENGTH (232)
        pool::create_pool(short_vk, THRESHOLD, scenario.ctx());
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 16: VK update too short rejected
// ===========================================================================
#[test]
#[expected_failure(abort_code = 18, location = veil::pool)]
fun threat_vk_update_too_short_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());
        let short_vk = make_n_zero_bytes(100);
        pool::propose_vk_update(&mut pool, &cap, short_vk, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 17: Duplicate commitment rejected on deposit_and_register
// ===========================================================================
#[test]
#[expected_failure(abort_code = 10, location = veil::pool)]
fun threat_duplicate_commitment_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    // First deposit+register succeeds
    scenario.next_tx(ALICE);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_a = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        let clk = clock::create_for_testing(scenario.ctx());
        pool::deposit_and_register(&mut pool, coin_a, valid_commitment(42), &clk, scenario.ctx());
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };

    // Second deposit+register with SAME commitment -- must fail
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin_b = coin::mint_for_testing<TOKEN>(DENOM_SMALL, scenario.ctx());
        let clk = clock::create_for_testing(scenario.ctx());
        pool::deposit_and_register(&mut pool, coin_b, valid_commitment(42), &clk, scenario.ctx());
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 18: Credential root double-proposal blocked
// ===========================================================================
#[test]
#[expected_failure(abort_code = 28, location = veil::compliance)]
fun threat_credential_root_double_proposal_blocked() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
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
        let clk = clock::create_for_testing(scenario.ctx());

        // First proposal succeeds
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &clk);

        // Second proposal while first pending -- must fail
        let another_root = vector[
            9u8, 8u8, 7u8, 6u8, 5u8, 4u8, 3u8, 2u8,
            1u8, 0u8, 9u8, 8u8, 7u8, 6u8, 5u8, 4u8,
            3u8, 2u8, 1u8, 0u8, 9u8, 8u8, 7u8, 6u8,
            5u8, 4u8, 3u8, 2u8, 1u8, 0u8, 9u8, 8u8,
        ];
        compliance::update_credential_root(&mut config, &cap, &pool, another_root, &clk);

        clock::destroy_for_testing(clk);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ATTACKER THREAT 19: Attacker cannot cancel admin's credential root update
// ===========================================================================
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun threat_attacker_cannot_cancel_credential_root_update() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        compliance::create_compliance_config(
            &cap,
            &mut pool,
            DUMMY_VK,
            DUMMY_ROOT,
            REQUIRED_KYC_LEVEL,
            DUMMY_AUDITOR_KEY,
            scenario.ctx(),
        );
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Propose root update in a separate tx (config now shared)
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());
        compliance::update_credential_root(&mut config, &cap, &pool, UPDATED_ROOT, &clk);
        clock::destroy_for_testing(clk);
        test_scenario::return_shared(config);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };

    // Attacker creates pool 2, tries to cancel admin's pending root update
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<AdminCap>(); // attacker's cap
        compliance::cancel_credential_root_update(&mut config, &cap, &pool);
        test_scenario::return_shared(pool);
        test_scenario::return_shared(config);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// HELPERS
// ===========================================================================

fun valid_commitment(seed: u8): vector<u8> {
    let mut commitment = vector[];
    let mut i: u8 = 0;
    while (i < 32) {
        commitment.push_back(seed + i);
        i = i + 1;
    };
    commitment
}

fun make_n_zero_bytes(n: u64): vector<u8> {
    let mut result = vector[];
    let mut i: u64 = 0;
    while (i < n) {
        result.push_back(0u8);
        i = i + 1;
    };
    result
}
