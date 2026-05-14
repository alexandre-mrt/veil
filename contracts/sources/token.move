module veil::token;

use sui::coin::{Self, TreasuryCap};

const FAUCET_AMOUNT: u64 = 1_000_000_000; // 1000 VEIL at 6 decimals

/// One-time witness — name must match module name (TOKEN = token uppercased)
public struct TOKEN has drop {}

fun init(witness: TOKEN, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        6,
        b"VEIL",
        b"Veil Token",
        b"",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury_cap, ctx.sender());
}

public fun mint(
    treasury: &mut TreasuryCap<TOKEN>,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    let minted = coin::mint(treasury, amount, ctx);
    transfer::public_transfer(minted, recipient);
}

public fun faucet(treasury: &mut TreasuryCap<TOKEN>, ctx: &mut TxContext) {
    let minted = coin::mint(treasury, FAUCET_AMOUNT, ctx);
    transfer::public_transfer(minted, ctx.sender());
}
