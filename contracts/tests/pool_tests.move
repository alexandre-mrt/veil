#[test_only]
module veil::pool_tests;

use sui::coin;
use sui::test_scenario;
use veil::pool::{Self, Pool, AdminCap};
use veil::token::TOKEN;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN: address = @0xA;
const USER: address = @0xB;
const ATTACKER: address = @0xC;
const RECIPIENT: address = @0xD;

const DUMMY_VK: vector<u8> = vector[0u8, 0u8];
const THRESHOLD: u64 = 1_000_000_000;
const DEPOSIT_AMOUNT: u64 = 500_000_000;
const WITHDRAW_AMOUNT: u64 = 200_000_000;
const MIN_DEPOSIT: u64 = 1_000;

// Error codes referenced via pool::E_* in expected_failure annotations.
// No local constants needed — Move 2024 resolves module-qualified constants.

// ===========================================================================
// HAPPY PATH TESTS
// ===========================================================================

// 1. create_pool — pool created with correct fields
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

// 2. deposit — tokens deposited, balance increases
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

// 3. deposit_and_register — tokens deposited + commitment registered
#[test]
fun test_deposit_and_register() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let commitment = valid_commitment(1);
        pool::deposit_and_register(&mut pool, deposit_coin, commitment, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT, 0);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 4. withdraw — admin can withdraw
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
        let cap = scenario.take_from_sender<AdminCap>();
        pool::withdraw(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT - WITHDRAW_AMOUNT, 0);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 5. freeze_pool / unfreeze_pool — toggles frozen state
#[test]
fun test_freeze_and_unfreeze_pool() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        assert!(!pool.is_frozen(), 0);
        pool::freeze_pool(&mut pool, &cap);
        assert!(pool.is_frozen(), 1);
        pool::unfreeze_pool(&mut pool, &cap);
        assert!(!pool.is_frozen(), 2);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 6. propose_vk_update — pending VK stored
#[test]
fun test_propose_vk_update() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let new_vk = vector[1u8, 2u8, 3u8, 4u8];
        pool::propose_vk_update(&mut pool, &cap, new_vk, &clock);
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 7. shielded_transfer with invalid proof fails (groth16 native abort)
#[test]
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
        let invalid_proof = vector[1u8, 2u8, 3u8];
        let public_inputs = make_192_zero_bytes();
        pool::shielded_transfer(
            &mut pool, invalid_proof, public_inputs, &clock, scenario.ctx(),
        );
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — FREEZE MECHANISM
// ===========================================================================

// 8. deposit when frozen
#[test]
#[expected_failure(abort_code = 1, location = veil::pool)]
fun test_deposit_when_frozen() {
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

// 9. shielded_transfer when frozen
#[test]
#[expected_failure(abort_code = 1, location = veil::pool)]
fun test_shielded_transfer_when_frozen() {
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
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let inputs = make_192_zero_bytes();
        pool::shielded_transfer(&mut pool, proof, inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 10. withdraw when frozen
#[test]
#[expected_failure(abort_code = 1, location = veil::pool)]
fun test_withdraw_when_frozen() {
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
        let cap = scenario.take_from_sender<AdminCap>();
        pool::freeze_pool(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        pool::withdraw(&mut pool, &cap, WITHDRAW_AMOUNT, RECIPIENT, scenario.ctx());
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 11. deposit_and_register when frozen
#[test]
#[expected_failure(abort_code = 1, location = veil::pool)]
fun test_deposit_and_register_when_frozen() {
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
        let commitment = valid_commitment(1);
        pool::deposit_and_register(&mut pool, deposit_coin, commitment, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — ACCESS CONTROL
// Uses take_shared_by_id to target pool 1 with ATTACKER's cap (for pool 2).
// most_recent_id_shared is called AFTER next_tx so the shared object is visible.
// ===========================================================================

// 12. withdraw with wrong AdminCap
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_withdraw_wrong_admin_cap() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(USER);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        pool::withdraw(&mut pool, &cap, WITHDRAW_AMOUNT, ATTACKER, scenario.ctx());
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 13. freeze_pool with wrong AdminCap
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_freeze_wrong_admin_cap() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        pool::freeze_pool(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 14. unfreeze_pool with wrong AdminCap
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_unfreeze_wrong_admin_cap() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ADMIN);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        pool::freeze_pool(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        pool::unfreeze_pool(&mut pool, &cap);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 15. propose_vk_update with wrong AdminCap
#[test]
#[expected_failure(abort_code = 4, location = veil::pool)]
fun test_propose_vk_update_wrong_admin_cap() {
    let mut scenario = test_scenario::begin(ADMIN);
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    let pool1_id = test_scenario::most_recent_id_shared<Pool>().destroy_some();
    pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared_by_id<Pool>(pool1_id);
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let new_vk = vector[9u8, 9u8];
        pool::propose_vk_update(&mut pool, &cap, new_vk, &clock);
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — DEPOSIT VALIDATION
// ===========================================================================

// 16. deposit below MIN_DEPOSIT
#[test]
#[expected_failure(abort_code = 11, location = veil::pool)]
fun test_deposit_below_min_deposit() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let dust_coin = coin::mint_for_testing<TOKEN>(MIN_DEPOSIT - 1, scenario.ctx());
        pool::deposit(&mut pool, dust_coin, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 17. deposit_and_register below MIN_DEPOSIT
#[test]
#[expected_failure(abort_code = 11, location = veil::pool)]
fun test_deposit_and_register_below_min_deposit() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let dust_coin = coin::mint_for_testing<TOKEN>(MIN_DEPOSIT - 1, scenario.ctx());
        let commitment = valid_commitment(1);
        pool::deposit_and_register(&mut pool, dust_coin, commitment, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 18. deposit_and_register with wrong commitment length (31 bytes)
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_deposit_and_register_wrong_commitment_length_31() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let short_commitment = vector[
            1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
            9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8,
            17u8, 18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8,
            25u8, 26u8, 27u8, 28u8, 29u8, 30u8, 31u8,
        ];
        pool::deposit_and_register(&mut pool, deposit_coin, short_commitment, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 19. deposit_and_register with duplicate commitment
#[test]
#[expected_failure(abort_code = 10, location = veil::pool)]
fun test_deposit_and_register_duplicate_commitment() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let commitment = valid_commitment(1);
        pool::deposit_and_register(&mut pool, deposit_coin, commitment, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let commitment = valid_commitment(1);
        pool::deposit_and_register(&mut pool, deposit_coin, commitment, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — WITHDRAW VALIDATION
// ===========================================================================

// 20. withdraw more than pool balance
#[test]
#[expected_failure(abort_code = 6, location = veil::pool)]
fun test_withdraw_insufficient_balance() {
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
        let cap = scenario.take_from_sender<AdminCap>();
        pool::withdraw(&mut pool, &cap, DEPOSIT_AMOUNT + 1, RECIPIENT, scenario.ctx());
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// ===========================================================================
// ERROR PATH TESTS — SHIELDED TRANSFER
// ===========================================================================

// 21. shielded_transfer with public_inputs too short (100 bytes)
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_shielded_transfer_short_public_inputs() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let short_inputs = make_n_zero_bytes(100);
        pool::shielded_transfer(&mut pool, proof, short_inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 22. shielded_transfer with public_inputs exactly 191 bytes
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_shielded_transfer_191_bytes_public_inputs() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let short_inputs = make_n_zero_bytes(191);
        pool::shielded_transfer(&mut pool, proof, short_inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 23. shielded_transfer with invalid proof (valid-length inputs, groth16 native abort)
#[test]
#[expected_failure]
fun test_shielded_transfer_bad_proof_with_valid_length_inputs() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8, 0u8, 0u8, 0u8];
        let public_inputs = make_inputs_with_threshold(THRESHOLD);
        pool::shielded_transfer(&mut pool, proof, public_inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 24. shielded_transfer with wrong threshold (groth16 native aborts before our check with dummy VK)
#[test]
#[expected_failure]
fun test_shielded_transfer_wrong_threshold() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let wrong_threshold = THRESHOLD + 1;
        let public_inputs = make_inputs_with_threshold(wrong_threshold);
        pool::shielded_transfer(&mut pool, proof, public_inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 25. shielded_transfer with non-zero upper bytes in threshold field
#[test]
#[expected_failure]
fun test_shielded_transfer_nonzero_upper_bytes_threshold() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let mut public_inputs = make_inputs_with_threshold(THRESHOLD);
        *&mut public_inputs[72] = 1u8;
        pool::shielded_transfer(&mut pool, proof, public_inputs, &clock, scenario.ctx());
        sui::clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// ===========================================================================
// EDGE CASE TESTS
// ===========================================================================

// 26. Multiple deposits from different users
#[test]
fun test_multiple_deposits_different_users() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin1 = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, coin1, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT, 0);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin2 = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT * 2, scenario.ctx());
        pool::deposit(&mut pool, coin2, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT * 3, 1);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(RECIPIENT);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin3 = coin::mint_for_testing<TOKEN>(MIN_DEPOSIT, scenario.ctx());
        pool::deposit(&mut pool, coin3, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT * 3 + MIN_DEPOSIT, 2);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 27. Withdraw exact pool balance (drain to zero)
#[test]
fun test_withdraw_exact_balance_drain() {
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
        let cap = scenario.take_from_sender<AdminCap>();
        pool::withdraw(&mut pool, &cap, DEPOSIT_AMOUNT, RECIPIENT, scenario.ctx());
        assert!(pool.pool_balance() == 0, 0);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 28. Create two pools — verify AdminCap isolation (positive test)
#[test]
fun test_two_pools_admin_cap_isolation() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ATTACKER);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD * 2, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<AdminCap>();
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ATTACKER);
    {
        let cap = scenario.take_from_sender<AdminCap>();
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 29. Deposit zero-value coin
#[test]
#[expected_failure(abort_code = 11, location = veil::pool)]
fun test_deposit_zero_value_coin() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let zero_coin = coin::mint_for_testing<TOKEN>(0, scenario.ctx());
        pool::deposit(&mut pool, zero_coin, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 30. freeze then unfreeze then deposit (should work)
#[test]
fun test_freeze_unfreeze_then_deposit() {
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
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        pool::unfreeze_pool(&mut pool, &cap);
        assert!(!pool.is_frozen(), 1);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit(&mut pool, deposit_coin, scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT, 2);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 31. deposit at exact MIN_DEPOSIT boundary (should succeed)
#[test]
fun test_deposit_exact_min_deposit() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let min_coin = coin::mint_for_testing<TOKEN>(MIN_DEPOSIT, scenario.ctx());
        pool::deposit(&mut pool, min_coin, scenario.ctx());
        assert!(pool.pool_balance() == MIN_DEPOSIT, 0);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 32. deposit_and_register with 33-byte commitment
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_deposit_and_register_wrong_commitment_length_33() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let long_commitment = vector[
            1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
            9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8,
            17u8, 18u8, 19u8, 20u8, 21u8, 22u8, 23u8, 24u8,
            25u8, 26u8, 27u8, 28u8, 29u8, 30u8, 31u8, 32u8,
            33u8,
        ];
        pool::deposit_and_register(&mut pool, deposit_coin, long_commitment, scenario.ctx());
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 33. Multiple deposit_and_register with unique commitments (all succeed)
#[test]
fun test_multiple_deposit_and_register_unique_commitments() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin1 = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit_and_register(&mut pool, coin1, valid_commitment(1), scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT, 0);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin2 = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit_and_register(&mut pool, coin2, valid_commitment(2), scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT * 2, 1);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(RECIPIENT);
    {
        let mut pool = scenario.take_shared<Pool>();
        let coin3 = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        pool::deposit_and_register(&mut pool, coin3, valid_commitment(3), scenario.ctx());
        assert!(pool.pool_balance() == DEPOSIT_AMOUNT * 3, 2);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 34. withdraw from empty pool
#[test]
#[expected_failure(abort_code = 6, location = veil::pool)]
fun test_withdraw_from_empty_pool() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        pool::withdraw(&mut pool, &cap, 1, RECIPIENT, scenario.ctx());
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    scenario.end();
}

// 35. deposit_and_register at exact MIN_DEPOSIT (should succeed)
#[test]
fun test_deposit_and_register_exact_min_deposit() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let min_coin = coin::mint_for_testing<TOKEN>(MIN_DEPOSIT, scenario.ctx());
        pool::deposit_and_register(&mut pool, min_coin, valid_commitment(1), scenario.ctx());
        assert!(pool.pool_balance() == MIN_DEPOSIT, 0);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// 36. shielded_transfer with 193 bytes (too long)
#[test]
#[expected_failure(abort_code = 7, location = veil::pool)]
fun test_shielded_transfer_193_bytes_public_inputs() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let clock = sui::clock::create_for_testing(scenario.ctx());
        let proof = vector[0u8];
        let long_inputs = make_n_zero_bytes(193);
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
        pool::create_pool(DUMMY_VK, THRESHOLD, scenario.ctx());
    };
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let empty_commitment = vector[];
        pool::deposit_and_register(&mut pool, deposit_coin, empty_commitment, scenario.ctx());
        test_scenario::return_shared(pool);
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

fun make_192_zero_bytes(): vector<u8> {
    make_n_zero_bytes(192)
}

fun make_inputs_with_threshold(threshold: u64): vector<u8> {
    let mut inputs = make_192_zero_bytes();
    let mut i: u8 = 0;
    while (i < 8) {
        let byte_val = ((threshold >> ((i as u8) * 8)) & 0xFF as u8);
        *&mut inputs[64 + (i as u64)] = byte_val;
        i = i + 1;
    };
    inputs
}
