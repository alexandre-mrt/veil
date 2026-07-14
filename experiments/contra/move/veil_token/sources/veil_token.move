/// VEIL test coin for the contra (confidential transfers) experiment.
///
/// Mirrors the real VEIL token from `contracts/sources/token.move` (6 decimals),
/// but is published standalone on devnet: contra only exists on devnet, and it
/// requires a *regulated* currency because wrap/unwrap consult the DenyList.
///
/// TreasuryCap and DenyCap go to the publisher, who acts as the issuer:
/// registers VEIL as a confidential token, mints payroll, and sets auditor keys.
module veil_token::veil_token;

use sui::coin_registry;

public struct VEIL_TOKEN has drop {}

fun init(witness: VEIL_TOKEN, ctx: &mut TxContext) {
    let (mut initializer, treasury_cap) = coin_registry::new_currency_with_otw(
        witness,
        6,
        b"VEIL".to_string(),
        b"Veil".to_string(),
        b"Veil privacy protocol token (devnet experiment)".to_string(),
        b"".to_string(),
        ctx,
    );
    // `true` enables the global pause, which contra's compliance levers rely on.
    let deny_cap = initializer.make_regulated(true, ctx);
    initializer.finalize_and_delete_metadata_cap(ctx);
    transfer::public_transfer(treasury_cap, ctx.sender());
    transfer::public_transfer(deny_cap, ctx.sender());
}
