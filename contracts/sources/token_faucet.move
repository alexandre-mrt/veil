/// Testnet-only faucet module. Exclude this file from mainnet deployments
/// by removing it from the sources directory or using a separate Move.toml.
module veil::token_faucet;

use sui::coin;
use sui::coin::TreasuryCap;
use veil::token::TOKEN;

const FAUCET_AMOUNT: u64 = 1_000_000_000; // 1000 VEIL at 6 decimals
const MAX_SUPPLY: u64 = 1_000_000_000_000; // 1M TOKEN max supply (6 decimals)
const E_MAX_SUPPLY_REACHED: u64 = 1;

/// Testnet-only faucet. Mints FAUCET_AMOUNT to caller.
/// Access is implicitly gated by TreasuryCap ownership.
/// For mainnet: remove this file from the sources directory.
public fun faucet(treasury: &mut TreasuryCap<TOKEN>, ctx: &mut TxContext) {
    assert!(coin::total_supply(treasury) + FAUCET_AMOUNT <= MAX_SUPPLY, E_MAX_SUPPLY_REACHED);
    let minted = coin::mint(treasury, FAUCET_AMOUNT, ctx);
    transfer::public_transfer(minted, ctx.sender());
}
