#[test_only]
// Regression tests for the recipient-binding vulnerability found in the 2026-09-21 backlog
// audit (RR10 / docs/threat-model.md E7): pool::zk_withdraw never checked that the
// recipientHash committed to by the Groth16 proof (public input bytes 96-128) actually
// corresponds to the `recipient` address argument. Anyone who observed a pending
// withdrawal's (proof_bytes, public_inputs_bytes) could resubmit them with their own address
// as `recipient`: the proof still verified (recipientHash is a public input, not a value the
// caller controls the check on) and the nullifier still got consumed, redirecting the funds
// and permanently blocking the real owner.
//
// Fixtures below are a REAL Groth16 proof for withdraw.circom (not simulated): compiled with
// circom 2.2.2, a fresh local Groth16 trusted setup (pot13), and snarkjs 0.7.6, independently
// verified with `snarkjs.groth16.verify` before being embedded here. See
// docs/research/2026-09-24-recipient-binding-fix.md for the exact reproduction commands.
//
// Witness: userSecret=0x1234567890ABCDEF, cumulativeOld=500_000_000, randomnessOld=111,
// withdrawAmount=200_000_000, randomnessNew=222, recipient field = BE(@0xD) mod BN254_R = 13
// (the legitimate recipient this proof was built for; @0xC / field 12 is the attacker).
module veil::pool_withdraw_recipient_binding_tests;

use sui::clock;
use sui::coin;
use sui::test_scenario;
use veil::pool::{Self, Pool, AdminCap};
use veil::test_helpers;
use veil::token::TOKEN;

const ADMIN: address = @0xA;
const USER: address = @0xB;
const ATTACKER: address = @0xC;
const RECIPIENT: address = @0xD;

const THRESHOLD: u64 = 1_000_000_000;
const DEPOSIT_AMOUNT: u64 = 500_000_000; // matches the proof's cumulativeOld (500 TOKEN, standard denom)
const EPOCH_DURATION_MS: u64 = 3_600_000;

// Real withdraw.circom Groth16 proof (128 bytes: A || B || C, arkworks-compressed).
fun real_proof_bytes(): vector<u8> { vector[126u8, 116u8, 175u8, 58u8, 79u8, 161u8, 65u8, 229u8, 8u8, 111u8, 34u8, 169u8, 89u8, 10u8, 254u8, 36u8, 153u8, 87u8, 249u8, 94u8, 59u8, 230u8, 250u8, 7u8, 148u8, 159u8, 122u8, 68u8, 13u8, 13u8, 145u8, 27u8, 129u8, 195u8, 243u8, 39u8, 90u8, 61u8, 169u8, 100u8, 129u8, 230u8, 214u8, 156u8, 137u8, 111u8, 139u8, 254u8, 128u8, 210u8, 110u8, 135u8, 248u8, 228u8, 252u8, 90u8, 73u8, 90u8, 223u8, 97u8, 212u8, 154u8, 195u8, 36u8, 6u8, 211u8, 128u8, 168u8, 36u8, 212u8, 0u8, 110u8, 23u8, 189u8, 134u8, 127u8, 108u8, 50u8, 19u8, 90u8, 169u8, 86u8, 101u8, 173u8, 43u8, 33u8, 232u8, 250u8, 7u8, 21u8, 212u8, 155u8, 109u8, 210u8, 249u8, 141u8, 27u8, 150u8, 4u8, 25u8, 175u8, 121u8, 64u8, 179u8, 179u8, 136u8, 140u8, 97u8, 191u8, 157u8, 226u8, 159u8, 218u8, 206u8, 9u8, 120u8, 78u8, 44u8, 150u8, 135u8, 182u8, 235u8, 125u8, 200u8, 137u8, 10u8, 211u8, 14u8] }

// Real public inputs (160 bytes = 5 x 32 LE): commitment, withdrawAmount, nullifier,
// recipientHash, newCommitment. recipientHash here is Poseidon(8, 13) — bound to @0xD.
fun real_public_inputs(): vector<u8> { vector[84u8, 173u8, 157u8, 217u8, 14u8, 252u8, 234u8, 60u8, 70u8, 103u8, 111u8, 189u8, 172u8, 26u8, 160u8, 189u8, 235u8, 201u8, 46u8, 18u8, 65u8, 66u8, 238u8, 107u8, 15u8, 19u8, 70u8, 215u8, 108u8, 243u8, 195u8, 8u8, 0u8, 194u8, 235u8, 11u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 150u8, 71u8, 16u8, 155u8, 13u8, 30u8, 242u8, 57u8, 29u8, 140u8, 186u8, 167u8, 152u8, 126u8, 57u8, 239u8, 44u8, 129u8, 35u8, 6u8, 48u8, 150u8, 179u8, 236u8, 191u8, 114u8, 193u8, 113u8, 76u8, 149u8, 189u8, 20u8, 123u8, 204u8, 9u8, 131u8, 6u8, 173u8, 102u8, 238u8, 140u8, 15u8, 116u8, 105u8, 179u8, 245u8, 24u8, 71u8, 225u8, 36u8, 112u8, 112u8, 86u8, 53u8, 76u8, 73u8, 99u8, 51u8, 105u8, 127u8, 213u8, 115u8, 192u8, 26u8, 89u8, 222u8, 153u8, 248u8, 72u8, 115u8, 68u8, 55u8, 45u8, 56u8, 133u8, 176u8, 178u8, 62u8, 60u8, 161u8, 72u8, 41u8, 146u8, 86u8, 221u8, 133u8, 232u8, 42u8, 43u8, 173u8, 82u8, 131u8, 186u8, 215u8, 236u8, 25u8] }

// Real verification key exported from the same trusted setup (424 bytes).
fun real_withdraw_vk(): vector<u8> { vector[112u8, 210u8, 76u8, 222u8, 163u8, 121u8, 128u8, 128u8, 177u8, 149u8, 140u8, 63u8, 237u8, 45u8, 69u8, 210u8, 8u8, 170u8, 197u8, 1u8, 6u8, 64u8, 31u8, 177u8, 31u8, 46u8, 101u8, 123u8, 182u8, 182u8, 116u8, 35u8, 74u8, 189u8, 218u8, 181u8, 244u8, 253u8, 123u8, 246u8, 75u8, 135u8, 185u8, 182u8, 5u8, 68u8, 160u8, 204u8, 10u8, 173u8, 168u8, 88u8, 99u8, 112u8, 51u8, 189u8, 235u8, 77u8, 10u8, 199u8, 27u8, 82u8, 146u8, 5u8, 148u8, 64u8, 145u8, 135u8, 163u8, 67u8, 69u8, 179u8, 87u8, 109u8, 98u8, 39u8, 154u8, 174u8, 40u8, 222u8, 130u8, 176u8, 64u8, 197u8, 154u8, 207u8, 173u8, 209u8, 92u8, 199u8, 5u8, 194u8, 28u8, 142u8, 165u8, 151u8, 237u8, 246u8, 146u8, 217u8, 92u8, 189u8, 222u8, 70u8, 221u8, 218u8, 94u8, 247u8, 212u8, 34u8, 67u8, 103u8, 121u8, 68u8, 92u8, 94u8, 102u8, 0u8, 106u8, 66u8, 118u8, 30u8, 31u8, 18u8, 239u8, 222u8, 0u8, 24u8, 194u8, 18u8, 243u8, 174u8, 183u8, 133u8, 228u8, 151u8, 18u8, 231u8, 169u8, 53u8, 51u8, 73u8, 170u8, 241u8, 37u8, 93u8, 251u8, 49u8, 183u8, 191u8, 96u8, 114u8, 58u8, 72u8, 13u8, 146u8, 147u8, 147u8, 142u8, 25u8, 205u8, 213u8, 240u8, 199u8, 31u8, 57u8, 60u8, 188u8, 85u8, 40u8, 18u8, 224u8, 49u8, 181u8, 147u8, 228u8, 60u8, 6u8, 93u8, 115u8, 175u8, 88u8, 142u8, 202u8, 231u8, 87u8, 72u8, 132u8, 91u8, 45u8, 77u8, 11u8, 63u8, 128u8, 230u8, 72u8, 169u8, 212u8, 195u8, 114u8, 57u8, 171u8, 155u8, 135u8, 164u8, 166u8, 119u8, 204u8, 86u8, 202u8, 17u8, 46u8, 238u8, 128u8, 80u8, 137u8, 195u8, 84u8, 194u8, 230u8, 83u8, 215u8, 55u8, 168u8, 6u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 117u8, 34u8, 70u8, 203u8, 196u8, 173u8, 44u8, 249u8, 113u8, 152u8, 235u8, 69u8, 217u8, 2u8, 8u8, 127u8, 167u8, 224u8, 103u8, 169u8, 45u8, 68u8, 90u8, 80u8, 120u8, 177u8, 206u8, 27u8, 70u8, 128u8, 41u8, 39u8, 200u8, 121u8, 90u8, 157u8, 4u8, 63u8, 60u8, 172u8, 239u8, 205u8, 211u8, 30u8, 240u8, 183u8, 75u8, 20u8, 225u8, 17u8, 25u8, 166u8, 219u8, 215u8, 226u8, 103u8, 87u8, 182u8, 59u8, 42u8, 50u8, 93u8, 102u8, 163u8, 235u8, 14u8, 164u8, 220u8, 132u8, 223u8, 211u8, 84u8, 175u8, 31u8, 141u8, 72u8, 222u8, 193u8, 136u8, 225u8, 199u8, 75u8, 188u8, 156u8, 206u8, 31u8, 72u8, 10u8, 42u8, 243u8, 187u8, 242u8, 218u8, 217u8, 106u8, 42u8, 61u8, 85u8, 49u8, 175u8, 196u8, 17u8, 49u8, 33u8, 188u8, 22u8, 158u8, 234u8, 106u8, 237u8, 243u8, 75u8, 100u8, 26u8, 30u8, 194u8, 141u8, 100u8, 143u8, 114u8, 254u8, 33u8, 246u8, 78u8, 189u8, 132u8, 60u8, 153u8, 200u8, 200u8, 176u8, 250u8, 133u8, 87u8, 96u8, 56u8, 172u8, 198u8, 64u8, 5u8, 138u8, 56u8, 123u8, 241u8, 87u8, 144u8, 82u8, 79u8, 229u8, 223u8, 241u8, 200u8, 226u8, 115u8, 139u8, 177u8, 129u8, 7u8, 51u8, 145u8, 196u8, 138u8, 0u8, 91u8, 113u8, 142u8, 43u8, 62u8, 8u8, 80u8, 19u8, 75u8, 129u8, 177u8, 60u8, 36u8, 127u8, 1u8, 8u8, 10u8, 114u8, 54u8, 234u8, 119u8, 208u8, 201u8, 196u8, 180u8, 243u8, 85u8, 14u8, 142u8] }

fun deposit_commitment(): vector<u8> {
    veil::verifier::extract_bytes(&real_public_inputs(), 0, 32)
}

fun setup_pool_ready_for_withdraw(scenario: &mut test_scenario::Scenario): u64 {
    pool::create_pool(test_helpers::dummy_vk(), THRESHOLD, EPOCH_DURATION_MS, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        pool::propose_withdraw_vk(&mut pool, &cap, real_withdraw_vk(), &clock);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
        scenario.return_to_sender(cap);
    };
    // Epoch 1: withdraw VK timelock elapses, user deposits (commitment matures next epoch).
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let deposit_coin = coin::mint_for_testing<TOKEN>(DEPOSIT_AMOUNT, scenario.ctx());
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, EPOCH_DURATION_MS);
        pool::deposit_and_register(&mut pool, deposit_coin, deposit_commitment(), &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    EPOCH_DURATION_MS * 2 // epoch 2: commitment is now mature (created at epoch 1)
}

// The actual vulnerability, reproduced and confirmed fixed: a real, validly-verifying proof
// and public inputs, submitted with an attacker-controlled `recipient` instead of the address
// the proof was actually built for. Before the fix, this abstracted-away check meant the
// funds went to ATTACKER. It must now abort with E_INVALID_RECIPIENT (30).
#[test]
#[expected_failure(abort_code = 30, location = veil::pool)]
fun test_zk_withdraw_rejects_recipient_substitution() {
    let mut scenario = test_scenario::begin(ADMIN);
    let withdraw_epoch_ms = setup_pool_ready_for_withdraw(&mut scenario);
    scenario.next_tx(ATTACKER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, withdraw_epoch_ms);
        // Same real proof + public inputs as the legitimate withdrawal — only `recipient` changes.
        pool::zk_withdraw(&mut pool, real_proof_bytes(), real_public_inputs(), ATTACKER, &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

// Positive control: the exact same proof and inputs, submitted with the recipient the proof
// was actually built for, succeeds — proving the new check rejects attackers without
// rejecting the legitimate withdrawal it was designed to allow.
#[test]
fun test_zk_withdraw_succeeds_for_bound_recipient() {
    let mut scenario = test_scenario::begin(ADMIN);
    let withdraw_epoch_ms = setup_pool_ready_for_withdraw(&mut scenario);
    scenario.next_tx(USER);
    {
        let mut pool = scenario.take_shared<Pool>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, withdraw_epoch_ms);
        let balance_before = pool.pool_balance();
        pool::zk_withdraw(&mut pool, real_proof_bytes(), real_public_inputs(), RECIPIENT, &clock, scenario.ctx());
        assert!(pool.pool_balance() == balance_before - 200_000_000, 0);
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(pool);
    };
    scenario.next_tx(RECIPIENT);
    {
        let received = scenario.take_from_sender<coin::Coin<TOKEN>>();
        assert!(received.value() == 200_000_000, 1);
        test_scenario::return_to_address(RECIPIENT, received);
    };
    scenario.end();
}
